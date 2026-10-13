import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import {
  assertImmutableBase,
  assertManifestMatches,
  buildMigrationManifest,
  canonicalJson,
  canonicalMigrationBytes,
  loadAndValidateManifest,
  migrationDigest,
  validateHistoricalBaseline,
  validateManifestShape,
  verifySignedReleaseManifest,
} from '../scripts/lib/migration-manifest.mjs';
import { writeLocalConfig } from '../scripts/lib/local-config.mjs';
import { fixtureModelPriceSql } from '../scripts/lib/dev-seed.mjs';
import {
  AmbiguousJournalError,
  openMigrationJournal,
  runJournaledMigration,
} from '../scripts/lib/migration-journal.mjs';
import { schemaDigest, schemaSnapshotFromDatabase } from '../scripts/lib/schema-digest.mjs';

const hubRoot = path.resolve(import.meta.dirname, '..');
const migrationsDir = path.join(hubRoot, 'migrations');
const manifestPath = path.join(migrationsDir, 'manifest.json');
const sourceBaselinePath = path.join(migrationsDir, 'source-baseline.json');
const historyPath = path.join(migrationsDir, 'historical-baseline.json');
const indexMigrationsDir = path.join(hubRoot, 'migrations-index');
const artifactDigest = 'a'.repeat(64);
const migrationRunnerUrl = process.env.MIGRATION_RUNNER_PATH
  ? pathToFileURL(path.resolve(process.env.MIGRATION_RUNNER_PATH)).href
  : new URL('../scripts/lib/migration-runner.mjs', import.meta.url).href;
const { hasLocalLegacyBlocks, migrationDatabaseIdentity, resolveMigrationDigest, runMigrations } = await import(migrationRunnerUrl);

async function loadFixture(directory = migrationsDir) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const sql = new Map();
  for (const migration of manifest.migrations) {
    sql.set(migration.filename, await readFile(path.join(directory, migration.filename), 'utf8'));
  }
  return { manifest, sql };
}

function createDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return database;
}

function applyPending(database, fixture, through = Infinity, transformSql = (entry, sql) => sql) {
  const applied = new Set(database.prepare('SELECT name FROM d1_migrations').all().map((row) => row.name));
  let count = 0;
  for (const migration of fixture.manifest.migrations) {
    if (migration.sequence > through || applied.has(migration.filename)) continue;
    database.exec(transformSql(migration, fixture.sql.get(migration.filename)));
    database.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(migration.filename);
    if (migration.sequence >= fixture.manifest.ledgerStartsAt) {
      database.prepare(`
        INSERT INTO migration_checksum_ledger
          (sequence, filename, sha256, artifact_sha256, deployment_id, recorded_at)
        VALUES (?, ?, ?, ?, ?, '2026-01-01T00:00:00Z')
      `).run(migration.sequence, migration.filename, migration.sha256, artifactDigest, 'migration-test');
    }
    count += 1;
  }
  return count;
}

function representativeUsage(database) {
  database.prepare(`
    INSERT INTO usage
      (session_id, turn_index, model, input_tokens, output_tokens, usd, priced_version)
    VALUES ('representative-session', 1, 'test-model', 100, 20, 0.01, 0)
  `).run();
}

