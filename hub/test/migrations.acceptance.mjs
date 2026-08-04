import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  assertImmutableBase,
  assertManifestMatches,
  buildMigrationManifest,
  canonicalJson,
  canonicalMigrationBytes,
  loadAndValidateManifest,
  migrationDigest,
  sha256,
  validateHistoricalBaseline,
  validateManifestShape,
  verifySignedReleaseManifest,
} from '../scripts/lib/migration-manifest.mjs';
import { runMigrations } from '../scripts/lib/migration-runner.mjs';
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
const artifactDigest = 'a'.repeat(64);

async function loadFixture() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const sql = new Map();
  for (const migration of manifest.migrations) {
    sql.set(migration.filename, await readFile(path.join(migrationsDir, migration.filename), 'utf8'));
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
  const bareCheck = spawnSync(process.execPath, [path.join(hubRoot, 'scripts', 'migrations.mjs'), 'check'], {
    cwd: hubRoot,
    encoding: 'utf8',
  });
  assert.notEqual(bareCheck.status, 0);
  assert.match(bareCheck.stderr, /requires independent policy evidence/);

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

test('migration runner applies once, measures verify state, and requires signed production history evidence', async (context) => {
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
  await assert.rejects(
    runMigrations({ ...productionBase, journalPath: path.join(directory, 'missing-baseline.json') }),
    /separately signed, human-approved historical baseline/,
  );

  const history = JSON.parse(await readFile(historyPath, 'utf8'));
  const payload = {
    kind: 'production-schema-baseline',
    approved: true,
    throughSequence: fixture.manifest.ledgerStartsAt - 1,
    migrationDigest: migrationDigest(fixture.manifest),
    historicalBaselineDigest: sha256(`${canonicalJson(history)}\n`),
    schemaDigest: schemaDigest(baselineSnapshot),
    approvedBy: 'migration-approver@example.com',
    measuredAt: '2026-08-03T00:00:00.000Z',
    reason: 'Reviewed against the measured production schema.',
    approvedAt: '2026-08-03T00:00:00.000Z',
  };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const envelope = {
    formatVersion: 1,
    payload,
    signature: sign(null, Buffer.from(`${canonicalJson(payload)}\n`), privateKey).toString('base64'),
  };
  const baselinePath = path.join(directory, 'production-baseline.json');
  await writeFile(baselinePath, `${JSON.stringify(envelope)}\n`);

  const forged = structuredClone(envelope);
  forged.payload.schemaDigest = 'f'.repeat(64);
  const forgedPath = path.join(directory, 'forged-baseline.json');
  await writeFile(forgedPath, `${JSON.stringify(forged)}\n`);
  await assert.rejects(
    runMigrations({
      ...productionBase,
      journalPath: path.join(directory, 'forged.json'),
      baselinePath: forgedPath,
      baselinePublicKey: publicKey,
    }),
    /signature is invalid/,
  );

  const preLedgerCount = fixture.manifest.migrations
    .filter((migration) => migration.sequence < fixture.manifest.ledgerStartsAt).length;
  const wrongSchemaPayload = { ...payload, schemaDigest: 'e'.repeat(64) };
  const wrongSchemaEnvelope = {
    formatVersion: 1,
    payload: wrongSchemaPayload,
    signature: sign(null, Buffer.from(`${canonicalJson(wrongSchemaPayload)}\n`), privateKey).toString('base64'),
  };
  const wrongSchemaPath = path.join(directory, 'wrong-schema-baseline.json');
  await writeFile(wrongSchemaPath, `${JSON.stringify(wrongSchemaEnvelope)}\n`);
  const blockedWrangler = createWranglerProcess(fixture, snapshot, preLedgerCount, baselineSnapshot);
  await assert.rejects(
    runMigrations({
      ...productionBase,
      journalPath: path.join(directory, 'wrong-schema.json'),
      baselinePath: wrongSchemaPath,
      baselinePublicKey: publicKey,
      runProcess: blockedWrangler.runProcess,
    }),
    /does not match the signed human-approved baseline before migration/,
  );
  assert.equal(blockedWrangler.state.applyCalls, 0);

  const productionWrangler = createWranglerProcess(fixture, snapshot, preLedgerCount, baselineSnapshot);
  const productionResult = await runMigrations({
    ...productionBase,
    journalPath: path.join(directory, 'production.json'),
    baselinePath,
    baselinePublicKey: publicKey,
    runProcess: productionWrangler.runProcess,
  });
  assert.equal(productionWrangler.state.applyCalls, 1);
  assert.equal(productionResult.pendingMigrations, 0);

  const alteredHistory = structuredClone(history);
  alteredHistory.deploymentHistory.reason += ' altered';
  const alteredHistoryPath = path.join(directory, 'altered-history.json');
  await writeFile(alteredHistoryPath, `${JSON.stringify(alteredHistory)}\n`);
  await assert.rejects(
    runMigrations({
      ...productionBase,
      historyPath: alteredHistoryPath,
      journalPath: path.join(directory, 'altered-history-journal.json'),
      baselinePath,
      baselinePublicKey: publicKey,
    }),
    /incomplete or not explicitly human-approved/,
  );
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
  };
  await openMigrationJournal(journalPath, identity);
  await assert.rejects(
    openMigrationJournal(journalPath, { ...identity, artifactDigest: 'd'.repeat(64) }),
    (error) => error instanceof AmbiguousJournalError && /different immutable artifact/.test(error.message),
  );

  const corrupt = JSON.parse(await readFile(journalPath, 'utf8'));
  corrupt.checksum = '0'.repeat(64);
  await writeFile(journalPath, JSON.stringify(corrupt));
  await assert.rejects(openMigrationJournal(journalPath, identity), /checksum is invalid/);

  corrupt.phase = 'maybe-applied';
  await writeFile(journalPath, JSON.stringify(corrupt));
  await assert.rejects(openMigrationJournal(journalPath, identity), /unknown format or phase/);
});
