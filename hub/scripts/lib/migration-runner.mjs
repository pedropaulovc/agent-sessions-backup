import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalJson,
  loadAndValidateManifest,
  migrationDigest,
  sha256,
  validateHistoricalBaseline,
  verifySignedReleaseManifest,
} from './migration-manifest.mjs';
import { runJournaledMigration } from './migration-journal.mjs';
import { normalizeSchemaSnapshot, schemaDigest } from './schema-digest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const hubRoot = path.resolve(here, '../..');
const defaultMigrationsDir = path.join(hubRoot, 'migrations');
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
      else {
        let cause;
        if (code === 1 && args.includes('--json')) {
          // Keep Wrangler's native API error separate from the diagnostic wrapper.
          // Warnings may precede the JSON envelope; malformed output still fails closed.
          for (const output of [stderr, stdout]) {
            try {
              cause = JSON.parse(output.slice(output.indexOf('{')))?.error;
              if (cause) break;
            } catch {}
          }
        }
        const error = new Error(`Wrangler exited with ${code ?? signal}`, { cause });
        error.stdout = stdout;
        error.stderr = stderr;
        error.exitCode = code;
        error.signal = signal;
        reject(error);
      }
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

// Do not print arbitrary subprocess output: Wrangler logs can contain HTTP headers,
// SQL values or credentials. Retain both original streams on the internal error,
// and expose only fingerprints and a deliberately narrow vocabulary of failures.
export function migrationFailureDiagnostic(error) {
  const result = { phase: error.phase ?? 'validation', operation: error.operation ?? 'validate' };
  if (error.sqlDigest) result.sqlDigest = error.sqlDigest;
  const signals = new Set();
  for (const stream of ['stdout', 'stderr']) {
    if (typeof error[stream] !== 'string') continue;
    const text = error[stream];
    result[stream] = { bytes: Buffer.byteLength(text), sha256: sha256(text) };
    if (stream === 'stdout' && Array.isArray(error.migrationNames)) {
      const migrations = [];
      for (const line of text.split('\n')) {
        const cells = line.split(/[│|]/).map((cell) => cell.trim());
        const filename = error.migrationNames.find((name) => cells.includes(name));
        if (!filename) continue;
        const status = cells.find((cell) => ['✅', '❌', '🕒', 'applied', 'pending', 'failed'].includes(cell));
        migrations.push({ filename, ...(status ? { status } : {}) });
      }
      if (migrations.length) result[stream].migrations = migrations;
    }
    for (const match of text.matchAll(/\[code:\s*\d+\]|no such (?:table|column): [a-zA-Z_][a-zA-Z_0-9]*|fetch failed|ECONNRESET|socket|other side closed|D1 DB storage operation exceeded timeout which caused object to be reset/g)) {
      signals.add(match[0]);
    }
  }
  if (error.message === 'Wrangler D1 response contains no result rows') signals.add(error.message);
  for (const category of [
    'requires independent policy evidence',
    'initial 0001 baseline with ledgerStartsAt=1',
    'no manifest or independent policy evidence',
    'immutable base migration changed',
    'cannot fetch migration base',
    'migration database ID does not match binding',
    'must identify exactly one configured binding and database ID',
    'migration directory does not match binding',
    'require an explicit persistTo directory',
    'require a trusted generated config',
    'unknown migration target',
  ]) {
    if (error.message?.includes(category)) signals.add(category);
  }
  if (Number.isInteger(error.exitCode)) result.exitCode = error.exitCode;
  if (signals.size) result.signals = [...signals];
  return result;
}

async function migrationOperation(phase, operation, sql, action) {
  try {
    return await action();
  } catch (error) {
    error.phase ??= phase;
    error.operation ??= operation;
    if (sql) error.sqlDigest ??= sha256(sql);
    if (typeof error.stdout === 'string' || typeof error.stderr === 'string') {
      error.message = `Migration operation failed: ${JSON.stringify(migrationFailureDiagnostic(error))}`;
    }
    throw error;
  }
}

