import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadAndValidateManifest,
  migrationDigest,
  validateHistoricalBaseline,
  verifySignedReleaseManifest,
} from './migration-manifest.mjs';
import { runJournaledMigration } from './migration-journal.mjs';
import { normalizeSchemaSnapshot, schemaDigest } from './schema-digest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const hubRoot = path.resolve(here, '../..');
const defaultMigrationsDir = path.join(hubRoot, 'migrations');
const defaultSourceBaselinePath = path.join(defaultMigrationsDir, 'source-baseline.json');
const defaultHistoryPath = path.join(defaultMigrationsDir, 'historical-baseline.json');
const wranglerBin = path.join(hubRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const DIGEST = /^[0-9a-f]{64}$/;

function targetArguments({ target, config, persistTo }) {
  const args = [];
  if (target === 'local' || target === 'e2e') {
    if (!persistTo) throw new Error(`${target} migrations require an explicit persistTo directory`);
    args.push('--local', '--persist-to', path.resolve(persistTo));
  } else if (target === 'preview' || target === 'ppe' || target === 'production') {
    if (!config) throw new Error(`${target} migrations require a trusted generated config`);
    args.push('--remote');
  } else {
    throw new Error(`unknown migration target: ${target}`);
  }
  if (config) args.push('--config', path.resolve(config));
  return args;
}

async function defaultRunProcess(args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wranglerBin, ...args], {
      cwd: hubRoot,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Wrangler exited with ${code ?? signal}: ${stderr || stdout}`));
    });
  });
}

function parseWranglerJson(stdout) {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const arrayStart = trimmed.indexOf('[');
    const objectStart = trimmed.indexOf('{');
    const start = [arrayStart, objectStart].filter((index) => index >= 0).sort((a, b) => a - b)[0];
    if (start == null) throw new Error('Wrangler did not return JSON');
    return JSON.parse(trimmed.slice(start));
  }
}

function rowsFromWrangler(value) {
  if (Array.isArray(value)) {
    if (value.every((item) => item && typeof item === 'object' && !('results' in item))) return value;
    for (const item of value) {
      const rows = rowsFromWrangler(item);
      if (rows) return rows;
    }
  }
  if (value && typeof value === 'object') {
    if (Array.isArray(value.results)) return value.results;
    if (Array.isArray(value.result)) return value.result;
  }
  return null;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function wranglerClient(options) {
  const runProcess = options.runProcess ?? defaultRunProcess;
  const common = targetArguments(options);
  const database = options.database ?? 'DB';
  const run = async (args) => await runProcess(args);
  return {
    async apply() {
      return await run(['d1', 'migrations', 'apply', database, ...common]);
    },
    async query(sql) {
      const { stdout } = await run(['d1', 'execute', database, ...common, '--command', sql, '--json', '--yes']);
      const rows = rowsFromWrangler(parseWranglerJson(stdout));
      if (!rows) throw new Error('Wrangler D1 response contains no result rows');
      return rows;
    },
  };
}

async function readAppliedNames(client) {
  const rows = await client.query('SELECT name FROM d1_migrations ORDER BY id');
  return rows.map((row) => row.name);
}

function assertAppliedManifest(manifest, appliedNames) {
  const expected = manifest.migrations.map((entry) => entry.filename);
  if (expected.length !== appliedNames.length || expected.some((name, index) => name !== appliedNames[index])) {
    throw new Error(`applied D1 migration history differs from manifest: expected ${expected.join(', ')}, found ${appliedNames.join(', ')}`);
  }
}

function assertAppliedManifestPrefix(manifest, appliedNames) {
  const expected = manifest.migrations.map((entry) => entry.filename);
  if (appliedNames.length > expected.length
      || appliedNames.some((name, index) => name !== expected[index])) {
    throw new Error(`applied D1 migration history is not an immutable manifest prefix: found ${appliedNames.join(', ')}`);
  }
}

function countPendingMigrations(manifest, appliedNames) {
  const applied = new Set(appliedNames);
  return manifest.migrations.reduce(
    (count, migration) => count + (applied.has(migration.filename) ? 0 : 1),
    0,
  );
}

async function recordLedger(client, manifest, artifactDigest, deploymentId) {
  for (const entry of manifest.migrations.filter((migration) => migration.sequence >= manifest.ledgerStartsAt)) {
    await client.query(`
      INSERT OR IGNORE INTO migration_checksum_ledger
        (sequence, filename, sha256, artifact_sha256, deployment_id, recorded_at)
      VALUES
        (${entry.sequence}, ${sqlLiteral(entry.filename)}, ${sqlLiteral(entry.sha256)},
         ${sqlLiteral(artifactDigest)}, ${sqlLiteral(deploymentId)}, CURRENT_TIMESTAMP)
      RETURNING sequence
    `);
  }
}

function assertLedger(manifest, rows) {
  const expected = manifest.migrations.filter((entry) => entry.sequence >= manifest.ledgerStartsAt);
  if (rows.length !== expected.length) throw new Error('migration checksum ledger is incomplete or contains unexpected rows');
  for (let index = 0; index < expected.length; index += 1) {
    const entry = expected[index];
    const row = rows[index];
    if (Number(row.sequence) !== entry.sequence || row.filename !== entry.filename || row.sha256 !== entry.sha256) {
      throw new Error(`migration checksum mismatch at ${entry.filename}`);
    }
  }
}

async function remoteSchemaSnapshot(client) {
  const objects = await client.query(`
    SELECT type, name, tbl_name, sql FROM sqlite_master
     WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
       AND name NOT GLOB '_cf_*' AND name <> 'd1_migrations'
     ORDER BY type, name
  `);
  const tableColumns = await client.query(`
    SELECT m.name AS table_name, p.* FROM sqlite_master AS m, pragma_table_xinfo(m.name) AS p
     WHERE m.type = 'table'
       AND m.name IN (SELECT name FROM pragma_table_list() WHERE schema = 'main' AND type <> 'shadow')
       AND m.name NOT LIKE 'sqlite_%' AND m.name NOT GLOB '_cf_*' AND m.name <> 'd1_migrations'
     ORDER BY m.name, p.cid
  `);
  const indexes = await client.query(`
    SELECT m.name AS table_name,
           il.seq AS index_sequence, il.name AS index_name, il."unique" AS "unique",
           il.origin, il.partial,
           ix.seqno, ix.cid, ix.name AS column_name, ix."desc" AS "desc",
           ix.coll, ix."key" AS "key"
      FROM sqlite_master AS m, pragma_index_list(m.name) AS il, pragma_index_xinfo(il.name) AS ix
     WHERE m.type = 'table'
       AND m.name IN (SELECT name FROM pragma_table_list() WHERE schema = 'main' AND type <> 'shadow')
       AND m.name NOT LIKE 'sqlite_%' AND m.name NOT GLOB '_cf_*' AND m.name <> 'd1_migrations'
     ORDER BY m.name, il.name, ix.seqno
  `);
  const foreignKeys = await client.query(`
    SELECT m.name AS table_name, fk.* FROM sqlite_master AS m, pragma_foreign_key_list(m.name) AS fk
     WHERE m.type = 'table'
       AND m.name IN (SELECT name FROM pragma_table_list() WHERE schema = 'main' AND type <> 'shadow')
       AND m.name NOT LIKE 'sqlite_%' AND m.name NOT GLOB '_cf_*' AND m.name <> 'd1_migrations'
     ORDER BY m.name, fk.id, fk.seq
  `);
  return normalizeSchemaSnapshot({
    objects,
    tableColumns,
    indexes,
    foreignKeys,
    pragmas: {},
  });
}

async function validateHistory(options, manifest) {
  // The trust anchor for production migrations is the protected main branch: whatever
  // manifest lands there deploys. The in-repo historical baseline stays validated for
  // structure (it names the pre-ledger history, incl. the 0019 divergence), but no
  // separately signed human-approved envelope is required — that ritual re-blocked
  // every migration behind a manual re-approval and was retired 2026-08-13.
  const history = JSON.parse(await readFile(options.historyPath ?? defaultHistoryPath, 'utf8'));
  validateHistoricalBaseline(history, manifest);
}

export function migrationDeploymentIdentity({ target, stateName, artifactDigest, migrationDigest: digest }) {
  if (!DIGEST.test(artifactDigest ?? '') || !DIGEST.test(digest ?? '')) {
    throw new Error('local migration identity requires artifact and migration SHA-256 digests');
  }
  if (!['local', 'e2e'].includes(target) || typeof stateName !== 'string' || !stateName) {
    throw new Error('invalid local migration identity');
  }
  return {
    journalName: `${artifactDigest}-${digest}.json`,
    deploymentId: `${target}:${stateName}:${artifactDigest}:${digest}`,
  };
}

export async function resolveMigrationDigest(options = {}) {
  const migrationsDir = options.migrationsDir ?? defaultMigrationsDir;
  const { digest } = await loadAndValidateManifest({
    migrationsDir,
    manifestPath: options.manifestPath ?? path.join(migrationsDir, 'manifest.json'),
    baseManifestPath: options.baseManifestPath ?? defaultSourceBaselinePath,
  });
  return digest;
}

export async function measureRemoteSchemaDigest(options) {
  if (options?.target !== 'production') {
    throw new Error('production schema measurement requires target production');
  }
  const client = wranglerClient(options);
  return schemaDigest(await remoteSchemaSnapshot(client));
}

export async function runMigrations(options) {
  if (!options?.journalPath) throw new Error('migrations require a trusted journalPath');
  if (!DIGEST.test(options.artifactDigest ?? '')) throw new Error('migrations require an artifact SHA-256');
  if (options.target === 'preview' && !options.baseManifestPath) {
    throw new Error('preview migrations require a trusted base manifest');
  }
  const migrationsDir = options.migrationsDir ?? defaultMigrationsDir;
  const { manifest, digest } = await loadAndValidateManifest({
    migrationsDir,
    manifestPath: options.manifestPath ?? path.join(migrationsDir, 'manifest.json'),
    baseManifestPath: options.baseManifestPath ?? defaultSourceBaselinePath,
  });
  if (options.expectedMigrationDigest && options.expectedMigrationDigest !== digest) {
    throw new Error('migration manifest changed after deployment identity was computed');
  }
  await validateHistory(options, manifest);
  if (options.releaseManifest && options.releasePublicKey) {
    const release = verifySignedReleaseManifest(options.releaseManifest, options.releasePublicKey);
    if (migrationDigest(release) !== digest) throw new Error('signed release manifest has the wrong migration digest');
  } else if (options.releaseManifest || options.releasePublicKey) {
    throw new Error('signed release manifest and public key must be supplied together');
  }
  const client = wranglerClient(options);
  const identity = {
    target: options.target,
    deploymentId: options.deploymentId,
    artifactDigest: options.artifactDigest,
    migrationDigest: digest,
  };
  const { result } = await runJournaledMigration({
    journalPath: options.journalPath,
    identity,
    apply: async () => {
      if (options.target === 'production') {
        assertAppliedManifestPrefix(manifest, await readAppliedNames(client));
      }
      await client.apply();
    },
    recordChecksums: async () => {
      assertAppliedManifest(manifest, await readAppliedNames(client));
      await recordLedger(client, manifest, options.artifactDigest, options.deploymentId);
      const ledger = await client.query(`
        SELECT sequence, filename, sha256 FROM migration_checksum_ledger ORDER BY sequence
      `);
      assertLedger(manifest, ledger);
    },
    verify: async () => {
      const applied = await readAppliedNames(client);
      const pendingMigrations = countPendingMigrations(manifest, applied);
      assertAppliedManifest(manifest, applied);
      const ledger = await client.query(`
        SELECT sequence, filename, sha256 FROM migration_checksum_ledger ORDER BY sequence
      `);
      assertLedger(manifest, ledger);
      const snapshot = await remoteSchemaSnapshot(client);
      const liveSchemaDigest = schemaDigest(snapshot);
      return {
        migrationDigest: digest,
        schemaDigest: liveSchemaDigest,
        pendingMigrations,
      };
    },
    now: options.now,
  });
  return result;
}