function createWranglerProcess(
  fixture,
  snapshot,
  initialAppliedCount = fixture.manifest.migrations.length,
  beforeSnapshot = snapshot,
) {
  const state = { applyCalls: 0, appliedReads: 0, appliedCount: initialAppliedCount };
  const applied = fixture.manifest.migrations.map(({ filename }) => ({ name: filename }));
  const ledger = fixture.manifest.migrations
    .filter((migration) => migration.sequence >= fixture.manifest.ledgerStartsAt)
    .map(({ sequence, filename, sha256: checksum }) => ({ sequence, filename, sha256: checksum }));
  return {
    state,
    runProcess: async (args) => {
      if (args[0] === 'd1' && args[1] === 'migrations' && args[2] === 'apply') {
        state.applyCalls += 1;
        state.appliedCount = applied.length;
        return { stdout: '', stderr: '' };
      }
      const commandIndex = args.indexOf('--command');
      assert.notEqual(commandIndex, -1, `unexpected Wrangler invocation: ${args.join(' ')}`);
      const sql = args[commandIndex + 1];
      const activeSnapshot = state.applyCalls === 0 ? beforeSnapshot : snapshot;
      let rows;
      if (sql.includes('SELECT name FROM d1_migrations')) {
        state.appliedReads += 1;
        rows = applied.slice(0, state.appliedCount);
      } else if (sql.includes('INSERT OR IGNORE INTO migration_checksum_ledger')) {
        const sequence = Number(/VALUES\s*\(\s*(\d+)/s.exec(sql)?.[1]);
        rows = [{ sequence }];
      } else if (sql.includes('SELECT sequence, filename, sha256 FROM migration_checksum_ledger')) {
        rows = ledger;
      } else if (sql.includes('SELECT type, name, tbl_name, sql FROM sqlite_master')) {
        rows = activeSnapshot.objects;
      } else if (sql.includes('pragma_table_xinfo')) {
        rows = activeSnapshot.tableColumns;
      } else if (sql.includes('pragma_index_list')) {
        rows = activeSnapshot.indexes;
      } else if (sql.includes('pragma_foreign_key_list')) {
        rows = activeSnapshot.foreignKeys;
      } else {
        assert.fail(`unexpected migration verification query: ${sql}`);
      }
      return { stdout: JSON.stringify([{ results: rows }]), stderr: '' };
    },
  };
}

async function createRemoteMigrationFixture(context, { fault, migrationDirectory = indexMigrationsDir } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-remote-migration-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const database = new DatabaseSync(':memory:');
  context.after(() => database.close());
  const { unstable_splitSqlQuery: splitSqlQuery } = await import('wrangler');
  const accountId = '1'.repeat(32);
  const databaseId = 'ac2e6cc9-6ef5-4943-ac40-b7076848bd05';
  const binding = migrationDirectory === migrationsDir ? 'DB' : 'IDX00';
  const configPath = path.join(directory, 'wrangler.json');
  const journalPath = path.join(directory, 'migration.json');
  const runnerPath = path.join(directory, 'run.mjs');
  await writeFile(configPath, JSON.stringify({
    name: 'remote-migration-test',
    account_id: accountId,
    compatibility_date: '2026-01-01',
    d1_databases: [{
      binding, database_name: `remote-migration-test-${binding.toLowerCase()}`, database_id: databaseId,
      migrations_dir: migrationDirectory,
    }],
  }));
  await writeFile(runnerPath, `
    import { runMigrations } from ${JSON.stringify(migrationRunnerUrl)};
    try {
      console.log(JSON.stringify(await runMigrations(JSON.parse(process.argv[2]))));
    } catch (error) {
      console.error(error.stack ?? error.message);
      process.exitCode = 1;
    }
  `);
  const requests = [];
  const server = createServer(async (request, response) => {
    const event = { method: request.method, path: request.url };
    requests.push(event);
    const send = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, `/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`);
      assert.equal(request.headers.authorization, 'Bearer synthetic-migration-test-token');
      let body = '';
      for await (const chunk of request) body += chunk;
      const { sql } = JSON.parse(body);
      event.sql = sql;
      const appliedRead = sql === 'SELECT name FROM d1_migrations ORDER BY id';
      if (appliedRead && fault === 'auth') {
        event.failure = 'auth';
        // Even ledger-like diagnostic text cannot override a native permission code.
        send(403, { success: false, errors: [{ code: 10000, message: 'no such table: d1_migrations: SQLITE_ERROR' }] });
        return;
      }
      if (appliedRead && fault === 'network') {
        event.failure = 'network';
        request.socket.destroy();
        return;
      }
      if (appliedRead && fault === 'malformed') {
        event.failure = 'malformed';
        send(200, { success: true, result: [{ success: true, results: {} }] });
        return;
      }
      const actualSql = appliedRead && fault === 'unrelated-sql'
        ? 'SELECT name FROM unrelated_missing_table ORDER BY id' : sql;
      database.exec('BEGIN');
      let results;
      try {
        results = splitSqlQuery(actualSql).map((statementSql) => {
          const statement = database.prepare(statementSql);
          const rows = statement.columns().length ? statement.all().map((row) => ({ ...row }))
            : (statement.run(), []);
          return { success: true, results: rows, meta: { duration: 0 } };
        });
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      event.success = true;
      if (fault === 'missing-after-apply' && /INSERT INTO\s+"d1_migrations"/i.test(sql)) {
        database.exec('DROP TABLE d1_migrations');
      }
      send(200, { success: true, result: results, errors: [], messages: [] });
    } catch (error) {
      event.failure = error.message;
      // Wrangler converts this real SQLite REST rejection into the captured native
      // JSON APIError (code 7500, notes[].text), exercising the actual process boundary.
      send(400, { success: false, errors: [{ code: 7500, message: `${error.message}: SQLITE_ERROR` }] });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const apiBaseUrl = `http://127.0.0.1:${server.address().port}/client/v4`;
  const options = {
    target: 'production', config: configPath, database: binding, databaseId,
    journalPath, artifactDigest, deploymentId: `production:remote-migration-test:${binding}`,
    migrationsDir: migrationDirectory,
    baseManifestPath: path.join(migrationDirectory, 'source-baseline.json'),
  };
  const run = async () => await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runnerPath, JSON.stringify(options)], {
      cwd: hubRoot,
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        CI: 'true',
        CLOUDFLARE_ACCOUNT_ID: accountId,
        CLOUDFLARE_API_TOKEN: 'synthetic-migration-test-token',
        CLOUDFLARE_API_KEY: '',
        CLOUDFLARE_EMAIL: '',
        CLOUDFLARE_API_BASE_URL: apiBaseUrl,
        CF_API_BASE_URL: apiBaseUrl,
        WRANGLER_SEND_METRICS: 'false',
        WRANGLER_LOG_PATH: path.join(directory, 'wrangler.log'),
        XDG_CONFIG_HOME: directory,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  return { database, requests, options, run };
}

test('the checked-in manifest exactly matches canonical migration names, order, and bytes', async () => {
  const { manifest, digest } = await loadAndValidateManifest({
    migrationsDir,
    manifestPath,
    baseManifestPath: sourceBaselinePath,
  });
  assert.equal(digest, migrationDigest(manifest));
  assert.deepEqual(manifest.reservedSequences, [4]);
  assert.equal(manifest.ledgerStartsAt, 21);
});

test('manifest policy comes only from independent base evidence', async (context) => {
  await assert.rejects(
    loadAndValidateManifest({ migrationsDir, manifestPath }),
    /requires independent policy evidence/,
  );
  const cleanEnv = { ...process.env };
  delete cleanEnv.MIGRATION_BASE_MANIFEST;
  delete cleanEnv.MIGRATION_BASE_REF;
  delete cleanEnv.GITHUB_EVENT_PATH;
  for (const command of ['check', 'check-base']) {
    const bareCheck = spawnSync(process.execPath, [path.join(hubRoot, 'scripts', 'migrations.mjs'), command], {
      cwd: hubRoot,
      encoding: 'utf8',
      env: cleanEnv,
    });
    assert.notEqual(bareCheck.status, 0);
    assert.match(bareCheck.stderr, /requires independent policy evidence/);
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-policy-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await cp(migrationsDir, directory, { recursive: true });
  const candidate = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  candidate.ledgerStartsAt += 1;
  await writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(candidate, null, 2)}\n`);
  await assert.rejects(
    loadAndValidateManifest({
      migrationsDir: directory,
      manifestPath: path.join(directory, 'manifest.json'),
      baseManifestPath: sourceBaselinePath,
    }),
    /manifest metadata mismatch/,
  );
});

test('manifest validation rejects edited, reordered, duplicate, and non-appended migrations', async (context) => {
  const fixture = await loadFixture();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-migrations-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await cp(migrationsDir, directory, { recursive: true });
  await writeFile(path.join(directory, '0002_blocks_on_main_path.sql'), `${fixture.sql.get('0002_blocks_on_main_path.sql')}\n-- edited\n`);
  const edited = await buildMigrationManifest(directory, fixture.manifest);
  assert.throws(() => assertManifestMatches(fixture.manifest, edited), /manifest mismatch/);
  assert.deepEqual(
    canonicalMigrationBytes("CREATE TABLE example (id INTEGER);\r\n"),
    canonicalMigrationBytes("CREATE TABLE example (id INTEGER);\n"),
  );
  assert.throws(
    () => canonicalMigrationBytes("CREATE TABLE example (value TEXT DEFAULT 'line one\r\nline two');"),
    /platform-dependent CRLF/,
  );

  const reordered = structuredClone(fixture.manifest);
  [reordered.migrations[0], reordered.migrations[1]] = [reordered.migrations[1], reordered.migrations[0]];
  assert.throws(() => validateManifestShape(reordered), /not strictly ordered/);

  const duplicate = structuredClone(fixture.manifest);
  duplicate.migrations.splice(1, 0, { ...duplicate.migrations[0], filename: '0001_duplicate.sql' });
  assert.throws(() => validateManifestShape(duplicate), /duplicate migration sequence/);

  const changedBase = structuredClone(fixture.manifest);
  changedBase.migrations[2].sha256 = '0'.repeat(64);
  assert.throws(() => assertImmutableBase(fixture.manifest, changedBase), /immutable base migration changed/);
  const changedPolicy = structuredClone(fixture.manifest);
  changedPolicy.ledgerStartsAt += 1;
  assert.throws(() => assertImmutableBase(fixture.manifest, changedPolicy), /immutable migration policy/);

  const insertedBeforeBaseEnd = structuredClone(fixture.manifest);
  insertedBeforeBaseEnd.migrations.splice(-1, 0, {
    sequence: 20,
    filename: '0020_reused.sql',
    sha256: '1'.repeat(64),
  });
  assert.throws(() => validateManifestShape(insertedBeforeBaseEnd), /duplicate migration sequence/);
});

test('clean install and base upgrade converge on the same normalized schema and ledger', async () => {
  const fixture = await loadFixture();
  const clean = createDatabase();
  const upgraded = createDatabase();
  try {
    assert.equal(applyPending(clean, fixture), fixture.manifest.migrations.length);
    assert.equal(applyPending(clean, fixture), 0, 'second apply must have no pending migrations');
    representativeUsage(clean);

    const baseMigrationCount = fixture.manifest.migrations.filter((migration) => migration.sequence <= 20).length;
    assert.equal(applyPending(upgraded, fixture, 20), baseMigrationCount);
    representativeUsage(upgraded);
    assert.equal(applyPending(upgraded, fixture), fixture.manifest.migrations.length - baseMigrationCount);
    assert.equal(applyPending(upgraded, fixture), 0, 'second upgrade apply must have no pending migrations');

    const cleanSchema = schemaSnapshotFromDatabase(clean);
    const upgradedSchema = schemaSnapshotFromDatabase(upgraded);
    assert.deepEqual(upgradedSchema, cleanSchema);
    assert.equal(schemaDigest(upgradedSchema), schemaDigest(cleanSchema));
    assert.deepEqual(
      clean.prepare("SELECT name FROM sqlite_master WHERE name IN ('blocks', 'blocks_fts')").all(),
      [],
      'the final main schema must contain metadata only, never a legacy block fallback',
    );
    assert.deepEqual(
      upgraded.prepare('SELECT sequence, filename, sha256 FROM migration_checksum_ledger ORDER BY sequence').all(),
      clean.prepare('SELECT sequence, filename, sha256 FROM migration_checksum_ledger ORDER BY sequence').all(),
    );
    assert.equal(upgraded.prepare("SELECT priced_version FROM usage WHERE session_id = 'representative-session'").get().priced_version, 0);
    assert.throws(() => clean.prepare(`
      INSERT INTO migration_checksum_ledger
        (sequence, filename, sha256, artifact_sha256, deployment_id, recorded_at)
      VALUES (9999, '9999_invalid.sql', 'not-a-hash', ?, 'migration-test', '2026-01-01T00:00:00Z')
    `).run(artifactDigest), /constraint/i);
  } finally {
    clean.close();
    upgraded.close();
  }
});

test('OMP QA batch cleanup retains only the newest 5,000 reports', async () => {
  const fixture = await loadFixture();
  const database = createDatabase();
  try {
    applyPending(database, fixture);
    const insert = database.prepare(`
      INSERT INTO omp_qa_reports
        (install_id, entry_id, dedup_key, agent_name, agent_version, platform, arch, model, omp_version, tool, report)
      VALUES ('cap-test', ?, ?, 'omp', '1', 'linux', 'x64', 'model', '1', 'read', 'report')
    `);
    database.exec('BEGIN');
    for (let entryId = 1; entryId <= 5001; entryId += 1) {
      insert.run(entryId, `cap-${entryId}`);
    }
    database.exec('COMMIT');
    database.exec(`
      DELETE FROM omp_qa_reports
       WHERE id IN (
         SELECT id
           FROM omp_qa_reports
          ORDER BY received_at DESC, id DESC
          LIMIT -1 OFFSET 5000
       )
    `);

    const retained = database.prepare(
      `SELECT COUNT(*) AS count, MIN(entry_id) AS oldest, MAX(entry_id) AS newest
         FROM omp_qa_reports WHERE install_id = 'cap-test'`,
    ).get();
    assert.equal(retained.count, 5000);
    assert.equal(retained.oldest, 2);
    assert.equal(retained.newest, 5001);
  } finally {
    database.close();
  }
});

test('schema digest preserves semantically significant whitespace inside SQL literals', () => {
  const oneSpace = new DatabaseSync(':memory:');
  const twoSpaces = new DatabaseSync(':memory:');
  try {
    oneSpace.exec("CREATE TABLE example (value TEXT DEFAULT 'one space')");
    twoSpaces.exec("CREATE TABLE example (value TEXT DEFAULT 'one  space')");
    assert.notEqual(
      schemaDigest(schemaSnapshotFromDatabase(oneSpace)),
      schemaDigest(schemaSnapshotFromDatabase(twoSpaces)),
    );
  } finally {
    oneSpace.close();
    twoSpaces.close();
  }
});

test('historical baseline names the 0019 divergence without claiming current bytes were applied', async () => {
  const fixture = await loadFixture();
  const history = JSON.parse(await readFile(historyPath, 'utf8'));
  validateHistoricalBaseline(history, fixture.manifest);
  assert.equal(history.deploymentHistory.status, 'baselined-not-hash-verified');
  assert.equal(history.deploymentHistory.approved, false);
  assert.match(history.knownDivergence.evidenceStatement, /does not assert which 0019 bytes/);
  assert.notEqual(
    history.knownDivergence.priorRepositorySourceRevisions[0].sha256,
    history.knownDivergence.currentSourceSha256,
  );

  const partial = structuredClone(history);
  partial.throughSequence -= 1;
  assert.throws(() => validateHistoricalBaseline(partial, fixture.manifest), /complete pre-ledger range/);
  const editedHistoricalSource = structuredClone(fixture.manifest);
  editedHistoricalSource.migrations[0].sha256 = 'e'.repeat(64);
  assert.throws(
    () => validateHistoricalBaseline(history, editedHistoricalSource),
    /repository source changed from the immutable baseline/,
  );

  const falselyVerified = structuredClone(history);
  falselyVerified.deploymentHistory.status = 'hash-verified';
  assert.throws(() => validateHistoricalBaseline(falselyVerified, fixture.manifest), /must not be inferred/);
});

test('0020 repairs rows created by the historically nullable 0019 source shape', async () => {
  const fixture = await loadFixture();
  const database = createDatabase();
  try {
    applyPending(database, fixture, 19, (entry, sql) => entry.sequence === 19
      ? sql.replace('priced_version INTEGER NOT NULL DEFAULT 0', 'priced_version INTEGER')
      : sql);
    database.prepare("INSERT INTO usage (session_id, turn_index, priced_version) VALUES ('legacy', 1, NULL)").run();
    applyPending(database, fixture, 20);
    assert.equal(database.prepare("SELECT priced_version FROM usage WHERE session_id = 'legacy'").get().priced_version, 0);
  } finally {
    database.close();
  }
});

test('0028 backfills per-session cost from the usage already stored', async () => {
  const fixture = await loadFixture();
  const database = createDatabase();
  try {
    applyPending(database, fixture, 27);
    // Pre-0028 state: an archive ingested and priced months ago. The backfill is the whole reason
    // the migration is more than three ALTERs -- without it every already-indexed session reads as
    // "no usage records" to the viewer, and for a settled archive nothing ever re-ingests or
    // re-prices it to fix that.
    database.exec(`
      INSERT INTO sessions (session_id, harness) VALUES
        ('cost-priced', 'claude-code'), ('cost-mixed', 'claude-code'),
        ('cost-unpriced', 'claude-code'), ('cost-no-usage', 'claude-code');
      INSERT INTO usage (session_id, turn_index, model, usd) VALUES
        ('cost-priced', 1, 'm', 0.25), ('cost-priced', 2, 'm', 0.75),
        ('cost-mixed', 1, 'm', 1.5), ('cost-mixed', 2, 'brand-new-model', NULL),
        ('cost-unpriced', 1, 'brand-new-model', NULL);
    `);
    applyPending(database, fixture, 28);
    const costs = (sessionId) => ({
      ...database
        .prepare('SELECT cost_usd, cost_calls, cost_priced_calls FROM sessions WHERE session_id = ?')
        .get(sessionId),
    });
    assert.deepEqual(costs('cost-priced'), { cost_usd: 1, cost_calls: 2, cost_priced_calls: 2 });
    // A partially priced session keeps all three numbers. The dollar figure is a LOWER BOUND, and
    // the counts are what let the viewer say so instead of presenting it as the total.
    assert.deepEqual(costs('cost-mixed'), { cost_usd: 1.5, cost_calls: 2, cost_priced_calls: 1 });
    // NULL, not 0: a session whose model we could not price did not cost nothing.
    assert.deepEqual(costs('cost-unpriced'), { cost_usd: null, cost_calls: 1, cost_priced_calls: 0 });
    // No usage rows at all -- left at the column defaults, which is what they mean.
    assert.deepEqual(costs('cost-no-usage'), { cost_usd: null, cost_calls: 0, cost_priced_calls: 0 });
  } finally {
    database.close();
  }
});

test('0029 backfills cache basis from the transcript harness and leaves unknown sources unclassified', async () => {
  const fixture = await loadFixture();
  const database = createDatabase();
  try {
    applyPending(database, fixture, 28);
    database.exec(`
      INSERT INTO sessions (session_id, harness) VALUES
        ('basis-codex', 'codex'),
        ('basis-omp', 'omp'),
        ('basis-claude', 'claude-code'),
        ('basis-unknown', 'future-harness');
      INSERT INTO usage (session_id, turn_index) VALUES
        ('basis-codex', 1),
        ('basis-omp', 1),
        ('basis-claude', 1),
        ('basis-unknown', 1);
    `);

    applyPending(database, fixture, 29);
    const rows = database
      .prepare('SELECT session_id, cache_basis FROM usage ORDER BY session_id')
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(rows, [
      { session_id: 'basis-claude', cache_basis: 'disjoint' },
      { session_id: 'basis-codex', cache_basis: 'subset' },
      { session_id: 'basis-omp', cache_basis: 'disjoint' },
      { session_id: 'basis-unknown', cache_basis: null },
    ]);
    assert.throws(
      () => database.prepare("UPDATE usage SET cache_basis = 'guessed' WHERE session_id = 'basis-unknown'").run(),
      /constraint/i,
    );
  } finally {
    database.close();
  }
});

test('0030 removes provider cache accounting without changing the remaining price catalog row', async () => {
  const fixture = await loadFixture();
  const database = createDatabase();
  try {
    applyPending(database, fixture, 29);
    database.prepare(`
      INSERT INTO model_prices
        (model, effective_from, litellm_key, provider, input_cost, output_cost, cache_read_cost,
         cache_write_5m_cost, cache_write_1h_cost, input_cost_batch, output_cost_batch,
         max_input_tokens, max_output_tokens, cache_accounting, source, fetched_at)
      VALUES
        ('preserved-model', '2026-09-01', 'upstream-model', 'openai', 1, 2, 3, 4, 5, 6, 7,
         8000, 2000, 'subset', 'test', '2026-09-15T00:00:00Z')
    `).run();

    applyPending(database, fixture, 30);
    const columns = database.prepare("SELECT name FROM pragma_table_info('model_prices') ORDER BY cid").all();
    assert.equal(columns.some((column) => column.name === 'cache_accounting'), false);
    assert.deepEqual(
      { ...database.prepare("SELECT * FROM model_prices WHERE model = 'preserved-model'").get() },
      {
        model: 'preserved-model',
        effective_from: '2026-09-01',
        litellm_key: 'upstream-model',
        provider: 'openai',
        input_cost: 1,
        output_cost: 2,
        cache_read_cost: 3,
        cache_write_5m_cost: 4,
        cache_write_1h_cost: 5,
        input_cost_batch: 6,
        output_cost_batch: 7,
        max_input_tokens: 8000,
        max_output_tokens: 2000,
        source: 'test',
        fetched_at: '2026-09-15T00:00:00Z',
      },
    );
    assert.deepEqual(
      database
        .prepare("SELECT name FROM pragma_index_list('model_prices') WHERE name = 'model_prices_model'")
        .all()
        .map((row) => ({ ...row })),
      [{ name: 'model_prices_model' }],
    );
  } finally {
    database.close();
  }
});

test('0031 drops only the costs the transcript-basis arithmetic changes', async () => {
  const fixture = await loadFixture();
  const database = createDatabase();
  try {
    applyPending(database, fixture, 30);
    // Pre-0031 state: a corpus priced under PRICING_VERSION 2, where the convention came from the
    // price catalog's provider. `cache_basis` is what 0029 stamped from the transcript source, so
    // an OMP session recording an OpenAI model is exactly the disagreement that mispriced money.
    //
    // `claude-opus-5`'s snapshot was re-fetched on 2026-01-02, which is how an in-place provider
    // correction looks afterwards: the sync writes INSERT OR REPLACE on (model, effective_from),
    // so whatever provider that row held on the 1st is gone.
    database.exec(`
      INSERT INTO model_prices
        (model, effective_from, litellm_key, provider, input_cost, output_cost, cache_read_cost,
         source, fetched_at)
      VALUES
        ('gpt-6-astra', '2026-01-01', 'gpt-6-astra', 'openai', 10, 50, 1, 'test', '2026-01-01T00:00:00Z'),
        ('claude-opus-5', '2026-01-01', 'claude-opus-5', 'anthropic', 15, 75, 1.5, 'test', '2026-01-02T00:00:00Z'),
        -- A LATER snapshot for the same model, fetched long after the January rows were priced. A
        -- rate move is not evidence about a January cost, so its presence must not blank one.
        ('claude-opus-5', '2026-06-01', 'claude-opus-5', 'anthropic', 18, 90, 1.8, 'test', '2026-06-01T00:00:00Z'),
        ('gemini-3-pro', '2026-01-01', 'gemini-3-pro', 'vertex_ai', 2, 10, 0.2, 'test', '2026-01-01T00:00:00Z'),
        -- A March boundary belonging to a DIFFERENT model. priceEpochExpr pools boundaries across
        -- every model, so a claude row timestamped in March is bucketed into this epoch even
        -- though claude has no snapshot here and priceAt resolves it back to the January one.
        ('gemini-3-pro', '2026-03-01', 'gemini-3-pro', 'vertex_ai', 3, 12, 0.3, 'test', '2026-03-01T00:00:00Z');
      INSERT INTO sessions (session_id, harness) VALUES
        ('v2-omp', 'omp'), ('v2-codex', 'codex'), ('v2-claude', 'claude-code'),
        ('v2-unknown', 'future-harness');
      INSERT INTO usage
        (session_id, turn_index, model, cache_basis, input_tokens, output_tokens, cache_read_tokens,
         usd, usd_input, usd_cache_read, priced_version, price_epoch, priced_at)
      VALUES
        -- Priced subset (provider openai) against disjoint counters: the production bug.
        ('v2-omp', 1, 'gpt-6-astra', 'disjoint', 1000, 100, 900, 0.5, 0.4, 0.1, 2, '2026-01-01', '2026-01-03T00:00:00Z'),
        -- Same disagreement, but with no cache reads the two conventions compute the same dollars.
        ('v2-omp', 2, 'gpt-6-astra', 'disjoint', 1000, 100, 0, 0.5, 0.5, NULL, 2, '2026-01-01', '2026-01-03T00:00:00Z'),
        -- An unrecognised provider derives no convention today, and post-0017 it was refused
        -- outright for a row with cache reads. A non-NULL cost here therefore predates 0017, when
        -- the sync stored the fallback 'subset' for exactly this case -- a wrong guess still on
        -- display, which is why 'unknown' has to count as a disagreement.
        ('v2-omp', 5, 'gemini-3-pro', 'disjoint', 1000, 100, 900, 1, 0.9, 0.1, 2, '2026-01-01', '2026-01-03T00:00:00Z'),
        -- The post-0017 shape of the same model: already NULL, nothing to do to it.
        ('v2-omp', 3, 'gemini-3-pro', 'disjoint', 1000, 100, 900, NULL, NULL, NULL, 2, '2026-01-01', '2026-01-03T00:00:00Z'),
        -- Already repriced by v3. Untouched even though its basis disagrees with the catalog --
        -- that disagreement is the whole point of the new arithmetic.
        ('v2-omp', 4, 'gpt-6-astra', 'disjoint', 1000, 100, 900, 2, 1.8, 0.1, 3, '2026-01-01', '2026-01-03T00:00:00Z'),
        -- Catalog and transcript agree (anthropic -> disjoint), and this row was priced AFTER the
        -- January snapshot's last write, so the provider it was priced under is the one still
        -- stored. The June snapshot is fetched later but is not the one that priced this row, so
        -- it must not cost this row its money.
        ('v2-claude', 1, 'claude-opus-5', 'disjoint', 1000, 100, 900, 0.9, 0.5, 0.4, 2, '2026-01-01', '2026-01-03T00:00:00Z'),
        -- Same agreement, but priced BEFORE the January snapshot was rewritten: the provider in
        -- force at pricing time is unrecoverable, so agreement with today's row proves nothing.
        ('v2-claude', 2, 'claude-opus-5', 'disjoint', 1000, 100, 900, 0.7, 0.4, 0.3, 2, '2026-01-01', '2026-01-01T12:00:00Z'),
        -- The same case bucketed into a pooled epoch claude has no snapshot for. priceAt resolves
        -- it back to January, so matching on effective_from = price_epoch would find nothing and
        -- leave the stale cost standing.
        ('v2-claude', 3, 'claude-opus-5', 'disjoint', 1000, 100, 900, 0.6, 0.3, 0.3, 2, '2026-03-01', '2026-01-01T12:00:00Z'),
        -- The sentinel a timestamp-less row gets, which is not a date at all: priced only when
        -- every snapshot agrees, so any of them being rewritten counts.
        ('v2-claude', 4, 'claude-opus-5', 'disjoint', 1000, 100, 900, 0.5, 0.2, 0.3, 2, 'unknown', '2026-01-01T12:00:00Z'),
        -- The sentinel for a row older than every snapshot, which priceAt resolves to the OLDEST.
        ('v2-claude', 5, 'claude-opus-5', 'disjoint', 1000, 100, 900, 0.4, 0.1, 0.3, 2, '0000-00-00', '2026-01-01T12:00:00Z'),
        -- Catalog said subset, transcript says subset: unchanged.
        ('v2-codex', 1, 'gpt-6-astra', 'subset', 1000, 100, 900, 0.3, 0.2, 0.1, 2, '2026-01-01', '2026-01-03T00:00:00Z'),
        -- An unrecognised transcript source. v3 refuses a row with no basis before it looks at a
        -- single token counter, so this one goes even with zero cache reads.
        ('v2-unknown', 1, 'gpt-6-astra', NULL, 1000, 100, 0, 0.4, 0.4, NULL, 2, '2026-01-01', '2026-01-03T00:00:00Z');
    `);
    database.exec(`
      UPDATE sessions
         SET cost_usd = agg.usd, cost_calls = agg.calls, cost_priced_calls = agg.priced_calls
        FROM (SELECT session_id, SUM(usd) AS usd, COUNT(*) AS calls, COUNT(usd) AS priced_calls
                FROM usage GROUP BY session_id) AS agg
       WHERE sessions.session_id = agg.session_id;
    `);

    applyPending(database, fixture, 31);
    const usage = database
      .prepare('SELECT session_id, turn_index, usd, usd_cache_read, priced_version FROM usage ORDER BY session_id, turn_index')
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(usage, [
      { session_id: 'v2-claude', turn_index: 1, usd: 0.9, usd_cache_read: 0.4, priced_version: 2 },
      { session_id: 'v2-claude', turn_index: 2, usd: null, usd_cache_read: null, priced_version: 2 },
      { session_id: 'v2-claude', turn_index: 3, usd: null, usd_cache_read: null, priced_version: 2 },
      { session_id: 'v2-claude', turn_index: 4, usd: null, usd_cache_read: null, priced_version: 2 },
      { session_id: 'v2-claude', turn_index: 5, usd: null, usd_cache_read: null, priced_version: 2 },
      { session_id: 'v2-codex', turn_index: 1, usd: 0.3, usd_cache_read: 0.1, priced_version: 2 },
      // Invalidated: unknown until the pass reprices it, and still due at version 2 rather than
      // reset to 0, which would be indistinguishable from never having been attempted.
      { session_id: 'v2-omp', turn_index: 1, usd: null, usd_cache_read: null, priced_version: 2 },
      { session_id: 'v2-omp', turn_index: 2, usd: 0.5, usd_cache_read: null, priced_version: 2 },
      { session_id: 'v2-omp', turn_index: 3, usd: null, usd_cache_read: null, priced_version: 2 },
      { session_id: 'v2-omp', turn_index: 4, usd: 2, usd_cache_read: 0.1, priced_version: 3 },
      { session_id: 'v2-omp', turn_index: 5, usd: null, usd_cache_read: null, priced_version: 2 },
      { session_id: 'v2-unknown', turn_index: 1, usd: null, usd_cache_read: null, priced_version: 2 },
    ]);

    // The list page reads these columns, not `usage`. A subtotal that still included the dollars
    // just invalidated would report a figure no row holds, at full coverage.
    const costs = database
      .prepare('SELECT session_id, cost_usd, cost_calls, cost_priced_calls FROM sessions ORDER BY session_id')
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(costs, [
      { session_id: 'v2-claude', cost_usd: 0.9, cost_calls: 5, cost_priced_calls: 1 },
      { session_id: 'v2-codex', cost_usd: 0.3, cost_calls: 1, cost_priced_calls: 1 },
      { session_id: 'v2-omp', cost_usd: 2.5, cost_calls: 5, cost_priced_calls: 2 },
      // A session left with no priced row at all reports unknown, not $0.
      { session_id: 'v2-unknown', cost_usd: null, cost_calls: 1, cost_priced_calls: 0 },
    ]);
  } finally {
    database.close();
  }
});

test('the manual price backfill writes only columns the migrated catalog still has', async () => {
  // scripts/sync-model-prices.mjs is a repo-root .mjs that no typecheck and no unit test covers,
  // and it hand-writes its INSERT against this schema. When 0030 dropped `cache_accounting` the
  // script kept naming it and kept importing the helper that derived it, so it was broken in two
  // ways that only a real run would have surfaced — a run that talks to production D1.
  //
  // Importing it proves every named import still resolves (the module guards its own main(), so
  // this does not sync anything), and comparing its INSERT column list against the fully migrated
  // table proves it writes a column set the database accepts.
  const scriptPath = path.resolve(hubRoot, '..', 'scripts', 'sync-model-prices.mjs');
  await import(pathToFileURL(scriptPath).href);

  const source = await readFile(scriptPath, 'utf8');
  const insert = /INSERT OR REPLACE INTO model_prices \(([^)]*)\)/.exec(source);
  assert.ok(insert, 'the script no longer contains a model_prices INSERT to check');
  const written = insert[1]
    .split(',')
    .map((column) => column.trim())
    .filter(Boolean);

  const fixture = await loadFixture();
  const database = createDatabase();
  try {
    applyPending(database, fixture);
    const existing = new Set(
      database.prepare("SELECT name FROM pragma_table_info('model_prices')").all().map((row) => row.name),
    );
    assert.deepEqual(
      written.filter((column) => !existing.has(column)),
      [],
      'the manual backfill names model_prices columns the migrations do not define',
    );
  } finally {
    database.close();
  }
});

test('fresh remote shard apply bootstraps through Wrangler and commits the verified SQLite schema and ledger', async (context) => {
  const fixture = await loadFixture(indexMigrationsDir);
  const remote = await createRemoteMigrationFixture(context);
  assert.deepEqual(remote.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all(), [],
    'the regression starts with a genuinely empty SQLite database, not a pre-created ledger');
  const applied = await remote.run();
  assert.equal(applied.signal, null, applied.stderr);
  assert.equal(remote.requests[0]?.sql, 'SELECT name FROM d1_migrations ORDER BY id', applied.stderr);
  assert.equal(remote.requests[0]?.failure, 'no such table: d1_migrations', applied.stderr);
  assert.equal(applied.status, 0, applied.stderr);
  const result = JSON.parse(applied.stdout);
  assert.equal(result.databaseBinding, 'IDX00');
  assert.equal(result.databaseId, remote.options.databaseId);
  assert.equal(result.migrationDigest, migrationDigest(fixture.manifest));
  assert.equal(result.pendingMigrations, 0);
  assert.equal(result.schemaDigest, schemaDigest(schemaSnapshotFromDatabase(remote.database)));
  assert.ok(remote.requests.some(({ sql }) => /^\s*CREATE TABLE IF NOT EXISTS "d1_migrations"/.test(sql ?? '')),
    'normal Wrangler apply must own the canonical ledger bootstrap');
  assert.equal(remote.requests.filter(({ sql }) => /INSERT INTO\s+"d1_migrations"/i.test(sql ?? '')).length, 1,
    'Wrangler must really execute the checked-in shard migration');
  assert.deepEqual(
    remote.database.prepare('SELECT name FROM d1_migrations ORDER BY id').all().map(({ name }) => name),
    fixture.manifest.migrations.map(({ filename }) => filename),
  );
  const ledger = remote.database.prepare(`
    SELECT sequence, filename, sha256, artifact_sha256, deployment_id FROM migration_checksum_ledger ORDER BY sequence
  `).all().map((row) => ({ ...row }));
  assert.deepEqual(ledger, fixture.manifest.migrations.map(({ sequence, filename, sha256 }) => ({
    sequence, filename, sha256, artifact_sha256: artifactDigest, deployment_id: remote.options.deploymentId,
  })));
  const identity = {
    target: remote.options.target, deploymentId: remote.options.deploymentId,
    artifactDigest, migrationDigest: result.migrationDigest,
    databaseBinding: 'IDX00', databaseId: remote.options.databaseId,
  };
  const journal = await openMigrationJournal(remote.options.journalPath, identity);
  assert.equal(journal.phase, 'committed');
  assert.equal(journal.revision, 3);
  const firstRequestCount = remote.requests.length;
  const resumed = await remote.run();
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.deepEqual(JSON.parse(resumed.stdout), result);
  assert.ok(remote.requests.length > firstRequestCount, 'committed resume must still reverify live state');
  assert.ok(remote.requests.slice(firstRequestCount).every(({ sql }) => /^\s*SELECT\b/i.test(sql)),
    'the exact committed journal resumes read-only, without another bootstrap, apply or checksum write');
  assert.deepEqual(remote.database.prepare(`
    SELECT sequence, filename, sha256, artifact_sha256, deployment_id FROM migration_checksum_ledger ORDER BY sequence
  `).all().map((row) => ({ ...row })), ledger, 'resume cannot rewrite historical checksum evidence');
});

test('fresh remote shard preflight fails closed for auth, network, unrelated SQLite and malformed responses', async (context) => {
  for (const [fault, expectedError] of [
    ['auth', /\[code: 10000\]/],
    ['network', /fetch failed|ECONNRESET|socket|other side closed/i],
    ['unrelated-sql', /no such table: unrelated_missing_table/],
    ['malformed', /Wrangler D1 response contains no result rows/],
    ['missing-column', /no such column: name/],
  ]) {
    await context.test(fault, async (child) => {
      const remote = await createRemoteMigrationFixture(child, { fault });
      if (fault === 'missing-column') {
        remote.database.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, filename TEXT)');
      }
      const before = schemaSnapshotFromDatabase(remote.database);
      const rejected = await remote.run();
      assert.equal(rejected.signal, null, rejected.stderr);
      assert.notEqual(rejected.status, 0, rejected.stdout);
      assert.match(rejected.stderr, expectedError);
      assert.ok(remote.requests.length > 0, 'the native remote preflight must encounter the chosen failure');
      assert.ok(remote.requests.every(({ sql }) => sql === 'SELECT name FROM d1_migrations ORDER BY id'),
        'a rejected preflight cannot enter Wrangler bootstrap or apply');
      assert.deepEqual(schemaSnapshotFromDatabase(remote.database), before);
      const journal = JSON.parse(await readFile(remote.options.journalPath, 'utf8'));
      assert.equal(journal.phase, 'intended');
      assert.equal(journal.revision, 0);
    });
  }
});

test('a missing remote main ledger rejects historical migrations before canonical bootstrap', async (context) => {
  const fixture = await loadFixture(migrationsDir);
  assert.equal(fixture.manifest.ledgerStartsAt, 21, 'use the canonical historical main migration contract');
  const remote = await createRemoteMigrationFixture(context, { migrationDirectory: migrationsDir });
  const rejected = await remote.run();
  assert.equal(rejected.signal, null, rejected.stderr);
  assert.notEqual(rejected.status, 0, rejected.stdout);
  assert.deepEqual(remote.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all(), [],
    'historical main cannot create either a migration ledger or user objects without its applied history');
  const journal = await openMigrationJournal(remote.options.journalPath, {
    target: 'production', deploymentId: remote.options.deploymentId,
    artifactDigest, migrationDigest: migrationDigest(fixture.manifest),
    databaseBinding: 'DB', databaseId: remote.options.databaseId,
  });
  assert.equal(journal.phase, 'intended');
  assert.equal(journal.revision, 0);
});

test('a populated remote index without a ledger fails canonical apply and preserves real block and FTS data', async (context) => {
  const fixture = await loadFixture(indexMigrationsDir);
  const remote = await createRemoteMigrationFixture(context);
  for (const sql of fixture.sql.values()) remote.database.exec(sql);
  remote.database.exec(`
    INSERT INTO blocks (id, session_id, file_id, turn_index, block_index, btype, text)
      VALUES (42, 'existing-session', 7, 0, 0, 'text', 'ledgerless sentinel content');
    INSERT INTO blocks_fts (rowid, text) SELECT id, text FROM blocks;
  `);
  assert.deepEqual(remote.database.prepare("SELECT name FROM sqlite_master WHERE name = 'd1_migrations'").all(), []);
  const beforeSchema = schemaSnapshotFromDatabase(remote.database);
  const beforeBlocks = remote.database.prepare('SELECT * FROM blocks ORDER BY id').all();
  const beforeMatches = remote.database.prepare(`
    SELECT rowid, text FROM blocks_fts WHERE blocks_fts MATCH 'ledgerless' ORDER BY rowid
  `).all();
  assert.equal(beforeMatches.length, 1, 'the sentinel must be genuinely indexed before the failed apply');
  assert.equal(beforeMatches[0]?.rowid, 42);
  assert.equal(beforeMatches[0]?.text, 'ledgerless sentinel content');
  const rejected = await remote.run();
  assert.equal(rejected.signal, null, rejected.stderr);
  assert.notEqual(rejected.status, 0, rejected.stdout);
  assert.deepEqual(schemaSnapshotFromDatabase(remote.database), beforeSchema);
  assert.deepEqual(remote.database.prepare('SELECT * FROM blocks ORDER BY id').all(), beforeBlocks);
  assert.deepEqual(remote.database.prepare(`
    SELECT rowid, text FROM blocks_fts WHERE blocks_fts MATCH 'ledgerless' ORDER BY rowid
  `).all(), beforeMatches, 'failed canonical apply must preserve the real source block and FTS MATCH result');
  assert.equal(remote.database.prepare('SELECT COUNT(*) AS count FROM d1_migrations').get().count, 0);
  assert.equal(remote.database.prepare('SELECT COUNT(*) AS count FROM migration_checksum_ledger').get().count, 0);
  const journal = await openMigrationJournal(remote.options.journalPath, {
    target: 'production', deploymentId: remote.options.deploymentId,
    artifactDigest, migrationDigest: migrationDigest(fixture.manifest),
    databaseBinding: 'IDX00', databaseId: remote.options.databaseId,
  });
  assert.equal(journal.phase, 'intended');
  assert.equal(journal.revision, 0);
});

test('a missing remote migration table after Wrangler apply cannot masquerade as a fresh database', async (context) => {
  const remote = await createRemoteMigrationFixture(context, { fault: 'missing-after-apply' });
  const rejected = await remote.run();
  assert.equal(rejected.signal, null, rejected.stderr);
  assert.notEqual(rejected.status, 0, rejected.stdout);
  assert.match(rejected.stderr, /no such table: d1_migrations: SQLITE_ERROR \[code: 7500\]/);
  assert.ok(remote.requests.some(({ sql, success }) => success && /INSERT INTO\s+"d1_migrations"/i.test(sql ?? '')),
    'the failure must follow genuine schema installation, not the original preflight defect');
  assert.equal(remote.database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'blocks'").get().count, 1);
  assert.equal(remote.database.prepare('SELECT COUNT(*) AS count FROM migration_checksum_ledger').get().count, 0);
  const journal = JSON.parse(await readFile(remote.options.journalPath, 'utf8'));
  assert.equal(journal.phase, 'wrangler-applied', 'checksum recording must not advance past missing applied history');
  assert.equal(journal.revision, 1);
});

test('production prefix and checksum integrity remain enforced for existing migration histories', async (context) => {
  const fixture = await loadFixture();
  const database = createDatabase();
  context.after(() => database.close());
  applyPending(database, fixture);
  const snapshot = schemaSnapshotFromDatabase(database);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-existing-history-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const options = {
    target: 'production', config: path.join(hubRoot, 'wrangler.jsonc'), database: 'sessions-index',
    artifactDigest, deploymentId: 'production:existing-history', migrationsDir,
    manifestPath, baseManifestPath: sourceBaselinePath, historyPath,
  };
  const divergent = createWranglerProcess(fixture, snapshot);
  const divergentProcess = async (args) => {
    const response = await divergent.runProcess(args);
    if (args[args.indexOf('--command') + 1] === 'SELECT name FROM d1_migrations ORDER BY id') {
      return { ...response, stdout: JSON.stringify([{ results: [{ name: '9999_removed.sql' }] }]) };
    }
    return response;
  };
  await assert.rejects(runMigrations({
    ...options, journalPath: path.join(directory, 'divergent.json'), runProcess: divergentProcess,
  }), /not an immutable manifest prefix/);
  assert.equal(divergent.state.applyCalls, 0, 'an existing divergent applied prefix must reject before Wrangler apply');
  const corrupt = createWranglerProcess(fixture, snapshot);
  const corruptProcess = async (args) => {
    const response = await corrupt.runProcess(args);
    if (args[args.indexOf('--command') + 1]?.includes('SELECT sequence, filename, sha256 FROM migration_checksum_ledger')) {
      const value = JSON.parse(response.stdout);
      value[0].results[0].sha256 = '0'.repeat(64);
      return { ...response, stdout: JSON.stringify(value) };
    }
    return response;
  };
  await assert.rejects(runMigrations({
    ...options, journalPath: path.join(directory, 'corrupt.json'), runProcess: corruptProcess,
  }), /migration checksum mismatch/);
  assert.equal(corrupt.state.applyCalls, 1);
  const journal = JSON.parse(await readFile(path.join(directory, 'corrupt.json'), 'utf8'));
  assert.equal(journal.phase, 'wrangler-applied', 'corrupt ledger evidence must never be marked checksum-recorded');
});

test('migration runner applies once, measures verify state, and trusts the protected-main manifest for production', async (context) => {
  const fixture = await loadFixture();
  const database = createDatabase();
  applyPending(database, fixture);
  const snapshot = schemaSnapshotFromDatabase(database);
  database.close();
  const baselineDatabase = createDatabase();
  applyPending(baselineDatabase, fixture, fixture.manifest.ledgerStartsAt - 1);
  const baselineSnapshot = schemaSnapshotFromDatabase(baselineDatabase);
  baselineDatabase.close();

  const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-runner-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const localWrangler = createWranglerProcess(fixture, snapshot);
  const localResult = await runMigrations({
    target: 'local',
    persistTo: directory,
    journalPath: path.join(directory, 'local.json'),
    artifactDigest,
    deploymentId: 'local:acceptance',
    migrationsDir,
    manifestPath,
    baseManifestPath: sourceBaselinePath,
    historyPath,
    runProcess: localWrangler.runProcess,
  });
  assert.equal(localWrangler.state.applyCalls, 1, 'the runner must invoke Wrangler apply exactly once');
  assert.equal(localWrangler.state.appliedReads, 2, 'pending state must be read again during final verification');
  assert.equal(localResult.pendingMigrations, 0);

  const productionBase = {
    target: 'production',
    config: path.join(hubRoot, 'wrangler.jsonc'),
    database: 'sessions-index',
    artifactDigest: 'b'.repeat(64),
    deploymentId: 'production:acceptance',
    migrationsDir,
    manifestPath,
    baseManifestPath: sourceBaselinePath,
    historyPath,
  };
  // Production trusts the protected-main manifest: no signed baseline envelope, but the
  // applied history must still be an immutable prefix of the manifest before apply runs.
  const preLedgerCount = fixture.manifest.migrations
    .filter((migration) => migration.sequence < fixture.manifest.ledgerStartsAt).length;
  const productionWrangler = createWranglerProcess(fixture, snapshot, preLedgerCount, baselineSnapshot);
  const productionResult = await runMigrations({
    ...productionBase,
    journalPath: path.join(directory, 'production.json'),
    runProcess: productionWrangler.runProcess,
  });
  assert.equal(productionWrangler.state.applyCalls, 1);
  assert.equal(productionResult.pendingMigrations, 0);

  // A tampered historical baseline still fails loud: the pre-ledger source digest is
  // anchored in the manifest, not in a separately signed envelope.
  const history = JSON.parse(await readFile(historyPath, 'utf8'));
  const alteredHistory = structuredClone(history);
  alteredHistory.sourceImmutability.digest = 'f'.repeat(64);
  const alteredHistoryPath = path.join(directory, 'altered-history.json');
  await writeFile(alteredHistoryPath, `${JSON.stringify(alteredHistory)}\n`);
  await assert.rejects(
    runMigrations({
      ...productionBase,
      historyPath: alteredHistoryPath,
      journalPath: path.join(directory, 'altered-history-journal.json'),
    }),
    /repository source changed from the immutable baseline/,
  );
});

test('local and e2e migrate independent main and two shard histories before fixture pricing', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-shard-migrations-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const fixtures = new Map([
    [migrationsDir, await loadFixture()],
    [indexMigrationsDir, await loadFixture(indexMigrationsDir)],
  ]);
  for (const target of ['local', 'e2e']) {
    const stateDir = path.join(directory, target);
    const { config, configPath } = await writeLocalConfig({ stateDir, hubRoot, revision: `${target}:acceptance` });
    const databases = new Map(config.d1_databases.map(({ binding }) => [binding, createDatabase()]));
    const applies = new Map();
    context.after(() => { for (const database of databases.values()) database.close(); });
    const runProcess = async (args) => {
      assert.equal(args[args.indexOf('--config') + 1], configPath);
      assert.equal(args[args.indexOf('--persist-to') + 1], stateDir);
      assert.ok(args.includes('--local'));
      assert.ok(!args.includes('--remote'));
      const applying = args[1] === 'migrations';
      const binding = args[applying ? 3 : 2];
      const database = databases.get(binding);
      assert.ok(database, `unexpected database ${binding}`);
      const definition = config.d1_databases.find((entry) => entry.binding === binding);
      if (applying) {
        applies.set(binding, (applies.get(binding) ?? 0) + 1);
        applyPending(database, fixtures.get(definition.migrations_dir));
        return { stdout: '', stderr: '' };
      }
      const sql = args[args.indexOf('--command') + 1];
      return { stdout: JSON.stringify([{ results: database.prepare(sql).all() }]), stderr: '' };
    };
    const optionsByBinding = new Map();
    for (const definition of config.d1_databases) {
      const options = {
        target, persistTo: stateDir, config: configPath, database: definition.binding,
        databaseId: definition.database_id, migrationsDir: definition.migrations_dir,
        journalPath: path.join(stateDir, `${definition.binding}.json`),
        artifactDigest, deploymentId: `${target}:same-artifact`, runProcess,
      };
      optionsByBinding.set(definition.binding, options);
      const result = await runMigrations(options);
      assert.equal(result.databaseBinding, definition.binding);
      assert.equal(result.databaseId, definition.database_id);
      assert.equal(result.migrationDigest, await resolveMigrationDigest({ migrationsDir: definition.migrations_dir }));
      assert.equal(result.pendingMigrations, 0);
      assert.deepEqual(await runMigrations(options), result, 'the exact database journal resumes without another apply');
      assert.equal(applies.get(definition.binding), 1);
      const database = databases.get(definition.binding);
      const fixture = fixtures.get(definition.migrations_dir);
      assert.deepEqual(
        database.prepare('SELECT name FROM d1_migrations ORDER BY id').all().map(({ name }) => name),
        fixture.manifest.migrations.map(({ filename }) => filename),
      );
      assert.equal(
        database.prepare('SELECT COUNT(*) AS count FROM migration_checksum_ledger').get().count,
        fixture.manifest.migrations.filter(({ sequence }) => sequence >= fixture.manifest.ledgerStartsAt).length,
      );
    }
    assert.deepEqual([...applies.keys()], ['DB', 'IDX00', 'IDX01']);
    const main = databases.get('DB');
    assert.deepEqual(main.prepare("SELECT name FROM sqlite_master WHERE name IN ('blocks', 'blocks_fts')").all(), []);
    for (const binding of ['IDX00', 'IDX01']) {
      const shard = databases.get(binding);
      assert.deepEqual(
        shard.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sessions', 'starred_turns', 'blocks', 'blocks_fts', 'catalog_versions', 'shard_meta') ORDER BY name").all().map(({ name }) => name),
        ['blocks', 'blocks_fts', 'catalog_versions', 'sessions', 'shard_meta', 'starred_turns'],
      );
      assert.deepEqual(shard.prepare("SELECT name FROM sqlite_master WHERE name IN ('usage', 'files', 'model_prices')").all(), []);
    }
    // Prices remain authoritative metadata; uploads still use the ordinary worker path.
    main.exec(fixtureModelPriceSql());
    assert.ok(main.prepare('SELECT COUNT(*) AS count FROM model_prices').get().count > 0);
    await assert.rejects(runMigrations({
      ...optionsByBinding.get('IDX01'), journalPath: optionsByBinding.get('IDX00').journalPath,
    }), /different immutable artifact, deployment, or database/);
    assert.equal(applies.get('IDX01'), 1, 'another shard cannot reuse a committed journal to skip its own migration');
    await assert.rejects(migrationDatabaseIdentity({
      ...optionsByBinding.get('IDX00'), databaseId: 'replacement-database',
    }), /database ID does not match/);
    await assert.rejects(migrationDatabaseIdentity({
      ...optionsByBinding.get('IDX00'), migrationsDir,
    }), /migration directory does not match/);
    const replacementConfig = structuredClone(config);
    replacementConfig.d1_databases.find(({ binding }) => binding === 'IDX00').database_id = 'replacement-index-00';
    const replacementConfigPath = path.join(stateDir, 'replacement.json');
    await writeFile(replacementConfigPath, JSON.stringify(replacementConfig));
    await assert.rejects(runMigrations({
      ...optionsByBinding.get('IDX00'), config: replacementConfigPath, databaseId: undefined,
    }), /different immutable artifact, deployment, or database/);
    assert.equal(applies.get('IDX00'), 1, 'the actual configured database ID is bound even without --database-id');
  }
});

test('the migration CLI validates the shard manifest against its own immutable base', async () => {
  const result = spawnSync(process.execPath, [
    path.join(hubRoot, 'scripts/migrations.mjs'), 'check',
    '--migrations-dir', indexMigrationsDir,
    '--base-manifest', path.join(indexMigrationsDir, 'source-baseline.json'),
  ], { cwd: hubRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).migrationDigest, await resolveMigrationDigest({ migrationsDir: indexMigrationsDir }));
});

test('protected-base shard validation bootstraps only an absent tree, then enforces immutable history', async (context) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'hub-shard-base-'));
  context.after(() => rm(repository, { recursive: true, force: true }));
  const scripts = path.join(repository, 'hub/scripts');
  await mkdir(path.join(scripts, 'lib'), { recursive: true });
  for (const file of [
    'migrations.mjs', 'lib/migration-runner.mjs', 'lib/migration-manifest.mjs',
    'lib/migration-journal.mjs', 'lib/schema-digest.mjs',
  ]) {
    await cp(path.join(hubRoot, 'scripts', file), path.join(scripts, file));
  }
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(repository, 'no-global-config'),
    GIT_TERMINAL_PROMPT: '0',
  };
  const git = (args) => {
    const result = spawnSync('git', [
      '-c', 'user.name=Migration test', '-c', 'user.email=migration-test@example.invalid',
      '-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${path.join(repository, 'no-hooks')}`,
      ...args,
    ], { cwd: repository, encoding: 'utf8', env: gitEnv });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '--quiet', '--object-format=sha1']);
  await writeFile(path.join(repository, 'README.md'), 'Initial protected base without shards.\n');
  git(['add', 'README.md']);
  git(['commit', '--quiet', '-m', 'Initial base']);
  const absentBase = git(['rev-parse', 'HEAD']);
  const candidate = path.join(repository, 'hub/migrations-index');
  await cp(indexMigrationsDir, candidate, { recursive: true });
  const check = (baseRef) => spawnSync(process.execPath, [
    path.join(scripts, 'migrations.mjs'), 'check',
    '--migrations-dir', candidate, '--base-ref', baseRef,
  ], { cwd: repository, encoding: 'utf8', env: gitEnv });
  const bootstrap = check(absentBase);
  assert.equal(bootstrap.status, 0, bootstrap.stderr);
  assert.equal(JSON.parse(bootstrap.stdout).migrationDigest, await resolveMigrationDigest({ migrationsDir: candidate }));

  const initial = JSON.parse(await readFile(path.join(candidate, 'source-baseline.json'), 'utf8'));
  const wrongPolicy = { ...initial, ledgerStartsAt: 2 };
  await writeFile(path.join(candidate, 'source-baseline.json'), JSON.stringify(wrongPolicy));
  const rejectedPolicy = check(absentBase);
  assert.notEqual(rejectedPolicy.status, 0);
  assert.match(rejectedPolicy.stderr, /initial 0001 baseline with ledgerStartsAt=1/);
  await writeFile(path.join(candidate, 'source-baseline.json'), JSON.stringify(initial));

  // Existing content without policy cannot be mistaken for a new namespace.
  await writeFile(path.join(candidate, 'README.md'), 'Existing tree, missing protected policy.\n');
  git(['add', 'hub/migrations-index/README.md']);
  git(['commit', '--quiet', '-m', 'Existing tree without policy']);
  const existingInvalid = check(git(['rev-parse', 'HEAD']));
  assert.notEqual(existingInvalid.status, 0);
  assert.match(existingInvalid.stderr, /no manifest or independent policy evidence/);

  git(['add', 'hub/migrations-index']);
  git(['commit', '--quiet', '-m', 'Protected initial shard history']);
  const existingBase = git(['rev-parse', 'HEAD']);
  const existing = check(existingBase);
  assert.equal(existing.status, 0, existing.stderr);
  const sqlPath = path.join(candidate, initial.migrations[0].filename);
  await writeFile(sqlPath, `${await readFile(sqlPath, 'utf8')}\n-- changed protected SQL\n`);
  const changed = await buildMigrationManifest(candidate, initial);
  await writeFile(path.join(candidate, 'manifest.json'), JSON.stringify(changed));
  await writeFile(path.join(candidate, 'source-baseline.json'), JSON.stringify(changed));
  const edited = check(existingBase);
  assert.notEqual(edited.status, 0);
  assert.match(edited.stderr, /immutable base migration changed/);

  const unreadable = check('0'.repeat(40));
  assert.notEqual(unreadable.status, 0);
  assert.match(unreadable.stderr, /cannot fetch migration base/);
});