function wranglerClient(options) {
  const runProcess = options.runProcess ?? defaultRunProcess;
  const common = targetArguments({
    ...options,
    config: options.config ?? (['local', 'e2e'].includes(options.target) ? path.join(hubRoot, 'wrangler.jsonc') : undefined),
  });
  const database = options.database ?? 'DB';
  const run = async (args) => await runProcess(args);
  let phase = 'inspection';
  return {
    setPhase(value) { phase = value; },
    async apply() {
      try {
        return await migrationOperation(phase, 'canonical-wrangler-apply', null,
          () => run(['d1', 'migrations', 'apply', database, ...common]));
      } catch (error) {
        error.migrationNames = options.trustedMigrationNames;
        error.message = `Migration operation failed: ${JSON.stringify(migrationFailureDiagnostic(error))}`;
        throw error;
      }
    },
    async query(sql) {
      return await migrationOperation(phase, 'd1-query', sql, async () => {
        const { stdout } = await run(['d1', 'execute', database, ...common, '--command', sql, '--json', '--yes']);
        const rows = rowsFromWrangler(parseWranglerJson(stdout));
        if (!rows) throw new Error('Wrangler D1 response contains no result rows');
        return rows;
      });
    },
  };
}

export async function hasLocalLegacyBlocks(options) {
  if (options?.target !== 'local') throw new Error('legacy local-state inspection requires target local');
  const client = wranglerClient(options);
  const tables = await client.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'blocks'");
  if (tables.length === 0) return false;
  const rows = await client.query('SELECT EXISTS(SELECT 1 FROM blocks LIMIT 1) AS has_blocks');
  return Number(rows[0]?.has_blocks) === 1;
}

function isMissingMigrationTable(error) {
  const native = error?.cause;
  return native?.name === 'APIError' && native.kind === 'error' && native.code === 7500
    && typeof native.text === 'string'
    && /^A request to the Cloudflare API \(\/accounts\/[^/]+\/d1\/database\/[^/]+\/query\) failed\.$/.test(native.text)
    && Array.isArray(native.notes) && native.notes.length === 1
    && native.notes[0]?.text === 'no such table: d1_migrations: SQLITE_ERROR [code: 7500]';
}

