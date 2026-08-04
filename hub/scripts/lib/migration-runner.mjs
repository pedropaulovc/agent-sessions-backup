import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadAndValidateManifest,
  migrationDigest,
  validateHistoricalBaseline,
  verifySignedCanonicalPayload,
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
  } else if (target === 'preview' || target === 'production') {
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

async function validateBaseline(options, manifest, digest) {
  const history = JSON.parse(await readFile(options.historyPath ?? defaultHistoryPath, 'utf8'));
  validateHistoricalBaseline(history, manifest);
  if (options.target !== 'production') return null;
  if (!options.baselinePath || !options.baselinePublicKey) {
    throw new Error('production requires a separately signed, human-approved historical baseline');
  }
  const envelope = JSON.parse(await readFile(options.baselinePath, 'utf8'));
  const baseline = verifySignedCanonicalPayload(envelope, options.baselinePublicKey, 'production schema baseline');
  if (baseline.kind !== 'production-schema-baseline'
      || baseline.approved !== true
      || baseline.throughSequence !== manifest.ledgerStartsAt - 1
      || baseline.migrationDigest !== digest
      || !DIGEST.test(baseline.schemaDigest ?? '')
      || typeof baseline.approvedBy !== 'string'
      || typeof baseline.approvedAt !== 'string') {
    throw new Error('production historical baseline is incomplete or not explicitly human-approved');
  }
  return baseline;
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
  const productionBaseline = await validateBaseline(options, manifest, digest);
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
      await client.apply();
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
      assertAppliedManifest(manifest, applied);
      const ledger = await client.query(`
        SELECT sequence, filename, sha256 FROM migration_checksum_ledger ORDER BY sequence
      `);
      assertLedger(manifest, ledger);
      const snapshot = await remoteSchemaSnapshot(client);
      const liveSchemaDigest = schemaDigest(snapshot);
      if (productionBaseline && productionBaseline.schemaDigest !== liveSchemaDigest) {
        throw new Error('production schema does not match the signed human-approved baseline');
      }
      return {
        migrationDigest: digest,
        schemaDigest: liveSchemaDigest,
        pendingMigrations: 0,
      };
    },
    now: options.now,
  });
  return result;
}