test('unidentified local state inspection detects populated legacy blocks without migration writes', async () => {
  const database = createDatabase();
  const runProcess = async (args) => {
    assert.equal(args[1], 'execute');
    assert.equal(args[2], 'DB');
    assert.ok(args.includes('--local'));
    const sql = args[args.indexOf('--command') + 1];
    return { stdout: JSON.stringify([{ results: database.prepare(sql).all() }]), stderr: '' };
  };
  const options = { target: 'local', persistTo: path.resolve('/tmp/local-inspection'), runProcess };
  try {
    assert.equal(await hasLocalLegacyBlocks(options), false);
    database.exec('CREATE TABLE blocks (id INTEGER PRIMARY KEY, text TEXT)');
    assert.equal(await hasLocalLegacyBlocks(options), false);
    database.exec("INSERT INTO blocks (text) VALUES ('preserve me')");
    assert.equal(await hasLocalLegacyBlocks(options), true);
    assert.equal(database.prepare('SELECT text FROM blocks').get().text, 'preserve me');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM d1_migrations').get().count, 0);
    await assert.rejects(hasLocalLegacyBlocks({ ...options, target: 'production' }), /requires target local/);
  } finally {
    database.close();
  }
});

test('signed release manifests bind the exact canonical ordered manifest', async () => {
  const { manifest } = await loadFixture();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signature = sign(null, Buffer.from(`${canonicalJson(manifest)}\n`), privateKey).toString('base64');
  const envelope = { formatVersion: 1, payload: manifest, signature };
  assert.deepEqual(verifySignedReleaseManifest(envelope, publicKey), manifest);
  envelope.payload.migrations[0].sha256 = 'f'.repeat(64);
  assert.throws(() => verifySignedReleaseManifest(envelope, publicKey), /signature is invalid/);
});