async function readAppliedNames(client, phase = 'installed') {
  try {
    const rows = await client.query('SELECT name FROM d1_migrations ORDER BY id');
    return rows.map((row) => row.name);
  } catch (error) {
    // Only an all-ledger schema's pre-apply guard may see no ledger. Wrangler owns
    // initialization; historical schemas and every installed-state read stay strict.
    if (phase === 'pre-apply' && isMissingMigrationTable(error)) return [];
    throw error;
  }
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

export async function migrationDatabaseIdentity(options = {}) {
  if (['local', 'e2e'].includes(options.target) && !options.persistTo) {
    throw new Error(`${options.target} migrations require an explicit persistTo directory`);
  }
  const configPath = path.resolve(options.config ?? path.join(hubRoot, 'wrangler.jsonc'));
  const { experimental_readRawConfig } = await import('wrangler');
  const { rawConfig } = experimental_readRawConfig({ config: configPath }, { redirect: false });
  const selector = options.database ?? 'DB';
  const matches = (rawConfig.d1_databases ?? []).filter((database) =>
    [database.binding, database.database_name, database.database_id].includes(selector));
  if (matches.length !== 1 || !matches[0].binding || !matches[0].database_id) {
    throw new Error(`migration database ${selector} must identify exactly one configured binding and database ID`);
  }
  const database = matches[0];
  if (options.databaseId !== undefined && options.databaseId !== database.database_id) {
    throw new Error(`migration database ID does not match binding ${database.binding}`);
  }
  const configuredMigrationsDir = path.resolve(path.dirname(configPath), database.migrations_dir ?? 'migrations');
  const migrationsDir = path.resolve(options.migrationsDir ?? defaultMigrationsDir);
  if (migrationsDir !== configuredMigrationsDir) {
    throw new Error(`migration directory does not match binding ${database.binding}: ${configuredMigrationsDir}`);
  }
  return {
    databaseBinding: database.binding,
    databaseId: database.database_id,
    ...(['local', 'e2e'].includes(options.target) ? { persistTo: path.resolve(options.persistTo) } : {}),
  };
}

async function validateHistory(options, manifest) {
  // The trust anchor for production migrations is the protected main branch: whatever
  // manifest lands there deploys. The in-repo historical baseline stays validated for
  // structure (it names the pre-ledger history, incl. the 0019 divergence), but no
  // separately signed human-approved envelope is required — that ritual re-blocked
  // every migration behind a manual re-approval and was retired 2026-08-13.
  if (manifest.ledgerStartsAt === 1) return; // Fresh schema: every migration is checksum-verified.
  const migrationsDir = options.migrationsDir ?? defaultMigrationsDir;
  const history = JSON.parse(await readFile(options.historyPath ?? path.join(migrationsDir, 'historical-baseline.json'), 'utf8'));
  validateHistoricalBaseline(history, manifest);
}

export function migrationDeploymentIdentity({ target, stateName, artifactDigest, migrationDigest: digest, databaseBinding, databaseId, persistTo }) {
  if (!DIGEST.test(artifactDigest ?? '') || !DIGEST.test(digest ?? '')) {
    throw new Error('local migration identity requires artifact and migration SHA-256 digests');
  }
  if (!['local', 'e2e'].includes(target) || typeof stateName !== 'string' || !stateName) {
    throw new Error('invalid local migration identity');
  }
  if (typeof databaseBinding !== 'string' || !databaseBinding || typeof databaseId !== 'string' || !databaseId || !persistTo) {
    throw new Error('local migration identity requires a database binding, database ID, and persistence directory');
  }
  const databaseDigest = sha256(`${canonicalJson({ stateName, databaseBinding, databaseId, persistTo: path.resolve(persistTo) })}\n`);
  return {
    journalName: `${databaseBinding}-${databaseDigest}-${artifactDigest}-${digest}.json`,
    deploymentId: `${target}:${databaseDigest}:${artifactDigest}:${digest}`,
  };
}

export async function resolveMigrationDigest(options = {}) {
  const migrationsDir = options.migrationsDir ?? defaultMigrationsDir;
  const { digest } = await loadAndValidateManifest({
    migrationsDir,
    manifestPath: options.manifestPath ?? path.join(migrationsDir, 'manifest.json'),
    baseManifestPath: options.baseManifestPath ?? path.join(migrationsDir, 'source-baseline.json'),
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

// Fixed metadata reads only: never open a journal, apply, or initialize a ledger.
export async function inspectMigrations(options = {}) {
  const snapshot = { formatVersion: 1, status: 'failed', identity: null, sections: {}, errors: [] };
  let client;
  try {
    const migrationsDir = options.migrationsDir ?? defaultMigrationsDir;
    const { manifest, digest } = await loadAndValidateManifest({
      migrationsDir,
      manifestPath: options.manifestPath ?? path.join(migrationsDir, 'manifest.json'),
      baseManifestPath: options.baseManifestPath ?? path.join(migrationsDir, 'source-baseline.json'),
    });
    await validateHistory(options, manifest);
    snapshot.identity = {
      target: options.target, ...await migrationDatabaseIdentity(options), migrationDigest: digest,
    };
    client = wranglerClient(options);
  } catch (error) {
    snapshot.errors.push(migrationFailureDiagnostic(error));
    return snapshot;
  }
  const capture = async (name, action) => {
    try {
      snapshot.sections[name] = await action();
    } catch (error) {
      error.operation = `inspect-${name}`;
      snapshot.sections[name] = { status: 'unavailable' };
      snapshot.errors.push(migrationFailureDiagnostic(error));
    }
  };
  const tableExists = async (name) => {
    const rows = await client.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${sqlLiteral(name)}`);
    return rows.length > 0;
  };
  await capture('schema', async () => {
    const objects = await client.query('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name');
    return {
      status: 'complete',
      objects: objects.map(({ type, name, tbl_name, sql }) => ({
        type, name, parent: tbl_name, definitionSha256: sql == null ? null : sha256(sql),
      })),
    };
  });
  await capture('appliedMigrations', async () => {
    if (!await tableExists('d1_migrations')) return { status: 'missing' };
    return { status: 'complete', names: await readAppliedNames(client) };
  });
  await capture('checksumLedger', async () => {
    if (!await tableExists('migration_checksum_ledger')) return { status: 'missing' };
    const rows = await client.query(`
      SELECT sequence, filename, sha256, artifact_sha256, deployment_id, recorded_at
        FROM migration_checksum_ledger ORDER BY sequence
    `);
    return { status: 'complete', rows };
  });
  await capture('legacyBlocks', async () => {
    if (!await tableExists('blocks')) return { status: 'missing' };
    const rows = await client.query('SELECT EXISTS(SELECT 1 FROM blocks LIMIT 1) AS has_blocks');
    if (rows.length !== 1 || ![0, 1].includes(Number(rows[0].has_blocks))) {
      throw new Error('invalid block existence result');
    }
    return { status: Number(rows[0].has_blocks) === 1 ? 'nonempty' : 'empty' };
  });
  snapshot.status = snapshot.errors.length === 0 ? 'complete'
    : Object.values(snapshot.sections).some((section) => section.status !== 'unavailable') ? 'partial' : 'failed';
  return snapshot;
}

export async function writeMigrationInspection(filePath, snapshot) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, filePath);
    let directoryHandle;
    try {
      directoryHandle = await open(directory, 'r');
      await directoryHandle.sync();
    } catch (error) {
      if (!['EINVAL', 'EPERM', 'EISDIR'].includes(error.code)) throw error;
    } finally {
      await directoryHandle?.close();
    }
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => {});
  }
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
    baseManifestPath: options.baseManifestPath ?? path.join(migrationsDir, 'source-baseline.json'),
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
  const databaseIdentity = await migrationDatabaseIdentity(options);
  const client = wranglerClient({ ...options, trustedMigrationNames: manifest.migrations.map(({ filename }) => filename) });
  const identity = {
    target: options.target,
    deploymentId: options.deploymentId,
    artifactDigest: options.artifactDigest,
    migrationDigest: digest,
    ...databaseIdentity,
  };
  const { result } = await runJournaledMigration({
    journalPath: options.journalPath,
    identity,
    apply: async () => await migrationOperation('apply', 'apply-and-prefix-guard', null, async () => {
      client.setPhase('apply');
      if (options.target === 'production') {
        const phase = manifest.ledgerStartsAt === 1 ? 'pre-apply' : 'installed';
        assertAppliedManifestPrefix(manifest, await readAppliedNames(client, phase));
      }
      await client.apply();
    }),
    recordChecksums: async () => await migrationOperation('checksums', 'record-and-validate-checksums', null, async () => {
      client.setPhase('checksums');
      assertAppliedManifest(manifest, await readAppliedNames(client));
      await recordLedger(client, manifest, options.artifactDigest, options.deploymentId);
      const ledger = await client.query(`
        SELECT sequence, filename, sha256 FROM migration_checksum_ledger ORDER BY sequence
      `);
      assertLedger(manifest, ledger);
    }),
    verify: async () => await migrationOperation('verify', 'verify-installed-state', null, async () => {
      client.setPhase('verify');
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
        ...databaseIdentity,
        migrationDigest: digest,
        schemaDigest: liveSchemaDigest,
        pendingMigrations,
      };
    }),
    now: options.now,
  });
  return result;
}