test('journal resumes every crash phase only for the exact immutable identity', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-journal-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const identity = {
    target: 'preview',
    deploymentId: 'pr-12-g1-deadbeefcafe',
    artifactDigest,
    migrationDigest: 'b'.repeat(64),
    databaseBinding: 'IDX00',
    databaseId: 'preview-index-00',
  };
  const journalPath = path.join(directory, 'deployment.json');
  const durable = { apply: 0, checksums: new Set(), verify: 0 };
  for (const crashAt of ['apply', 'checksums', 'verify']) {
    let crashed = false;
    await assert.rejects(runJournaledMigration({
      journalPath,
      identity,
      apply: async () => {
        durable.apply += 1;
        if (crashAt === 'apply' && !crashed) { crashed = true; throw new Error('crash'); }
      },
      recordChecksums: async () => {
        durable.checksums.add('0021');
        if (crashAt === 'checksums' && !crashed) { crashed = true; throw new Error('crash'); }
      },
      verify: async () => {
        durable.verify += 1;
        if (crashAt === 'verify' && !crashed) { crashed = true; throw new Error('crash'); }
        return { pendingMigrations: 0 };
      },
    }), /crash/);
    const phaseAfterCrash = (await openMigrationJournal(journalPath, identity)).phase;
    assert.equal(phaseAfterCrash, crashAt === 'apply' ? 'intended' : crashAt === 'checksums' ? 'wrangler-applied' : 'checksum-recorded');
    const resumed = await runJournaledMigration({
      journalPath,
      identity,
      apply: async () => { durable.apply += 1; },
      recordChecksums: async () => { durable.checksums.add('0021'); },
      verify: async () => ({ pendingMigrations: 0 }),
    });
    assert.equal(resumed.journal.phase, 'committed');
    await rm(journalPath);
  }
  assert.deepEqual([...durable.checksums], ['0021']);
});

test('journal recovery fails closed for wrong artifacts, corrupt checksums, and unknown phases', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-journal-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const journalPath = path.join(directory, 'deployment.json');
  const identity = {
    target: 'production',
    deploymentId: 'release-1',
    artifactDigest,
    migrationDigest: 'c'.repeat(64),
    databaseBinding: 'IDX00',
    databaseId: 'production-index-00',
  };
  await openMigrationJournal(journalPath, identity);
  await assert.rejects(
    openMigrationJournal(journalPath, { ...identity, artifactDigest: 'd'.repeat(64) }),
    (error) => error instanceof AmbiguousJournalError && /different immutable artifact/.test(error.message),
  );
  for (const change of [{ databaseBinding: 'IDX01' }, { databaseId: 'replacement-index-00' }]) {
    await assert.rejects(
      openMigrationJournal(journalPath, { ...identity, ...change }),
      (error) => error instanceof AmbiguousJournalError && /different immutable artifact/.test(error.message),
    );
  }
  await assert.rejects(openMigrationJournal(path.join(directory, 'missing-database.json'), {
    ...identity, databaseId: undefined,
  }), /invalid migration journal databaseId/);
  const legacy = JSON.parse(await readFile(journalPath, 'utf8'));
  legacy.formatVersion = 1;
  await writeFile(journalPath, JSON.stringify(legacy));
  await assert.rejects(openMigrationJournal(journalPath, identity), /unknown format or phase/);
  legacy.formatVersion = 2;
  await writeFile(journalPath, JSON.stringify(legacy));

  const corrupt = JSON.parse(await readFile(journalPath, 'utf8'));
  corrupt.checksum = '0'.repeat(64);
  await writeFile(journalPath, JSON.stringify(corrupt));
  await assert.rejects(openMigrationJournal(journalPath, identity), /checksum is invalid/);

  corrupt.phase = 'maybe-applied';
  await writeFile(journalPath, JSON.stringify(corrupt));
  await assert.rejects(openMigrationJournal(journalPath, identity), /unknown format or phase/);
});
