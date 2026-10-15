import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import test from 'node:test';
import {
  ACTIVATION_CHECKPOINT, COPY_CHECKPOINT, COPY_ENCODING, COPY_PAGE_BYTES, READY_CHECKPOINT, SEED_CHECKPOINT, SOURCE_FREEZE_TABLE,
  assertActivationProof, assertMaintenanceHealth, assertReadyProof, buildActivationProof, buildReadyProof, canonicalRow,
  classifyIndexMigration, copyFrozenIndex, initializeShardLayouts, readCheckpoint, reconcileIndexCatalog, rowDigest,
  seedFrozenCatalog, sourceCopyForecast, verifyIndexRecords, writeCheckpoint,
} from '../scripts/lib/index-migration.mjs';
import {
  BLOCK_COLUMNS, INDEX_ID_SPAN, INDEX_LAYOUT, SESSION_CATALOG_COLUMNS,
  STAR_CATALOG_COLUMNS, indexIdBase, indexShardForSessionId,
} from '../src/index-layout.mjs';
import {
  CopyPassBudgetExhausted, cloudflareRetryDelay, createCopyPassRequestGate, indexControlClient,
  pauseConsumers, requireProtectedProduction, runCopyPass, verifyActiveIndex, verifyReadyIndex,
} from '../../infra/cf/index-control.mjs';
import { PREVIEW_ACCOUNT_ID, PRODUCTION_ACCOUNT_ID } from '../../infra/cf/preview-trust.mjs';
import {
  D1_BATCH_PROBE_TEXT, d1SqlFailureReason, verifyD1BatchAtomicity as currentBatchAtomicity,
} from '../../infra/cf/d1-batch-atomicity.mjs';
import { CLOUDFLARE_REQUEST_RATE_PER_SECOND } from '../scripts/lib/cloudflare-api-budget.mjs';
import {
  verifyNativeCopyControl as currentNativeCopyControl,
  withScratchD1Databases as currentScratchD1Databases,
} from '../../infra/cf/native-copy-control.mjs';

// Historical controls replace only classification, so older modules missing the new proof
// exports still execute the load-bearing pending/active assertions rather than failing import.
const classifyActivation = process.env.INDEX_CLASSIFICATION_MODULE_PATH
  ? (await import(process.env.INDEX_CLASSIFICATION_MODULE_PATH)).classifyIndexMigration : classifyIndexMigration;
const nativeParameters = process.env.INDEX_COPY_MODULE_PATH
  ? await import(process.env.INDEX_COPY_MODULE_PATH)
  : { copyFrozenIndex, verifyIndexRecords, seedFrozenCatalog, reconcileIndexCatalog };
const {
  copyFrozenIndex: copyWithNativeParameters, verifyIndexRecords: verifyWithNativeParameters,
  seedFrozenCatalog: seedCatalogWithNativeParameters, reconcileIndexCatalog: reconcileCatalogWithNativeParameters,
} = nativeParameters;
const consumerControl = process.env.INDEX_CONTROL_MODULE_PATH
  ? await import(process.env.INDEX_CONTROL_MODULE_PATH) : { pauseConsumers };
const diagnosticClient = consumerControl.indexControlClient ?? indexControlClient;
const { verifyNativeCopyControl, withScratchD1Databases } = process.env.NATIVE_COPY_CONTROL_MODULE_PATH
  ? await import(process.env.NATIVE_COPY_CONTROL_MODULE_PATH)
  : { verifyNativeCopyControl: currentNativeCopyControl, withScratchD1Databases: currentScratchD1Databases };
const verifyD1BatchAtomicity = process.env.D1_ATOMICITY_MODULE_PATH
  ? (await import(process.env.D1_ATOMICITY_MODULE_PATH)).verifyD1BatchAtomicity : currentBatchAtomicity;

const hubRoot = path.resolve(import.meta.dirname, '..');
const revision = 'frozen-index-revision-0123456789';
const health = {
  ok: true, environment: 'production', indexMode: 'maintenance',
  deploymentRevision: revision, indexShardCount: 2,
};
const gate = async () => assertMaintenanceHealth(health, revision, 2);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const quoted = (name) => `"${name.replaceAll('"', '""')}"`;
const isWrite = (sql) => /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i.test(sql)
  || /^\s*WITH\b[^;]*\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/is.test(sql);
const selectsTable = (sql, table) => /^\s*(?:SELECT|WITH)\b/i.test(sql) && !isWrite(sql)
  && new RegExp(`\\bFROM\\s+"?${table}"?\\b`, 'i').test(sql);
// D1's JSON integer parameters are SQLite INTEGERs. Older Node SQLite binds every
// Number as REAL; FTS5 omits the rowid-equality recheck and only bounds INTEGER values,
// so a REAL-bound id can incorrectly return all rows sharing the MATCH term.
const sqliteParams = (params) => params.map((value) =>
  typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : value);

function plainRows(database, sql, params = [], statement = database.prepare(sql)) {
  const columns = statement.columns();
  // Schema PRAGMAs contain no stored text values. For SELECT results, native Node SQLite
  // decodes TEXT through a NUL-terminated string, even though SQLite stores the entire value.
  // Project TEXT as BLOB before crossing that boundary; retain its storage type so real
  // BLOBs, nulls and numbers are not silently converted into strings.
  if (/^\s*PRAGMA\b/i.test(sql)) return statement.all(...sqliteParams(params)).map((row) => ({ ...row }));
  const aliases = columns.map((_, index) => quoted(`__column_${index}`));
  const selectors = aliases.flatMap((column, index) => [
    `CASE WHEN typeof(${column}) = 'text' THEN CAST(${column} AS BLOB)
      ELSE ${column} END AS ${quoted(`__value_${index}`)}`,
    `typeof(${column}) AS ${quoted(`__type_${index}`)}`,
  ]);
  const transport = database.prepare(`WITH "__d1_result" (${aliases.join(',')}) AS MATERIALIZED (
    ${sql.replace(/;\s*$/, '')}
  ) SELECT ${selectors.join(',')} FROM "__d1_result"`);
  return transport.all(...sqliteParams(params)).map((row) => Object.fromEntries(columns.map(({ name }, index) => [
    name, row[`__type_${index}`] === 'text'
      ? Buffer.from(row[`__value_${index}`]).toString('utf8') : row[`__value_${index}`],
  ])));
}
let nextTransaction = 0;

// The copier's real REST adapter exposes D1 result records, not SQLite statement objects. Execute
// all SQL against SQLite, retaining only this thin transport boundary. A D1 batch is ONE atomic
// transaction; faults after an executed statement must roll back blocks and FTS together.
class SqliteD1 {
  constructor(id, filename, trace) {
    this.id = id;
    this.filename = filename;
    this.trace = trace;
    this.database = new DatabaseSync(filename);
    this.database.exec('PRAGMA foreign_keys = ON');
    this.atomicBatch = true;
    this.beforeQuery = null;
    this.beforeStatement = null;
    this.transformQuery = null;
    this.afterStatement = null;
    this.afterBatch = null;
  }

  execute(sql, params) {
    const statement = this.database.prepare(sql);
    if (statement.columns().length) return plainRows(this.database, sql, params, statement);
    statement.run(...sqliteParams(params));
    return [];
  }

  async query(sql, params = []) {
    const event = { db: this.id, kind: 'query', sql, params: [...params], success: false };
    this.trace.push(event);
    await this.beforeQuery?.(event);
    let rows = this.execute(sql, params);
    if (this.transformQuery) rows = await this.transformQuery(event, rows);
    event.rows = rows;
    event.responseBytes = Buffer.byteLength(JSON.stringify(rows));
    event.success = true;
    return rows;
  }

  async batch(statements) {
    const transaction = `${this.id}:${++nextTransaction}`;
    const event = { db: this.id, kind: 'batch', transaction, statements, atomic: this.atomicBatch, committed: false };
    this.trace.push(event);
    if (this.atomicBatch) this.database.exec('BEGIN');
    try {
      const results = [];
      for (const { sql, params = [] } of statements) {
        const call = { db: this.id, kind: 'batch-statement', transaction, sql, params, success: false };
        this.trace.push(call);
        await this.beforeStatement?.(call);
        let rows = this.execute(sql, params);
        if (this.transformQuery) rows = await this.transformQuery(call, rows);
        await this.afterStatement?.(call, rows);
        call.rows = rows;
        call.responseBytes = Buffer.byteLength(JSON.stringify(rows));
        call.success = true;
        results.push({ success: true, results: rows });
      }
      if (this.atomicBatch) this.database.exec('COMMIT');
      event.committed = true;
      event.responseBytes = Buffer.byteLength(JSON.stringify(results));
      await this.afterBatch?.(event);
      return results;
    } catch (error) {
      if (this.atomicBatch && !event.committed) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  rows(sql, params = []) {
    return plainRows(this.database, sql, params);
  }

  close() {
    this.database.close();
  }
}

async function migrations(directory) {
  const names = (await readdir(directory)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  return Promise.all(names.map(async (name) => ({
    sequence: Number(name.slice(0, 4)), sql: await readFile(path.join(directory, name), 'utf8'),
  })));
}

async function fixture(context, { identities = ['main-database', 'index-database-00', 'index-database-01'] } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'index-migration-test-'));
  const trace = [];
  const filenames = identities.map((id) => path.join(directory, `${id}.sqlite`));
  let adapters = identities.map((id, index) => new SqliteD1(id, filenames[index], trace));
  const mainMigrations = await migrations(path.join(hubRoot, 'migrations'));
  const indexMigrations = await migrations(path.join(hubRoot, 'migrations-index'));
  // Reconstruct the actual legacy schema, not a shortened synthetic blocks table. The new main
  // migrations drop legacy blocks and create the catalog outbox only AFTER the verified copy.
  for (const migration of mainMigrations.filter(({ sequence }) => sequence <= 34)) {
    adapters[0].database.exec(migration.sql);
  }
  for (const shard of adapters.slice(1)) {
    for (const migration of indexMigrations) shard.database.exec(migration.sql);
  }
  await initializeShardLayouts(adapters.slice(1));
  trace.length = 0;
  const result = {
    trace,
    get source() { return adapters[0]; },
    get shards() { return adapters.slice(1); },
    async migrateMain() {
      for (const migration of mainMigrations.filter(({ sequence }) => sequence > 34)) {
        adapters[0].database.exec(migration.sql);
      }
    },
    restart() {
      for (const db of adapters) db.close();
      adapters = identities.map((id, index) => new SqliteD1(id, filenames[index], trace));
    },
    args(extra = {}) { return { source: this.source, shards: this.shards, gate, ...extra }; },
  };
  context.after(async () => {
    for (const db of adapters) db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return result;
}

// The same query/batch result-record boundary as SqliteD1, but every statement
// executes in workerd's real D1 implementation, with no SQL rewriting or hit echo.
class WorkerdD1 {
  constructor(id, database, trace) {
    this.id = id;
    this.database = database;
    this.trace = trace;
    this.beforeQuery = null;
    this.beforeStatement = null;
    this.transformQuery = null;
  }

  async rows(sql, params = []) {
    return (await this.database.prepare(sql).bind(...params).all()).results;
  }

  async query(sql, params = []) {
    const event = { db: this.id, kind: 'query', sql, params: [...params], success: false };
    this.trace.push(event);
    await this.beforeQuery?.(event);
    let rows = await this.rows(sql, params);
    if (this.transformQuery) rows = await this.transformQuery(event, rows);
    event.rows = rows;
    event.responseBytes = Buffer.byteLength(JSON.stringify(rows));
    event.success = true;
    return rows;
  }

  async batch(statements) {
    const transaction = `${this.id}:${++nextTransaction}`;
    const event = { db: this.id, kind: 'batch', transaction, statements, atomic: true, committed: false };
    this.trace.push(event);
    const calls = [];
    // Hooks observe the request before workerd executes the entire native batch;
    // they do not turn it into separate per-statement RPCs or transactions.
    for (const { sql, params = [] } of statements) {
      const call = { db: this.id, kind: 'batch-statement', transaction, sql, params, success: false };
      this.trace.push(call);
      calls.push(call);
      await this.beforeStatement?.(call);
    }
    const results = await this.database.batch(statements.map(({ sql, params = [] }) =>
      this.database.prepare(sql).bind(...params)));
    event.committed = true;
    event.responseBytes = Buffer.byteLength(JSON.stringify(results));
    for (let index = 0; index < calls.length; index += 1) {
      calls[index].rows = results[index].results;
      calls[index].responseBytes = Buffer.byteLength(JSON.stringify(results[index].results));
      calls[index].success = results[index].success;
    }
    return results;
  }
}

async function workerdFixture(context) {
  const { Miniflare } = await import('miniflare');
  const { unstable_splitSqlQuery: splitSqlQuery } = await import('wrangler');
  const identities = { DB: 'workerd-copy-source', IDX00: 'workerd-copy-index-00', IDX01: 'workerd-copy-index-01' };
  const native = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("index-copy-test"); } };',
    compatibilityDate: '2026-07-17',
    d1Databases: identities,
  });
  // Register disposal before setup so failures cannot leave the native process running.
  context.after(() => native.dispose());
  const trace = [];
  const adapters = await Promise.all(Object.entries(identities).map(async ([binding, id]) =>
    new WorkerdD1(id, await native.getD1Database(binding), trace)));
  const indexMigrations = await migrations(path.join(hubRoot, 'migrations-index'));
  // Like the isolated native-copy control, use the actual index schema for its
  // source as well as both shards; its blocks layout/tokenizer is the legacy layout.
  for (const adapter of adapters) {
    for (const migration of indexMigrations) {
      await adapter.batch(splitSqlQuery(migration.sql).map((sql) => ({ sql, params: [] })));
    }
  }
  const [source, ...shards] = adapters;
  await initializeShardLayouts(shards);
  trace.length = 0;
  return { source, shards, trace, args: (extra = {}) => ({ source, shards, gate, ...extra }) };
}

async function seedWorkerdBlocks(db, rows) {
  const ids = JSON.stringify(rows.map(({ id }) => id));
  await db.batch([
    {
      sql: `INSERT INTO blocks (${BLOCK_COLUMNS.map(quoted).join(',')})
        SELECT ${BLOCK_COLUMNS.map((_, index) => `json_extract(value,'$[${index}]')`).join(',')} FROM json_each(?)`,
      params: [JSON.stringify(rows.map((row) => BLOCK_COLUMNS.map((column) => row[column])))],
    },
    { sql: 'INSERT INTO blocks_fts (rowid, text) SELECT id, text FROM blocks WHERE id IN (SELECT value FROM json_each(?))',
      params: [ids] },
  ]);
}

async function nativeSnapshot(db) {
  const results = await db.database.batch([
    'SELECT * FROM blocks ORDER BY id',
    'SELECT * FROM blocks_fts_data ORDER BY id',
    'SELECT * FROM blocks_fts_idx ORDER BY segid, term',
  ].map((sql) => db.database.prepare(sql)));
  return { blocks: results[0].results, ftsData: results[1].results, ftsIndex: results[2].results };
}

function nativeDenseRows(count, { tokenizerBoundaries = false } = {}) {
  const session_id = sessionOn(1);
  const cases = tokenizerBoundaries ? nativeTokenizerBoundaryCases() : [];
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1, session_id, file_id: 0, turn_index: 0, block_index: index,
    role: null, btype: 'text', tool_name: null, ts: '', byte_start: 0, byte_len: 0,
    truncated: 0, text: cases[index]?.only ? cases[index].text
      : `${cases[index]?.text ?? (tokenizerBoundaries ? `v${index}` : 'nativedensevisible')}\u0000 nativedensesuffix`,
    on_main_path: 1,
    row_hash: index + 1, media_byte_start: null, media_byte_len: 0, media_type: '',
  }));
}

function insert(db, table, columns, row) {
  db.database.prepare(`INSERT INTO ${quoted(table)} (${columns.map(quoted).join(',')})
    VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map((column) => row[column]));
}

function sessionOn(shard) {
  for (let index = 0; ; index += 1) {
    const sid = `copier-会話-${shard}-${index}`;
    if (indexShardForSessionId(sid, 2) === shard) return sid;
  }
}

function block(id, shard = id % 2, overrides = {}) {
  return {
    id, session_id: sessionOn(shard), file_id: 4_294_967_297,
    turn_index: id % 19, block_index: id % 7, role: 'assistant', btype: 'text',
    tool_name: null, ts: '2026-10-08T04:58:19.123Z', byte_start: 4_294_967_311,
    byte_len: 123_457, truncated: 0, text: `needle_${id} café 会話 Ελληνικά résumé a.b-c_d`,
    on_main_path: id % 2, row_hash: 4_294_967_295, media_byte_start: null,
    media_byte_len: null, media_type: null, ...overrides,
  };
}

function seedBlocks(source, rows, columns = BLOCK_COLUMNS) {
  source.database.exec('BEGIN');
  try {
    for (const row of rows) {
      insert(source, 'blocks', columns, row);
      source.database.prepare('INSERT INTO blocks_fts (rowid, text) VALUES (?, ?)').run(row.id, row.text);
    }
    source.database.exec('COMMIT');
  } catch (error) {
    source.database.exec('ROLLBACK');
    throw error;
  }
}

function nativeTokenizerBoundaryCases() {
  return [
    ...['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].map((word) => ({
      text: `nativevaried${word}`, tokens: [`nativevaried${word}`],
    })),
    { text: '🫠alpha', tokens: ['🫠alpha'], absent: ['alpha'] },
    { text: '🫠 alpha', tokens: ['🫠', 'alpha'] },
    { text: '🧮alpha', tokens: ['🧮alpha'], absent: ['alpha'] },
    { text: '🧠alpha', tokens: ['🧠alpha'], absent: ['alpha'] },
    { text: '🛠alpha', tokens: ['🛠alpha'], absent: ['alpha'] },
    { text: 'al🫠pha', tokens: ['al🫠pha'], absent: ['al', 'pha'] },
    { text: '₿alpha', tokens: ['₿alpha'], absent: ['alpha'] },
    { text: '\u{1CF00}alpha', tokens: ['\u{1CF00}alpha'], absent: ['alpha'] },
    { text: '🫠', tokens: ['🫠'], absent: ['index-migration-tokenless-probe', 'alpha'], only: true },
    { text: '! ? : ; ( ) [ ] { } \t\n\u0000', tokens: [],
      absent: ['index-migration-tokenless-probe', '🫠', 'alpha'], only: true },
    ...[`a${'中'.repeat(11000)}`, `a${'🫠'.repeat(8250)}`,
      `a${'Ж'.repeat(16500)}`, `a${'ø'.repeat(16500)}`].map((text) => ({
      text, tokens: [text], only: true,
    })),
  ];
}

async function assertNativeTokenizerBoundaryMatches(db, rows) {
  for (const [index, { tokens, absent = [] }] of nativeTokenizerBoundaryCases().entries()) {
    const row = rows[index];
    for (const [terms, present] of [[tokens, true], [absent, false]]) {
      for (const term of terms) {
        assert.deepEqual(await db.rows(
          'SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ? AND rowid = CAST(? AS INTEGER)',
          [`"${term.replaceAll('"', '""')}"`, row.id],
        ), present ? [{ rowid: row.id }] : [],
        'native whole terms and old alpha/al misses must agree on actual source and destination postings');
      }
    }
  }
}

function nativeLongWordCases() {
  // These original full words use the reviewer's actual 40k/45k native geometries.
  // No expectation is computed from the copier's repaired or truncated probe.
  const cjk = '中'.repeat(15000);
  const emoji = '🫠'.repeat(10000);
  return [
    { name: 'cjk-notail-cut1', text: `a${cjk}`, tokens: [`a${cjk}`] },
    { name: 'cjk-notail-cut2', text: `abc${cjk}`, tokens: [`abc${cjk}`] },
    { name: 'cjk-tail', text: `a${cjk} tail`, tokens: [`a${cjk}`, 'tail'] },
    { name: 'modernemoji-notail-cut3', text: `a${emoji}`, tokens: [`a${emoji}`] },
    { name: 'modernemoji-notail-cut2', text: `ab${emoji}`, tokens: [`ab${emoji}`] },
    { name: 'modernemoji-notail-cut1', text: `abc${emoji}`, tokens: [`abc${emoji}`] },
    { name: 'modernemoji-tail', text: `a${emoji} tail`, tokens: [`a${emoji}`, 'tail'] },
    { name: 'cyrillic-lower-notail', text: `a${'ж'.repeat(20000)}`, tokens: [`a${'ж'.repeat(20000)}`] },
    { name: 'cyrillic-upper-fold-changing-notail', text: `a${'Ж'.repeat(20000)}`,
      tokens: [`a${'Ж'.repeat(20000)}`, `a${'ж'.repeat(20000)}`] },
    { name: 'oslash-notail', text: `a${'ø'.repeat(20000)}`, tokens: [`a${'ø'.repeat(20000)}`] },
    { name: 'control-ascii-notail', text: 'a'.repeat(40000), tokens: ['a'.repeat(40000)] },
    { name: 'control-fold-eacute-notail', text: `a${'é'.repeat(20000)}`,
      tokens: [`a${'é'.repeat(20000)}`, `a${'e'.repeat(20000)}`] },
    { name: 'control-ascii-then-eacute-tail', text: `${'x'.repeat(32767)}éy tail`,
      tokens: [`${'x'.repeat(32767)}éy`, 'tail'] },
    { name: 'control-cjk-validutf8-aligned-notail', text: `ab${cjk}`, tokens: [`ab${cjk}`] },
  ];
}

async function storedBlockSnapshot(db) {
  return db instanceof SqliteD1 ? blockSnapshot(db) : nativeSnapshot(db);
}

async function assertNativeLongWordIdentity(db, row, tokens, { posting = true } = {}) {
  const stored = await db.rows('SELECT * FROM blocks WHERE id = ?', [row.id]);
  assert.deepEqual(stored, [row], 'all 18 original columns must survive native storage and copy');
  const [bytes] = await db.rows('SELECT hex(CAST(text AS BLOB)) AS bytes FROM blocks WHERE id = ?', [row.id]);
  assert.equal(bytes.bytes, Buffer.from(row.text).toString('hex').toUpperCase(),
    'native storage must preserve every byte of the original full valid UTF-8 word');
  assert.equal(rowDigest(BLOCK_COLUMNS, stored[0]), sha256(JSON.stringify(BLOCK_COLUMNS.map((column) => row[column]))),
    'full-row SHA must include all 18 columns, not only the indexed word');
  for (const term of tokens) {
    assert.deepEqual(await db.rows(
      'SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ? AND rowid = CAST(? AS INTEGER)',
      [`"${term.replaceAll('"', '""')}"`, row.id],
    ), posting ? [{ rowid: row.id }] : [],
    'independent native MATCH must use the original whole valid word, including native folding');
  }
}

function blockSnapshot(db) {
  return {
    blocks: db.rows('SELECT * FROM blocks ORDER BY id'),
    // External-content SELECT/count alone cannot reveal missing or duplicate postings.
    ftsData: db.rows('SELECT * FROM blocks_fts_data ORDER BY id'),
    ftsIndex: db.rows('SELECT * FROM blocks_fts_idx ORDER BY segid, term'),
  };
}

function nativeSourceTokenRows(source) {
  // Read independent physical row membership, not the copier's tokenizer or a JS
  // Unicode approximation. Raw terms may end in partial UTF-8; never decode them into MATCH probes.
  // This TEMP view does not mutate legacy FTS pages.
  source.database.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS temp.__test_source_fts_vocab
    USING fts5vocab(main, blocks_fts, 'instance')`);
  return new Set(source.rows(`SELECT doc FROM temp.__test_source_fts_vocab
    WHERE col = 'text' AND offset = 0 ORDER BY doc`).map(({ doc }) => doc));
}

function assertCopied(f, rows) {
  assert.deepEqual(f.source.rows('SELECT * FROM blocks'), []);
  for (let index = 0; index < f.shards.length; index += 1) {
    const shard = f.shards[index];
    const expected = rows.filter((row) => indexShardForSessionId(row.session_id, f.shards.length) === index)
      .sort((left, right) => left.id - right.id);
    assert.deepEqual(shard.rows('SELECT * FROM blocks ORDER BY id'), expected);
    shard.database.exec("INSERT INTO blocks_fts (blocks_fts, rank) VALUES ('integrity-check', 1)");
  }
}

function sourceWrites(f) {
  return f.trace.filter((event) => event.db === f.source.id && event.sql && isWrite(event.sql));
}

function assertAtomicBlockBatches(f) {
  const batches = f.trace.filter((event) => event.kind === 'batch'
    && event.statements.some(({ sql }) => /\bINSERT\s+INTO\s+"?blocks"?\s*\(/i.test(sql)));
  assert.ok(batches.length > 0, 'the real destination must receive block batches');
  for (const batch of batches) {
    assert.ok(batch.statements.some(({ sql }) => /\bINSERT\s+INTO\s+blocks_fts\b/i.test(sql)),
      'each block mutation batch must also mutate its FTS index');
    const statements = f.trace.filter((event) => event.kind === 'batch-statement'
      && event.transaction === batch.transaction);
    assert.equal(statements.length, batch.statements.length);
    assert.equal(new Set(statements.map(({ transaction }) => transaction)).size, 1);
  }
  return batches;
}

function destinationBatchCount(f) {
  return f.trace.filter((event) => event.kind === 'batch' && event.db !== f.source.id
    && event.statements.some(({ sql }) => isWrite(sql))).length;
}

// Inspect successful adapter evidence, independently decoding the raw transport.
// In-process adapters return mutable rows while REST serializes them before the
// copier decodes them; neither boundary may replace full readback with an ID hit.
function hasVerifiedReadback(f, checkpoint, item) {
  const shard = f.shards[item.shard];
  return f.trace.some((event) => event.db === shard.id && event.success
    && ['query', 'batch-statement'].includes(event.kind) && selectsTable(event.sql, 'blocks')
    && event.rows.some((stored) => {
      if (stored.id !== item.id || !Object.hasOwn(stored, 'text')) return false;
      const row = {};
      for (const [index, column] of checkpoint.columns.entries()) {
        let value = stored[column];
        const marker = `__long_${index}`;
        if (Object.hasOwn(stored, marker) && Number.isSafeInteger(stored[marker]) && stored[marker] >= 0) {
          const length = stored[marker];
          let bytes;
          if (typeof value === 'string' && value.length === length * 2 && /^(?:[0-9a-f]{2})*$/i.test(value)) {
            bytes = Buffer.from(value, 'hex');
          } else if (value === null) {
            const slices = f.trace.slice(f.trace.indexOf(event) + 1).filter((part) =>
              part.db === shard.id && part.success && part.params?.length === 3
              && part.sql.includes(`CAST(${quoted(column)} AS BLOB)`)
              && typeof part.params[2] === 'string'
              && JSON.parse(part.params[2]).includes(item.id) && part.rows?.length === 1
              && typeof part.rows[0].bytes === 'string');
            const chunks = [];
            let offset = 0;
            for (const part of slices) {
              if (part.params[0] !== offset + 1 || part.rows[0].bytes.length !== part.params[1] * 2) continue;
              chunks.push(Buffer.from(part.rows[0].bytes, 'hex'));
              offset += part.params[1];
              if (offset >= length) break;
            }
            if (offset !== length) return false;
            bytes = Buffer.concat(chunks);
          } else return false;
          try { value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
          catch { value = { x: bytes.toString('hex') }; }
        }
        row[column] = value;
      }
      return rowDigest(checkpoint.columns, row) === item.sha256;
    }));
}

function assertVerifiedBeforeDelete(f) {
  const tokenRows = nativeSourceTokenRows(f.source);
  let verifiedRows = 0;
  const beforeSourceStatement = ({ sql }) => {
    if (!isWrite(sql)) return;
    const deletingBlock = /\bDELETE\s+FROM\s+"?blocks"?\b/i.test(sql);
    if (!deletingBlock) {
      assert.ok(sql.includes(SOURCE_FREEZE_TABLE) || /\bindex_migration_blocks_(?:insert|update|delete)\b/i.test(sql),
        'the only additional source writes may install or transact the persistent blocks writer barrier');
      const saved = JSON.parse(f.shards[0].rows(
        'SELECT value FROM index_migration_state WHERE name = ?', [COPY_CHECKPOINT],
      )[0].value);
      assert.equal(saved.pending?.phase, 'verified', 'source barrier writes also require durable row verification');
      return;
    }
    const checkpoint = JSON.parse(f.shards[0].rows(
      'SELECT value FROM index_migration_state WHERE name = ?', [COPY_CHECKPOINT],
    )[0].value);
    assert.equal(checkpoint.pending.phase, 'verified', 'verification must be durable BEFORE deletion');
    for (const item of checkpoint.pending.rows) {
      const shard = f.shards[item.shard];
      assert.ok(hasVerifiedReadback(f, checkpoint, item),
        `block ${item.id} must have a successful full-row adapter readback before source deletion`);
      const hasToken = tokenRows.has(item.id);
      assert.ok(f.trace.some((event) => event.db === shard.id && ['query', 'batch-statement'].includes(event.kind)
        && event.success && /\bMATCH\b/i.test(event.sql)
        && JSON.parse(event.params[0]).some(([, id]) => id === item.id)
        && event.rows.some((row) => row.rowid === item.id) === hasToken),
      `successful adapter FTS MATCH for block ${item.id} must precede source deletion`);
    }
    verifiedRows += checkpoint.pending.rows.length;
  };
  f.source.beforeQuery = beforeSourceStatement;
  f.source.beforeStatement = beforeSourceStatement;
  return () => verifiedRows;
}

test('native SQLite transport reads stored UTF-8 past NUL without coercing scalar or BLOB types', async (context) => {
  const f = await fixture(context);
  const text = '\u0000transport_head 😀 e\u0301\u0000会話\ntransport_tail\u0000';
  const row = block(0, 0, { text, role: '', tool_name: null, byte_start: 0, row_hash: Number.MAX_SAFE_INTEGER });
  seedBlocks(f.source, [row]);
  assert.deepEqual(f.source.rows('SELECT * FROM blocks'), [row]);
  assert.deepEqual(await f.source.query('SELECT * FROM blocks'), [row]);
  const readback = await f.source.batch([{ sql: 'SELECT * FROM blocks', params: [] }]);
  assert.deepEqual(readback[0].results, [row]);
  const stored = f.source.rows('SELECT CAST(text AS BLOB) AS bytes FROM blocks')[0].bytes;
  assert.deepEqual(Buffer.from(stored), Buffer.from(text), 'expectations must match actual SQLite bytes, not a cached fixture');
  const [sizes] = await f.source.query(`SELECT length(text) AS text_length,
    length(CAST(text AS BLOB)) AS byte_length, json_quote(text) AS encoded,
    length(CAST(json_quote(text) AS BLOB)) AS json_bytes FROM blocks`);
  assert.equal(sizes.text_length, 0, 'native TEXT length stops at the leading NUL');
  assert.equal(sizes.byte_length, Buffer.byteLength(text));
  assert.equal(JSON.parse(sizes.encoded), text, 'JSON1 must escape every NUL and retain its suffix');
  assert.equal(sizes.json_bytes, Buffer.byteLength(JSON.stringify(text)));
  const binary = new Uint8Array([0, 255, 65, 0]);
  const [scalars] = await f.source.query(`SELECT ? AS text, ? AS binary, ? AS nil,
    ? AS empty, ? AS zero, ? AS integer, ? AS real`, [text, binary, null, '', 0, Number.MAX_SAFE_INTEGER, 0.125]);
  assert.equal(scalars.text, text);
  assert.deepEqual(scalars.binary, binary);
  assert.deepEqual({ ...scalars, text: undefined, binary: undefined },
    { text: undefined, binary: undefined, nil: null, empty: '', zero: 0, integer: Number.MAX_SAFE_INTEGER, real: 0.125 });
  assert.deepEqual(await f.source.query(`SELECT typeof(?) AS zero_type, typeof(?) AS id_type,
    typeof(?) AS max_type, typeof(?) AS real_type`, [0, 600, Number.MAX_SAFE_INTEGER, 0.125]),
  [{ zero_type: 'integer', id_type: 'integer', max_type: 'integer', real_type: 'real' }],
  'native D1 transport must preserve integer binds as INTEGER and fractional binds as REAL');
  f.restart();
  assert.deepEqual(f.source.rows('SELECT * FROM blocks'), [row], 'reopened transport must recover all stored bytes');
});

test('checkpoint reads distinguish missing rows from persisted JSON null, primitives and arrays', async (context) => {
  const f = await fixture(context);
  const db = f.shards[0];
  for (const name of [COPY_CHECKPOINT, SEED_CHECKPOINT, READY_CHECKPOINT, ACTIVATION_CHECKPOINT]) {
    assert.equal(await readCheckpoint(db, name), null);
    for (const raw of ['null', 'false', 'true', '0', '"complete"', '[]', '[{}]']) {
      db.database.prepare(`INSERT INTO index_migration_state (name, value) VALUES (?, ?)
        ON CONFLICT (name) DO UPDATE SET value = excluded.value`).run(name, raw);
      await assert.rejects(readCheckpoint(db, name), /invalid index migration checkpoint payload/);
      assert.deepEqual(db.rows('SELECT name, value FROM index_migration_state WHERE name = ?', [name]),
        [{ name, value: raw }], 'invalid persisted payloads must remain intact, not be mistaken for absent checkpoints');
    }
    const object = { state: 'pending', pending: null, counter: 0 };
    await writeCheckpoint(db, name, object);
    assert.deepEqual(await readCheckpoint(db, name), object, 'nested null fields inside a checkpoint object remain valid JSON transport');
    db.database.prepare('DELETE FROM index_migration_state WHERE name = ?').run(name);
    assert.equal(await readCheckpoint(db, name), null, 'physical absence is the only missing-checkpoint representation');
  }
});

test('canonical rows preserve column order, every column, null/empty, Unicode and exact numeric types', () => {
  const row = block(INDEX_ID_SPAN - 1, 0, {
    role: '', tool_name: null, text: '😀 e\u0301\n\"\\\u0000', row_hash: Number.MAX_SAFE_INTEGER,
    byte_start: 0, byte_len: Number.MAX_SAFE_INTEGER, media_byte_start: 2 ** 40 + 17,
    media_byte_len: 0, media_type: '',
  });
  assert.equal(canonicalRow(BLOCK_COLUMNS, row), JSON.stringify(BLOCK_COLUMNS.map((column) => row[column])));
  assert.equal(rowDigest(BLOCK_COLUMNS, row), sha256(canonicalRow(BLOCK_COLUMNS, row)));
  assert.deepEqual(JSON.parse(canonicalRow(BLOCK_COLUMNS, row)), BLOCK_COLUMNS.map((column) => row[column]));
  for (const column of BLOCK_COLUMNS) {
    const value = row[column];
    const replacement = value === null ? '' : typeof value === 'number' ? value - 1 : `${value} changed`;
    assert.notEqual(rowDigest(BLOCK_COLUMNS, { ...row, [column]: replacement }), rowDigest(BLOCK_COLUMNS, row), column);
  }
  assert.notEqual(rowDigest(['value'], { value: null }), rowDigest(['value'], { value: '' }));
  assert.notEqual(rowDigest(['value'], { value: 0 }), rowDigest(['value'], { value: '0' }));
  assert.equal(canonicalRow(['real', 'integer'], { integer: -42, real: 0.125 }), '[0.125,-42]');
  assert.equal(rowDigest(BLOCK_COLUMNS, { ...row, ignored: 'not a column' }), rowDigest(BLOCK_COLUMNS, row));
  assert.notEqual(rowDigest([...BLOCK_COLUMNS].reverse(), row), rowDigest(BLOCK_COLUMNS, row));
});

test('canonical rows reject omitted, unsupported and unsafe values instead of silently normalizing them', () => {
  assert.throws(() => canonicalRow(['missing'], {}), /omitted column/);
  for (const value of [undefined, true, 1n, new Uint8Array([1]), {}, []]) {
    assert.throws(() => canonicalRow(['value'], { value }), /unsupported D1 value/);
  }
  for (const value of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, -(Number.MAX_SAFE_INTEGER + 1)]) {
    assert.throws(() => rowDigest(['value'], { value }), /unsafe D1 number/);
  }
});

test('maintenance health fails closed unless mode, revision, count and production health match exactly', () => {
  assert.doesNotThrow(() => assertMaintenanceHealth(health, revision, 2));
  for (const bad of [null, undefined, {},
    { ...health, ok: false }, { ...health, ok: 'true' },
    { ...health, environment: 'preview' }, { ...health, indexMode: 'active' },
    { ...health, indexMode: 'Maintenance' }, { ...health, deploymentRevision: `${revision}-old` },
    { ...health, indexShardCount: 16 }, { ...health, indexShardCount: '2' },
    ...Object.keys(health).map((key) => Object.fromEntries(Object.entries(health).filter(([name]) => name !== key))),
  ]) assert.throws(() => assertMaintenanceHealth(bad, revision, 2), /refusing index writes/);
  assert.throws(() => assertMaintenanceHealth(health, `${revision}-next`, 2), /refusing index writes/);
  assert.throws(() => assertMaintenanceHealth(health, revision, 16), /refusing index writes/);
});

test('maintenance gate refusal performs no source or destination calls', async (context) => {
  const f = await fixture(context);
  seedBlocks(f.source, [block(1)]);
  await assert.rejects(copyFrozenIndex(f.args({ gate: async () => {
    assertMaintenanceHealth({ ...health, indexMode: 'active' }, revision, 2);
  } })), /refusing index writes/);
  assert.deepEqual(f.trace, []);
  assert.equal(f.source.rows('SELECT COUNT(*) AS n FROM blocks')[0].n, 1);
});

test('shard layout initialization is immutable and preserves an already advanced allocator', async (context) => {
  const f = await fixture(context);
  f.shards[1].database.prepare('UPDATE shard_meta SET next_block_id = ? WHERE id = 1').run(indexIdBase(1) + 97);
  await initializeShardLayouts(f.shards);
  for (let index = 0; index < 2; index += 1) {
    assert.deepEqual(f.shards[index].rows('SELECT * FROM shard_meta'), [{
      id: 1, shard_index: index, shard_count: 2, layout: INDEX_LAYOUT,
      next_block_id: indexIdBase(index) + (index === 1 ? 97 : 0),
    }]);
  }
  await assert.rejects(initializeShardLayouts([...f.shards].reverse()), /immutable shard layout mismatch/);
  await assert.rejects(initializeShardLayouts([f.shards[0]]), /immutable shard layout mismatch/);
});

test('wrong layout metadata and exhausted or out-of-range allocators fail closed without repair', async (context) => {
  for (const [column, value] of [
    ['layout', `${INDEX_LAYOUT}-changed`], ['shard_index', 1], ['shard_count', 16],
    ['next_block_id', indexIdBase(0) - 1], ['next_block_id', indexIdBase(0) + INDEX_ID_SPAN],
  ]) await context.test(`${column}=${value}`, async (child) => {
    const f = await fixture(child);
    f.shards[0].database.prepare(`UPDATE shard_meta SET ${quoted(column)} = ? WHERE id = 1`).run(value);
    const before = f.shards[0].rows('SELECT * FROM shard_meta');
    await assert.rejects(initializeShardLayouts(f.shards), /immutable shard layout mismatch/);
    assert.deepEqual(f.shards[0].rows('SELECT * FROM shard_meta'), before);
    assert.deepEqual(sourceWrites(f), []);
  });
});

test('full-fidelity copy retains long Unicode text, all columns and FTS beyond former text caps', async (context) => {
  const f = await fixture(context);
  const longText = `\uFEFFlong_head α😀 café 会話\n${'naïve e\u0301 Ελληνικά 😀\u0000\n'.repeat(40_000)}long_tail_unique`;
  assert.ok(Buffer.byteLength(longText) > 1024 * 1024);
  assert.ok(Buffer.byteLength(longText) < 2_000_000, 'fixture must remain a valid D1 scalar while exceeding a REST read page');
  const rows = [
    block(1, 0, { text: longText, byte_len: Buffer.byteLength(longText), on_main_path: 0, row_hash: Number.MAX_SAFE_INTEGER }),
    block(2, 1, { role: null, tool_name: '', text: null, byte_start: null, byte_len: null, row_hash: 0 }),
    block(3, 0, { role: '', text: '', ts: null, media_byte_start: 2 ** 40 + 123, media_byte_len: 0, media_type: '' }),
    block(4, 1, { btype: 'image', text: null, media_byte_start: 4_294_967_319, media_byte_len: 987_654, media_type: 'image/png' }),
    ...Array.from({ length: 20 }, (_, index) => block(index + 5)),
    block(INDEX_ID_SPAN - 1, 1, { text: 'last_legacy_id 私用\uE000 token_with-dot.name' }),
  ];
  seedBlocks(f.source, rows);
  assert.deepEqual(f.source.rows('SELECT * FROM blocks ORDER BY id'), rows,
    'source expectations must retain the complete original UTF-8 values, including BOM and NUL suffixes');
  const deletes = assertVerifiedBeforeDelete(f);
  const checkpoints = [];
  const result = await copyFrozenIndex(f.args({ checkpointHook: (state) => checkpoints.push(state) }));
  assert.equal(result.state, 'complete');
  assert.equal(result.rows, rows.length);
  assert.equal(result.after, INDEX_ID_SPAN - 1);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assertCopied(f, rows);
  assert.deepEqual(f.shards[0].rows('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ?', ['"long_tail_unique"']), [{ rowid: 1 }]);
  assert.equal(deletes(), rows.length, 'every deleted source tuple must have durable full-row and FTS readback proof');
  const sourcePages = f.trace.filter((event) => event.db === f.source.id && event.kind === 'batch');
  assert.ok(sourcePages.length >= 2, 'byte bounds must separate the oversized row from ordinary deletion pages');
  const copying = checkpoints.filter((state) => state.pending?.phase === 'copying');
  assert.deepEqual(copying[0].pending.rows.map(({ id }) => id), [1], 'oversized single row is preserved, never split or truncated');
  assert.ok(copying.every((state) => state.pending.rows.length <= 2048));
  const byteSlices = f.trace.filter((event) => event.kind === 'query' && event.success
    && event.rows?.some((row) => typeof row.bytes === 'string'));
  assert.ok(byteSlices.length > 4, 'large text must travel as multiple bounded byte slices');
  assert.ok(f.trace.filter((event) => event.kind === 'query' && event.success)
    .every((event) => event.responseBytes <= 1024 * 1024), 'no readback response may exceed the bounded REST page');
  assertAtomicBlockBatches(f);
  assert.ok(!sourceWrites(f).some(({ sql }) => /\bblocks_fts\b/i.test(sql)), 'legacy source FTS must never receive DML');
  assert.deepEqual(f.source.rows(`SELECT * FROM ${SOURCE_FREEZE_TABLE}`), [{ id: 1, state: 'frozen' }]);
  assert.equal((await readCheckpoint(f.shards[0], COPY_CHECKPOINT)).state, 'complete');
});

test('ordinary NUL-rich rows preserve JSON1 text and bound pages by escaped UTF-8 bytes', async (context) => {
  const f = await fixture(context);
  const rows = Array.from({ length: 4 }, (_, index) => block(501 + index, 0, {
    text: `json_nul_head_${index} ${'\u0000'.repeat(60_000)} json_nul_tail_${index}`,
  }));
  seedBlocks(f.source, rows);
  assert.deepEqual(f.source.rows('SELECT * FROM blocks ORDER BY id'), rows);
  assert.deepEqual(f.source.rows(`SELECT id, length(CAST(json_quote(text) AS BLOB)) AS bytes
    FROM blocks ORDER BY id`), rows.map(({ id, text }) => ({ id, bytes: Buffer.byteLength(JSON.stringify(text)) })));
  assertVerifiedBeforeDelete(f);
  const pages = [];
  const result = await copyFrozenIndex(f.args({ checkpointHook: (state) => {
    if (state.pending?.phase === 'copying') pages.push(state.pending.rows);
  } }));
  assert.equal(result.state, 'complete');
  assert.equal(result.rows, rows.length);
  assert.ok(pages.length > 1, 'NUL escape expansion, not raw TEXT length, must split the bounded response pages');
  assertCopied(f, rows);
  for (let index = 0; index < rows.length; index += 1) {
    assert.deepEqual(f.shards[0].rows('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ?',
      [`"json_nul_tail_${index}"`]), [{ rowid: rows[index].id }], 'FTS must retain tokens after embedded NULs');
  }
  assertNativeRequestLimits(f);
  for (const batch of assertAtomicBlockBatches(f)) assert.equal(batch.statements.length, 4);
});

test('shared first MATCH terms with embedded NUL copy exactly and retire source rows on the same and different shards', async (context) => {
  for (const distribution of ['same-shard', 'across-shards']) {
    await context.test(distribution, async (child) => {
      const f = await fixture(child);
      for (const db of [f.source, ...f.shards]) {
        db.database.exec('ALTER TABLE blocks ADD COLUMN future_text TEXT; ALTER TABLE blocks ADD COLUMN future_real REAL');
      }
      const columns = [...BLOCK_COLUMNS, 'future_text', 'future_real'];
      const untouched = block(599, 0, { future_text: '', future_real: null });
      // Retain the original CAS matrix's pre-mutation shared-term/NUL values,
      // column width and numeric/null edges.
      const originals = columns.filter((column) => column !== 'id').map((_, index) =>
        block(600 + index, distribution === 'same-shard' ? 0 : index % 2, {
          role: '', tool_name: null, ts: null, byte_start: 0, byte_len: Number.MAX_SAFE_INTEGER,
          text: 'all_columns_cas_needle\u0000original_tail', on_main_path: 0,
          future_text: 'future_prefix\u0000original_tail', future_real: 0.125,
        }));
      const rows = [untouched, ...originals];
      const assertStoredRows = (db, expected) => {
        assert.deepEqual(db.rows('SELECT * FROM blocks ORDER BY id'), expected);
        assert.deepEqual(db.rows(`SELECT id, CAST(text AS BLOB) AS text_bytes,
          CAST(future_text AS BLOB) AS future_bytes FROM blocks ORDER BY id`).map((row) => ({
          id: row.id, text_bytes: Buffer.from(row.text_bytes), future_bytes: Buffer.from(row.future_bytes),
        })), expected.map((row) => ({
          id: row.id, text_bytes: Buffer.from(row.text), future_bytes: Buffer.from(row.future_text),
        })), 'full native stored bytes must agree with the originals, including both NUL suffixes');
      };
      const assertSharedMatches = (db, expected) => {
        const ids = expected.filter((row) => row.id !== untouched.id).map(({ id }) => ({ rowid: id }));
        for (const token of ['all_columns_cas_needle', 'original_tail']) {
          assert.deepEqual(db.rows('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ? ORDER BY rowid',
            [`"${token}"`]), ids, 'shared first terms and after-NUL terms must expose each real row once');
          for (const { rowid } of ids) {
            assert.deepEqual(db.rows('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ? AND rowid = ?',
              [`"${token}"`, rowid]), [{ rowid }], 'each real MATCH probe must retain its requested row identity');
          }
        }
      };
      seedBlocks(f.source, rows, columns);
      assertStoredRows(f.source, rows);
      assertSharedMatches(f.source, rows);
      const protectedRows = assertVerifiedBeforeDelete(f);
      let verifiedBeforeRetirement = false;
      const copied = await copyFrozenIndex(f.args({ checkpointHook: (state) => {
        if (state.pending?.phase !== 'verified') return;
        verifiedBeforeRetirement = true;
        assertStoredRows(f.source, rows);
        for (let index = 0; index < f.shards.length; index += 1) {
          const expected = rows.filter((row) => indexShardForSessionId(row.session_id, 2) === index);
          assertStoredRows(f.shards[index], expected);
          assertSharedMatches(f.shards[index], expected);
        }
      } }));
      assert.equal(verifiedBeforeRetirement, true, 'shared-token identity verification must finish before any source retirement');
      assert.equal(copied.state, 'complete');
      assert.equal(copied.rows, rows.length);
      assert.equal(protectedRows(), rows.length);
      assertCopied(f, rows);
      assert.deepEqual(f.source.rows(`SELECT * FROM ${SOURCE_FREEZE_TABLE}`), [{ id: 1, state: 'frozen' }]);
      assert.equal((await readCheckpoint(f.shards[0], COPY_CHECKPOINT)).state, 'complete');
      const matchRows = f.trace.filter((event) => event.db !== f.source.id
        && ['query', 'batch-statement'].includes(event.kind) && /\bMATCH\b/i.test(event.sql));
      assert.ok(matchRows.every((event) => event.success), 'native grouped shared-token probes must all succeed');
      assert.deepEqual(matchRows.flatMap((event) => event.rows.map(({ rowid }) => rowid)).sort((a, b) => a - b),
        rows.map(({ id }) => id), 'grouping must not duplicate, lose or substitute any requested row identity');
      const snapshots = f.shards.map(blockSnapshot);
      f.trace.length = 0;
      const evidence = await verifyIndexRecords({ source: f.source, shards: f.shards, catalogConsistency: 'required' });
      assert.deepEqual(evidence, {
        mainSessions: 0, mainStars: 0,
        shards: f.shards.map((_db, index) => {
          const expected = rows.filter((row) => indexShardForSessionId(row.session_id, 2) === index);
          return {
            shard: index, blockCount: expected.length, sessionCount: 0, starCount: 0,
            blockSampleSha256: sha256(JSON.stringify(expected.slice(0, 4).map((row) => canonicalRow(columns, row)))),
            catalogSampleSha256: sha256('[]'),
          };
        }),
      }, 'readonly consumer evidence must preserve full-column identities for shared-token samples too');
      assertReadonlyEvidenceCalls(f);
      assert.deepEqual(f.shards.map(blockSnapshot), snapshots);
    });
  }
});

test('actual copier MATCH SQL preserves shared-term row identities with uncoerced native parameters', async (context) => {
  const f = await fixture(context);
  const rows = Array.from({ length: 100 }, (_, index) => block(40_001 + index, index % 2, {
    text: 'native_binding_probe\u0000shared_tail 会話',
  }));
  seedBlocks(f.source, rows);
  let nativeMatchCalls = 0;
  for (const shard of f.shards) {
    const execute = shard.execute.bind(shard);
    // Only the numeric-only MATCH result transport uses Node's native Number bindings.
    // Execute the producer's SQL unchanged against the real FTS index; never echo hits.
    shard.execute = (sql, params) => {
      if (!/\bMATCH\b/i.test(sql)) return execute(sql, params);
      nativeMatchCalls += 1;
      // Do not normalize bindings or substitute results for the producer's query.
      return shard.database.prepare(sql).all(...params).map((row) => ({ ...row }));
    };
  }
  const protectedRows = assertVerifiedBeforeDelete(f);
  const copied = await copyWithNativeParameters(f.args());
  assert.equal(copied.state, 'complete');
  assert.equal(copied.rows, rows.length);
  assert.equal(protectedRows(), rows.length);
  assert.ok(nativeMatchCalls > 0);
  assertCopied(f, rows);
  const matches = f.trace.filter((event) => ['query', 'batch-statement'].includes(event.kind)
    && event.db !== f.source.id && /\bMATCH\b/i.test(event.sql));
  assert.deepEqual(matches.flatMap((event) => event.rows.map(({ rowid }) => rowid)).sort((a, b) => a - b),
    rows.map(({ id }) => id), 'shared terms must return each requested identity exactly once even with native SDK Number bindings');
  assertNativeRequestLimits(f);
  f.trace.length = 0;
  const evidence = await verifyIndexRecords({ source: f.source, shards: f.shards, catalogConsistency: 'required' });
  assert.deepEqual(evidence.shards.map(({ blockCount }) => blockCount), [50, 50]);
  assertReadonlyEvidenceCalls(f);
});

test('native workerd actual copier tokenizer boundaries verify 1461 same-shard rows before source acknowledgment', async (context) => {
  const f = await workerdFixture(context);
  const rows = nativeDenseRows(1461, { tokenizerBoundaries: true });
  const boundaryCases = nativeTokenizerBoundaryCases();
  const ids = rows.map(({ id }) => id);
  const outside = { ...rows[0], id: 1462, block_index: 1462, row_hash: 1462 };
  await seedWorkerdBlocks(f.source, rows);
  await seedWorkerdBlocks(f.shards[1], [outside]);
  const before = await nativeSnapshot(f.source);
  assert.deepEqual(before.blocks, rows, 'native source must store every complete tuple, including text past NUL');
  await assertNativeTokenizerBoundaryMatches(f.source, rows);
  f.trace.length = 0;
  let verifiedBeforeAck = false;
  let acknowledgedRows = 0;
  const beforeSourceWrite = async ({ sql }) => {
    if (!isWrite(sql)) return;
    assert.equal(verifiedBeforeAck, true, 'full-row and FTS proof must precede all source writes');
    const durable = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
    assert.equal(durable.pending?.phase, 'verified', 'the native verified checkpoint must be durable before source writes');
    assert.deepEqual(durable.pending.rows.map(({ id }) => id), ids);
    if (/\bDELETE\s+FROM\s+"?blocks"?\b/i.test(sql)) acknowledgedRows += durable.pending.rows.length;
  };
  f.source.beforeQuery = beforeSourceWrite;
  f.source.beforeStatement = beforeSourceWrite;
  // The historical-module seam must execute the actual older copier and expose
  // its Unicode-version mismatch, not substitute the current implementation.
  const copied = await copyWithNativeParameters(f.args({ checkpointHook: async (state) => {
    if (state.pending?.phase !== 'verified') return;
    assert.deepEqual(state.pending.rows.map(({ id }) => id), ids, 'the dense fixture must be verified as one complete source page');
    assert.deepEqual(await nativeSnapshot(f.source), before, 'verification must not acknowledge or mutate source data');
    assert.deepEqual((await nativeSnapshot(f.shards[0])).blocks, []);
    const destination = (await nativeSnapshot(f.shards[1])).blocks;
    assert.deepEqual(destination, [...rows, outside], 'native full-row readback must preserve the outside row and every copied column');
    for (const item of state.pending.rows) {
      assert.equal(item.shard, 1);
      assert.equal(item.sha256, rowDigest(state.columns, destination[item.id - 1]));
      assert.ok(f.trace.some((event) => event.db === f.shards[1].id && event.success
        && selectsTable(event.sql, 'blocks') && event.rows.some((row) => row.id === item.id
          && Object.hasOwn(row, 'text') && rowDigest(state.columns, row) === item.sha256)),
      'each source tuple needs successful full-column consumer readback before acknowledgment');
    }
    const matchRows = f.trace.filter((event) => event.db === f.shards[1].id
      && ['query', 'batch-statement'].includes(event.kind) && /\bMATCH\b/i.test(event.sql));
    assert.ok(matchRows.every((event) => event.success));
    assert.deepEqual(matchRows.flatMap((event) => event.rows.map(({ rowid }) => rowid)).sort((a, b) => a - b),
      rows.filter((_row, index) => boundaryCases[index]?.tokens.length !== 0).map(({ id }) => id),
      'native-token rows need one hit; truly tokenless rows and the outside-probe id need none');
    await assertNativeTokenizerBoundaryMatches(f.shards[1], rows);
    verifiedBeforeAck = true;
  } }));
  assert.equal(copied.state, 'complete');
  assert.equal(copied.rows, rows.length);
  assert.equal(acknowledgedRows, rows.length, 'every complete source tuple must be acknowledged only after durable proof');
  const after = await nativeSnapshot(f.source);
  assert.deepEqual(after.blocks, []);
  assert.deepEqual(after.ftsData, before.ftsData, 'source acknowledgment must not issue legacy FTS mutations');
  assert.deepEqual(after.ftsIndex, before.ftsIndex);
  assert.deepEqual(await f.shards[1].rows('SELECT * FROM blocks ORDER BY id'), [...rows, outside]);
  await assertNativeTokenizerBoundaryMatches(f.shards[1], rows);
  assert.deepEqual(await f.shards[1].rows(
    'SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ? ORDER BY rowid', ['"nativedensesuffix"'],
  ), [...rows, outside].filter(({ text }) => text.includes('\u0000 nativedensesuffix')).map(({ id }) => ({ rowid: id })),
  'the independent common suffix must include exactly the rows whose stored text has the post-NUL suffix');
  assert.deepEqual(await f.source.rows(`SELECT * FROM ${SOURCE_FREEZE_TABLE}`), [{ id: 1, state: 'frozen' }]);
  assert.equal((await readCheckpoint(f.shards[0], COPY_CHECKPOINT)).state, 'complete');
  assertAtomicBlockBatches(f);
  assertNativeRequestLimits(f);
  const requests = f.trace.filter((event) => ['query', 'batch'].includes(event.kind));
  assert.ok(requests.length <= 100, `dense native verification must not make per-row RPCs, observed ${requests.length}`);
});

test('native workerd short malformed TEXT is copied byte exactly before source retirement', async (context) => {
  const f = await workerdFixture(context);
  const row = block(901, 1, { text: 'public raw token', tool_name: 'public tool' });
  await seedWorkerdBlocks(f.source, [row]);
  const invalidHex = '61FF62007075626C6963';
  await f.source.batch([
    { sql: 'UPDATE blocks SET text = CAST(unhex(?) AS TEXT), tool_name = CAST(unhex(?) AS TEXT) WHERE id = ?',
      params: [invalidHex, 'EFBBBF74ED A08000'.replaceAll(' ', ''), row.id] },
    { sql: "INSERT INTO blocks_fts (blocks_fts, rowid, text) VALUES ('delete', ?, ?)", params: [row.id, row.text] },
    { sql: 'INSERT INTO blocks_fts (rowid, text) SELECT id, text FROM blocks', params: [] },
  ]);
  const before = await nativeSnapshot(f.source);
  let verified = false;
  const copied = await copyWithNativeParameters(f.args({ checkpointHook: async (state) => {
    if (state.pending?.phase !== 'verified') return;
    verified = true;
    assert.equal(state.pending.rows[0].sha256, rowDigest(BLOCK_COLUMNS, {
      ...row, text: { x: invalidHex.toLowerCase() }, tool_name: { x: 'efbbbf74eda08000' },
    }));
    assert.deepEqual(await f.shards[1].rows('SELECT hex(CAST(text AS BLOB)) AS bytes FROM blocks'),
      [{ bytes: invalidHex }]);
    assert.deepEqual(await nativeSnapshot(f.source), before);
    assert.deepEqual(await f.shards[1].rows(
      'SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH CAST(unhex(?) AS TEXT)', ['2261ff6222']), [{ rowid: row.id }]);
  } }));
  assert.equal(verified, true);
  assert.equal(copied.state, 'complete');
  const after = await nativeSnapshot(f.source);
  assert.deepEqual(after.blocks, []);
  assert.deepEqual(after.ftsData, before.ftsData);
  assert.deepEqual(after.ftsIndex, before.ftsIndex);
});


test('native workerd copier rejects missing, wrong, duplicate and out-of-probe MATCH identities before source acknowledgment', async (context) => {
  const f = await workerdFixture(context);
  const rows = nativeDenseRows(48);
  const ids = rows.map(({ id }) => id);
  const outside = { ...rows[0], id: 1462, block_index: 1462, row_hash: 1462 };
  await seedWorkerdBlocks(f.source, rows);
  await seedWorkerdBlocks(f.shards[1], [outside]);
  const before = await nativeSnapshot(f.source);
  for (const [fault, code] of [
    ['missing', 'fts-match'], ['wrong', 'fts-identity'], ['duplicate', 'fts-identity'],
    ['out-of-probe', 'fts-identity'], ['unsafe', 'fts-identity'], ['wrong-type', 'fts-identity'],
  ]) {
    await context.test(fault, async () => {
      f.trace.length = 0;
      let exercised = false;
      f.shards[1].transformQuery = async (event, matches) => {
        if (!/\bMATCH\b/i.test(event.sql)) return matches;
        exercised = true;
        assert.deepEqual(matches.map(({ rowid }) => rowid).sort((a, b) => a - b), ids,
          'faults must alter genuine native results from the actual copier, not an echoed expected response');
        if (fault === 'missing') return matches.slice(1);
        if (fault === 'duplicate') return [...matches, { ...matches[0] }];
        if (fault === 'out-of-probe') return f.shards[1].rows(
          'SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ? ORDER BY rowid', ['"nativedensevisible"']);
        return matches.map((row, index) => index ? row : {
          rowid: fault === 'wrong' ? row.rowid + 0.25
            : fault === 'unsafe' ? Number.MAX_SAFE_INTEGER + 1 : String(row.rowid),
        });
      };
      await assert.rejects(copyWithNativeParameters(f.args()), (error) => {
        assert.equal(error.code, code);
        assert.equal(error.d1Phase, 'copy-fts-match');
        return true;
      });
      assert.equal(exercised, true, 'the consumer must reach the real native MATCH boundary');
      assert.deepEqual(await nativeSnapshot(f.source), before, 'invalid MATCH evidence must retain all source bytes and postings');
      assert.deepEqual(sourceWrites(f), [], 'invalid native result identities cannot authorize source writes');
      const checkpoint = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
      assert.equal(checkpoint.pending.phase, 'copying', 'invalid MATCH evidence must never persist verified acknowledgment authority');
      assert.equal(checkpoint.rows, 0);
      assert.equal(checkpoint.after, -1);
      assert.deepEqual(await f.shards[1].rows('SELECT * FROM blocks ORDER BY id'), [...rows, outside]);
      assertNativeRequestLimits(f);
    });
  }
});

for (const [backend, createFixture] of [['SQLite', fixture], ['workerd', workerdFixture]]) {
  test(`native ${backend} fold-growth probe budget copies a complete same-shard page before acknowledgment`, async (context) => {
    const f = await createFixture(context);
    const word = `a${'Ⱥ'.repeat(11000)}`;
    const rows = nativeDenseRows(48).map((row, index) => ({
      ...row, text: index < 46 ? word : `foldgrowthascii${index}`,
    }));
    const sourceBytes = Buffer.byteLength(`[${rows.map((row) => canonicalRow(BLOCK_COLUMNS, row)).join(',')}]`);
    assert.ok(sourceBytes < COPY_PAGE_BYTES, 'the unexpanded original words must fit one canonical source page');
    if (backend === 'SQLite') seedBlocks(f.source, rows);
    else await seedWorkerdBlocks(f.source, rows);
    const before = await storedBlockSnapshot(f.source);
    for (const row of rows) await assertNativeLongWordIdentity(f.source, row, [row.text]);
    f.trace.length = 0;
    let verifiedBeforeAck = false;
    let acknowledgedRows = 0;
    const beforeSourceWrite = async ({ sql }) => {
      if (!isWrite(sql)) return;
      const checkpoint = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
      assert.equal(checkpoint.pending?.phase, 'verified');
      assert.equal(verifiedBeforeAck, true, 'all full-word/native/full-row evidence must precede every source write');
      if (/\bDELETE\s+FROM\s+blocks\b/i.test(sql)) acknowledgedRows += checkpoint.pending.rows.length;
    };
    f.source.beforeQuery = beforeSourceWrite;
    f.source.beforeStatement = beforeSourceWrite;
    // Run the actual selected historical module through full retirement too. The
    // pre-grouping 4c5cb33 copier succeeds natively but violates our internal budget.
    const result = await copyWithNativeParameters(f.args({ checkpointHook: async (state) => {
      if (state.pending?.phase !== 'verified') return;
      assert.deepEqual(state.columns, BLOCK_COLUMNS);
      assert.deepEqual(state.pending.rows, rows.map((row) => ({
        id: row.id, shard: 1, sha256: rowDigest(BLOCK_COLUMNS, row),
      })), 'all 48 source rows must share one full-row SHA checkpoint');
      assert.deepEqual(await storedBlockSnapshot(f.source), before, 'verified authority must not mutate source bytes or postings');
      assert.deepEqual(await f.shards[0].rows('SELECT * FROM blocks'), []);
      for (const row of rows) await assertNativeLongWordIdentity(f.shards[1], row, [row.text]);
      verifiedBeforeAck = true;
    } }));
    assert.equal(result.state, 'complete');
    assert.equal(result.rows, rows.length);
    assert.equal(result.after, rows.at(-1).id);
    assert.equal(acknowledgedRows, rows.length);
    assert.deepEqual(await f.source.rows('SELECT * FROM blocks'), []);
    assert.deepEqual(await f.shards[1].rows('SELECT * FROM blocks ORDER BY id'), rows);
    assert.equal((await readCheckpoint(f.shards[0], COPY_CHECKPOINT)).state, 'complete');
    assert.deepEqual(await f.source.rows(`SELECT id, state FROM ${SOURCE_FREEZE_TABLE}`), [{ id: 1, state: 'frozen' }]);
    const groups = f.trace.filter(({ db, kind, sql, params }) => db === f.shards[1].id
      && kind === 'query' && /\bMATCH\b/.test(sql) && params.length === 1);
    assert.ok(groups.length > 0 && groups.every(({ success }) => success), 'actual native grouped MATCH must complete');
    assert.deepEqual(groups.flatMap(({ rows: matches }) => matches.map(({ rowid }) => rowid)).sort((a, b) => a - b),
      rows.map(({ id }) => id), 'every complete native posting must return exactly once');
    const pairs = groups.flatMap(({ params }) => JSON.parse(params[0]));
    assert.deepEqual(pairs.map(([, id]) => id), rows.map(({ id }) => id));
    assert.ok(Buffer.byteLength(JSON.stringify([JSON.stringify(pairs)])) > COPY_PAGE_BYTES,
      'native folding must grow this otherwise bounded source page beyond the internal unsplit parameter budget');
    for (const { params } of groups) assert.ok(Buffer.byteLength(JSON.stringify(params)) <= COPY_PAGE_BYTES,
      'internal FTS parameter budget violation: every actual serialized params envelope must fit 1 MiB; this is not a native API rejection');
    assert.ok(groups.length > 1, 'the real same-shard fold-growth page must exercise multiple native verification groups');
  });

  test(`native ${backend} fold-growth later missing posting retains exact source and pending proof`, async (context) => {
    const f = await createFixture(context);
    const word = `a${'Ⱥ'.repeat(11000)}`;
    const rows = nativeDenseRows(48).map((row, index) => ({
      ...row, text: index < 46 ? word : `foldgrowthascii${index}`,
    }));
    if (backend === 'SQLite') seedBlocks(f.source, rows);
    else await seedWorkerdBlocks(f.source, rows);
    const before = await storedBlockSnapshot(f.source);
    const missing = rows[45];
    let deletedPosting = false;
    let earlierGroups = 0;
    f.trace.length = 0;
    f.shards[1].beforeQuery = async ({ sql, params }) => {
      if (!/\bMATCH\b/.test(sql) || params.length !== 1) return;
      const ids = JSON.parse(params[0]).map(([, id]) => id);
      if (!ids.includes(missing.id)) {
        earlierGroups += 1;
        return;
      }
      assert.equal(deletedPosting, false);
      // This independent whole ORIGINAL word is a native positive control before
      // physical deletion; no copier-derived completion or fabricated result.
      await assertNativeLongWordIdentity(f.shards[1], missing, [missing.text]);
      const earlier = f.trace.filter(({ db, kind, sql, success }) => db === f.shards[1].id
        && kind === 'query' && /\bMATCH\b/.test(sql) && success);
      assert.equal(earlier.length, earlierGroups);
      for (const event of earlier) assert.deepEqual(event.rows.map(({ rowid }) => rowid).sort((a, b) => a - b),
        JSON.parse(event.params[0]).map(([, id]) => id), 'all earlier native groups must pass before the later posting is removed');
      if (backend === 'SQLite') f.shards[1].database.prepare(
        'INSERT INTO blocks_fts (blocks_fts, rowid, text) VALUES (?, ?, ?)',
      ).run('delete', missing.id, missing.text);
      else await f.shards[1].database.prepare(
        'INSERT INTO blocks_fts (blocks_fts, rowid, text) VALUES (?, ?, ?)',
      ).bind('delete', missing.id, missing.text).run();
      deletedPosting = true;
    };
    await assert.rejects(copyWithNativeParameters(f.args()), (error) => {
      assert.equal(error.code, 'fts-match');
      assert.equal(error.d1Phase, 'copy-fts-match');
      assert.equal(error.cause, undefined);
      assert.ok(!`${error.message} ${error.stack} ${JSON.stringify(error)}`.includes(word),
        'verification errors must not retain transcript terms or native causes');
      return true;
    });
    assert.equal(deletedPosting, true, 'the negative control must physically remove a real native posting');
    assert.deepEqual(await storedBlockSnapshot(f.source), before);
    assert.deepEqual(sourceWrites(f), [], 'missing later-group evidence must not authorize any source writes');
    assert.deepEqual(await f.shards[1].rows('SELECT * FROM blocks ORDER BY id'), rows);
    await assertNativeLongWordIdentity(f.shards[1], missing, [missing.text], { posting: false });
    const checkpoint = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
    assert.equal(checkpoint.state, 'pending');
    assert.equal(checkpoint.after, -1);
    assert.equal(checkpoint.rows, 0);
    assert.equal(checkpoint.pending.phase, 'copying');
    assert.deepEqual(checkpoint.pending.rows, rows.map((row) => ({
      id: row.id, shard: 1, sha256: rowDigest(BLOCK_COLUMNS, row),
    })));
    // Historical 4c5cb33 is deliberately still a valid negative posting control:
    // it rejects missing native evidence even though it sends one oversized group.
  });

  test(`native ${backend} fold-growth rejects genuine hits belonging to another probe group`, async (context) => {
    for (const fault of ['future-group', 'previous-group']) {
      await context.test(fault, async (child) => {
        const f = await createFixture(child);
        const word = `a${'Ⱥ'.repeat(11000)}`;
        const rows = nativeDenseRows(48).map((row, index) => ({
          ...row, text: index < 46 ? word : `foldgrowthascii${index}`,
        }));
        if (backend === 'SQLite') seedBlocks(f.source, rows);
        else await seedWorkerdBlocks(f.source, rows);
        const before = await storedBlockSnapshot(f.source);
        f.trace.length = 0;
        let groups = 0;
        let exercised = false;
        f.shards[1].transformQuery = async (event, matches) => {
          if (!/\bMATCH\b/.test(event.sql) || event.params.length !== 1) return matches;
          groups += 1;
          const ids = JSON.parse(event.params[0]).map(([, id]) => id);
          assert.deepEqual(matches.map(({ rowid }) => rowid).sort((a, b) => a - b), ids,
            'the fault must alter genuine native results after every requested posting matched');
          if (fault === 'previous-group' && groups === 1) return matches;
          const outside = fault === 'future-group' ? rows[45] : rows[0];
          assert.ok(!ids.includes(outside.id), 'the injected native hit must belong to the page but not this group');
          const hits = await f.shards[1].rows(
            'SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ? AND rowid = CAST(? AS INTEGER)',
            [`"${outside.text}"`, outside.id]);
          assert.deepEqual(hits, [{ rowid: outside.id }], 'use a genuine independently queried posting, never an echoed row');
          exercised = true;
          return [...matches.slice(1), ...hits];
        };
        await assert.rejects(copyWithNativeParameters(f.args()), (error) => {
          assert.equal(error.code, 'fts-identity');
          assert.equal(error.d1Phase, 'copy-fts-match');
          return true;
        });
        assert.equal(exercised, true);
        assert.equal(groups, fault === 'future-group' ? 1 : 2);
        assert.deepEqual(await storedBlockSnapshot(f.source), before);
        assert.deepEqual(sourceWrites(f), []);
        const checkpoint = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
        assert.equal(checkpoint.pending.phase, 'copying');
        assert.equal(checkpoint.rows, 0);
        assert.equal(checkpoint.after, -1);
      });
    }
  });
}

for (const [backend, createFixture] of [['SQLite', fixture], ['workerd', workerdFixture]]) {
  const nativeBackend = backend === 'SQLite' ? 'native tokenizer' : 'native workerd tokenizer';
  test(`${nativeBackend} B3 long UTF8 copier verifies original words before acknowledgment and resumes durable proof`, async (context) => {
    for (const { name, text, tokens } of nativeLongWordCases()) {
      await context.test(name, async (child) => {
        const f = await createFixture(child);
        const row = block(41, 1, {
          text, byte_len: Buffer.byteLength(text), role: '', tool_name: null,
          on_main_path: 0, media_byte_start: 2 ** 40 + 17, media_byte_len: 0, media_type: '',
        });
        if (backend === 'SQLite') seedBlocks(f.source, [row]);
        else await seedWorkerdBlocks(f.source, [row]);
        await assertNativeLongWordIdentity(f.source, row, tokens);
        const before = await storedBlockSnapshot(f.source);
        f.trace.length = 0;
        const stop = new Error('stop after durable native long-word verification, before source acknowledgment');
        let verifiedBeforeAck = false;
        let acknowledgedRows = 0;
        const beforeSourceWrite = async ({ sql }) => {
          if (!isWrite(sql)) return;
          assert.equal(verifiedBeforeAck, true, 'independent original-word proof must precede all source writes');
          const durable = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
          assert.equal(durable.pending?.phase, 'verified');
          assert.deepEqual(durable.pending.rows, [{ id: row.id, shard: 1, sha256: rowDigest(BLOCK_COLUMNS, row) }]);
          if (/\bDELETE\s+FROM\s+"?blocks"?\b/i.test(sql)) acknowledgedRows += durable.pending.rows.length;
        };
        f.source.beforeQuery = beforeSourceWrite;
        f.source.beforeStatement = beforeSourceWrite;
        await assert.rejects(copyWithNativeParameters(f.args({ checkpointHook: async (state) => {
          if (state.pending?.phase !== 'verified') return;
          assert.deepEqual(state.columns, BLOCK_COLUMNS);
          assert.deepEqual(state.pending.rows, [{ id: row.id, shard: 1, sha256: rowDigest(BLOCK_COLUMNS, row) }]);
          assert.deepEqual(await storedBlockSnapshot(f.source), before,
            'verified long-word proof must retain the exact source content and physical postings');
          await assertNativeLongWordIdentity(f.source, row, tokens);
          await assertNativeLongWordIdentity(f.shards[1], row, tokens);
          assert.deepEqual(await f.shards[0].rows('SELECT * FROM blocks'), []);
          assert.ok(f.trace.some((event) => event.db === f.shards[1].id && event.success
            && selectsTable(event.sql, 'blocks') && event.rows.some((stored) => stored.id === row.id
              && Object.hasOwn(stored, 'text') && rowDigest(BLOCK_COLUMNS, stored) === rowDigest(BLOCK_COLUMNS, row))),
          'actual copier readback must independently recover every original column');
          assert.ok(f.trace.some((event) => event.db === f.shards[1].id && event.success
            && /\bMATCH\b/i.test(event.sql) && event.rows.some(({ rowid }) => rowid === row.id)),
          'actual grouped copier MATCH must succeed before durable acknowledgment authority');
          verifiedBeforeAck = true;
          throw stop;
        } })), (error) => error === stop);
        assert.equal(verifiedBeforeAck, true);
        assert.deepEqual(sourceWrites(f), []);
        const saved = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
        assert.equal(saved.state, 'pending');
        assert.equal(saved.pending.phase, 'verified');
        assert.equal(saved.rows, 0);
        assert.equal(saved.after, -1);
        const destinationBeforeResume = await Promise.all(f.shards.map(storedBlockSnapshot));
        const batchesBeforeResume = destinationBatchCount(f);
        if (backend === 'SQLite') f.restart();
        assert.deepEqual(await readCheckpoint(f.shards[0], COPY_CHECKPOINT), saved,
          'resume must read the actual saved native proof, including after reopening SQLite');
        assert.deepEqual(await storedBlockSnapshot(f.source), before);
        f.source.beforeQuery = beforeSourceWrite;
        f.source.beforeStatement = beforeSourceWrite;
        const result = await copyWithNativeParameters(f.args());
        assert.equal(result.state, 'complete');
        assert.equal(result.rows, 1);
        assert.equal(result.after, row.id);
        assert.equal(acknowledgedRows, 1);
        assert.equal(destinationBatchCount(f), batchesBeforeResume,
          'verified resume must not rewrite the copied full word or regenerate native postings');
        assert.deepEqual(await Promise.all(f.shards.map(storedBlockSnapshot)), destinationBeforeResume);
        await assertNativeLongWordIdentity(f.shards[1], row, tokens);
        const retired = await storedBlockSnapshot(f.source);
        assert.deepEqual(retired.blocks, []);
        assert.deepEqual(retired.ftsData, before.ftsData, 'source retirement must retain the original FTS backing pages');
        assert.deepEqual(retired.ftsIndex, before.ftsIndex);
        assert.ok(!sourceWrites(f).some(({ sql }) => /\bblocks_fts\b/i.test(sql)));
        assert.deepEqual(await f.source.rows(`SELECT * FROM ${SOURCE_FREEZE_TABLE}`), [{ id: 1, state: 'frozen' }]);
        assert.equal((await readCheckpoint(f.shards[0], COPY_CHECKPOINT)).state, 'complete');
        assertAtomicBlockBatches(f);
        assertNativeRequestLimits(f);
      });
    }
  });

  test(`${nativeBackend} B3 long UTF8 readonly verification uses original words and rejects physical missing postings without writes`, async (context) => {
    for (const { name, text, tokens } of nativeLongWordCases()) {
      for (const missing of [false, true]) {
        await context.test(`${name}-${missing ? 'missing-posting' : 'native-positive'}`, async (child) => {
          const f = await createFixture(child);
          const sourceRow = block(900, 0, { text: 'readonly_source_guard\u0000retained_source_tail' });
          const row = block(41, 1, { text, byte_len: Buffer.byteLength(text) });
          if (backend === 'SQLite') {
            seedBlocks(f.source, [sourceRow]);
            seedBlocks(f.shards[1], [row]);
          } else {
            await seedWorkerdBlocks(f.source, [sourceRow]);
            await seedWorkerdBlocks(f.shards[1], [row]);
          }
          await assertNativeLongWordIdentity(f.shards[1], row, tokens);
          if (missing) {
            const deletion = f.shards[1].database.prepare(
              'INSERT INTO blocks_fts (blocks_fts, rowid, text) VALUES (?, ?, ?)',
            );
            if (backend === 'SQLite') deletion.run('delete', row.id, row.text);
            else await deletion.bind('delete', row.id, row.text).run();
            await assertNativeLongWordIdentity(f.shards[1], row, tokens, { posting: false });
          }
          const sourceBefore = await storedBlockSnapshot(f.source);
          const shardsBefore = await Promise.all(f.shards.map(storedBlockSnapshot));
          const metadata = async () => Promise.all(f.shards.map(async (db) => ({
            layout: await db.rows('SELECT * FROM shard_meta'),
            checkpoints: await db.rows('SELECT * FROM index_migration_state ORDER BY name'),
          })));
          const metadataBefore = await metadata();
          f.trace.length = 0;
          const operation = verifyWithNativeParameters({
            source: f.source, shards: f.shards, catalogConsistency: 'required',
          });
          if (missing) await assert.rejects(operation, (error) => {
            assert.equal(error.code, 'fts-match');
            assert.equal(error.d1Phase, 'copy-fts-match');
            return true;
          });
          else {
            const evidence = await operation;
            assert.deepEqual(evidence, {
              mainSessions: 0, mainStars: 0,
              shards: [0, 1].map((shard) => ({
                shard, blockCount: shard === 1 ? 1 : 0, sessionCount: 0, starCount: 0,
                blockSampleSha256: sha256(JSON.stringify(shard === 1 ? [canonicalRow(BLOCK_COLUMNS, row)] : [])),
                catalogSampleSha256: sha256('[]'),
              })),
            });
          }
          assertReadonlyEvidenceCalls(f);
          assert.deepEqual(await storedBlockSnapshot(f.source), sourceBefore,
            'readonly native completion must not alter the retained source row or its physical postings');
          assert.deepEqual(await Promise.all(f.shards.map(storedBlockSnapshot)), shardsBefore);
          assert.deepEqual(await metadata(), metadataBefore);
          await assertNativeLongWordIdentity(f.source, sourceRow, ['readonly_source_guard', 'retained_source_tail']);
          await assertNativeLongWordIdentity(f.shards[1], row, tokens, { posting: !missing });
          assertNativeRequestLimits(f);
        });
      }
    }
  });
}

test('native tokenizer configured FTS tokenizer preserves Unicode61 boundaries, empty and after-NUL copy results', async (context) => {
  const f = await fixture(context);
  const cases = [
    ...nativeTokenizerBoundaryCases(),
    { text: null, tokens: [] },
    { text: '', tokens: [] },
    { text: ' \t\n\u0000', tokens: [] },
    { text: '! ? : ; ( ) [ ] { }', tokens: [] },
    // The schema explicitly adds these punctuation characters to unicode61 tokenchars.
    // Probe the real source index instead of assuming the default tokenizer's behavior.
    { text: '---', tokens: ['---'] },
    { text: '___', tokens: ['___'] },
    { text: '...', tokens: ['...'] },
    { text: '--- separator_tail', tokens: ['---', 'separator_tail'] },
    { text: '会話 café Ελληνικά e\u0301', tokens: ['会話', 'café', 'Ελληνικά', 'e\u0301'] },
    { text: '😀\u0000会話_unicode_tail', tokens: ['会話_unicode_tail'] },
    { text: 'shared_visible_term\u0000shared_tail_0 会話', tokens: ['shared_visible_term', 'shared_tail_0', '会話'] },
    { text: 'shared_visible_term\u0000shared_tail_1 Ελληνικά', tokens: ['shared_visible_term', 'shared_tail_1', 'Ελληνικά'] },
    { text: 'shared_visible_term\u0000shared_tail_2 café', tokens: ['shared_visible_term', 'shared_tail_2', 'café'] },
  ];
  const rows = cases.map(({ text }, index) => block(800 + index, 1, {
    text, byte_len: text === null ? null : Buffer.byteLength(text),
  }));
  const assertBytesAndMatches = (db, expected) => {
    assert.deepEqual(db.rows('SELECT * FROM blocks ORDER BY id'), expected);
    assert.deepEqual(db.rows('SELECT id, CAST(text AS BLOB) AS bytes FROM blocks ORDER BY id').map((row) => ({
      id: row.id, bytes: row.bytes === null ? null : Buffer.from(row.bytes),
    })), expected.map((row) => ({
      id: row.id, bytes: row.text === null ? null : Buffer.from(row.text),
    })), 'empty/null/punctuation/Unicode rows must retain every original stored UTF-8 byte');
    for (const row of expected) {
      const { tokens, absent = [] } = cases[row.id - 800];
      for (const token of tokens.length ? tokens : ['index-migration-tokenless-probe']) {
        assert.deepEqual(db.rows('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ? AND rowid = ?',
          [`"${token}"`, row.id]), tokens.length ? [{ rowid: row.id }] : [],
        'actual row-scoped MATCH must agree before and after copy, including punctuation tokenchars and NUL suffixes');
      }
      for (const term of absent) {
        assert.deepEqual(db.rows('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ? AND rowid = ?',
          [`"${term.replaceAll('"', '""')}"`, row.id]), [],
        'old alpha/al probes and tokenless sentinels must remain actual native misses');
      }
    }
  };
  seedBlocks(f.source, rows);
  assertBytesAndMatches(f.source, rows);
  const before = blockSnapshot(f.source);
  const protectedRows = assertVerifiedBeforeDelete(f);
  let verifiedBeforeRetirement = false;
  const copied = await copyWithNativeParameters(f.args({ checkpointHook: (state) => {
    if (state.pending?.phase !== 'verified') return;
    verifiedBeforeRetirement = true;
    assertBytesAndMatches(f.source, rows);
    assert.deepEqual(blockSnapshot(f.source), before, 'durable verification must retain the exact source bytes and postings');
    assert.deepEqual(state.columns, BLOCK_COLUMNS);
    assert.deepEqual(state.pending.rows, rows.map((row) => ({
      id: row.id, shard: 1, sha256: rowDigest(BLOCK_COLUMNS, row),
    })));
    for (let index = 0; index < f.shards.length; index += 1) {
      assertBytesAndMatches(f.shards[index], rows.filter((row) => indexShardForSessionId(row.session_id, 2) === index));
    }
  } }));
  assert.equal(verifiedBeforeRetirement, true);
  assert.equal(copied.state, 'complete');
  assert.equal(copied.rows, rows.length);
  assert.equal(protectedRows(), rows.length);
  assertCopied(f, rows);
  const retired = blockSnapshot(f.source);
  assert.deepEqual(retired.ftsData, before.ftsData);
  assert.deepEqual(retired.ftsIndex, before.ftsIndex);
  assert.ok(!sourceWrites(f).some(({ sql }) => /\bblocks_fts\b/i.test(sql)), 'source retirement must never mutate legacy FTS');
  f.trace.length = 0;
  const evidence = await verifyIndexRecords({ source: f.source, shards: f.shards, catalogConsistency: 'required' });
  assert.deepEqual(evidence, {
    mainSessions: 0, mainStars: 0,
    shards: f.shards.map((_db, index) => {
      const expected = rows.filter((row) => indexShardForSessionId(row.session_id, 2) === index);
      return {
        shard: index, blockCount: expected.length, sessionCount: 0, starCount: 0,
        blockSampleSha256: sha256(JSON.stringify(expected.slice(0, 4).map((row) => canonicalRow(BLOCK_COLUMNS, row)))),
        catalogSampleSha256: sha256('[]'),
      };
    }),
  });
  assertReadonlyEvidenceCalls(f);
  assert.deepEqual(f.source.rows('SELECT * FROM blocks'), []);
});

test('native tokenizer crash checkpoints reuse Unicode61 blocks and exact FTS postings after reopening', async (context) => {
  for (const stage of ['before-copy', 'verified-before-delete', 'after-delete']) {
    await context.test(stage, async (child) => {
      const f = await fixture(child);
      const cases = [...nativeTokenizerBoundaryCases(), { text: null }, { text: '' }];
      const rows = cases.map(({ text }, index) => block(11 + index, 1, { on_main_path: 0, text }));
      seedBlocks(f.source, rows);
      const sourceBefore = blockSnapshot(f.source);
      await assertNativeTokenizerBoundaryMatches(f.source, rows);
      const deleted = assertVerifiedBeforeDelete(f);
      const crash = new Error(`simulated process crash ${stage}`);
      let crashed = false;
      await assert.rejects(copyWithNativeParameters(f.args({ checkpointHook: (state) => {
        const target = stage === 'before-copy' ? state.pending?.phase === 'copying'
          : stage === 'verified-before-delete' ? state.pending?.phase === 'verified'
            : !state.pending && state.rows > 0 && state.state === 'pending';
        if (target && !crashed) { crashed = true; throw crash; }
      } })), (error) => error === crash);
      assert.equal(crashed, true);
      const saved = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
      if (saved.pending) assert.deepEqual(saved.pending.rows, rows.map((row) => ({
        id: row.id, shard: 1, sha256: rowDigest(BLOCK_COLUMNS, row),
      })));
      const sourceAtCrash = blockSnapshot(f.source);
      assert.deepEqual(sourceAtCrash.blocks, stage === 'after-delete' ? [] : rows);
      assert.deepEqual(sourceAtCrash.ftsData, sourceBefore.ftsData);
      assert.deepEqual(sourceAtCrash.ftsIndex, sourceBefore.ftsIndex);
      const snapshots = f.shards.map(blockSnapshot);
      const batchesBeforeRestart = destinationBatchCount(f);
      assert.equal(deleted(), stage === 'after-delete' ? rows.length : 0);
      assert.equal(f.source.rows('SELECT COUNT(*) AS n FROM blocks')[0].n, stage === 'after-delete' ? 0 : rows.length);
      assert.equal(saved.pending?.phase ?? null, stage === 'before-copy' ? 'copying'
        : stage === 'verified-before-delete' ? 'verified' : null);
      if (stage === 'before-copy') assert.equal(batchesBeforeRestart, 0);
      else assert.equal(batchesBeforeRestart, 1);
      f.restart();
      assert.deepEqual(await readCheckpoint(f.shards[0], COPY_CHECKPOINT), saved);
      assertVerifiedBeforeDelete(f);
      const result = await copyWithNativeParameters(f.args());
      assert.equal(result.rows, rows.length);
      assert.equal(result.state, 'complete');
      assertCopied(f, rows);
      await assertNativeTokenizerBoundaryMatches(f.shards[1], rows);
      assert.ok(!sourceWrites(f).some(({ sql }) => /\bblocks_fts\b/i.test(sql)));
      if (stage !== 'before-copy') {
        assert.equal(destinationBatchCount(f), batchesBeforeRestart,
          'verified-page restart must not replace rows or regenerate their FTS postings');
        assert.deepEqual(f.shards.map(blockSnapshot), snapshots);
      }
      assertAtomicBlockBatches(f);
    });
  }
});

test('a failed shard batch rolls back content and FTS atomically; a copying-page restart safely replaces prior shards', async (context) => {
  const f = await fixture(context);
  const rows = [block(21, 0), block(22, 1)];
  seedBlocks(f.source, rows);
  const initial = blockSnapshot(f.shards[1]);
  assertVerifiedBeforeDelete(f);
  f.shards[1].afterStatement = ({ sql }) => {
    if (/\bINSERT\s+INTO\s+blocks_fts\b/i.test(sql) && !/['"]delete['"]/i.test(sql)) {
      throw new Error('crash after FTS SQL executed, before D1 transaction commit');
    }
  };
  await assert.rejects(copyFrozenIndex(f.args()), /before D1 transaction commit/);
  assert.deepEqual(blockSnapshot(f.shards[1]), initial, 'both tables and FTS backing data roll back');
  assert.equal(f.shards[0].rows('SELECT COUNT(*) AS n FROM blocks')[0].n, 1);
  assert.deepEqual(f.source.rows('SELECT * FROM blocks ORDER BY id'), rows);
  assert.deepEqual(sourceWrites(f), []);
  assert.equal((await readCheckpoint(f.shards[0], COPY_CHECKPOINT)).pending.phase, 'copying');
  f.restart();
  assertVerifiedBeforeDelete(f);
  await copyFrozenIndex(f.args());
  assertCopied(f, rows);
  const batches = assertAtomicBlockBatches(f);
  assert.equal(batches.filter(({ db }) => db === f.shards[0].id).length, 2,
    'restart idempotently replaces the first shard, including deleting its old FTS postings');
  assert.equal(batches.filter(({ committed }) => !committed).length, 1);
});

test('malformed destination readback never authorizes source deletion', async (context) => {
  for (const corruption of ['missing-row', 'duplicate-row', 'unexpected-row', 'omitted-column', 'null-to-empty', 'wrong-number', 'truncated-text']) {
    await context.test(corruption, async (child) => {
      const f = await fixture(child);
      const row = block(31, 0, { role: null, text: 'readback_needle 会話 😀 exact tail' });
      seedBlocks(f.source, [row]);
      let exercised = false;
      f.shards[0].transformQuery = ({ sql }, rows) => {
        if (!selectsTable(sql, 'blocks') || !rows.some((value) => Object.hasOwn(value, 'text'))) return rows;
        exercised = true;
        if (corruption === 'missing-row') return [];
        if (corruption === 'duplicate-row') return [...rows, { ...rows[0] }];
        if (corruption === 'unexpected-row') return [...rows, { ...rows[0], id: rows[0].id + 1000 }];
        return rows.map((value) => {
          const changed = { ...value };
          if (corruption === 'omitted-column') delete changed.media_byte_len;
          if (corruption === 'null-to-empty') changed.role = '';
          if (corruption === 'wrong-number') changed.row_hash -= 1;
          if (corruption === 'truncated-text') changed.text = changed.text.slice(0, 16);
          return changed;
        });
      };
      await assert.rejects(copyFrozenIndex(f.args()), /readback|omitted|SHA-256|byte transport/i);
      assert.equal(exercised, true);
      assert.deepEqual(f.source.rows('SELECT * FROM blocks'), [row]);
      assert.deepEqual(sourceWrites(f), []);
      assert.equal((await readCheckpoint(f.shards[0], COPY_CHECKPOINT)).pending.phase, 'copying');
    });
  }
});

test('malformed long-column byte slices fail closed without dropping the original transcript', async (context) => {
  for (const corruption of ['missing-slice', 'short-slice', 'invalid-utf8']) {
    await context.test(corruption, async (child) => {
      const f = await fixture(child);
      const row = block(35, 0, { text: `slice_needle ${'😀 e\u0301 会話\u0000\n'.repeat(10_000)}slice_tail` });
      seedBlocks(f.source, [row]);
      let exercised = false;
      f.shards[0].transformQuery = (_event, rows) => {
        if (!rows.some((value) => typeof value.bytes === 'string')) return rows;
        exercised = true;
        if (corruption === 'missing-slice') return [];
        return rows.map((value) => ({
          ...value,
          bytes: corruption === 'short-slice' ? value.bytes.slice(2) : `ff${value.bytes.slice(2)}`,
        }));
      };
      await assert.rejects(copyFrozenIndex(f.args()));
      assert.equal(exercised, true, 'fault must affect an actual long-text destination readback');
      assert.deepEqual(f.source.rows('SELECT * FROM blocks'), [row]);
      assert.deepEqual(Buffer.from(f.source.rows('SELECT CAST(text AS BLOB) AS bytes FROM blocks')[0].bytes),
        Buffer.from(row.text), 'malformed destination slices cannot alter any byte of the original source transcript');
      assert.deepEqual(sourceWrites(f), []);
      assert.equal((await readCheckpoint(f.shards[0], COPY_CHECKPOINT)).pending.phase, 'copying');
    });
  }
});

test('native tokenizer real missing FTS posting blocks deletion for ASCII, modernemoji-only and long UTF8 words', async (context) => {
  for (const [name, text, term] of [
    ['ascii', 'missing_match_needle café Unicode会話', 'missing_match_needle'],
    ['modernemoji-only', '🫠', '🫠'],
    ...nativeLongWordCases().map(({ name, text, tokens }) => [name, text, tokens[0]]),
  ]) {
    await context.test(name, async (child) => {
      const f = await fixture(child);
      const row = block(41, 1, { text });
      seedBlocks(f.source, [row]);
      const before = blockSnapshot(f.source);
      assert.deepEqual(f.source.rows('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ?', [`"${term}"`]),
        [{ rowid: row.id }]);
      await assertNativeLongWordIdentity(f.source, row, [term]);
      let deletedPosting = false;
      f.shards[1].beforeQuery = ({ sql }) => {
        if (!/\bMATCH\b/.test(sql) || deletedPosting) return;
        assert.deepEqual(f.shards[1].rows('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ?', [`"${term}"`]),
          [{ rowid: row.id }], 'the fault must remove a genuine native posting');
        f.shards[1].database.prepare('INSERT INTO blocks_fts (blocks_fts, rowid, text) VALUES (?, ?, ?)')
          .run('delete', row.id, row.text);
        deletedPosting = true;
      };
      await assert.rejects(copyWithNativeParameters(f.args()), (error) => {
        assert.equal(error.code, 'fts-match');
        assert.equal(error.d1Phase, 'copy-fts-match');
        return true;
      });
      assert.equal(deletedPosting, true);
      assert.deepEqual(f.shards[1].rows('SELECT * FROM blocks'), [row]);
      assert.deepEqual(f.shards[1].rows('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ?', [`"${term}"`]), []);
      await assertNativeLongWordIdentity(f.shards[1], row, [term], { posting: false });
      assert.deepEqual(blockSnapshot(f.source), before);
      assert.deepEqual(sourceWrites(f), []);
      const checkpoint = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
      assert.equal(checkpoint.rows, 0);
      assert.equal(checkpoint.after, -1);
      assert.equal(checkpoint.pending.phase, 'copying');
      assert.deepEqual(checkpoint.pending.rows, [{ id: row.id, shard: 1, sha256: rowDigest(BLOCK_COLUMNS, row) }]);
    });
  }
});

test('native workerd tokenizer rejects real missing modernemoji-only and long UTF8 postings before source acknowledgment', async (context) => {
  for (const { name, text, tokens } of [
    { name: 'modernemoji-only', text: '🫠', tokens: ['🫠'] }, ...nativeLongWordCases(),
  ]) {
    await context.test(name, async (child) => {
      const f = await workerdFixture(child);
      const row = block(41, 1, { text });
      await seedWorkerdBlocks(f.source, [row]);
      const before = await nativeSnapshot(f.source);
      await assertNativeLongWordIdentity(f.source, row, tokens);
      f.trace.length = 0;
      let deletedPosting = false;
      f.shards[1].beforeQuery = async ({ sql }) => {
        if (!/\bMATCH\b/.test(sql) || deletedPosting) return;
        await assertNativeLongWordIdentity(f.shards[1], row, tokens);
        await f.shards[1].database.prepare('INSERT INTO blocks_fts (blocks_fts, rowid, text) VALUES (?, ?, ?)')
          .bind('delete', row.id, row.text).run();
        deletedPosting = true;
      };
      await assert.rejects(copyWithNativeParameters(f.args()), (error) => {
        assert.equal(error.code, 'fts-match');
        assert.equal(error.d1Phase, 'copy-fts-match');
        return true;
      });
      assert.equal(deletedPosting, true, 'the fault must remove genuine native postings, not substitute MATCH results');
      assert.deepEqual(await nativeSnapshot(f.source), before);
      await assertNativeLongWordIdentity(f.shards[1], row, tokens, { posting: false });
      assert.deepEqual(sourceWrites(f), []);
      const checkpoint = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
      assert.equal(checkpoint.rows, 0);
      assert.equal(checkpoint.after, -1);
      assert.equal(checkpoint.pending.phase, 'copying');
      assert.deepEqual(checkpoint.pending.rows, [{ id: row.id, shard: 1, sha256: rowDigest(BLOCK_COLUMNS, row) }]);
      assertNativeRequestLimits(f);
    });
  }
});

test('native tokenizer readonly samples use whole native terms and reject missing modernemoji-only postings without writes', async (context) => {
  for (const missing of [false, true]) {
    await context.test(missing ? 'missing-modernemoji-only' : 'native-positive', async (child) => {
      const f = await fixture(child);
      const cases = [6, 7, 11, 14].map((index) => nativeTokenizerBoundaryCases()[index]);
      const rows = cases.map(({ text }, index) => block(900 + index, 1, { text }));
      seedBlocks(f.shards[1], rows);
      for (const [index, { tokens, absent = [] }] of cases.entries()) {
        for (const [terms, present] of [[tokens, true], [absent, false]]) {
          for (const term of terms) {
            assert.deepEqual(f.shards[1].rows('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ? AND rowid = ?',
              [`"${term}"`, rows[index].id]), present ? [{ rowid: rows[index].id }] : []);
          }
        }
      }
      if (missing) f.shards[1].database.prepare(
        'INSERT INTO blocks_fts (blocks_fts, rowid, text) VALUES (?, ?, ?)',
      ).run('delete', rows[3].id, rows[3].text);
      const before = f.shards.map(blockSnapshot);
      f.trace.length = 0;
      const operation = verifyIndexRecords({ source: f.source, shards: f.shards, catalogConsistency: 'required' });
      if (missing) await assert.rejects(operation, (error) => {
        assert.equal(error.code, 'fts-match');
        assert.equal(error.d1Phase, 'copy-fts-match');
        return true;
      });
      else {
        const evidence = await operation;
        assert.equal(evidence.shards[1].blockCount, rows.length);
        assert.equal(evidence.shards[1].blockSampleSha256,
          sha256(JSON.stringify(rows.map((row) => canonicalRow(BLOCK_COLUMNS, row)))));
      }
      assertReadonlyEvidenceCalls(f);
      assert.deepEqual(f.shards.map(blockSnapshot), before);
      assert.deepEqual(f.source.rows('SELECT * FROM blocks'), []);
    });
  }
});

test('native tokenizer rejects malformed schema readback and native clone errors without private diagnostics or source acknowledgment', async (context) => {
  for (const operation of ['copy', 'readonly']) {
    for (const fault of ['missing-schema', 'unsupported-tokenizer']) {
      await context.test(`${operation}-${fault}`, async (child) => {
        const f = await fixture(child);
        const row = block(1100, 1, { text: '🫠' });
        seedBlocks(operation === 'copy' ? f.source : f.shards[1], [row]);
        const sourceBefore = blockSnapshot(f.source);
        const shardsBefore = f.shards.map(blockSnapshot);
        const [schema] = f.shards[1].rows(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'blocks_fts'",
        );
        assert.equal(typeof schema?.sql, 'string');
        let exercised = false;
        f.shards[1].transformQuery = (_event, rows) => {
          if (rows.length !== 1 || rows[0]?.sql !== schema.sql) return rows;
          assert.equal(exercised, false, 'the fault must alter the actual destination schema readback');
          exercised = true;
          // This declaration reaches native SQLite and rejects an unsupported
          // tokenizer. No successful token or MATCH result is substituted.
          return fault === 'missing-schema' ? [] : [{
            sql: `CREATE VIRTUAL TABLE blocks_fts USING fts5(text, content='blocks', content_rowid='id',
              tokenize='PRIVATE_NATIVE_ORACLE_ERROR_CANARY')`,
          }];
        };
        await assert.rejects(operation === 'copy' ? copyWithNativeParameters(f.args())
          : verifyIndexRecords({ source: f.source, shards: f.shards, catalogConsistency: 'required' }), (error) => {
          assert.equal(error.code, 'fts-tokenizer-schema');
          assert.equal(error.d1Phase, 'copy-fts-match');
          assert.equal(error.cause, undefined);
          assert.ok(!`${error.message} ${error.stack} ${JSON.stringify(error)}`.includes('PRIVATE_NATIVE_ORACLE_ERROR_CANARY'),
            'native errors, causes and schema SQL must never become public diagnostics');
          return true;
        });
        assert.equal(exercised, true, 'the fault must reach actual destination schema readback');
        assert.deepEqual(blockSnapshot(f.source), sourceBefore);
        assert.deepEqual(sourceWrites(f), []);
        if (operation === 'readonly') {
          assert.deepEqual(f.shards.map(blockSnapshot), shardsBefore);
          assertReadonlyEvidenceCalls(f);
        } else {
          assert.deepEqual(f.shards[1].rows('SELECT * FROM blocks'), [row]);
          assert.deepEqual(f.shards[1].rows('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ?', ['"🫠"']),
            [{ rowid: row.id }], 'schema rejection must retain the genuine copied posting without authorizing source retirement');
          const checkpoint = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
          assert.equal(checkpoint.rows, 0);
          assert.equal(checkpoint.after, -1);
          assert.equal(checkpoint.pending.phase, 'copying');
          assert.deepEqual(checkpoint.pending.rows, [{ id: row.id, shard: 1, sha256: rowDigest(BLOCK_COLUMNS, row) }]);
        }
      });
    }
  }
});

test('a changed maintenance revision after readback retains the source', async (context) => {
  const f = await fixture(context);
  const row = block(51, 0);
  seedBlocks(f.source, [row]);
  let current = health;
  f.shards[0].afterBatch = () => { current = { ...health, deploymentRevision: 'other-revision' }; };
  await assert.rejects(copyFrozenIndex(f.args({ gate: async () => assertMaintenanceHealth(current, revision, 2) })), /refusing index writes/);
  assert.deepEqual(f.shards[0].rows('SELECT * FROM blocks'), [row]);
  assert.deepEqual(f.source.rows('SELECT * FROM blocks'), [row]);
  assert.deepEqual(sourceWrites(f), []);
  assert.equal((await readCheckpoint(f.shards[0], COPY_CHECKPOINT)).pending.phase, 'copying');
});

test('durable checkpoints bind the exact source and ordered shard database identities', async (context) => {
  const f = await fixture(context);
  seedBlocks(f.source, [block(61)]);
  await assert.rejects(copyFrozenIndex(f.args({ checkpointHook: (state) => {
    if (state.pending) throw new Error('stop with pending durable page');
  } })), /stop with pending durable page/);
  const saved = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
  assert.deepEqual(saved.identity, {
    format: 1, layout: INDEX_LAYOUT, source: f.source.id, shards: f.shards.map(({ id }) => id),
  });
  const originalSourceId = f.source.id;
  f.source.id = 'replacement-source-database';
  await assert.rejects(copyFrozenIndex(f.args()), /different databases\/layout/);
  f.source.id = originalSourceId;
  const originalShardId = f.shards[1].id;
  f.shards[1].id = 'replacement-shard-database';
  await assert.rejects(copyFrozenIndex(f.args()), /different databases\/layout/);
  f.shards[1].id = originalShardId;
  await assert.rejects(copyFrozenIndex(f.args({ shards: [f.shards[0]] })), /different databases\/layout/);
  await writeCheckpoint(f.shards[1], COPY_CHECKPOINT, saved);
  await assert.rejects(copyFrozenIndex(f.args({ shards: [...f.shards].reverse() })), /different databases\/layout/);
  await writeCheckpoint(f.shards[0], COPY_CHECKPOINT, { ...saved, identity: { ...saved.identity, layout: 'changed-layout' } });
  await assert.rejects(copyFrozenIndex(f.args()), /different databases\/layout/);
  assert.deepEqual(sourceWrites(f), []);
  assert.equal(f.source.rows('SELECT COUNT(*) AS n FROM blocks')[0].n, 1);
});

test('completed copy reruns are idempotent but refuse reappeared legacy rows', async (context) => {
  const f = await fixture(context);
  const row = block(71);
  seedBlocks(f.source, [row]);
  const first = await copyFrozenIndex(f.args());
  const batches = f.trace.filter((event) => event.kind === 'batch').length;
  assert.deepEqual(await copyFrozenIndex(f.args()), first);
  assert.equal(f.trace.filter((event) => event.kind === 'batch').length, batches);
  assert.throws(() => seedBlocks(f.source, [block(72)]), /index_migration_frozen/);
  for (const event of ['insert', 'update', 'delete']) {
    f.source.database.exec(`DROP TRIGGER index_migration_blocks_${event}`);
  }
  seedBlocks(f.source, [block(72)]);
  await assert.rejects(copyFrozenIndex(f.args()), /reappeared/);
});

test('mismatched or unsupported schemas and changes after a checkpoint retain all source rows', async (context) => {
  for (const scenario of ['destination-extra-column', 'source-extra-column', 'blob-values', 'changed-after-checkpoint']) {
    await context.test(scenario, async (child) => {
      const f = await fixture(child);
      const row = block(81, 0);
      seedBlocks(f.source, [row]);
      if (scenario === 'destination-extra-column') f.shards[0].database.exec('ALTER TABLE blocks ADD COLUMN future TEXT');
      if (scenario === 'source-extra-column') f.source.database.exec('ALTER TABLE blocks ADD COLUMN future TEXT');
      if (scenario === 'blob-values') {
        for (const db of [f.source, ...f.shards]) db.database.exec('ALTER TABLE blocks ADD COLUMN future BLOB');
        f.source.database.prepare('UPDATE blocks SET future = ? WHERE id = ?').run(new Uint8Array([0, 255, 1]), row.id);
      }
      if (scenario === 'changed-after-checkpoint') {
        await assert.rejects(copyFrozenIndex(f.args({ checkpointHook: (state) => {
          if (state.pending) throw new Error('stop before copy');
        } })), /stop before copy/);
        for (const db of [f.source, ...f.shards]) db.database.exec('ALTER TABLE blocks ADD COLUMN future TEXT');
      }
      await assert.rejects(copyFrozenIndex(f.args()), /columns differ|columns changed|unsupported D1 value/);
      assert.equal(f.source.rows('SELECT COUNT(*) AS n FROM blocks')[0].n, 1);
      assert.deepEqual(sourceWrites(f), []);
      assert.deepEqual(f.shards.flatMap((db) => db.rows('SELECT * FROM blocks')), []);
    });
  }
});

test('matching future scalar columns are copied and digested rather than silently discarded', async (context) => {
  const f = await fixture(context);
  for (const db of [f.source, ...f.shards]) {
    db.database.exec('ALTER TABLE blocks ADD COLUMN future_text TEXT; ALTER TABLE blocks ADD COLUMN future_real REAL');
  }
  const columns = [...BLOCK_COLUMNS, 'future_text', 'future_real'];
  const rows = [block(91, 0, { future_text: '', future_real: 0.125 }), block(92, 1, { future_text: null, future_real: null })];
  seedBlocks(f.source, rows, columns);
  assertVerifiedBeforeDelete(f);
  const result = await copyFrozenIndex(f.args());
  assert.deepEqual(result.columns, columns);
  assertCopied(f, rows);
});

test('unsafe legacy ID ranges are refused before checkpointing or copying', async (context) => {
  for (const id of [-1, INDEX_ID_SPAN, Number.MAX_SAFE_INTEGER]) {
    await context.test(String(id), async (child) => {
      const f = await fixture(child);
      seedBlocks(f.source, [block(id, 0)]);
      await assert.rejects(copyFrozenIndex(f.args()), /legacy block IDs exceed reserved safe copy range/);
      assert.equal(await readCheckpoint(f.shards[0], COPY_CHECKPOINT), null);
      assert.equal(f.trace.filter((event) => event.kind === 'batch').length, 0);
      assert.deepEqual(sourceWrites(f), []);
      assert.equal(f.source.rows('SELECT id FROM blocks')[0].id, id);
    });
  }
});

function session(sid, index = 0) {
  return {
    session_id: sid, harness: index % 2 ? 'codex' : 'omp', machine_id: 'catalog-machine', os: 'linux',
    canonical_file_id: null, cwd: index % 2 ? '' : null, repo_url: 'https://example.test/会話/repo',
    git_branch: '', models: '["model-α","model-😀"]', primary_model: 'model-α',
    title: index % 3 === 0 ? null : index % 3 === 1 ? '' : '会話 résumé 😀',
    started_at: '2026-10-08T04:58:19.123Z', ended_at: null,
    parent_session_id: index ? 'catalog-00' : null, parent_tool_use_id: index ? 'tool-α' : null,
    is_sidechain: index % 2, turn_count: index + 1, block_count: index * 3,
    tokens_in: 4_294_967_297 + index, tokens_out: 0, tokens_reasoning: null,
    tokens_cached: 9_876_543_210, index_state: index % 2 ? 'parsing' : 'ready',
    updated_at: '2026-10-08T04:58:20.456Z', project_name: '', first_interaction_title: 'e\u0301 😀',
    cost_usd: index % 3 === 0 ? null : index % 3 === 1 ? 0 : 0.03125,
    cost_calls: index + 1, cost_priced_calls: index % 3 === 0 ? 0 : index + 1,
  };
}

async function catalogFixture(context, blockRows = [], sessionCount = 100) {
  const f = await fixture(context);
  seedBlocks(f.source, blockRows);
  await copyFrozenIndex(f.args());
  await f.migrateMain();
  f.source.database.exec('BEGIN');
  for (let index = 0; index < sessionCount; index += 1) {
    const sid = `catalog-${String(index).padStart(2, '0')}`;
    insert(f.source, 'sessions', SESSION_CATALOG_COLUMNS, session(sid, index));
    for (const turnKey of ['z-last-turn', 'a-first-turn']) insert(f.source, 'starred_turns', STAR_CATALOG_COLUMNS, {
      session_id: sid, turn_key: turnKey, starred_at: '2026-10-08T05:00:00.001Z',
    });
  }
  // Generate a tombstone and strictly advanced versions using the REAL authoritative triggers.
  insert(f.source, 'sessions', SESSION_CATALOG_COLUMNS, session('catalog-deleted', 19));
  f.source.database.prepare('DELETE FROM sessions WHERE session_id = ?').run('catalog-deleted');
  insert(f.source, 'starred_turns', STAR_CATALOG_COLUMNS, {
    session_id: 'catalog-orphan-star', turn_key: 'stable-content-key', starred_at: '2026-10-08T05:01:00.999Z',
  });
  f.source.database.prepare('UPDATE sessions SET cost_usd = ?, title = ? WHERE session_id = ?')
    .run(12.125, '', 'catalog-00');
  f.source.database.exec('COMMIT');
  // An existing obsolete row and star must disappear when the main tombstone is replicated.
  for (const shard of f.shards) {
    insert(shard, 'sessions', SESSION_CATALOG_COLUMNS, session('catalog-deleted', 19));
    insert(shard, 'starred_turns', STAR_CATALOG_COLUMNS, {
      session_id: 'catalog-deleted', turn_key: 'obsolete-turn', starred_at: '2000-01-01T00:00:00.000Z',
    });
    shard.database.prepare('INSERT INTO catalog_versions (session_id, version, presence) VALUES (?, ?, ?)')
      .run('catalog-deleted', 0, 'present');
  }
  f.trace.length = 0;
  return f;
}

function catalogSnapshot(db) {
  return {
    sessions: db.rows('SELECT * FROM sessions ORDER BY session_id'),
    stars: db.rows('SELECT * FROM starred_turns ORDER BY session_id, turn_key'),
    versions: db.rows('SELECT session_id, version, presence FROM catalog_versions ORDER BY session_id'),
  };
}

function expectedCatalog(f) {
  const sessions = f.source.rows('SELECT * FROM sessions ORDER BY session_id');
  const ids = new Set(sessions.map(({ session_id }) => session_id));
  return {
    sessions,
    stars: f.source.rows('SELECT * FROM starred_turns ORDER BY session_id, turn_key'),
    versions: f.source.rows('SELECT session_id, version FROM session_catalog_versions ORDER BY session_id')
      .map((row) => ({ ...row, presence: ids.has(row.session_id) ? 'present' : 'deleted' })),
  };
}

function catalogStarBytes(db) {
  return db.rows(`SELECT hex(CAST(session_id AS BLOB)) AS session_bytes,
    hex(CAST(turn_key AS BLOB)) AS key_bytes, hex(CAST(starred_at AS BLOB)) AS timestamp_bytes,
    typeof(turn_key) AS storage_class FROM starred_turns ORDER BY session_id, turn_key`);
}

// The export archive parser and shared UTF-8 router accept all nonempty strings;
// control characters are not a separate migration identity policy.
const PUBLIC_SESSION_IDS = ['public\u0000left', 'public\u0000right',
  'public\u0001\u007f会話😀', '\ufeffpublic-session\u0000尾'];

function assertCatalogAcknowledgement(f, expected, mode = 'seed') {
  assert.ok(['seed', 'reconcile'].includes(mode));
  let acknowledgements = 0;
  const committed = new Map(f.shards.map((shard) => [shard.id, []]));
  if (mode === 'reconcile') {
    // Active reconciliation uses the Worker's monotonic write batches, not
    // seed's explicit SELECT readback. Observe real state at native COMMIT.
    for (const shard of f.shards) {
      const afterBatch = shard.afterBatch;
      shard.afterBatch = async (event) => {
        await afterBatch?.(event);
        if (event.committed && event.statements.some(({ sql }) => isWrite(sql))) {
          committed.get(shard.id).push(catalogSnapshot(shard));
        }
      };
    }
  }
  f.source.beforeQuery = ({ sql, params }) => {
    if (!isWrite(sql)) return;
    assert.match(sql, /^\s*DELETE\s+FROM\s+session_catalog_outbox\b/i,
      'catalog seeding may only acknowledge its durable outbox, not mutate authoritative catalog rows');
    const pairs = typeof params[0] === 'string' ? JSON.parse(params[0]) : null;
    const ids = new Set(pairs ? pairs.map(([sid]) => sid)
      : expected.versions.map(({ session_id }) => session_id));
    const subset = (snapshot) => Object.fromEntries(Object.entries(snapshot)
      .map(([key, rows]) => [key, rows.filter(({ session_id }) => ids.has(session_id))]));
    if (pairs) {
      assert.deepEqual(pairs, expected.versions.filter(({ session_id }) => ids.has(session_id))
        .map(({ session_id, version }) => [session_id, version]));
    }
    for (const shard of f.shards) {
      assert.deepEqual(subset(catalogSnapshot(shard)), subset(expected),
        'ALL shards must agree on every acknowledged entry before source outbox deletion');
      if (mode === 'reconcile') {
        assert.ok(committed.get(shard.id).some((snapshot) => isDeepStrictEqual(subset(snapshot), subset(expected))),
          'every acknowledged identity must have its exact catalog/version state on a successful native commit at every shard');
        continue;
      }
      for (const table of ['sessions', 'starred_turns', 'catalog_versions']) {
        for (const sid of ids) {
          assert.ok(f.trace.some((event) => event.db === shard.id && ['query', 'batch-statement'].includes(event.kind)
            && event.success && selectsTable(event.sql, table) && (event.params.includes(sid)
              || event.params.some((value) => typeof value === 'string' && value.startsWith('[')
                && JSON.parse(value).includes(sid)))),
          `${shard.id} ${table} ${sid} must be read back before acknowledgement`);
        }
      }
    }
    acknowledgements += 1;
  };
  return () => acknowledgements;
}

test('catalog seed copies every session/star column, versions and tombstones identically to every shard before clearing outbox', async (context) => {
  const f = await catalogFixture(context);
  const expected = expectedCatalog(f);
  const outbox = f.source.rows('SELECT * FROM session_catalog_outbox ORDER BY seq');
  assert.ok(outbox.length > 16);
  assert.ok(expected.versions.some((row) => row.session_id === 'catalog-deleted' && row.presence === 'deleted'));
  assert.ok(expected.versions.some((row) => row.session_id === 'catalog-orphan-star' && row.presence === 'deleted'));
  const acknowledged = assertCatalogAcknowledgement(f, expected);
  const result = await seedFrozenCatalog(f.args());
  assert.equal(result.state, 'complete');
  assert.equal(result.rows, expected.versions.length);
  assert.ok(acknowledged() >= 2, 'multiple catalog pages must each be verified before retirement');
  assert.deepEqual(f.source.rows('SELECT * FROM session_catalog_outbox'), []);
  assert.deepEqual(expectedCatalog(f), expected, 'main metadata, stars, versions and tombstones are unchanged');
  for (const shard of f.shards) assert.deepEqual(catalogSnapshot(shard), expected);
  assert.deepEqual(catalogSnapshot(f.shards[0]), catalogSnapshot(f.shards[1]));
  assert.equal((await readCheckpoint(f.shards[0], SEED_CHECKPOINT)).state, 'complete');
  const snapshots = f.trace.filter((event) => event.db === f.source.id && event.kind === 'batch');
  assert.ok(snapshots.length >= 2);
  assert.ok(snapshots.every((event) => event.committed && event.statements.length === 3
    && event.statements.every(({ sql }) => /^\s*SELECT\b/i.test(sql))),
  'versions, sessions and stars must come from a single atomic main snapshot per page');
});

for (const operation of ['seed', 'reconcile']) {
  test(`catalog ${operation} preserves viewer-accepted control-character turn keys byte exactly`, async (context) => {
    const f = await catalogFixture(context, [], 3);
    if (operation === 'reconcile') await seedFrozenCatalog(f.args());
    // These are distinct valid UTF-8 values admitted by the viewer's existing
    // nonempty <=1024-code-unit form field contract, including two NUL-prefix keys.
    const keys = ['public\u0000left', 'public\u0000right', '\u0001start', 'end\u001f',
      '\u007fDEL', '\ufeff会話\u0000😀', 'public\n\tline'];
    for (const turn_key of keys) {
      assert.ok(turn_key.length > 0 && turn_key.length <= 1024);
      assert.equal(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(turn_key)), turn_key);
      insert(f.source, 'starred_turns', STAR_CATALOG_COLUMNS, {
        session_id: 'catalog-00', turn_key, starred_at: '2026-10-15T12:34:56.123Z',
      });
      assert.deepEqual(f.source.rows('SELECT turn_key FROM starred_turns WHERE session_id = ? AND turn_key = ?',
        ['catalog-00', turn_key]), [{ turn_key }], 'each key must exist distinctly in native SQLite, including its post-NUL suffix');
    }
    const before = catalogStarBytes(f.source), expected = expectedCatalog(f);
    const hashes = new Map(expected.stars.map((row) => [JSON.stringify([row.session_id, row.turn_key]),
      sha256(JSON.stringify(STAR_CATALOG_COLUMNS.map((column) => row[column])))]));
    const copy = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
    assert.ok(f.source.rows('SELECT seq FROM session_catalog_outbox').length > 0);
    f.trace.length = 0;
    const acknowledged = assertCatalogAcknowledgement(f, expected, operation);
    const result = await (operation === 'seed'
      ? seedCatalogWithNativeParameters(f.args()) : reconcileCatalogWithNativeParameters(f.args()));
    assert.equal(result.state, operation === 'seed' ? 'complete' : 'current');
    assert.ok(acknowledged() > 0, 'outbox retirement requires actual complete catalog replication on every shard');
    assert.deepEqual(f.source.rows('SELECT * FROM session_catalog_outbox'), []);
    assert.deepEqual(catalogStarBytes(f.source), before);
    assert.deepEqual(await readCheckpoint(f.shards[0], COPY_CHECKPOINT), copy);
    for (const shard of f.shards) {
      assert.deepEqual(catalogSnapshot(shard), expected);
      assert.deepEqual(catalogStarBytes(shard), before);
      for (const row of shard.rows('SELECT * FROM starred_turns ORDER BY session_id, turn_key')) {
        assert.equal(rowDigest(STAR_CATALOG_COLUMNS, row), hashes.get(JSON.stringify([row.session_id, row.turn_key])));
      }
    }
  });
}

for (const operation of ['seed', 'reconcile']) {
  test(`catalog ${operation} preserves valid UTF-8 control-bearing session identities`, async (context) => {
    const f = await catalogFixture(context, [], 1);
    if (operation === 'reconcile') await seedFrozenCatalog(f.args());
    for (const sid of PUBLIC_SESSION_IDS) {
      insert(f.source, 'sessions', SESSION_CATALOG_COLUMNS, session(sid));
      insert(f.source, 'starred_turns', STAR_CATALOG_COLUMNS, {
        session_id: sid, turn_key: 'public-ordinary-key', starred_at: '2026-10-15T12:34:56.123Z',
      });
    }
    const before = catalogStarBytes(f.source), expected = expectedCatalog(f);
    const copy = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
    const acknowledged = assertCatalogAcknowledgement(f, expected, operation);
    const result = await (operation === 'seed'
      ? seedCatalogWithNativeParameters(f.args()) : reconcileCatalogWithNativeParameters(f.args()));
    assert.equal(result.state, operation === 'seed' ? 'complete' : 'current');
    assert.ok(acknowledged() > 0);
    assert.deepEqual(f.source.rows('SELECT * FROM session_catalog_outbox'), []);
    assert.deepEqual(catalogStarBytes(f.source), before);
    assert.deepEqual(await readCheckpoint(f.shards[0], COPY_CHECKPOINT), copy);
    for (const shard of f.shards) {
      assert.deepEqual(catalogSnapshot(shard), expected);
      assert.deepEqual(catalogStarBytes(shard), before);
    }
  });
}

test('catalog key validation still refuses empty and malformed native turn keys without acknowledging the outbox', async (context) => {
  for (const operation of ['seed', 'reconcile']) for (const fault of ['empty', 'malformed-utf8']) {
    await context.test(`${operation} ${fault}`, async (child) => {
      const f = await catalogFixture(child, [], 1);
      if (operation === 'reconcile') await seedFrozenCatalog(f.args());
      insert(f.source, 'starred_turns', STAR_CATALOG_COLUMNS, {
        session_id: 'catalog-00', turn_key: 'public-invalid-key', starred_at: '2026-10-15T12:34:56.123Z',
      });
      f.source.database.prepare(`UPDATE starred_turns SET turn_key = ${fault === 'empty' ? "''" : "CAST(unhex('61ff6200') AS TEXT)"}
        WHERE session_id = ? AND turn_key = ?`).run('catalog-00', 'public-invalid-key');
      const source = catalogStarBytes(f.source), before = f.shards.map(catalogSnapshot);
      const outbox = f.source.rows('SELECT * FROM session_catalog_outbox ORDER BY seq');
      f.trace.length = 0;
      await assert.rejects(operation === 'seed'
        ? seedCatalogWithNativeParameters(f.args()) : reconcileCatalogWithNativeParameters(f.args()),
      (error) => error.code === (fault === 'empty' ? 'row-identity' : 'value'));
      assert.deepEqual(catalogStarBytes(f.source), source);
      assert.deepEqual(f.shards.map(catalogSnapshot), before);
      assert.deepEqual(f.source.rows('SELECT * FROM session_catalog_outbox ORDER BY seq'), outbox);
      assert.deepEqual(sourceWrites(f), []);
    });
  }
});


test('partial catalog shard failure retains the entire outbox and resumes from the durable page after reopening databases', async (context) => {
  const f = await catalogFixture(context);
  const expected = expectedCatalog(f);
  const outbox = f.source.rows('SELECT * FROM session_catalog_outbox ORDER BY seq');
  let exercised = false;
  f.shards[1].transformQuery = ({ sql }, rows) => {
    if (!selectsTable(sql, 'sessions') || !rows.length) return rows;
    exercised = true;
    return rows.map((row, index) => index ? row : { ...row, cwd: row.cwd === null ? '' : null });
  };
  await assert.rejects(seedFrozenCatalog(f.args()), /session catalog readback differs/);
  assert.equal(exercised, true);
  assert.deepEqual(f.source.rows('SELECT * FROM session_catalog_outbox ORDER BY seq'), outbox);
  assert.deepEqual(sourceWrites(f), []);
  const checkpoint = await readCheckpoint(f.shards[0], SEED_CHECKPOINT);
  assert.equal(checkpoint.state, 'pending');
  assert.equal(checkpoint.after, '');
  assert.equal(checkpoint.rows, 0);
  assert.ok(f.shards[0].rows('SELECT COUNT(*) AS n FROM sessions')[0].n > 1);
  f.restart();
  assert.deepEqual(await readCheckpoint(f.shards[0], SEED_CHECKPOINT), checkpoint);
  const acknowledged = assertCatalogAcknowledgement(f, expected);
  await seedFrozenCatalog(f.args());
  assert.ok(acknowledged() >= 2);
  for (const shard of f.shards) assert.deepEqual(catalogSnapshot(shard), expected);
  assert.deepEqual(f.source.rows('SELECT * FROM session_catalog_outbox'), []);
});

test('catalog star and version/tombstone readback corruption also blocks every source acknowledgement', async (context) => {
  for (const table of ['starred_turns', 'catalog_versions']) {
    await context.test(table, async (child) => {
      const f = await catalogFixture(child);
      const expected = expectedCatalog(f);
      const outbox = f.source.rows('SELECT * FROM session_catalog_outbox ORDER BY seq');
      let exercised = false, checkpointAtFault, restore;
      const corruptReadback = async ({ sql, params }) => {
        if (exercised || !selectsTable(sql, table)) return;
        const shard = f.shards[1];
        const [row] = shard.rows(`SELECT * FROM ${quoted(table)}
          WHERE session_id IN (SELECT value FROM json_each(?)) LIMIT 1`, [JSON.stringify(params)]);
        if (!row) return;
        exercised = true;
        checkpointAtFault = await readCheckpoint(f.shards[0], SEED_CHECKPOINT);
        const field = table === 'starred_turns' ? 'turn_key' : 'presence';
        const changed = table === 'starred_turns' ? 'not-the-authoritative-content-key'
          : row.presence === 'deleted' ? 'present' : 'deleted';
        const key = table === 'starred_turns' ? ' AND turn_key = ?' : '';
        const update = shard.database.prepare(`UPDATE ${quoted(table)} SET ${quoted(field)} = ? WHERE session_id = ?${key}`);
        update.run(changed, row.session_id, ...(key ? [row.turn_key] : []));
        const [stored] = shard.rows(`SELECT * FROM ${quoted(table)} WHERE session_id = ?${key}`,
          [row.session_id, ...(key ? [changed] : [])]);
        assert.equal(stored[field], changed, 'the fault must change native stored content on the actual readback page');
        assert.deepEqual({ ...stored, [field]: row[field] }, row, 'only the intended catalog scalar may change');
        restore = () => update.run(row[field], row.session_id, ...(key ? [changed] : []));
      };
      f.shards[1].beforeQuery = corruptReadback;
      f.shards[1].beforeStatement = corruptReadback;
      await assert.rejects(seedFrozenCatalog(f.args()), (error) =>
        error instanceof Error && !(error instanceof TypeError));
      assert.equal(exercised, true);
      assert.deepEqual(f.source.rows('SELECT * FROM session_catalog_outbox ORDER BY seq'), outbox);
      assert.deepEqual(sourceWrites(f), []);
      assert.deepEqual(await readCheckpoint(f.shards[0], SEED_CHECKPOINT), checkpointAtFault);
      f.shards[1].beforeQuery = null;
      f.shards[1].beforeStatement = null;
      restore();
      assert.equal((await seedFrozenCatalog(f.args())).state, 'complete',
        'restoring the one physical fault must allow the same durable page to complete');
      for (const shard of f.shards) assert.deepEqual(catalogSnapshot(shard), expected);
      assert.deepEqual(f.source.rows('SELECT * FROM session_catalog_outbox'), []);
    });
  }
});

test('a catalog checkpoint crash retires only the all-shard verified page and resumes unprocessed entries', async (context) => {
  const f = await catalogFixture(context);
  const expected = expectedCatalog(f);
  const outbox = f.source.rows('SELECT * FROM session_catalog_outbox ORDER BY seq');
  assertCatalogAcknowledgement(f, expected);
  await assert.rejects(seedFrozenCatalog(f.args({ checkpointHook: (state) => {
    if (state.rows > 0 && state.state === 'pending') throw new Error('crash after verified catalog page');
  } })), /crash after verified catalog page/);
  const saved = await readCheckpoint(f.shards[0], SEED_CHECKPOINT);
  assert.ok(saved.after);
  assert.ok(saved.rows > 0 && saved.rows < expected.versions.length);
  assert.deepEqual(f.source.rows('SELECT * FROM session_catalog_outbox ORDER BY seq'),
    outbox.filter(({ session_id }) => session_id > saved.after),
    'only the fully verified page is retired; unprocessed catalog pages stay durable');
  assert.equal(sourceWrites(f).length, 1);
  f.restart();
  assert.deepEqual(await readCheckpoint(f.shards[0], SEED_CHECKPOINT), saved);
  assertCatalogAcknowledgement(f, expected);
  const result = await seedFrozenCatalog(f.args());
  assert.equal(result.rows, expected.versions.length);
  for (const shard of f.shards) assert.deepEqual(catalogSnapshot(shard), expected);
  assert.deepEqual(f.source.rows('SELECT * FROM session_catalog_outbox'), []);
});

test('catalog seed refuses missing verified copy, incompatible schemas and a checkpoint from another database', async (context) => {
  await context.test('copy prerequisite', async (child) => {
    const f = await fixture(child);
    await assert.rejects(seedFrozenCatalog(f.args()), /completed verified index copy/);
    assert.deepEqual(sourceWrites(f), []);
  });
  for (const table of ['sessions', 'starred_turns']) {
    await context.test(`${table} schema`, async (child) => {
      const f = await catalogFixture(child);
      f.shards[1].database.exec(`ALTER TABLE ${quoted(table)} ADD COLUMN unsupported TEXT`);
      const outbox = f.source.rows('SELECT * FROM session_catalog_outbox ORDER BY seq');
      await assert.rejects(seedFrozenCatalog(f.args()), /columns differ/);
      assert.deepEqual(sourceWrites(f), []);
      assert.deepEqual(f.source.rows('SELECT * FROM session_catalog_outbox ORDER BY seq'), outbox);
    });
    await context.test(`${table} unsupported matching schema`, async (child) => {
      const f = await catalogFixture(child);
      for (const db of [f.source, ...f.shards]) {
        db.database.exec(`ALTER TABLE ${quoted(table)} ADD COLUMN unsupported TEXT`);
      }
      const outbox = f.source.rows('SELECT * FROM session_catalog_outbox ORDER BY seq');
      await assert.rejects(seedFrozenCatalog(f.args()), /shared replication column contract/);
      assert.deepEqual(sourceWrites(f), []);
      assert.deepEqual(f.source.rows('SELECT * FROM session_catalog_outbox ORDER BY seq'), outbox);
    });
  }
  await context.test('seed checkpoint database identity', async (child) => {
    const f = await catalogFixture(child);
    await assert.rejects(seedFrozenCatalog(f.args({ checkpointHook: () => {
      throw new Error('stop after seed checkpoint');
    } })), /stop after seed checkpoint/);
    const checkpoint = await readCheckpoint(f.shards[0], SEED_CHECKPOINT);
    await writeCheckpoint(f.shards[0], SEED_CHECKPOINT, {
      ...checkpoint, identity: { ...checkpoint.identity, shards: ['other-index-00', 'other-index-01'] },
    });
    const outbox = f.source.rows('SELECT * FROM session_catalog_outbox ORDER BY seq');
    await assert.rejects(seedFrozenCatalog(f.args()), /different databases\/layout/);
    assert.deepEqual(sourceWrites(f), []);
    assert.deepEqual(f.source.rows('SELECT * FROM session_catalog_outbox ORDER BY seq'), outbox);
  });
});

test('a lost response after source deletion resumes its durable verified page without rewriting shard data or FTS', async (context) => {
  const f = await fixture(context);
  const rows = [block(101, 1, { text: 'lost_response_needle résumé 😀' })];
  seedBlocks(f.source, rows);
  assertVerifiedBeforeDelete(f);
  f.source.afterBatch = ({ statements }) => {
    if (statements.some(({ sql }) => /\bDELETE\s+FROM\s+blocks\b/i.test(sql))) {
      throw new Error('lost response after committed source deletion');
    }
  };
  await assert.rejects(copyWithNativeParameters(f.args()), /lost response after committed source deletion/);
  assert.deepEqual(f.source.rows('SELECT * FROM blocks'), []);
  const saved = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
  assert.equal(saved.pending.phase, 'verified');
  assert.equal(saved.rows, 0);
  const snapshots = f.shards.map(blockSnapshot);
  const sourceAfterCommit = blockSnapshot(f.source);
  const batches = destinationBatchCount(f);
  f.restart();
  assertVerifiedBeforeDelete(f);
  const resumedAt = f.trace.length;
  const result = await copyWithNativeParameters(f.args());
  assert.equal(result.rows, rows.length);
  assert.equal(result.state, 'complete');
  assertCopied(f, rows);
  assert.equal(destinationBatchCount(f), batches);
  assert.deepEqual(f.shards.map(blockSnapshot), snapshots);
  assert.deepEqual(blockSnapshot(f.source), sourceAfterCommit);
  assert.deepEqual(f.trace.slice(resumedAt).filter((event) =>
    event.db === f.source.id && event.sql && isWrite(event.sql)), [],
  'observing an already committed deletion must not replay any source mutation');
});

test('catalog seed cannot downgrade a newer shard version or resurrect a newer tombstone', async (context) => {
  for (const presence of ['present', 'deleted']) {
    await context.test(presence === 'deleted' ? 'newer tombstone' : 'newer live catalog', async (child) => {
      const f = await catalogFixture(child);
      const sid = 'catalog-00';
      const sourceVersion = f.source.rows('SELECT version FROM session_catalog_versions WHERE session_id = ?', [sid])[0].version;
      if (presence === 'present') insert(f.shards[1], 'sessions', SESSION_CATALOG_COLUMNS,
        { ...session(sid), title: 'newer authoritative shard record' });
      f.shards[1].database.prepare('INSERT INTO catalog_versions (session_id, version, presence) VALUES (?, ?, ?)')
        .run(sid, sourceVersion + 1000, presence);
      const before = catalogSnapshot(f.shards[1]);
      const outbox = f.source.rows('SELECT * FROM session_catalog_outbox ORDER BY seq');
      await assert.rejects(seedFrozenCatalog(f.args()), /catalog readback differs|version\/tombstone readback mismatch/);
      assert.deepEqual(f.shards[1].rows('SELECT * FROM sessions WHERE session_id = ?', [sid]),
        before.sessions.filter((row) => row.session_id === sid));
      assert.deepEqual(f.shards[1].rows('SELECT * FROM starred_turns WHERE session_id = ?', [sid]), []);
      assert.deepEqual(f.shards[1].rows('SELECT * FROM catalog_versions WHERE session_id = ?', [sid]),
        [{ session_id: sid, version: sourceVersion + 1000, presence }]);
      assert.deepEqual(sourceWrites(f), []);
      assert.deepEqual(f.source.rows('SELECT * FROM session_catalog_outbox ORDER BY seq'), outbox);
    });
  }
});

const protectedProductionEnv = Object.freeze({
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'pedropaulovc/agent-sessions-backup',
  GITHUB_EVENT_NAME: 'push',
  GITHUB_REF: 'refs/heads/main',
  PROTECTED_PRODUCTION_MIGRATION: '1',
  GITHUB_SHA: 'ab'.repeat(20),
  GITHUB_RUN_ID: '123456789',
  GITHUB_RUN_ATTEMPT: '2',
});

function assertProductionGate(candidate, failure) {
  let credentialReads = 0;
  const env = { ...candidate };
  Object.defineProperty(env, 'CLOUDFLARE_API_TOKEN', {
    get() {
      credentialReads += 1;
      throw new Error('production guard must finish before authentication');
    },
  });
  Object.freeze(env);
  if (failure) assert.throws(() => requireProtectedProduction(env), failure);
  else assert.doesNotThrow(() => requireProtectedProduction(env));
  assert.equal(credentialReads, 0, 'gate decisions must not access production credentials');
}

test('production control accepts only a complete protected main-push identity with the pinned or absent account', () => {
  assertProductionGate(protectedProductionEnv);
  assertProductionGate({ ...protectedProductionEnv, CLOUDFLARE_ACCOUNT_ID: PRODUCTION_ACCOUNT_ID });
  assertProductionGate({ ...protectedProductionEnv, CLOUDFLARE_ACCOUNT_ID: '' });
});

test('production control rejects local, PR, fork and incomplete job identities before authentication', () => {
  const protectedJobError = /protected main-push GitHub Actions job/;
  assertProductionGate({}, protectedJobError);
  for (const [field, values] of [
    ['GITHUB_ACTIONS', ['false', 'TRUE', true]],
    ['GITHUB_REPOSITORY', ['untrusted-fork/agent-sessions-backup', 'pedropaulovc/other-repo', 'PEDROPAULOVC/agent-sessions-backup']],
    ['GITHUB_EVENT_NAME', ['pull_request', 'pull_request_target', 'workflow_dispatch']],
    ['GITHUB_REF', ['refs/pull/150/merge', 'refs/heads/fork-main', 'refs/heads/main-old']],
    ['PROTECTED_PRODUCTION_MIGRATION', ['0', 'true', 1]],
  ]) {
    for (const value of values) assertProductionGate({ ...protectedProductionEnv, [field]: value }, protectedJobError);
  }
  for (const field of Object.keys(protectedProductionEnv)) {
    const missing = Object.fromEntries(Object.entries(protectedProductionEnv).filter(([name]) => name !== field));
    assertProductionGate(missing, protectedJobError);
  }
  assertProductionGate({
    ...protectedProductionEnv, GITHUB_REPOSITORY: 'untrusted-fork/agent-sessions-backup',
    GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/150/merge',
  }, protectedJobError);
  assertProductionGate({
    ...protectedProductionEnv, GITHUB_REPOSITORY: 'untrusted-fork/agent-sessions-backup',
  }, protectedJobError);
  const unprotectedForkPush = {
    ...protectedProductionEnv, GITHUB_REPOSITORY: 'untrusted-fork/agent-sessions-backup',
  };
  delete unprotectedForkPush.PROTECTED_PRODUCTION_MIGRATION;
  assertProductionGate(unprotectedForkPush, protectedJobError);
});

test('production control rejects malformed revisions, run identities and wrong accounts before authentication', () => {
  const protectedJobError = /protected main-push GitHub Actions job/;
  for (const GITHUB_SHA of [
    '', 'a'.repeat(39), 'a'.repeat(41), 'AB'.repeat(20), 'g'.repeat(40),
    ` ${protectedProductionEnv.GITHUB_SHA}`, `${protectedProductionEnv.GITHUB_SHA}\n`,
  ]) assertProductionGate({ ...protectedProductionEnv, GITHUB_SHA }, protectedJobError);
  for (const field of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) {
    for (const value of ['', '-1', '1.5', 'run-1', ' 1', '1\n']) {
      assertProductionGate({ ...protectedProductionEnv, [field]: value }, protectedJobError);
    }
  }
  for (const CLOUDFLARE_ACCOUNT_ID of [
    PREVIEW_ACCOUNT_ID, 'f'.repeat(32), PRODUCTION_ACCOUNT_ID.toUpperCase(),
  ]) assertProductionGate({ ...protectedProductionEnv, CLOUDFLARE_ACCOUNT_ID }, /production account identity mismatch/);
});

function assertReadonlyEvidenceCalls(f) {
  assert.ok(f.trace.length > 0);
  assert.ok(f.trace.every((event) => event.kind === 'batch'
    ? event.committed && event.statements.every(({ sql }) => !isWrite(sql))
    : ['query', 'batch-statement'].includes(event.kind) && event.success && !isWrite(event.sql)),
  'operational verification may batch read queries but must never issue DML or change state');
}

function verifierSnapshot(f) {
  return {
    main: expectedCatalog(f),
    outbox: f.source.rows('SELECT * FROM session_catalog_outbox ORDER BY seq'),
    shards: f.shards.map((db) => ({
      ...blockSnapshot(db), catalog: catalogSnapshot(db), meta: db.rows('SELECT * FROM shard_meta'),
      checkpoints: db.rows('SELECT * FROM index_migration_state ORDER BY name'),
    })),
  };
}

test('readonly operational evidence reports real copied block/catalog counts and independent sample digests', async (context) => {
  const rows = Array.from({ length: 10 }, (_, index) => {
    const sid = `catalog-${String(index).padStart(2, '0')}`;
    return block(201 + index, indexShardForSessionId(sid, 2), {
      session_id: sid, text: index ? `verify_needle_${index} résumé 😀` : `verify_long_head ${'会話 😀\u0000'.repeat(10_000)}verify_long_tail`,
    });
  });
  const f = await catalogFixture(context, rows);
  await seedFrozenCatalog(f.args());
  const before = verifierSnapshot(f);
  f.trace.length = 0;
  const result = await verifyIndexRecords({ source: f.source, shards: f.shards, catalogConsistency: 'required' });
  const expected = expectedCatalog(f);
  assert.equal(result.mainSessions, expected.sessions.length);
  assert.equal(result.mainStars, expected.stars.length);
  assert.deepEqual(result.shards, f.shards.map((_db, index) => {
    const shardRows = rows.filter((row) => indexShardForSessionId(row.session_id, 2) === index)
      .sort((left, right) => left.id - right.id);
    return {
      shard: index, blockCount: shardRows.length, sessionCount: expected.sessions.length,
      starCount: expected.stars.length,
      blockSampleSha256: sha256(JSON.stringify(shardRows.slice(0, 4)
        .map((row) => JSON.stringify(BLOCK_COLUMNS.map((column) => row[column]))))),
      catalogSampleSha256: sha256(JSON.stringify(expected.sessions.slice(0, 4)
        .map((row) => JSON.stringify(SESSION_CATALOG_COLUMNS.map((column) => row[column]))))),
    };
  }));
  assertReadonlyEvidenceCalls(f);
  assert.deepEqual(verifierSnapshot(f), before, 'read-only proof must preserve source, catalog, FTS, allocators and checkpoints');
});

test('readonly verification probes empty FTS indexes and reports empty sample digests without initializing or writing', async (context) => {
  const f = await fixture(context);
  const result = await verifyIndexRecords({ source: f.source, shards: f.shards, catalogConsistency: 'required' });
  assert.deepEqual(result, {
    mainSessions: 0, mainStars: 0,
    shards: [0, 1].map((shard) => ({
      shard, blockCount: 0, sessionCount: 0, starCount: 0,
      blockSampleSha256: sha256('[]'), catalogSampleSha256: sha256('[]'),
    })),
  });
  assert.equal(f.trace.filter((event) => /\bMATCH\b/i.test(event.sql)).length, 2);
  assertReadonlyEvidenceCalls(f);
  assert.deepEqual(f.shards.flatMap((db) => db.rows('SELECT * FROM index_migration_state')), []);
});

test('readonly verification refuses wrong routing, allocator IDs, layout, or missing MATCH without repair writes', async (context) => {
  for (const corruption of ['routing', 'allocator', 'layout', 'missing-match']) {
    await context.test(corruption, async (child) => {
      const f = await fixture(child);
      const row = block(corruption === 'allocator' ? indexIdBase(1) : 301, 0, {
        session_id: sessionOn(corruption === 'routing' ? 1 : 0),
      });
      if (corruption === 'missing-match') insert(f.shards[0], 'blocks', BLOCK_COLUMNS, row);
      else seedBlocks(f.shards[0], [row]);
      if (corruption === 'layout') f.shards[0].database.prepare('UPDATE shard_meta SET layout = ? WHERE id = 1').run('untrusted-layout');
      const before = f.shards.map(blockSnapshot);
      f.trace.length = 0;
      await assert.rejects(verifyIndexRecords({ source: f.source, shards: f.shards }),
        /wrong shard|invalid shard allocator ID|layout mismatch|FTS MATCH verification failed/);
      assertReadonlyEvidenceCalls(f);
      assert.deepEqual(f.shards.map(blockSnapshot), before);
    });
  }
});

test('readonly current-catalog verification requires matching session and star counts on every shard', async (context) => {
  for (const table of ['sessions', 'starred_turns']) {
    await context.test(table, async (child) => {
      const f = await catalogFixture(child);
      await seedFrozenCatalog(f.args());
      if (table === 'sessions') {
        f.shards[1].database.prepare('DELETE FROM sessions WHERE session_id = ?').run('catalog-00');
      } else {
        f.shards[1].database.prepare('DELETE FROM starred_turns WHERE session_id = ? AND turn_key = ?')
          .run('catalog-00', 'a-first-turn');
      }
      const before = verifierSnapshot(f);
      f.trace.length = 0;
      await assert.rejects(verifyIndexRecords({ source: f.source, shards: f.shards, catalogConsistency: 'required' }),
        /complete catalog counts differ/);
      assertReadonlyEvidenceCalls(f);
      assert.deepEqual(verifierSnapshot(f), before);
      f.trace.length = 0;
      const sampled = await verifyIndexRecords({ source: f.source, shards: f.shards });
      assert.equal(sampled.shards[1][table === 'sessions' ? 'sessionCount' : 'starCount'],
        sampled[table === 'sessions' ? 'mainSessions' : 'mainStars'] - 1);
      assertReadonlyEvidenceCalls(f);
    });
  }
});

test('readonly sampled catalog evidence refuses absent/zero versions and live-row tombstones', async (context) => {
  for (const corruption of ['missing-version', 'zero-version', 'live-tombstone']) {
    await context.test(corruption, async (child) => {
      const f = await fixture(child);
      insert(f.shards[0], 'sessions', SESSION_CATALOG_COLUMNS, session('verifier-live'));
      if (corruption !== 'missing-version') {
        f.shards[0].database.prepare('INSERT INTO catalog_versions (session_id, version, presence) VALUES (?, ?, ?)')
          .run('verifier-live', corruption === 'zero-version' ? 0 : 1, corruption === 'live-tombstone' ? 'deleted' : 'present');
      }
      const before = catalogSnapshot(f.shards[0]);
      await assert.rejects(verifyIndexRecords({ source: f.source, shards: f.shards }), /live catalog version\/tombstone mismatch/);
      assertReadonlyEvidenceCalls(f);
      assert.deepEqual(catalogSnapshot(f.shards[0]), before);
    });
  }
});

test('full-column source CAS independently rejects every changed scalar column, including NUL suffixes and future columns', async (context) => {
  const f = await fixture(context);
  for (const db of [f.source, ...f.shards]) {
    db.database.exec('ALTER TABLE blocks ADD COLUMN future_text TEXT; ALTER TABLE blocks ADD COLUMN future_real REAL');
  }
  const columns = [...BLOCK_COLUMNS, 'future_text', 'future_real'];
  const compared = columns.filter((column) => column !== 'id');
  const untouched = block(599, 0, { future_text: '', future_real: null });
  const originals = compared.map((column, index) => block(600 + index, 0, {
    role: '', tool_name: null, ts: null, byte_start: 0, byte_len: Number.MAX_SAFE_INTEGER,
    // Distinct first MATCH terms keep this matrix focused on independent CAS columns,
    // rather than making every FTS probe search the same multi-row posting list.
    text: `all_columns_cas_needle_${column}\u0000original_tail`, on_main_path: 0,
    future_text: 'future_prefix\u0000original_tail', future_real: 0.125,
  }));
  const integerNulls = new Set(['byte_start', 'byte_len', 'media_byte_start', 'media_byte_len']);
  const changed = originals.map((row, index) => {
    const column = compared[index];
    const value = row[column];
    const replacement = value === null ? (integerNulls.has(column) ? 0 : '')
      : typeof value === 'number' ? (column === 'future_real' ? 0.25 : value === 0 ? 1 : value - 1)
        : column === 'role' ? null
          : ['text', 'future_text'].includes(column) ? value.replace('original_tail', 'changed_tail') : `${value} changed`;
    return { ...row, [column]: replacement };
  });
  seedBlocks(f.source, [untouched, ...originals], columns);
  const expectedSource = [untouched, ...originals];
  assert.deepEqual(f.source.rows('SELECT * FROM blocks ORDER BY id'), expectedSource);
  for (const row of originals) {
    assert.deepEqual(Buffer.from(f.source.rows('SELECT CAST(text AS BLOB) AS bytes FROM blocks WHERE id = ?', [row.id])[0].bytes),
      Buffer.from(row.text), 'each original source transcript must retain its complete NUL suffix');
    assert.deepEqual(f.source.rows('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ? AND rowid = ?',
      [`"all_columns_cas_needle_${compared[row.id - 600]}"`, row.id]), [{ rowid: row.id }],
    'the unmodified source row must satisfy its actual first-token MATCH probe');
    assert.deepEqual(f.source.rows('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ? AND rowid = ?',
      ['"original_tail"', row.id]), [{ rowid: row.id }], 'source FTS must index text after NUL too');
  }
  assertVerifiedBeforeDelete(f);
  let mutated = false;
  let observedDeletion = false;
  f.source.afterStatement = ({ sql }) => {
    if (!/\bDELETE\s+FROM\s+blocks\b/i.test(sql)) return;
    observedDeletion = true;
    assert.deepEqual(f.source.rows('SELECT * FROM blocks ORDER BY id'), changed,
      'each independently changed column must retain its own row while the unchanged neighbor is provisionally deleted');
  };
  await assert.rejects(copyFrozenIndex(f.args({ checkpointHook: (state) => {
    if (mutated || state.pending?.phase !== 'verified') return;
    assert.deepEqual(f.source.rows('SELECT * FROM blocks ORDER BY id'), expectedSource,
      'the mutation checkpoint must be reached with every original source byte still intact');
    assert.deepEqual(f.shards[0].rows('SELECT * FROM blocks ORDER BY id'), expectedSource,
      'all-column destination readback must succeed before introducing the CAS counterexamples');
    for (let index = 0; index < originals.length; index += 1) {
      const row = originals[index];
      assert.deepEqual(f.shards[0].rows('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ? AND rowid = ?',
        [`"all_columns_cas_needle_${compared[index]}"`, row.id]), [{ rowid: row.id }],
      'destination first-token FTS MATCH must be a positive control before source mutation');
      assert.deepEqual(f.shards[0].rows('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ? AND rowid = ?',
        ['"original_tail"', row.id]), [{ rowid: row.id }], 'destination FTS must retain the original NUL suffix token');
    }
    mutated = true;
    for (let index = 0; index < changed.length; index += 1) {
      const column = compared[index];
      f.source.database.prepare(`UPDATE blocks SET ${quoted(column)} = ? WHERE id = ?`)
        .run(changed[index][column], changed[index].id);
    }
  } })), /malformed JSON/);
  assert.equal(mutated, true, 'all mutations must occur after durable full-row verification');
  assert.equal(observedDeletion, true, 'the native CAS must actually execute against the changed rows');
  assert.deepEqual(f.source.rows('SELECT * FROM blocks ORDER BY id'), [untouched, ...changed],
    'the same-transaction source-empty assertion must roll back the unchanged neighbor too');
  assert.deepEqual(f.shards[0].rows('SELECT * FROM blocks ORDER BY id'), [untouched, ...originals]);
  const pending = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
  assert.equal(pending.pending.phase, 'verified');
  assert.equal(pending.rows, 0);
  assert.deepEqual(f.source.rows('SELECT name FROM sqlite_master WHERE name = ?', [SOURCE_FREEZE_TABLE]), [],
    'failed full-column comparison must not install the first source guard');
  assert.equal(f.trace.find((event) => event.db === f.source.id && event.kind === 'batch').committed, false);
});

test('oversized per-field source CAS cannot delete a transcript changed only after an embedded NUL', async (context) => {
  const f = await fixture(context);
  const text = `oversized_cas_needle\u0000${'😀 e\u0301 会話\n'.repeat(80_000)}oversized_original_tail`;
  assert.ok(Buffer.byteLength(text) > 1024 * 1024);
  assert.ok(Buffer.byteLength(text) < 2_000_000);
  const original = block(701, 0, { text, byte_len: Buffer.byteLength(text) });
  const changed = { ...original, text: text.replace('oversized_original_tail', 'oversized_changed_tail') };
  seedBlocks(f.source, [original]);
  assertVerifiedBeforeDelete(f);
  let mutated = false;
  let observedDeletion = false;
  f.source.afterStatement = ({ sql }) => {
    if (!/\bDELETE\s+FROM\s+blocks\b/i.test(sql)) return;
    observedDeletion = true;
    assert.deepEqual(f.source.rows('SELECT * FROM blocks'), [changed],
      'a matching id, row hash and pre-NUL prefix cannot authorize deleting changed suffix bytes');
  };
  await assert.rejects(copyFrozenIndex(f.args({ checkpointHook: (state) => {
    if (mutated || state.pending?.phase !== 'verified') return;
    mutated = true;
    f.source.database.prepare('UPDATE blocks SET text = ? WHERE id = ?').run(changed.text, changed.id);
  } })), /malformed JSON/);
  assert.equal(mutated, true);
  assert.equal(observedDeletion, true);
  assert.deepEqual(f.source.rows('SELECT * FROM blocks'), [changed]);
  assert.deepEqual(f.shards[0].rows('SELECT * FROM blocks'), [original]);
  const pending = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
  assert.equal(pending.pending.phase, 'verified');
  assert.equal(pending.rows, 0);
  assert.deepEqual(f.source.rows('SELECT name FROM sqlite_master WHERE name = ?', [SOURCE_FREEZE_TABLE]), []);
  assert.equal(f.trace.find((event) => event.db === f.source.id && event.kind === 'batch').committed, false);
});

test('a late source mutation aborts the whole verified deletion transaction and preserves every original source row', async (context) => {
  const f = await fixture(context);
  const untouched = block(400, 0, { text: 'untouched_verified_neighbor' });
  const original = block(401, 0, { text: 'verified_original_needle résumé 😀', role: null });
  const changed = { ...original, text: 'late_unverified_replacement 会話', row_hash: original.row_hash - 1, role: '' };
  seedBlocks(f.source, [untouched, original]);
  assertVerifiedBeforeDelete(f);
  let mutated = false;
  let observedConditionalDeletion = false;
  f.source.afterStatement = ({ sql }) => {
    if (/\bDELETE\s+FROM\s+blocks\b/i.test(sql)) {
      observedConditionalDeletion = true;
      assert.deepEqual(f.source.rows('SELECT * FROM blocks ORDER BY id'), [changed],
        'inside the transaction, the bulk CAS must delete only the unchanged verified neighbor');
    }
  };
  await assert.rejects(copyFrozenIndex(f.args({ checkpointHook: (state) => {
    if (!mutated && state.pending?.phase === 'verified') {
      mutated = true;
      f.source.database.prepare('UPDATE blocks SET text = ?, row_hash = ?, role = ? WHERE id = ?')
        .run(changed.text, changed.row_hash, changed.role, changed.id);
    }
  } })), /malformed JSON/);
  assert.equal(mutated, true, 'mutation must occur AFTER readback and durable verification, before source deletion');
  assert.equal(observedConditionalDeletion, true);
  assert.deepEqual(f.source.rows('SELECT * FROM blocks ORDER BY id'), [untouched, changed],
    'the changed tuple and an earlier successfully compared tuple must BOTH survive the rollback');
  assert.deepEqual(f.shards[0].rows('SELECT * FROM blocks ORDER BY id'), [untouched, original]);
  assert.deepEqual(f.shards[0].rows('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ?', ['"verified_original_needle"']),
    [{ rowid: original.id }]);
  const checkpoint = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
  assert.equal(checkpoint.pending.phase, 'verified');
  assert.equal(checkpoint.rows, 0);
  const deletions = sourceWrites(f);
  assert.equal(deletions.length, 1, 'all ordinary verified rows must use one native bulk CAS deletion');
  assert.equal(deletions[0].kind, 'batch-statement');
  assert.deepEqual(deletions[0].rows, [], 'deletion evidence comes from the atomic source-empty assertion, not RETURNING allocations');
  const sourceBatch = f.trace.find((event) => event.db === f.source.id && event.kind === 'batch');
  assert.equal(sourceBatch.committed, false);
  assert.ok(sourceBatch.statements.some(({ sql }) => selectsTable(sql, 'blocks')),
    'remaining-row verification must run in the SAME source transaction as the conditional deletion');
  assert.deepEqual(f.source.rows('SELECT name FROM sqlite_master WHERE name = ?', [SOURCE_FREEZE_TABLE]), [],
    'a failed comparison must occur before any source barrier allocation');
  const beforeRetry = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
  f.restart();
  assert.deepEqual(await readCheckpoint(f.shards[0], COPY_CHECKPOINT), beforeRetry);
  assertVerifiedBeforeDelete(f);
  const recovered = await copyFrozenIndex(f.args());
  assert.equal(recovered.state, 'complete');
  assert.equal(recovered.rows, 2, 'only a never-committed first source deletion may replan its changed authoritative rows');
  assertCopied(f, [untouched, changed]);
  assert.deepEqual(f.shards[0].rows('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ?', ['"verified_original_needle"']), [],
    'replanning must remove obsolete FTS content from the unacknowledged first copy');
});

async function frozenFirstPageFixture(context, beforeCopy) {
  const f = await fixture(context);
  const rows = Array.from({ length: 2050 }, (_, index) => block(501 + index, index % 2));
  seedBlocks(f.source, rows);
  await beforeCopy?.(f);
  assertVerifiedBeforeDelete(f);
  await assert.rejects(copyFrozenIndex(f.args({ checkpointHook: (state) => {
    if (!state.pending && state.rows > 0 && state.state === 'pending') throw new Error('CI aborted after first frozen source page');
  } })), /CI aborted after first frozen source page/);
  const saved = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
  assert.ok(saved.rows > 100 && saved.rows <= 2048,
    'the first dense page must exceed the former tiny cap while respecting the native row and actual response-byte bounds');
  assert.equal(saved.pending, null);
  assert.equal(saved.state, 'pending');
  assert.deepEqual(f.source.rows('SELECT * FROM blocks ORDER BY id'), rows.slice(saved.rows));
  assert.deepEqual(f.source.rows(`SELECT * FROM ${SOURCE_FREEZE_TABLE}`), [{ id: 1, state: 'frozen' }]);
  return { f, rows, saved };
}

test('the committed SQL barrier rejects pre-existing source writers after CI abort and survives resumed copying', async (context) => {
  let staleDatabase;
  let staleInsert;
  let staleUpdate;
  let staleDelete;
  try {
    const { f, rows, saved } = await frozenFirstPageFixture(context, (current) => {
      // Prepare the old invocation's statements BEFORE the copier installs its trigger schema.
      // SQLite must invalidate/reprepare them so a long-lived HTTP invocation cannot commit later.
      staleDatabase = new DatabaseSync(current.source.filename);
      staleInsert = staleDatabase.prepare(`INSERT INTO blocks (${BLOCK_COLUMNS.map(quoted).join(',')})
        VALUES (${BLOCK_COLUMNS.map(() => '?').join(',')})`);
      staleUpdate = staleDatabase.prepare('UPDATE blocks SET text = ? WHERE id = ?');
      staleDelete = staleDatabase.prepare('DELETE FROM blocks WHERE id = ?');
    });
    const remaining = rows.slice(saved.rows);
    const attempted = block(999, 0, { text: 'old_invocation_new_unverified_text' });
    const assertOldWritesBlocked = () => {
      assert.throws(() => staleInsert.run(...BLOCK_COLUMNS.map((column) => attempted[column])), /index_migration_frozen/);
      assert.throws(() => staleUpdate.run('old invocation replacement', remaining[0].id), /index_migration_frozen/);
      assert.throws(() => staleDelete.run(remaining[0].id), /index_migration_frozen/);
      assert.deepEqual(f.source.rows('SELECT * FROM blocks ORDER BY id'), remaining);
    };
    assertOldWritesBlocked();
    f.restart();
    assert.deepEqual(await readCheckpoint(f.shards[0], COPY_CHECKPOINT), saved);
    assertOldWritesBlocked();
    assertVerifiedBeforeDelete(f);
    let observedCopyingTransaction = false;
    f.source.afterStatement = ({ sql }) => {
      if (/^\s*UPDATE\s+index_migration_freeze\b.*'copying'/is.test(sql)) {
        observedCopyingTransaction = true;
        assert.deepEqual(plainRows(staleDatabase, `SELECT * FROM ${SOURCE_FREEZE_TABLE}`),
          [{ id: 1, state: 'frozen' }], 'an old connection must never observe a committed copying/unfrozen state');
      }
    };
    const result = await copyFrozenIndex(f.args());
    assert.equal(result.state, 'complete');
    assert.equal(result.rows, rows.length);
    assert.equal(observedCopyingTransaction, true);
    assertCopied(f, rows);
    assert.deepEqual(f.source.rows(`SELECT * FROM ${SOURCE_FREEZE_TABLE}`), [{ id: 1, state: 'frozen' }]);
    assert.throws(() => staleInsert.run(...BLOCK_COLUMNS.map((column) => attempted[column])), /index_migration_frozen/);
  } finally {
    // Release the independently opened writer before the fixture's after-hook unlinks its files.
    staleDatabase?.close();
  }
});

test('malformed persisted copying state or missing source freeze triggers fails closed without repairing or deleting source rows', async (context) => {
  for (const corruption of ['copying-state', 'missing-trigger', 'missing-control-row']) {
    await context.test(corruption, async (child) => {
      const { f, rows, saved } = await frozenFirstPageFixture(child);
      let restore;
      if (corruption === 'copying-state') {
        f.source.database.exec(`UPDATE ${SOURCE_FREEZE_TABLE} SET state = 'copying' WHERE id = 1`);
        restore = () => f.source.database.exec(`UPDATE ${SOURCE_FREEZE_TABLE} SET state = 'frozen' WHERE id = 1`);
      } else if (corruption === 'missing-trigger') {
        const [{ sql }] = f.source.rows("SELECT sql FROM sqlite_master WHERE name = 'index_migration_blocks_insert'");
        restore = () => f.source.database.exec(sql);
        f.source.database.exec('DROP TRIGGER index_migration_blocks_insert');
      } else {
        f.source.database.exec(`DELETE FROM ${SOURCE_FREEZE_TABLE} WHERE id = 1`);
        restore = () => f.source.database.exec(`INSERT INTO ${SOURCE_FREEZE_TABLE}(id,state) VALUES(1,'frozen')`);
      }
      const before = f.source.rows('SELECT * FROM blocks ORDER BY id');
      const controlBefore = f.source.rows(`SELECT * FROM ${SOURCE_FREEZE_TABLE}`);
      f.trace.length = 0;
      await assert.rejects(copyFrozenIndex(f.args()), (error) => {
        assert.equal(error.code, corruption === 'missing-trigger' ? 'freeze-schema' : 'freeze-state');
        assert.equal(error.d1Phase, 'copy-source-freeze-read');
        return true;
      });
      assert.deepEqual(f.source.rows('SELECT * FROM blocks ORDER BY id'), before);
      assert.deepEqual(before, rows.slice(saved.rows));
      assert.deepEqual(f.source.rows(`SELECT * FROM ${SOURCE_FREEZE_TABLE}`), controlBefore);
      assert.deepEqual(sourceWrites(f), [], 'invalid committed barrier state must not be repaired into permission to delete');
      assert.deepEqual(await readCheckpoint(f.shards[0], COPY_CHECKPOINT), saved);
      restore();
      const completed = await copyFrozenIndex(f.args());
      assert.equal(completed.state, 'complete');
      assert.equal(completed.rows, rows.length);
      assertCopied(f, rows);
    });
  }
});

test('first source barrier DDL failure rolls back every verified deletion and resumes without regenerating shard FTS', async (context) => {
  const f = await fixture(context);
  const rows = [block(601, 0), block(602, 1)];
  seedBlocks(f.source, rows);
  const sourceBefore = blockSnapshot(f.source);
  assertVerifiedBeforeDelete(f);
  let exercised = false;
  let observedSourceEmptyBeforeDdl = false;
  f.source.afterStatement = ({ sql }) => {
    if (/\bDELETE\s+FROM\s+blocks\b/i.test(sql)) {
      observedSourceEmptyBeforeDdl = true;
      assert.deepEqual(f.source.rows('SELECT id FROM blocks'), [],
        'the source deletion really executed before the injected barrier DDL fault');
    }
    if (/^\s*CREATE\s+TABLE\b/i.test(sql) && sql.includes(SOURCE_FREEZE_TABLE)) {
      exercised = true;
      throw new Error('source storage fault after first barrier table DDL');
    }
  };
  await assert.rejects(copyFrozenIndex(f.args()), /source storage fault after first barrier table DDL/);
  assert.equal(exercised, true);
  assert.equal(observedSourceEmptyBeforeDdl, true);
  assert.deepEqual(blockSnapshot(f.source), sourceBefore,
    'source blocks, the retained legacy FTS and all original text must be restored by the transaction rollback');
  assert.deepEqual(f.source.rows(`SELECT name FROM sqlite_master
    WHERE name = ? OR name LIKE 'index_migration_blocks_%'`, [SOURCE_FREEZE_TABLE]), [],
  'rolled-back barrier DDL must leave no table or partially installed triggers');
  const saved = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
  assert.equal(saved.pending.phase, 'verified');
  assert.equal(saved.rows, 0);
  const sourceBatch = f.trace.find((event) => event.db === f.source.id && event.kind === 'batch');
  assert.equal(sourceBatch.committed, false);
  const deletion = sourceWrites(f).filter(({ sql }) => /\bDELETE\s+FROM\s+blocks\b/i.test(sql));
  assert.equal(deletion.length, 1);
  assert.deepEqual(deletion[0].rows, []);
  const destinationBefore = f.shards.map(blockSnapshot);
  const batches = destinationBatchCount(f);
  f.restart();
  assertVerifiedBeforeDelete(f);
  const result = await copyFrozenIndex(f.args());
  assert.equal(result.state, 'complete');
  assertCopied(f, rows);
  assert.equal(destinationBatchCount(f), batches, 'a durable verified page must reuse its previous shard content and postings');
  assert.deepEqual(f.shards.map(blockSnapshot), destinationBefore);
  assert.deepEqual(f.source.rows(`SELECT * FROM ${SOURCE_FREEZE_TABLE}`), [{ id: 1, state: 'frozen' }]);
});

test('migration classification distinguishes legacy, pending and active states without reading or writing databases', () => {
  const source = Object.freeze({ id: 'classification-main' });
  const shards = [Object.freeze({ id: 'classification-00' }), Object.freeze({ id: 'classification-01' })];
  const identity = { format: 1, layout: INDEX_LAYOUT, source: source.id, shards: shards.map(({ id }) => id) };
  const copy = { identity, state: 'complete' };
  const seed = { identity, state: 'complete' };
  const classify = (extra) => classifyIndexMigration({ source, shards, legacyTables: [], copy: null, seed: null, ...extra });
  for (const legacyTables of [['blocks'], ['blocks_fts'], ['blocks', 'blocks_fts']]) {
    assert.equal(classify({ legacyTables }), 'legacy');
    assert.equal(classify({ legacyTables, copy: { identity, state: 'pending' } }), 'pending');
    assert.equal(classify({ legacyTables, copy, seed }), 'pending', 'retained legacy tables always prohibit the active fast path');
  }
  assert.equal(classify({ copy }), 'pending');
  assert.equal(classify({ copy, seed: { identity, state: 'pending' } }), 'pending');
  assert.equal(classify({ copy, seed, legacyTables: [SOURCE_FREEZE_TABLE] }), 'pending');
  assert.equal(classify({ copy, seed }), 'pending', 'completed copy and seed do not prove successful initial activation');
  for (const extra of [{}, { seed }, { copy: { identity, state: 'pending' }, seed }, { legacyTables: [SOURCE_FREEZE_TABLE] }]) {
    assert.throws(() => classify(extra), /no legacy source and no completed verified copy/);
  }
});

test('classification rejects copy and seed checkpoints for different database identities before taking any fast path', () => {
  const source = { id: 'classification-main' };
  const shards = [{ id: 'classification-00' }, { id: 'classification-01' }];
  const identity = { format: 1, layout: INDEX_LAYOUT, source: source.id, shards: shards.map(({ id }) => id) };
  const complete = { identity, state: 'complete' };
  for (const badIdentity of [
    { ...identity, source: 'another-main' },
    { ...identity, shards: ['another-index-00', shards[1].id] },
    { ...identity, shards: [...identity.shards].reverse() },
    { ...identity, shards: [shards[0].id] },
    { ...identity, layout: `${INDEX_LAYOUT}-changed` },
    { ...identity, format: 2 },
  ]) {
    for (const key of ['copy', 'seed']) {
      for (const legacyTables of [[], ['blocks', 'blocks_fts']]) {
        assert.throws(() => classifyIndexMigration({
          source, shards, legacyTables, copy: complete, seed: complete,
          [key]: { identity: badIdentity, state: 'complete' },
        }), /different databases\/layout/);
      }
    }
  }
});

function activationProofFixture() {
  const source = Object.freeze({ id: 'activation-main' });
  const shards = [Object.freeze({ id: 'activation-00' }), Object.freeze({ id: 'activation-01' })];
  const identity = { format: 1, layout: INDEX_LAYOUT, source: source.id, shards: shards.map(({ id }) => id) };
  const copy = { identity, columns: [...BLOCK_COLUMNS], after: 7, rows: 1, sha256: sha256('complete copy'),
    pending: null, state: 'complete' };
  const seed = { identity, after: 'catalog-00', rows: 1, state: 'complete' };
  const args = { source, shards, copy, seed, revision: 'a'.repeat(40), cycle: '12345:1',
    verifiedAt: 1_760_001_600_000, evidence: { outbox: 'empty', verifiedRows: 1 } };
  const ready = buildReadyProof(args);
  const activation = buildActivationProof({ ...args, ready, verifiedAt: args.verifiedAt + 1 });
  return { ...args, ready, activation };
}

test('durable readiness and activation proofs bind complete snapshots, provenance and evidence without DB calls', () => {
  const args = activationProofFixture();
  const { ready, activation, copy, seed } = args;
  assert.equal(READY_CHECKPOINT, 'full-fidelity-index-ready-v1');
  assert.equal(ACTIVATION_CHECKPOINT, 'full-fidelity-index-activated-v1');
  assert.equal(new Set([COPY_CHECKPOINT, SEED_CHECKPOINT, READY_CHECKPOINT, ACTIVATION_CHECKPOINT]).size, 4);
  assert.equal(ready.state, 'ready');
  assert.equal(activation.state, 'active');
  assert.deepEqual(ready.copy.columns, copy.columns);
  assert.notEqual(ready.copy.columns, copy.columns);
  assert.equal(ready.copy.sha256, copy.sha256);
  assert.equal(ready.copy.rows, copy.rows);
  assert.equal(ready.copy.after, copy.after);
  assert.equal(ready.seed.rows, seed.rows);
  assert.ok(!Object.hasOwn(ready.seed, 'after'), 'proofs must hash, not expose, the seed session-id cursor');
  assert.equal(activation.readyDigest, ready.digest);
  assert.equal(activation.copyCheckpointSha256, ready.copy.checkpointSha256);
  assert.equal(activation.seedCheckpointSha256, ready.seed.checkpointSha256);
  for (const value of [ready.digest, activation.digest, ready.evidenceSha256, ready.copy.checkpointSha256,
    ready.seed.checkpointSha256]) assert.match(value, /^[a-f0-9]{64}$/);
  const roundtrip = JSON.parse(JSON.stringify({ ready, activation }));
  assertReadyProof({ ...args, ready: roundtrip.ready });
  assertActivationProof({ ...args, ...roundtrip });
  const reverseKeys = (value) => Object.fromEntries(Object.entries(value).reverse());
  assertReadyProof({ ...args, ready: reverseKeys(roundtrip.ready) });
  assertActivationProof({ ...args, activation: reverseKeys(roundtrip.activation) });
  assert.deepEqual(buildReadyProof({ ...args, copy: reverseKeys(copy), seed: reverseKeys(seed),
    evidence: reverseKeys(args.evidence) }), ready, 'hashes must not depend on object insertion order');
  const evidence = { records: { rows: 1 }, privateMarker: 'evidence-content-must-not-be-stored' };
  const privateReady = buildReadyProof({ ...args, evidence });
  assert.ok(!JSON.stringify(privateReady).includes(evidence.privateMarker));
  assert.notEqual(privateReady.evidenceSha256, ready.evidenceSha256);
});

test('durable proof validation refuses missing states, unsafe counters, invalid attempts and incomplete snapshots', () => {
  const args = activationProofFixture();
  for (const proof of [undefined, null, false, true, {}, [], { ...args.ready, state: true },
    { ...args.ready, state: 'complete' }, { ...args.ready, format: 2 }]) {
    assert.throws(() => assertReadyProof({ ...args, ready: proof }), /ready proof/);
  }
  for (const proof of [undefined, null, false, true, {}, [], { ...args.activation, state: true },
    { ...args.activation, state: 'complete' }, { ...args.activation, format: 2 }]) {
    assert.throws(() => assertActivationProof({ ...args, activation: proof }), /activation proof/);
  }
  for (const extra of [
    { copy: undefined }, { seed: undefined }, { copy: { ...args.copy, state: 'pending' } },
    { seed: { ...args.seed, state: 'pending' } }, { copy: { ...args.copy, pending: { phase: 'verified' } } },
    { copy: { ...args.copy, sha256: 'not-a-hash' } }, { copy: { ...args.copy, rows: -1 } },
    { copy: { ...args.copy, rows: Number.MAX_SAFE_INTEGER + 1 } }, { copy: { ...args.copy, after: INDEX_ID_SPAN } },
    { copy: { ...args.copy, columns: ['id', 'id'] } }, { copy: { ...args.copy, columns: ['text'] } },
    { seed: { ...args.seed, rows: '1' } }, { seed: { ...args.seed, after: null } },
    { revision: 'A'.repeat(40) }, { revision: true }, { revision: 'a'.repeat(39) },
    { cycle: '12345' }, { cycle: '12345:0' }, { cycle: false },
    { verifiedAt: 0 }, { verifiedAt: 0.5 }, { verifiedAt: Number.MAX_SAFE_INTEGER + 1 },
    { evidence: undefined }, { evidence: true }, { evidence: [] }, { evidence: {} }, { evidence: { rows: undefined } },
  ]) assert.throws(() => buildReadyProof({ ...args, ...extra }), /proof|snapshot|checkpoint/);
  for (const evidence of [undefined, true, [], {}, { rows: NaN }]) {
    assert.throws(() => buildActivationProof({ ...args, evidence }), /proof/);
  }
  assert.throws(() => buildActivationProof({ ...args, verifiedAt: args.ready.verifiedAt - 1 }), /activation proof/);
  assert.throws(() => buildActivationProof({ ...args, revision: 'b'.repeat(40) }), /current revision\/cycle/);
  assert.throws(() => buildActivationProof({ ...args, cycle: '12345:2' }), /current revision\/cycle/);
  const empty = { ...args, copy: { ...args.copy, rows: 0, after: -1 }, seed: { ...args.seed, rows: 0, after: '' } };
  assertReadyProof({ ...empty, ready: buildReadyProof(empty) });
});

test('durable proofs reject substituted same-identity checkpoints and every altered binding field', () => {
  const args = activationProofFixture();
  const snapshots = [
    { copy: { ...args.copy, sha256: sha256('different copied contents') } },
    { copy: { ...args.copy, columns: [...args.copy.columns].reverse() } },
    { copy: { ...args.copy, rows: 2 } }, { copy: { ...args.copy, after: 8 } },
    { copy: { ...args.copy, additionalSnapshotField: 1 } },
    { seed: { ...args.seed, rows: 2 } }, { seed: { ...args.seed, after: 'catalog-01' } },
    { seed: { ...args.seed, additionalSnapshotField: 1 } },
  ];
  for (const extra of snapshots) {
    assert.throws(() => assertReadyProof({ ...args, ...extra }), /binding mismatch/);
    assert.throws(() => assertActivationProof({ ...args, ...extra }), /binding mismatch/);
  }
  for (const extra of [
    { source: { id: 'different-main' } }, { shards: [...args.shards].reverse() },
    { shards: [args.shards[0]] }, { copy: { ...args.copy, identity: { ...args.copy.identity, layout: 'different' } } },
  ]) assert.throws(() => assertReadyProof({ ...args, ...extra }), /different databases\/layout/);
  for (const key of ['digest', 'evidenceSha256', 'revision', 'cycle', 'verifiedAt', 'identity', 'copy', 'seed']) {
    const ready = structuredClone(args.ready);
    ready[key] = key === 'verifiedAt' ? ready[key] + 1
      : key === 'identity' ? { ...ready.identity, source: 'another-main' }
        : key === 'copy' ? { ...ready.copy, after: ready.copy.after + 1 }
          : key === 'seed' ? { ...ready.seed, rows: ready.seed.rows + 1 }
            : key === 'revision' ? 'b'.repeat(40) : key === 'cycle' ? '12345:2' : '0'.repeat(64);
    assert.throws(() => assertReadyProof({ ...args, ready }), /proof/);
  }
  for (const key of ['digest', 'readyDigest', 'evidenceSha256', 'copySha256',
    'copyCheckpointSha256', 'seedCheckpointSha256', 'revision', 'cycle', 'verifiedAt', 'identity']) {
    const activation = structuredClone(args.activation);
    activation[key] = key === 'verifiedAt' ? activation[key] + 1
      : key === 'identity' ? { ...activation.identity, source: 'another-main' }
        : key === 'revision' ? 'b'.repeat(40) : key === 'cycle' ? '12345:2' : '0'.repeat(64);
    assert.throws(() => assertActivationProof({ ...args, activation }), /proof/);
  }
  assert.throws(() => assertReadyProof({ ...args, revision: 'b'.repeat(40) }), /current revision\/cycle/);
  assert.throws(() => assertReadyProof({ ...args, cycle: '12345:2' }), /current revision\/cycle/);
  assert.throws(() => assertReadyProof({ ...args, ready: { ...args.ready, extraField: 'unbound' } }), /binding mismatch/);
});

test('initial activation classification remains pending until valid durable activation and preserves ordinary redeploys', () => {
  const args = activationProofFixture();
  const classify = (extra = {}) => classifyActivation({ ...args, legacyTables: [], ...extra });
  assert.equal(classify({ ready: undefined, activation: undefined }), 'pending',
    'completed copy and seed cannot silently enter the active fast path');
  assert.equal(classify({ activation: undefined }), 'pending', 'READY alone cannot authorize activation');
  assert.equal(classify(), 'active');
  assert.equal(classify({ revision: 'b'.repeat(40), cycle: '99999:3' }), 'active',
    'a valid original activation must survive later ordinary deploy revisions and CI attempts');
  for (const legacyTables of [['blocks'], ['blocks_fts'], [SOURCE_FREEZE_TABLE]]) {
    assert.equal(classify({ legacyTables }), 'pending');
  }
  for (const extra of [
    { ready: false }, { activation: false }, { ready: undefined },
    { activation: { ...args.activation, state: 'complete' } },
    { ready: { ...args.ready, identity: { ...args.ready.identity, source: 'another-main' } } },
    { seed: { ...args.seed, after: 'another-completed-seed' } },
  ]) assert.throws(() => classify(extra), /proof/);
  assert.throws(() => classify({ legacyTables: ['blocks'], activation: false }), /proof/,
    'legacy tables must not hide a malformed present activation proof');
});

test('durable initial activation resumes pending after failed real index verification and survives database reopening', async (context) => {
  const sid = 'catalog-00';
  const row = block(50_001, indexShardForSessionId(sid, 2), { session_id: sid, text: 'activation_verified_needle\u0000original_tail' });
  const f = await catalogFixture(context, [row], 3);
  await seedFrozenCatalog(f.args());
  const copy = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
  const seed = await readCheckpoint(f.shards[0], SEED_CHECKPOINT);
  const evidence = await verifyIndexRecords({ source: f.source, shards: f.shards, catalogConsistency: 'required' });
  assert.deepEqual(f.source.rows('SELECT * FROM session_catalog_outbox'), []);
  const legacyTables = f.source.rows(`SELECT name FROM sqlite_master WHERE type = 'table'
    AND name IN ('blocks', 'blocks_fts', '${SOURCE_FREEZE_TABLE}') ORDER BY name`).map(({ name }) => name);
  assert.deepEqual(legacyTables, [], 'real main migrations must have retired the legacy source and its writer barrier');
  const args = { source: f.source, shards: f.shards, copy, seed, revision: 'c'.repeat(40),
    cycle: '54321:1', verifiedAt: 1_760_001_600_000, evidence };
  const calls = f.trace.length;
  const ready = buildReadyProof(args);
  assertReadyProof({ ...args, ready });
  assert.equal(classifyActivation({ ...args, ready, legacyTables }), 'pending');
  assert.equal(f.trace.length, calls, 'proof construction/assertion/classification must not query any database');
  await writeCheckpoint(f.shards[0], READY_CHECKPOINT, ready);
  f.restart();
  const resumed = { ...args, source: f.source, shards: f.shards,
    ready: await readCheckpoint(f.shards[0], READY_CHECKPOINT) };
  assert.deepEqual(resumed.ready, ready);
  assert.equal(await readCheckpoint(f.shards[0], ACTIVATION_CHECKPOINT), null);
  assert.equal(classifyActivation({ ...resumed, legacyTables }), 'pending');
  const shard = f.shards[indexShardForSessionId(sid, 2)];
  shard.database.prepare("INSERT INTO blocks_fts (blocks_fts, rowid, text) VALUES ('delete', ?, ?)").run(row.id, row.text);
  await assert.rejects(verifyIndexRecords({ source: f.source, shards: f.shards, catalogConsistency: 'required' }),
    /FTS MATCH verification failed/);
  assert.equal(await readCheckpoint(f.shards[0], ACTIVATION_CHECKPOINT), null,
    'failed actual index verification must leave initial activation unwritten');
  f.restart();
  const retried = { ...resumed, source: f.source, shards: f.shards,
    ready: await readCheckpoint(f.shards[0], READY_CHECKPOINT) };
  assert.equal(classifyActivation({ ...retried, legacyTables }), 'pending');
  f.shards[indexShardForSessionId(sid, 2)].database.prepare('INSERT INTO blocks_fts (rowid, text) VALUES (?, ?)')
    .run(row.id, row.text);
  const activeEvidence = await verifyIndexRecords({ source: f.source, shards: f.shards, catalogConsistency: 'required' });
  const activation = buildActivationProof({ ...retried, verifiedAt: args.verifiedAt + 1, evidence: activeEvidence });
  assertActivationProof({ ...retried, activation });
  await writeCheckpoint(f.shards[0], ACTIVATION_CHECKPOINT, activation);
  f.restart();
  const activated = { ...retried, source: f.source, shards: f.shards,
    ready: await readCheckpoint(f.shards[0], READY_CHECKPOINT),
    activation: await readCheckpoint(f.shards[0], ACTIVATION_CHECKPOINT) };
  assertActivationProof(activated);
  assert.equal(classifyActivation({ ...activated, legacyTables }), 'active');
  assert.equal(classifyActivation({ ...activated, legacyTables, revision: 'd'.repeat(40), cycle: '54321:2' }), 'active');
  assert.deepEqual(f.shards[indexShardForSessionId(sid, 2)].rows('SELECT * FROM blocks'), [row]);
});

test('actual controller phases persist readiness and activation only after all checks and resume failures without overwriting proofs', async (context) => {
  const sid = 'catalog-00';
  const row = block(50_002, indexShardForSessionId(sid, 2), { session_id: sid, text: 'controller_phase_needle\u0000original_tail' });
  const f = await catalogFixture(context, [row], 3);
  await seedFrozenCatalog(f.args());
  const initialRevision = 'e'.repeat(40);
  const initialCycle = '67890:1';
  const args = (extra = {}) => ({ source: f.source, shards: f.shards,
    revision: initialRevision, cycle: initialCycle, ...extra });
  const healthFor = (indexMode, deploymentRevision = initialRevision) => ({
    ...health, indexMode, deploymentRevision,
  });
  const maintenanceGate = async () => {
    const current = healthFor('maintenance');
    assertMaintenanceHealth(current, initialRevision, 2);
    return current;
  };
  const activeGate = async () => healthFor('active');
  const proofs = async () => ({
    copy: await readCheckpoint(f.shards[0], COPY_CHECKPOINT),
    seed: await readCheckpoint(f.shards[0], SEED_CHECKPOINT),
    ready: await readCheckpoint(f.shards[0], READY_CHECKPOINT),
    activation: await readCheckpoint(f.shards[0], ACTIVATION_CHECKPOINT),
  });
  const classifyPersisted = async () => {
    const legacyTables = f.source.rows(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('blocks', 'blocks_fts', '${SOURCE_FREEZE_TABLE}')`).map(({ name }) => name);
    return classifyActivation({ ...args(), ...await proofs(), legacyTables });
  };
  const missing = f.shards[1].rows('SELECT * FROM sessions WHERE session_id = ?', [sid])[0];
  f.shards[1].database.prepare('DELETE FROM sessions WHERE session_id = ?').run(sid);
  await assert.rejects(verifyReadyIndex(args({ gate: maintenanceGate })), /complete catalog counts differ/);
  assert.equal((await proofs()).ready, null, 'failed actual strict readback cannot persist READY');
  assert.equal((await proofs()).activation, null);
  assert.equal(await classifyPersisted(), 'pending');
  insert(f.shards[1], 'sessions', SESSION_CATALOG_COLUMNS, missing);
  const failedReadyHealth = new Error('final maintenance health failed');
  let readyGates = 0;
  await assert.rejects(verifyReadyIndex(args({ gate: async () => {
    if (++readyGates === 2) throw failedReadyHealth;
    return maintenanceGate();
  } })), (error) => error === failedReadyHealth);
  assert.equal(readyGates, 2, 'the final readiness health check must run after actual strict verification');
  assert.equal((await proofs()).ready, null);
  f.restart();
  assert.equal(await classifyPersisted(), 'pending');
  const prepared = await verifyReadyIndex(args({ gate: maintenanceGate }));
  assert.equal(prepared.state, 'ready');
  const preparedProofs = await proofs();
  assertReadyProof({ ...args(), ...preparedProofs });
  assert.equal(preparedProofs.activation, null);
  const readyValue = f.shards[0].rows('SELECT value FROM index_migration_state WHERE name = ?', [READY_CHECKPOINT])[0].value;
  let prematureChecks = 0;
  await assert.rejects(verifyActiveIndex(args({ revision: 'f'.repeat(40), cycle: '67890:2',
    gate: async () => { prematureChecks += 1; return activeGate(); },
    login: async () => { prematureChecks += 1; },
  })), /current revision\/cycle/);
  assert.equal(prematureChecks, 0, 'initial current-revision READY must be checked before active health or login');
  const failedLogin = new Error('real login verification failed');
  const loginFailureOrder = [];
  await assert.rejects(verifyActiveIndex(args({
    gate: async () => { loginFailureOrder.push('health'); return activeGate(); },
    login: async () => { loginFailureOrder.push('login'); throw failedLogin; },
  })), (error) => error === failedLogin);
  assert.deepEqual(loginFailureOrder, ['health', 'login']);
  assert.equal((await proofs()).activation, null, 'failed login must not authorize initial activation');
  f.restart();
  assert.equal(await classifyPersisted(), 'pending');
  assert.equal(f.shards[0].rows('SELECT value FROM index_migration_state WHERE name = ?', [READY_CHECKPOINT])[0].value, readyValue);
  const failedActiveHealth = new Error('final active health failed');
  let activeGates = 0;
  let successfulLogins = 0;
  await assert.rejects(verifyActiveIndex(args({
    gate: async () => {
      if (++activeGates === 2) throw failedActiveHealth;
      return activeGate();
    },
    login: async () => { successfulLogins += 1; },
  })), (error) => error === failedActiveHealth);
  assert.equal(activeGates, 2);
  assert.equal(successfulLogins, 1);
  assert.equal((await proofs()).activation, null, 'final health failure after login must still leave activation unwritten');
  f.restart();
  assert.equal(await classifyPersisted(), 'pending');
  const activated = await verifyActiveIndex(args({ gate: activeGate, login: async () => { successfulLogins += 1; } }));
  assert.equal(activated.state, 'active');
  assert.equal(activated.activationState, 'initial');
  assertActivationProof({ ...args(), ...await proofs() });
  const activationValue = f.shards[0].rows('SELECT value FROM index_migration_state WHERE name = ?', [ACTIVATION_CHECKPOINT])[0].value;
  f.restart();
  assert.equal(await classifyPersisted(), 'active');
  let redeployGates = 0;
  let redeployLogins = 0;
  const redeployed = await verifyActiveIndex(args({ revision: 'f'.repeat(40), cycle: '67890:2',
    gate: async () => { redeployGates += 1; return healthFor('active', 'f'.repeat(40)); },
    login: async () => { redeployLogins += 1; },
  }));
  assert.equal(redeployed.activationState, 'existing');
  assert.equal(redeployGates, 2);
  assert.equal(redeployLogins, 1);
  assert.equal(f.shards[0].rows('SELECT value FROM index_migration_state WHERE name = ?', [READY_CHECKPOINT])[0].value, readyValue);
  assert.equal(f.shards[0].rows('SELECT value FROM index_migration_state WHERE name = ?', [ACTIVATION_CHECKPOINT])[0].value, activationValue,
    'ordinary deploys must retain the exact original durable activation proof');
  assertActivationProof({ ...args(), ...await proofs() });
  assert.deepEqual(f.shards[indexShardForSessionId(sid, 2)].rows('SELECT * FROM blocks'), [row]);
});

test('failed initial activation can abort and resume an intentional reseed without retaining stale READY or clearing activation', async (context) => {
  const sid = 'catalog-00';
  const row = block(50_003, indexShardForSessionId(sid, 2), { session_id: sid, text: 'reseed_resume_needle\u0000original_tail' });
  const f = await catalogFixture(context, [row], 3);
  await seedFrozenCatalog(f.args());
  const proofRevision = '1'.repeat(40);
  const cycle = '77777:1';
  const args = (extra = {}) => ({ source: f.source, shards: f.shards, revision: proofRevision, cycle, ...extra });
  const maintenanceGate = async () => {
    const current = { ...health, deploymentRevision: proofRevision };
    assertMaintenanceHealth(current, proofRevision, 2);
    return current;
  };
  const activeGate = async () => ({ ...health, indexMode: 'active', deploymentRevision: proofRevision });
  const persisted = async () => ({
    ...args(),
    copy: await readCheckpoint(f.shards[0], COPY_CHECKPOINT),
    seed: await readCheckpoint(f.shards[0], SEED_CHECKPOINT),
    ready: await readCheckpoint(f.shards[0], READY_CHECKPOINT),
    activation: await readCheckpoint(f.shards[0], ACTIVATION_CHECKPOINT),
    legacyTables: f.source.rows(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('blocks', 'blocks_fts', '${SOURCE_FREEZE_TABLE}')`).map(({ name }) => name),
  });
  await verifyReadyIndex(args({ gate: maintenanceGate }));
  const original = await persisted();
  assertReadyProof(original);
  const failedLogin = new Error('login failed before initial activation');
  await assert.rejects(verifyActiveIndex(args({ gate: activeGate, login: async () => { throw failedLogin; } })),
    (error) => error === failedLogin);
  assert.equal((await persisted()).activation, null);
  assert.equal(classifyActivation(await persisted()), 'pending');
  const crash = new Error('CI aborted after reseed checkpoint reset');
  let abortedAfterReset = false;
  await assert.rejects(seedFrozenCatalog(f.args({ checkpointHook: async (state) => {
    if (state.state !== 'pending') return;
    abortedAfterReset = true;
    assert.equal(await readCheckpoint(f.shards[0], READY_CHECKPOINT), null,
      'the old READY must already be durably absent when SEED first becomes pending');
    assert.equal(await readCheckpoint(f.shards[0], ACTIVATION_CHECKPOINT), null);
    throw crash;
  } })), (error) => error === crash);
  assert.equal(abortedAfterReset, true);
  const aborted = await persisted();
  assert.equal(aborted.seed.state, 'pending');
  assert.equal(aborted.ready, null);
  assert.equal(aborted.activation, null);
  assert.deepEqual(aborted.copy, original.copy);
  assert.equal(classifyActivation(aborted), 'pending', 'an intentional unactivated reseed must remain resumable, not throw for stale READY');
  f.restart();
  assert.equal(classifyActivation(await persisted()), 'pending');
  await assert.rejects(verifyReadyIndex(args({ gate: maintenanceGate })), /prerequisites incomplete/);
  assert.equal((await persisted()).ready, null);
  const reseeded = await seedFrozenCatalog(f.args());
  assert.equal(reseeded.state, 'complete');
  assert.equal(classifyActivation(await persisted()), 'pending');
  await verifyReadyIndex(args({ gate: maintenanceGate }));
  assertReadyProof(await persisted());
  await verifyActiveIndex(args({ gate: activeGate, login: async () => {} }));
  const activated = await persisted();
  assertActivationProof(activated);
  assert.equal(classifyActivation(activated), 'active');
  const before = verifierSnapshot(f);
  await assert.rejects(seedFrozenCatalog(f.args()), /initial activation is already proven; refusing catalog reseed/);
  assert.deepEqual(verifierSnapshot(f), before, 'a proven initial activation and its READY/SEED must never be cleared or reseeded');
  assert.deepEqual(f.shards[indexShardForSessionId(sid, 2)].rows('SELECT * FROM blocks'), [row]);
});

test('reseed and actual controller phases refuse corrupt or foreign proofs without deleting or replacing them', async (context) => {
  for (const corruption of ['ready-digest', 'ready-identity', 'ready-null', 'activation-state', 'activation-null']) {
    await context.test(corruption, async (child) => {
      const f = await catalogFixture(child, [], 2);
      await seedFrozenCatalog(f.args());
      const proofRevision = '2'.repeat(40);
      const args = { source: f.source, shards: f.shards, revision: proofRevision, cycle: '88888:1',
        gate: async () => ({ ...health, deploymentRevision: proofRevision }) };
      await verifyReadyIndex(args);
      const ready = await readCheckpoint(f.shards[0], READY_CHECKPOINT);
      const name = corruption.startsWith('activation-') ? ACTIVATION_CHECKPOINT : READY_CHECKPOINT;
      const corrupt = corruption.endsWith('-null') ? null : corruption === 'activation-state' ? false
        : corruption === 'ready-digest' ? { ...ready, digest: '0'.repeat(64) }
          : { ...ready, identity: { ...ready.identity, source: 'foreign-main' } };
      const raw = JSON.stringify(corrupt);
      f.shards[0].database.prepare(`INSERT INTO index_migration_state (name, value) VALUES (?, ?)
        ON CONFLICT (name) DO UPDATE SET value = excluded.value`).run(name, raw);
      assert.deepEqual(f.shards[0].rows('SELECT value FROM index_migration_state WHERE name = ?', [name]), [{ value: raw }]);
      const expectedError = corrupt === null || corrupt === false
        ? /invalid index migration checkpoint payload/ : /proof/;
      const before = verifierSnapshot(f);
      await assert.rejects(seedFrozenCatalog(f.args()), expectedError);
      assert.deepEqual(verifierSnapshot(f), before, 'malformed present proof data must fail closed, never be discarded to permit reseeding');
      await assert.rejects(verifyReadyIndex(args), expectedError);
      assert.deepEqual(verifierSnapshot(f), before, 'readiness must not silently replace an invalid existing proof');
      let activeChecks = 0;
      await assert.rejects(verifyActiveIndex({ ...args,
        gate: async () => { activeChecks += 1; return { ...health, indexMode: 'active', deploymentRevision: proofRevision }; },
        login: async () => { activeChecks += 1; },
      }), expectedError);
      assert.equal(activeChecks, 0, 'malformed persisted proof state must fail before active health or login');
      assert.deepEqual(verifierSnapshot(f), before, 'active verification must never treat a false or corrupt activation as absent');
    });
  }
});

async function queueControlFixture(context, consumerRows = [
  { consumer_id: 'owned-consumer', type: 'worker', script: 'pause-worker' },
], additionalQueues = []) {
  const queues = [
    { queue_id: 'consumer-id', queue_name: 'consumer-only' },
    { queue_id: 'producer-id', queue_name: 'producer-only' },
    ...additionalQueues.map(({ queue_id, queue_name }) => ({ queue_id, queue_name })),
  ];
  const consumers = new Map([
    ['consumer-id', consumerRows],
    ['producer-id', [{ consumer_id: 'producer-consumer', type: 'worker', script: 'producer-worker' }]],
    ...additionalQueues.map(({ queue_id, consumers: rows }) => [queue_id, rows]),
  ]);
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://queue.fixture');
    const parts = url.pathname.split('/').filter(Boolean);
    requests.push({ method: request.method, path: url.pathname });
    const reply = (status, result) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ success: status === 200, result,
        result_info: { total_count: queues.length } }));
    };
    if (request.method === 'GET' && url.pathname === '/queues') return reply(200, queues);
    if (parts[0] !== 'queues' || parts[2] !== 'consumers' || !consumers.has(parts[1])) return reply(404, null);
    if (request.method === 'GET' && parts.length === 3) return reply(200, consumers.get(parts[1]));
    if (request.method === 'DELETE' && parts.length === 4) {
      const entries = consumers.get(parts[1]);
      if (!entries.some(({ consumer_id }) => consumer_id === parts[3])) return reply(404, null);
      consumers.set(parts[1], entries.filter(({ consumer_id }) => consumer_id !== parts[3]));
      return reply(200, null);
    }
    return reply(400, null);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const api = { cf: async (pathname, init = {}) => {
    const { responseFormat = 'result', ...request } = init;
    if (responseFormat !== 'result' && responseFormat !== 'envelope') throw new Error('invalid local queue response format');
    delete request.allowNotFound;
    const response = await fetch(`${origin}/${pathname}`, request);
    const envelope = await response.json();
    if (!response.ok || !envelope.success) throw new Error(`local queue API rejected HTTP ${response.status}`);
    return responseFormat === 'envelope' ? envelope : envelope.result;
  } };
  return { api, consumers, requests };
}

test('actual queue pause uses native intended consumers only and rejects invalid identities without DELETE', async (context) => {
  const config = { name: 'pause-worker', queues: {
    consumers: [{ queue: 'consumer-only' }, { queue: 'consumer-only' }],
    producers: [{ queue: 'producer-only', binding: 'OUTGOING' }],
  } };
  await context.test('consumer-only queue paused and producer-only queue untouched', async (child) => {
    const f = await queueControlFixture(child);
    const producerBefore = structuredClone(f.consumers.get('producer-id'));
    assert.deepEqual(await consumerControl.pauseConsumers(f.api, config), { pausedConsumers: 1 });
    assert.deepEqual(f.consumers.get('consumer-id'), [], 'the real local DELETE must remove the intended consumer');
    assert.deepEqual(f.consumers.get('producer-id'), producerBefore);
    assert.deepEqual(f.requests.filter(({ method }) => method === 'DELETE'),
      [{ method: 'DELETE', path: '/queues/consumer-id/consumers/owned-consumer' }]);
    assert.equal(f.requests.filter(({ path }) => path === '/queues/consumer-id/consumers').length, 1);
    assert.ok(!f.requests.some(({ path }) => path.startsWith('/queues/producer-id/')),
      'a producer binding must not cause listing or pausing that queue');
  });
  await context.test('canonical script owns the consumer even when an alias disagrees', async (child) => {
    const f = await queueControlFixture(child, [
      { consumer_id: 'owned-consumer', type: 'worker', script: config.name, script_name: 'other-worker' },
    ]);
    assert.deepEqual(await consumerControl.pauseConsumers(f.api, config), { pausedConsumers: 1 });
    assert.deepEqual(f.requests.filter(({ method }) => method === 'DELETE'),
      [{ method: 'DELETE', path: '/queues/consumer-id/consumers/owned-consumer' }]);
  });
  await context.test('all-owned multi-target pause deletes both consumers and preserves producer-only state', async (child) => {
    const f = await queueControlFixture(child, [
      { consumer_id: 'first-owned', type: 'worker', script: config.name, harmless_extra: 'ignored metadata' },
    ], [{
      queue_id: 'last-id', queue_name: 'last-target',
      consumers: [{ consumer_id: 'last-owned', script: config.name }],
    }]);
    const producerBefore = structuredClone(f.consumers.get('producer-id'));
    const targets = { ...config, queues: { ...config.queues,
      consumers: [...config.queues.consumers, { queue: 'last-target' }, { queue: 'last-target' }],
    } };
    assert.deepEqual(await consumerControl.pauseConsumers(f.api, targets), { pausedConsumers: 2 });
    assert.deepEqual([...f.consumers], [
      ['consumer-id', []], ['producer-id', producerBefore], ['last-id', []],
    ]);
    assert.deepEqual(f.requests.filter(({ method }) => method === 'DELETE'), [
      { method: 'DELETE', path: '/queues/consumer-id/consumers/first-owned' },
      { method: 'DELETE', path: '/queues/last-id/consumers/last-owned' },
    ]);
  });
  for (const [name, laterConsumer] of [
    ['foreign owner', { consumer_id: 'foreign-consumer', type: 'worker', script: 'other-worker' }],
    ['non-worker type', { consumer_id: 'invalid-consumer', type: 'http_pull', script: config.name }],
    ['invalid consumer ID', { consumer_id: 42, type: 'worker', script: config.name }],
  ]) {
    for (const location of ['same target after owned consumer', 'last configured target']) {
      await context.test(`${name} on ${location} rejects the whole pause without DELETE`, async (child) => {
        const owned = { consumer_id: 'first-owned', type: 'worker', script: config.name };
        const sameTarget = location === 'same target after owned consumer';
        const f = await queueControlFixture(child, sameTarget ? [owned, laterConsumer] : [owned],
          sameTarget ? [] : [{
            queue_id: 'last-id', queue_name: 'last-target', consumers: [laterConsumer],
          }]);
        const targets = { ...config, queues: { ...config.queues,
          consumers: sameTarget ? config.queues.consumers : [...config.queues.consumers, { queue: 'last-target' }],
        } };
        const before = structuredClone([...f.consumers]);
        await assert.rejects(consumerControl.pauseConsumers(f.api, targets));
        assert.deepEqual(f.requests.filter(({ method }) => method === 'DELETE'), []);
        assert.deepEqual([...f.consumers], before);
      });
    }
  }
  await context.test('missing last configured queue rejects the whole pause without DELETE', async (child) => {
    const f = await queueControlFixture(child);
    const targets = { ...config, queues: { ...config.queues,
      consumers: [...config.queues.consumers, { queue: 'missing-target' }],
    } };
    const before = structuredClone([...f.consumers]);
    await assert.rejects(consumerControl.pauseConsumers(f.api, targets));
    assert.deepEqual(f.requests.filter(({ method }) => method === 'DELETE'), []);
    assert.deepEqual([...f.consumers], before);
  });
  for (const [name, consumer] of [
    ['wrong Worker owner', { consumer_id: 'owned-consumer', type: 'worker', script: 'other-worker', script_name: config.name }],
    ['missing canonical owner despite an owned alias', { consumer_id: 'owned-consumer', type: 'worker', script_name: config.name }],
    ['non-string canonical owner despite an owned alias', { consumer_id: 'owned-consumer', type: 'worker', script: 42, script_name: config.name }],
    ['non-worker type', { consumer_id: 'owned-consumer', type: 'http_pull', script: config.name, script_name: config.name }],
    ['non-string consumer ID', { consumer_id: 42, type: 'worker', script: config.name, script_name: config.name }],
    ['null record', null],
    ['array record', []],
    ['primitive record', 'private primitive consumer record'],
  ]) {
    await context.test(`${name} fails before any DELETE`, async (child) => {
      const f = await queueControlFixture(child, [consumer]);
      const before = structuredClone([...f.consumers]);
      await assert.rejects(consumerControl.pauseConsumers(f.api, config));
      assert.ok(!f.requests.some(({ method }) => method === 'DELETE'));
      assert.deepEqual([...f.consumers], before);
    });
  }
  await context.test('rejection diagnostics redact unrelated values and malformed identity strings', async (child) => {
    const privateValues = {
      consumerId: 'private-consumer-id-value',
      settings: 'private-unrelated-settings-value',
      auth: 'private-auth-token-value',
      owner: 'private invalid owner/value',
      type: 'private malformed type/value',
      alias: 'private invalid alias/value',
      propertyKey: 'PRIVATE PROPERTY KEY production consumer canary',
    };
    const f = await queueControlFixture(child, [{
      consumer_id: privateValues.consumerId, type: privateValues.type, script: privateValues.owner,
      script_name: privateValues.alias, settings: { retry: privateValues.settings }, auth: { bearer: privateValues.auth },
      [privateValues.propertyKey]: privateValues.auth,
    }]);
    const before = structuredClone([...f.consumers]);
    await assert.rejects(consumerControl.pauseConsumers(f.api, config), (error) => {
      for (const value of Object.values(privateValues)) {
        assert.ok(!error.message.includes(value), 'rejection diagnostics must not contain private response values');
      }
      return true;
    });
    assert.ok(!f.requests.some(({ method }) => method === 'DELETE'));
    assert.deepEqual([...f.consumers], before);
  });
});

test('active catalog reconciliation drains at most 16 distinct outbox sessions without performing a full seed', async (context) => {
  const f = await catalogFixture(context, [], 18);
  const expected = expectedCatalog(f);
  const before = f.source.rows('SELECT * FROM session_catalog_outbox ORDER BY seq');
  const firstIds = f.source.rows(`SELECT session_id FROM session_catalog_outbox
    GROUP BY session_id ORDER BY MIN(seq) LIMIT 16`).map(({ session_id }) => session_id);
  const selected = new Set(firstIds);
  assert.equal(await readCheckpoint(f.shards[0], SEED_CHECKPOINT), null);
  f.trace.length = 0;
  const first = await reconcileIndexCatalog({ source: f.source, shards: f.shards });
  assert.deepEqual(first, { state: 'pending', synced: 16 });
  assert.deepEqual(f.source.rows('SELECT * FROM session_catalog_outbox ORDER BY seq'),
    before.filter(({ session_id }) => !selected.has(session_id)));
  for (const shard of f.shards) {
    const actual = catalogSnapshot(shard);
    for (const key of ['sessions', 'stars', 'versions']) {
      assert.deepEqual(actual[key].filter(({ session_id }) => selected.has(session_id)),
        expected[key].filter(({ session_id }) => selected.has(session_id)));
    }
  }
  const reads = f.trace.filter((event) => event.db === f.source.id && event.kind === 'batch');
  assert.equal(reads.length, 1);
  assert.equal(reads[0].committed, true);
  assert.equal(reads[0].statements.length, 3);
  assert.ok(reads[0].statements.every(({ sql }) => /^\s*SELECT\b/i.test(sql)));
  const retirement = sourceWrites(f);
  assert.equal(retirement.length, 1);
  const retiredPairs = JSON.parse(retirement[0].params[0]);
  assert.deepEqual(new Set(retiredPairs.map(([sid]) => sid)), selected);
  assert.ok(retiredPairs.every(([sid, version]) => expected.versions.some((row) => row.session_id === sid && row.version === version)));
  const second = await reconcileIndexCatalog({ source: f.source, shards: f.shards });
  assert.deepEqual(second, { state: 'current', synced: expected.versions.length - 16 });
  for (const shard of f.shards) assert.deepEqual(catalogSnapshot(shard), expected);
  assert.deepEqual(f.source.rows('SELECT * FROM session_catalog_outbox'), []);
  assert.equal(await readCheckpoint(f.shards[0], SEED_CHECKPOINT), null, 'bounded active reconciliation never writes a full-seed checkpoint');
  f.trace.length = 0;
  assert.deepEqual(await reconcileIndexCatalog({ source: f.source, shards: f.shards }), { state: 'current', synced: 0 });
  assert.equal(f.trace.length, 1, 'an empty outbox must not trigger shard queries or any snapshot/write batch');
  assert.equal(f.trace[0].db, f.source.id);
  assert.equal(f.trace[0].kind, 'query');
});

test('older reconciliation snapshots cannot overwrite concurrent newer live rows or tombstones and leave the newer outbox version durable', async (context) => {
  for (const presence of ['present', 'deleted']) {
    await context.test(presence === 'deleted' ? 'concurrent tombstone' : 'concurrent live metadata', async (child) => {
      const f = await catalogFixture(child);
      await seedFrozenCatalog(f.args());
      const sid = 'catalog-00';
      f.source.database.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('older captured metadata', sid);
      const capturedVersion = f.source.rows('SELECT version FROM session_catalog_versions WHERE session_id = ?', [sid])[0].version;
      let advanced = false;
      let newerVersion;
      f.source.afterBatch = ({ statements }) => {
        if (advanced || !statements.every(({ sql }) => /^\s*SELECT\b/i.test(sql))) return;
        advanced = true;
        if (presence === 'deleted') f.source.database.prepare('DELETE FROM sessions WHERE session_id = ?').run(sid);
        else f.source.database.prepare('UPDATE sessions SET title = ?, cost_usd = ? WHERE session_id = ?')
          .run('newer concurrent metadata 会話 😀', 44.125, sid);
        newerVersion = f.source.rows('SELECT version FROM session_catalog_versions WHERE session_id = ?', [sid])[0].version;
        const latestSession = f.source.rows('SELECT * FROM sessions WHERE session_id = ?', [sid])[0];
        const latestStars = f.source.rows('SELECT * FROM starred_turns WHERE session_id = ? ORDER BY turn_key', [sid]);
        // A newer runtime synchronization already reached every shard before the older snapshot
        // returns to its caller. This exercises the SQL version guards, not an echoed response.
        for (const shard of f.shards) {
          shard.database.prepare('DELETE FROM sessions WHERE session_id = ?').run(sid);
          shard.database.prepare('DELETE FROM starred_turns WHERE session_id = ?').run(sid);
          if (latestSession) insert(shard, 'sessions', SESSION_CATALOG_COLUMNS, latestSession);
          for (const star of latestStars) insert(shard, 'starred_turns', STAR_CATALOG_COLUMNS, star);
          shard.database.prepare('UPDATE catalog_versions SET version = ?, presence = ? WHERE session_id = ?')
            .run(newerVersion, presence, sid);
        }
      };
      const first = await reconcileIndexCatalog({ source: f.source, shards: f.shards });
      assert.equal(advanced, true);
      assert.ok(newerVersion > capturedVersion);
      assert.deepEqual(first, { state: 'pending', synced: 1 });
      const latest = expectedCatalog(f);
      for (const shard of f.shards) assert.deepEqual(catalogSnapshot(shard), latest,
        'older batches must not degrade the newer row or resurrect its tombstone');
      const remaining = f.source.rows('SELECT * FROM session_catalog_outbox ORDER BY seq');
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].session_id, sid);
      assert.equal(remaining[0].seq, newerVersion);
      assert.deepEqual(await reconcileIndexCatalog({ source: f.source, shards: f.shards }), { state: 'current', synced: 1 });
      assert.deepEqual(f.source.rows('SELECT * FROM session_catalog_outbox'), []);
      for (const shard of f.shards) assert.deepEqual(catalogSnapshot(shard), latest);
    });
  }
});

test('full seed restart revisits late authoritative changes behind the durable scan cursor instead of discarding their outbox', async (context) => {
  const f = await catalogFixture(context);
  const initial = expectedCatalog(f);
  assertCatalogAcknowledgement(f, initial);
  const sid = 'catalog-00';
  let changed = false;
  await assert.rejects(seedFrozenCatalog(f.args({ checkpointHook: (state) => {
    if (!changed && state.rows > 0 && state.state === 'pending') {
      changed = true;
      assert.ok(sid < state.after);
      f.source.database.prepare('UPDATE sessions SET title = ?, cost_usd = ? WHERE session_id = ?')
        .run('late main metadata behind cursor 会話 😀', 19.03125, sid);
      insert(f.source, 'starred_turns', STAR_CATALOG_COLUMNS, {
        session_id: sid, turn_key: 'late-stable-turn', starred_at: '2026-10-08T06:00:00.000Z',
      });
      throw new Error('CI crash after behind-cursor main metadata change');
    }
  } })), /CI crash after behind-cursor main metadata change/);
  assert.equal(changed, true);
  const saved = await readCheckpoint(f.shards[0], SEED_CHECKPOINT);
  assert.equal(saved.rows, 96, 'full seed uses the native 96-session page, not active reconciliation’s 16-id slice');
  assert.ok(saved.after > sid);
  const latest = expectedCatalog(f);
  const version = latest.versions.find((row) => row.session_id === sid).version;
  assert.ok(f.source.rows('SELECT * FROM session_catalog_outbox WHERE session_id = ?', [sid])
    .some((row) => row.seq === version));
  assert.notDeepEqual(catalogSnapshot(f.shards[0]), latest, 'the late update really was absent from the first page proof');
  f.restart();
  assert.deepEqual(await readCheckpoint(f.shards[0], SEED_CHECKPOINT), saved);
  assertCatalogAcknowledgement(f, latest);
  const result = await seedFrozenCatalog(f.args());
  assert.equal(result.state, 'complete');
  assert.equal(result.rows, latest.versions.length + 1, 'the previously scanned session must be verified again at its newer version');
  assert.deepEqual(f.source.rows('SELECT * FROM session_catalog_outbox'), []);
  for (const shard of f.shards) assert.deepEqual(catalogSnapshot(shard), latest);
});

test('Cloudflare retry decisions replay only explicit 429 responses with bounded retry-after seconds', () => {
  for (const seconds of [1, 7, 90, 3600]) {
    const response = new Response('private response body must remain unread', {
      status: 429, headers: { 'retry-after': String(seconds) },
    });
    assert.equal(cloudflareRetryDelay(response), seconds * 1000);
    assert.equal(response.bodyUsed, false);
  }
  for (const status of [200, 201, 400, 401, 403, 404, 500, 503]) {
    const response = new Response('ambiguous response must not be replayed', {
      status, headers: { 'retry-after': 'invalid delay' },
    });
    assert.equal(cloudflareRetryDelay(response), null);
    assert.equal(response.bodyUsed, false);
  }
  for (const value of [null, '', '0', '-1', '1.5', '3601', 'Infinity', 'not-numeric', 'Wed, 21 Oct 2026 07:28:00 GMT']) {
    const response = new Response('private rejected response', {
      status: 429, headers: value === null ? {} : { 'retry-after': value },
    });
    assert.throws(() => cloudflareRetryDelay(response), /valid retry-after delay; checkpoint retained/);
    assert.equal(response.bodyUsed, false);
  }
});

test('readonly index verification refuses invalid catalog consistency enums before querying any database', async (context) => {
  const f = await fixture(context);
  for (const catalogConsistency of ['active', 'pending', true, false, null]) {
    await assert.rejects(verifyIndexRecords({ source: f.source, shards: f.shards, catalogConsistency }),
      /invalid catalog consistency mode/);
  }
  assert.deepEqual(f.trace, []);
});

function assertNativeRequestLimits(f) {
  const statements = f.trace.filter((event) => typeof event.sql === 'string');
  assert.ok(statements.length > 0);
  for (const { sql, params = [], responseBytes } of statements) {
    assert.ok(params.length <= 100, `native D1 statement exceeds 100 binds: ${params.length}`);
    assert.ok(Buffer.byteLength(sql) <= 100_000, 'native SQL must remain below the 100 KB statement cap');
    assert.ok(Buffer.byteLength(JSON.stringify(params)) <= 1024 * 1024,
      'ordinary serialized D1 parameters must stay within the internal 1 MiB JSON budget');
    if (responseBytes !== undefined) assert.ok(responseBytes <= 1024 * 1024,
      'readback must budget object keys and long markers, not only canonical row values');
  }
  for (const event of f.trace.filter((call) => call.kind === 'batch')) {
    assert.ok(Buffer.byteLength(JSON.stringify(event.statements)) <= 1024 * 1024,
      'ordinary native batch JSON must remain within the 1 MiB transport budget');
  }
}

test('a dense 600-row copy uses bounded native bulk writes, MATCH verification and deletion rather than one RPC per row', async (context) => {
  const f = await fixture(context);
  const rows = Array.from({ length: 600 }, (_, index) => block(10_001 + index, index % 2, {
    text: `dense_needle_${index} café\u0000会話 😀 dense_tail_${index}`,
    role: index % 3 ? '' : null, on_main_path: index % 2, row_hash: 2 ** 32 - index,
  }));
  seedBlocks(f.source, rows);
  const copiedTuples = assertVerifiedBeforeDelete(f);
  const pages = [];
  const result = await copyFrozenIndex(f.args({ checkpointHook: (state) => {
    if (state.pending?.phase === 'copying') pages.push(state);
  } }));
  assert.equal(result.state, 'complete');
  assert.equal(result.rows, rows.length);
  assert.equal(copiedTuples(), rows.length);
  assert.equal(pages.length, 1, 'dense short rows must not use the former 16-row operational paging');
  assert.equal(pages[0].pending.rows.length, rows.length);
  assertCopied(f, rows);
  assertNativeRequestLimits(f);
  const writes = assertAtomicBlockBatches(f);
  assert.equal(writes.length, 2);
  for (const batch of writes) {
    assert.equal(batch.statements.length, 4, 'ordinary row count must not expand the atomic shard write statement count');
    assert.ok(batch.statements.every(({ params }) => params.length === 1),
      'IDs and ordinary canonical rows each use one JSON1 bind');
    const insertion = batch.statements.find(({ sql }) => /\bINSERT\s+INTO\s+"?blocks"?\s*\(/i.test(sql));
    const tuples = JSON.parse(insertion.params[0]);
    const shardIndex = f.shards.findIndex(({ id }) => id === batch.db);
    assert.deepEqual(tuples, rows.filter((row) => indexShardForSessionId(row.session_id, 2) === shardIndex)
      .map((row) => BLOCK_COLUMNS.map((column) => row[column])));
  }
  const deletion = sourceWrites(f).filter(({ sql }) => /\bDELETE\s+FROM\s+blocks\b/i.test(sql));
  assert.equal(deletion.length, 1, 'an ordinary source page must use one native full-column bulk CAS');
  const matches = f.trace.filter((event) => ['query', 'batch-statement'].includes(event.kind) && /\bMATCH\b/i.test(event.sql));
  assert.ok(matches.every((event) => event.success), 'every native MATCH read must complete before acknowledgment');
  assert.deepEqual(matches.flatMap((event) => event.rows.map(({ rowid }) => rowid)).sort((a, b) => a - b),
    rows.map(({ id }) => id), 'FTS verification must return every requested identity exactly once');
  const requests = f.trace.filter((event) => ['query', 'batch'].includes(event.kind));
  assert.ok(requests.length <= 50, `dense copy must use bounded native RPCs, observed ${requests.length}`);
});

test('source copy forecast measures real SQLite density/fanout and reports only aggregate estimates without any state changes', async (context) => {
  const f = await fixture(context);
  const privateMarker = 'private-forecast-transcript-会話-😀';
  const rows = Array.from({ length: 600 }, (_, index) => block(20_001 + index, index % 2, {
    text: `${privateMarker} ${index}`,
  }));
  seedBlocks(f.source, rows);
  const before = blockSnapshot(f.source);
  const metadataBefore = f.shards.map((db) => ({
    meta: db.rows('SELECT * FROM shard_meta'), checkpoints: db.rows('SELECT * FROM index_migration_state'),
  }));
  const sizes = rows.map((row) => Buffer.byteLength(JSON.stringify(BLOCK_COLUMNS.map((column) => row[column]))));
  const forecast = await sourceCopyForecast({ source: f.source, shards: f.shards });
  assert.deepEqual(forecast, {
    kind: 'estimate', remainingRows: rows.length, shardCount: 2, rowCap: 2048, byteCap: 1024 * 1024,
    sampledRows: rows.length, sampledPages: 1,
    observedRowBytes: { total: sizes.reduce((sum, size) => sum + size, 0),
      mean: sizes.reduce((sum, size) => sum + size, 0) / rows.length, max: Math.max(...sizes) },
    observedPageRows: { mean: rows.length, max: rows.length },
    observedShardFanout: { mean: 2, max: 2 },
    estimatedRemainingPages: 1, estimatedRemainingRequests: 20, requestRatePerSecond: CLOUDFLARE_REQUEST_RATE_PER_SECOND,
    estimatedApiTimeLowerBoundSeconds: 20 / CLOUDFLARE_REQUEST_RATE_PER_SECOND,
  });
  assertReadonlyEvidenceCalls(f);
  assertNativeRequestLimits(f);
  assert.deepEqual(blockSnapshot(f.source), before);
  assert.deepEqual(f.shards.map((db) => ({
    meta: db.rows('SELECT * FROM shard_meta'), checkpoints: db.rows('SELECT * FROM index_migration_state'),
  })), metadataBefore);
  assert.deepEqual(f.source.rows('SELECT name FROM sqlite_master WHERE name = ?', [SOURCE_FREEZE_TABLE]), []);
  const serialized = JSON.stringify(forecast);
  assert.ok(!serialized.includes(privateMarker));
  assert.ok(!serialized.includes(rows[0].session_id));
  assert.ok(!serialized.includes(f.source.id));
  assert.ok(!f.trace.some((event) => /\bindex_migration_state\b/i.test(event.sql)),
    'forecasting must not load or rewrite migration checkpoints');
});

test('empty-source forecasting is read-only and explicitly estimates zero remaining copy work', async (context) => {
  const f = await fixture(context);
  const forecast = await sourceCopyForecast({ source: f.source, shards: f.shards });
  assert.deepEqual(forecast, {
    kind: 'estimate', remainingRows: 0, shardCount: 2, rowCap: 2048, byteCap: 1024 * 1024,
    sampledRows: 0, sampledPages: 0, observedRowBytes: { total: 0, mean: 0, max: 0 },
    observedPageRows: { mean: 0, max: 0 }, observedShardFanout: { mean: 0, max: 0 },
    estimatedRemainingPages: 0, estimatedRemainingRequests: 0, requestRatePerSecond: CLOUDFLARE_REQUEST_RATE_PER_SECOND,
    estimatedApiTimeLowerBoundSeconds: 0,
  });
  assertReadonlyEvidenceCalls(f);
  assert.deepEqual(f.source.rows('SELECT name FROM sqlite_master WHERE name = ?', [SOURCE_FREEZE_TABLE]), []);
});

test('first-page recovery removes unacknowledged shard rows and FTS for source IDs deleted before any source transaction committed', async (context) => {
  const f = await fixture(context);
  const removed = block(30_001, 0, { text: 'removed_stale_pending_needle' });
  const kept = block(30_002, 1, { text: 'kept_pending_original_needle' });
  const updated = { ...kept, text: 'kept_pending_latest_needle 会話', row_hash: kept.row_hash - 1 };
  seedBlocks(f.source, [removed, kept]);
  await assert.rejects(copyFrozenIndex(f.args({ checkpointHook: (state) => {
    if (state.pending?.phase === 'verified') {
      f.source.database.prepare('DELETE FROM blocks WHERE id = ?').run(removed.id);
      f.source.database.prepare('UPDATE blocks SET text = ?, row_hash = ? WHERE id = ?')
        .run(updated.text, updated.row_hash, updated.id);
    }
  } })), /malformed JSON/);
  assert.deepEqual(f.source.rows('SELECT * FROM blocks'), [updated]);
  const saved = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
  assert.equal(saved.rows, 0);
  assert.equal(saved.pending.phase, 'verified');
  assert.deepEqual(f.source.rows('SELECT name FROM sqlite_master WHERE name = ?', [SOURCE_FREEZE_TABLE]), []);
  f.restart();
  assertVerifiedBeforeDelete(f);
  const result = await copyFrozenIndex(f.args());
  assert.equal(result.rows, 1);
  assert.equal(result.state, 'complete');
  assertCopied(f, [updated]);
  assert.deepEqual(f.shards[0].rows('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ?', ['"removed_stale_pending_needle"']), []);
  assert.deepEqual(f.shards[1].rows('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ?', ['"kept_pending_original_needle"']), []);
  const cleanup = f.trace.filter((event) => event.kind === 'batch' && event.statements.length === 2
    && event.statements.some(({ sql }) => /INSERT\s+INTO\s+blocks_fts/i.test(sql))
    && event.statements.some(({ sql }) => /\bDELETE\s+FROM\s+blocks\b/i.test(sql)));
  assert.equal(cleanup.length, 2, 'every affected shard discards only its unacknowledged prior pending IDs atomically with FTS');
  assert.ok(cleanup.every((event) => event.atomic && event.committed));
});

test('a committed first-page writer barrier forbids checkpoint replan after lost responses even if destination or source rows are later corrupted', async (context) => {
  for (const corruption of ['destination', 'source']) {
    await context.test(corruption, async (child) => {
      const f = await fixture(child);
      const original = block(31_001, 0, { text: 'committed_first_page_expected_needle' });
      const corrupted = { ...original, text: 'corrupted_after_commit_unverified', row_hash: original.row_hash - 1 };
      seedBlocks(f.source, [original]);
      f.source.afterBatch = ({ statements }) => {
        if (statements.some(({ sql }) => /\bDELETE\s+FROM\s+blocks\b/i.test(sql))) {
          throw new Error('lost committed first-page response');
        }
      };
      await assert.rejects(copyFrozenIndex(f.args()), /lost committed first-page response/);
      assert.deepEqual(f.source.rows(`SELECT * FROM ${SOURCE_FREEZE_TABLE}`), [{ id: 1, state: 'frozen' }]);
      assert.deepEqual(f.source.rows('SELECT * FROM blocks'), []);
      const originalProof = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
      assert.equal(originalProof.pending.phase, 'verified');
      assert.equal(originalProof.rows, 0);
      if (corruption === 'destination') {
        f.shards[0].database.prepare('UPDATE blocks SET text = ?, row_hash = ? WHERE id = ?')
          .run(corrupted.text, corrupted.row_hash, corrupted.id);
      } else {
        // Deliberate administrative corruption, not an ordinary old writer (which the barrier
        // rejects). The complete frozen schema still proves the original deletion committed.
        f.source.database.exec('BEGIN');
        f.source.database.exec(`UPDATE ${SOURCE_FREEZE_TABLE} SET state = 'copying' WHERE id = 1`);
        insert(f.source, 'blocks', BLOCK_COLUMNS, corrupted);
        f.source.database.exec(`UPDATE ${SOURCE_FREEZE_TABLE} SET state = 'frozen' WHERE id = 1`);
        f.source.database.exec('COMMIT');
      }
      const destinationBefore = f.shards.map(blockSnapshot);
      f.restart();
      f.trace.length = 0;
      await assert.rejects(copyFrozenIndex(f.args()), /readback SHA-256 mismatch|frozen source changed/);
      assert.deepEqual(await readCheckpoint(f.shards[0], COPY_CHECKPOINT), originalProof,
        'an irreversible first-page commit must retain its original IDs and digests, never reset a proof to match corruption');
      assert.deepEqual(f.shards.map(blockSnapshot), destinationBefore);
      assert.deepEqual(sourceWrites(f), []);
      assert.equal(destinationBatchCount(f), 0);
      assert.deepEqual(f.source.rows(`SELECT * FROM ${SOURCE_FREEZE_TABLE}`), [{ id: 1, state: 'frozen' }]);
    });
  }
});

function annotateSqlProbeFailures(db) {
  const batch = db.batch.bind(db);
  db.batch = async (statements) => {
    try { return await batch(statements); }
    catch (error) {
      error.d1SqlReason = d1SqlFailureReason([{ message: error.message }]);
      throw error;
    }
  };
  return db;
}

function probeTables(db) {
  return db.rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '__index_batch_probe_%'");
}

test('D1 atomicity positive control proves exact BOM/Unicode/NUL text bytes, native commit/readback and intentional SQL rollback using real SQLite', async (context) => {
  const f = await fixture(context);
  const db = annotateSqlProbeFailures(f.shards[0]);
  seedBlocks(f.source, [block(32_001)]);
  const sourceBefore = blockSnapshot(f.source);
  const indexBefore = blockSnapshot(db);
  const textBytes = Buffer.byteLength(D1_BATCH_PROBE_TEXT, 'utf8');
  const expectedReadback = [{ id: 1, value: D1_BATCH_PROBE_TEXT, value_bytes: textBytes }];
  const result = await verifyD1BatchAtomicity(db);
  assert.deepEqual(result, {
    state: 'verified', probe: 'd1-rest-batch-atomicity', databaseId: db.id,
    textTransport: 'verified', textBytes,
  });
  const batches = f.trace.filter((event) => event.kind === 'batch');
  assert.equal(batches.length, 2);
  assert.equal(batches[0].atomic, true);
  assert.equal(batches[0].committed, true);
  assert.equal(batches[0].statements.length, 3);
  assert.equal(batches[1].atomic, true);
  assert.equal(batches[1].committed, false);
  const readbacks = f.trace.filter((event) => event.success
    && ['query', 'batch-statement'].includes(event.kind)
    && event.rows?.some((row) => Object.hasOwn(row, 'value')));
  assert.deepEqual(readbacks.map(({ kind, rows }) => ({ kind, rows })), [
    { kind: 'batch-statement', rows: expectedReadback },
    { kind: 'query', rows: expectedReadback },
  ], 'native and independent SQL getters must preserve the complete text and stored UTF-8 byte length');
  for (const { rows } of readbacks) {
    assert.deepEqual(Buffer.from(rows[0].value, 'utf8'), Buffer.from(D1_BATCH_PROBE_TEXT, 'utf8'));
    assert.equal(Buffer.byteLength(rows[0].value, 'utf8'), rows[0].value_bytes);
  }
  assert.deepEqual(probeTables(db), []);
  assert.deepEqual(blockSnapshot(f.source), sourceBefore);
  assert.deepEqual(blockSnapshot(db), indexBefore);
  assert.ok(f.trace.every((event) => event.db === db.id), 'the atomicity probe must never write or query the source database');
});

test('corrupt native or independent atomicity text/byte readbacks fail closed and clean only the owned table before copy', async (context) => {
  for (const phase of ['batch', 'independent']) {
    for (const corruption of ['missing-text', 'nul-suffix-truncation', 'bom-strip', 'missing-byte-length',
      'byte-length-mismatch', 'missing-row', 'duplicate-row']) {
      await context.test(`${phase}: ${corruption}`, async (child) => {
        const f = await fixture(child);
        const db = annotateSqlProbeFailures(f.shards[0]);
        seedBlocks(f.source, [block(32_101, 0)]);
        seedBlocks(db, [block(32_102, 0)]);
        const sourceBefore = blockSnapshot(f.source);
        const indexesBefore = f.shards.map(blockSnapshot);
        const sentinel = '__index_batch_probe_user_owned_text_sentinel';
        db.database.exec(`CREATE TABLE ${quoted(sentinel)} (value TEXT NOT NULL)`);
        db.database.prepare(`INSERT INTO ${quoted(sentinel)} (value) VALUES (?)`).run('keep user-owned table');
        const textBytes = Buffer.byteLength(D1_BATCH_PROBE_TEXT, 'utf8');
        let exercised = 0;
        db.transformQuery = ({ kind }, rows) => {
          if (kind !== (phase === 'batch' ? 'batch-statement' : 'query')
            || !rows.some((row) => Object.hasOwn(row, 'value_bytes'))) return rows;
          exercised += 1;
          assert.deepEqual(rows, [{ id: 1, value: D1_BATCH_PROBE_TEXT, value_bytes: textBytes }],
            'the fault must corrupt genuine SQL readback, not substitute a fabricated successful response');
          if (corruption === 'missing-row') return [];
          if (corruption === 'duplicate-row') return [...rows, { ...rows[0] }];
          return rows.map((row) => {
            const changed = { ...row };
            if (corruption === 'missing-text') delete changed.value;
            if (corruption === 'nul-suffix-truncation') changed.value = changed.value.slice(0, changed.value.indexOf('\u0000'));
            if (corruption === 'bom-strip') changed.value = changed.value.slice(1);
            if (corruption === 'missing-byte-length') delete changed.value_bytes;
            if (corruption === 'byte-length-mismatch') changed.value_bytes -= 1;
            return changed;
          });
        };
        await assert.rejects(verifyD1BatchAtomicity(db), (error) => {
          assert.equal(error.d1AtomicityPhase, phase === 'batch' ? 'batch-positive' : 'independent-positive');
          assert.equal(error.d1AtomicityFailure, 'assertion');
          return true;
        });
        assert.equal(exercised, 1, 'the selected native or independent SQL readback must encounter the fault');
        const batches = f.trace.filter((event) => event.kind === 'batch');
        assert.equal(batches.length, 1);
        assert.equal(batches[0].committed, true, 'real CREATE/INSERT/SELECT must commit before transport corruption is rejected');
        assert.ok(!f.trace.some((event) => event.sql?.includes('index_batch_atomicity_intentional_invalid_json')),
          'rollback proof cannot start after text transport proof fails');
        const drops = f.trace.filter((event) => event.kind === 'query' && /^\s*DROP TABLE\b/i.test(event.sql));
        assert.equal(drops.length, 1);
        assert.ok(drops[0].sql.includes('__index_batch_probe_'));
        assert.ok(!drops[0].sql.includes(sentinel), 'a similarly named pre-existing table is not owned by the probe');
        assert.deepEqual(probeTables(db), [{ name: sentinel }]);
        assert.deepEqual(db.rows(`SELECT * FROM ${quoted(sentinel)}`), [{ value: 'keep user-owned table' }]);
        assert.deepEqual(blockSnapshot(f.source), sourceBefore);
        assert.deepEqual(f.shards.map(blockSnapshot), indexesBefore);
        assert.deepEqual(sourceWrites(f), []);
        assert.ok(f.trace.every((event) => event.db === db.id));
        assert.ok(f.trace.every((event) => !event.sql
          || selectsTable(event.sql, 'sqlite_master') || event.sql.includes('__index_batch_probe_')),
        'text transport rejection must precede every data-table operation');
      });
    }
  }
});

test('unexpected native atomicity result counts fail closed after real SQL commit and owned cleanup', async (context) => {
  for (const corruption of ['missing-result', 'extra-result']) {
    await context.test(corruption, async (child) => {
      const f = await fixture(child);
      const db = annotateSqlProbeFailures(f.shards[0]);
      seedBlocks(f.source, [block(32_201, 0)]);
      seedBlocks(db, [block(32_202, 0)]);
      const sourceBefore = blockSnapshot(f.source);
      const indexesBefore = f.shards.map(blockSnapshot);
      const native = db.batch.bind(db);
      let exercised = 0;
      db.batch = async (statements) => {
        const results = await native(statements);
        assert.equal(results.length, 3);
        assert.deepEqual(results[2].results, [{
          id: 1, value: D1_BATCH_PROBE_TEXT, value_bytes: Buffer.byteLength(D1_BATCH_PROBE_TEXT, 'utf8'),
        }], 'result-count corruption starts only after genuine SQLite text/byte readback');
        exercised += 1;
        return corruption === 'missing-result' ? results.slice(0, -1) : [...results, results.at(-1)];
      };
      await assert.rejects(verifyD1BatchAtomicity(db), (error) => {
        assert.equal(error.d1AtomicityPhase, 'batch-positive');
        assert.equal(error.d1AtomicityFailure, 'assertion');
        return true;
      });
      assert.equal(exercised, 1);
      const batches = f.trace.filter((event) => event.kind === 'batch');
      assert.equal(batches.length, 1);
      assert.equal(batches[0].committed, true);
      assert.ok(!f.trace.some((event) => event.sql?.includes('index_batch_atomicity_intentional_invalid_json')));
      const drops = f.trace.filter((event) => event.kind === 'query' && /^\s*DROP TABLE\b/i.test(event.sql));
      assert.equal(drops.length, 1);
      assert.ok(drops[0].sql.includes('__index_batch_probe_'));
      assert.deepEqual(probeTables(db), []);
      assert.deepEqual(blockSnapshot(f.source), sourceBefore);
      assert.deepEqual(f.shards.map(blockSnapshot), indexesBefore);
      assert.deepEqual(sourceWrites(f), []);
      assert.ok(f.trace.every((event) => event.db === db.id));
      assert.ok(f.trace.every((event) => !event.sql
        || selectsTable(event.sql, 'sqlite_master') || event.sql.includes('__index_batch_probe_')),
      'invalid native result counts must be rejected before any data-table operation');
    });
  }
});

test('the atomicity positive control detects non-atomic partial commits and removes only its own random probe table', async (context) => {
  const f = await fixture(context);
  const db = annotateSqlProbeFailures(f.shards[0]);
  // Deliberately break the adapter's transaction boundary: the exact same real SQLite SQL now
  // autocommits CREATE/INSERT before the invalid JSON statement. This is the negative control.
  db.atomicBatch = false;
  db.database.exec("CREATE TABLE user_owned_atomicity_sentinel (value TEXT); INSERT INTO user_owned_atomicity_sentinel VALUES ('keep')");
  await assert.rejects(verifyD1BatchAtomicity(db), (error) => {
    assert.equal(error.d1AtomicityPhase, 'rollback-negative');
    assert.equal(error.d1AtomicityFailure, 'assertion');
    return true;
  });
  assert.deepEqual(probeTables(db), []);
  assert.deepEqual(db.rows('SELECT * FROM user_owned_atomicity_sentinel'), [{ value: 'keep' }]);
  const drops = f.trace.filter((event) => event.kind === 'query' && /^\s*DROP TABLE\b/i.test(event.sql));
  assert.equal(drops.length, 2, 'successful proof table and detected partial-commit table are both owned and cleaned');
  assert.ok(drops.every(({ sql }) => sql.includes('__index_batch_probe_')));
  assert.ok(f.trace.every((event) => event.db === db.id));
});

test('non-atomic partial commit retains its primary assertion when owned DROP fails and leaves foreign SQLite state untouched', async (context) => {
  const canary = 'PRIVATE_ATOMICITY_CLEANUP_CANARY';
  for (const failureKind of ['transport', 'http', 'statement', 'shape']) {
    await context.test(failureKind, async (child) => {
      const f = await fixture(child);
      const db = annotateSqlProbeFailures(f.shards[0]);
      seedBlocks(f.source, [block(32_301, 0)]);
      seedBlocks(db, [block(32_302, 0)]);
      const sourceBefore = blockSnapshot(f.source);
      const indexesBefore = f.shards.map(blockSnapshot);
      const sentinel = '__index_batch_probe_user_owned_cleanup_sentinel';
      db.database.exec(`CREATE TABLE ${quoted(sentinel)} (value TEXT NOT NULL)`);
      db.database.prepare(`INSERT INTO ${quoted(sentinel)} VALUES (?)`).run('keep foreign probe-like table');
      db.atomicBatch = false;
      let drops = 0;
      db.beforeQuery = ({ sql }) => {
        if (!/^DROP TABLE "__index_batch_probe_[0-9a-f]+"$/.test(sql)) return;
        if (++drops === 2) {
          throw Object.assign(new Error(canary), { d1FailureKind: failureKind, cause: new Error(canary) });
        }
      };
      await assert.rejects(verifyD1BatchAtomicity(db), (error) => {
        assert.equal(error.d1AtomicityPhase, 'rollback-negative');
        assert.equal(error.d1AtomicityFailure, 'assertion');
        assert.equal(error.d1AtomicityCleanupFailure, failureKind);
        assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(canary));
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(drops, 2, 'the positive control drops once; final cleanup attempts the retained owned table once');
      const owned = probeTables(db).filter(({ name }) => name !== sentinel);
      assert.equal(owned.length, 1, 'the failed DROP must leave the genuinely partially committed probe');
      assert.deepEqual(db.rows(`SELECT id, value FROM ${quoted(owned[0].name)}`),
        [{ id: 1, value: D1_BATCH_PROBE_TEXT }]);
      assert.deepEqual(db.rows(`SELECT * FROM ${quoted(sentinel)}`), [{ value: 'keep foreign probe-like table' }]);
      assert.deepEqual(blockSnapshot(f.source), sourceBefore);
      assert.deepEqual(f.shards.map(blockSnapshot), indexesBefore);
      assert.deepEqual(sourceWrites(f), []);
      assert.ok(f.trace.every((event) => event.db === db.id));
      const batches = f.trace.filter((event) => event.kind === 'batch');
      assert.equal(batches.length, 2);
      assert.equal(batches[0].committed, true);
      assert.equal(batches[1].atomic, false);
      assert.equal(batches[1].committed, false);
      assert.ok(f.trace.some((event) => event.kind === 'batch-statement' && event.transaction === batches[1].transaction
        && /^INSERT INTO/.test(event.sql) && event.success), 'SQLite must commit the insert before the intentional SQL failure');
    });
  }
});

test('auth/network and unclassified rejection reasons cannot masquerade as atomicity proof', async (context) => {
  for (const reason of ['auth', 'network', 'unclassified']) {
    await context.test(reason, async (child) => {
      const f = await fixture(child);
      const db = annotateSqlProbeFailures(f.shards[0]);
      const native = db.batch.bind(db);
      db.batch = async (statements) => {
        if (statements.some(({ sql }) => sql.includes('index_batch_atomicity_intentional_invalid_json'))) {
          const error = new Error(reason === 'auth' ? 'authentication rejected' : reason === 'network' ? 'connection reset' : 'unclassified rejection');
          if (reason !== 'unclassified') error.d1SqlReason = 'other';
          throw error;
        }
        return native(statements);
      };
      await assert.rejects(verifyD1BatchAtomicity(db), (error) => {
        assert.equal(error.d1AtomicityPhase, 'rollback-negative');
        assert.equal(error.d1AtomicityFailure, 'other');
        return true;
      });
      assert.deepEqual(probeTables(db), []);
      assert.equal(f.trace.filter((event) => event.kind === 'batch').length, 1,
        'only the real successful batch ran; table absence after an unexecuted request is not rollback evidence');
      assert.ok(f.trace.every((event) => event.db === db.id));
    });
  }
});

test('unsupported SQL in the successful atomicity control fails closed and leaves no probe ownership residue', async (context) => {
  const f = await fixture(context);
  const db = annotateSqlProbeFailures(f.shards[0]);
  db.beforeStatement = ({ sql }) => {
    if (/^\s*CREATE TABLE\b/i.test(sql) && sql.includes('__index_batch_probe_')) {
      // An actual SQLite unsupported-function rejection stands in for a transport/backend
      // refusing the first SQL capability, rather than fabricated successful batch records.
      db.execute('SELECT index_atomicity_unsupported_capability()', []);
    }
  };
  await assert.rejects(verifyD1BatchAtomicity(db), (error) => {
    assert.equal(error.d1AtomicityPhase, 'batch-positive');
    assert.equal(error.d1AtomicityFailure, 'other');
    return true;
  });
  assert.deepEqual(probeTables(db), []);
  const batches = f.trace.filter((event) => event.kind === 'batch');
  assert.equal(batches.length, 1);
  assert.equal(batches[0].committed, false);
  assert.ok(!f.trace.some((event) => event.sql?.includes('index_batch_atomicity_intentional_invalid_json')),
    'the failing rollback control cannot run before successful transport execution has been proved');
});

test('atomicity probe refuses an already-owned random name without deleting or modifying that table', async (context) => {
  const f = await fixture(context);
  const db = f.shards[0];
  let existingName;
  db.beforeQuery = ({ sql, params }) => {
    if (!existingName && selectsTable(sql, 'sqlite_master') && params[0]?.startsWith('__index_batch_probe_')) {
      existingName = params[0];
      db.database.exec(`CREATE TABLE ${quoted(existingName)} (value TEXT NOT NULL)`);
      db.database.prepare(`INSERT INTO ${quoted(existingName)} (value) VALUES (?)`).run('pre-existing owner sentinel');
    }
  };
  await assert.rejects(verifyD1BatchAtomicity(db), (error) => {
    assert.equal(error.d1AtomicityPhase, 'ownership');
    assert.equal(error.d1AtomicityFailure, 'assertion');
    return true;
  });
  assert.ok(existingName);
  assert.deepEqual(db.rows(`SELECT * FROM ${quoted(existingName)}`), [{ value: 'pre-existing owner sentinel' }]);
  assert.equal(f.trace.filter((event) => event.kind === 'batch').length, 0);
  assert.ok(!f.trace.some((event) => event.sql && isWrite(event.sql)), 'the existing table must never enter probe cleanup');
});

test('D1 SQL failure classification exposes only safe reason enums and leaves absent or conflicting tokens unknown', () => {
  for (const errors of [
    ['malformed JSON'], [{ message: 'D1_ERROR: malformed JSON: SQLITE_ERROR', code: 7500 }],
    [{ message: 'MALFORMED json in intentional SQL probe' }],
  ]) assert.equal(d1SqlFailureReason(errors), 'malformed-json');
  for (const errors of [
    [], [null, undefined, {}], [{ code: 10000 }], [{ message: 42 }],
    ['authentication failed'], [{ message: 'connection reset' }], [{ message: 'not valid JSON' }],
    ['index_migration_frozen_extra'], ['INDEX_MIGRATION_FROZEN'], ['SQLITE_CONSTRAINT'],
  ]) assert.equal(d1SqlFailureReason(errors), 'other');
  for (const [message, reason] of [
    ['index_migration_frozen', 'writer-fence'],
    ['D1_ERROR: index_migration_frozen: SQLITE_CONSTRAINT [code: 7500]', 'writer-fence'],
    ['D1_ERROR: database or disk is full: SQLITE_FULL', 'capacity'],
    ['near "private_sql": syntax error', 'sql-syntax'],
    ['no such table: private_schema', 'missing-schema'],
    ['too many SQL variables', 'limits'],
    ['too many terms in compound SELECT', 'limits'],
    ['string or blob too big: SQLITE_TOOBIG', 'limits'],
    ['Exceeded maximum DB size.', 'capacity'],
    ["Your account has exceeded D1's maximum account storage limit, please contact Cloudflare to raise your limit", 'capacity'],
    ["Your account has exceeded D1's free tier daily row read limit.", 'quota'],
    ['D1_COLUMN_NOTFOUND: private_column', 'missing-schema'],
    ['D1_TYPE_ERROR: private_value', 'type-error'],
    ['D1 DB reset because its code was updated.', 'transient-reset'],
    ['Internal error while starting up D1 DB storage caused object to be reset.', 'transient-reset'],
    ['Network connection lost.', 'transient-reset'],
    ['Replica disconnected from primary.', 'transient-reset'],
    ['Cannot resolve D1 DB due to transient issue on remote node.', 'transient-reset'],
    ['D1 DB storage operation exceeded timeout which caused object to be reset.', 'storage-timeout'],
    ['D1 DB is overloaded. Requests queued for too long.', 'overloaded'],
    ["D1 DB's isolate exceeded its memory limit and was reset.", 'memory-limit'],
    ['D1 DB exceeded its CPU time limit and was reset.', 'cpu-limit'],
  ]) {
    const classified = d1SqlFailureReason([{ message, code: 7500 }]);
    assert.equal(classified, reason);
  }
  assert.equal(d1SqlFailureReason([{ code: 7500 }]), 'other');
  assert.equal(d1SqlFailureReason(['database or disk is full; malformed JSON']), 'other');
  assert.equal(d1SqlFailureReason(['index_migration_frozen; malformed JSON']), 'other');
});

test('REST D1 diagnostics sanitize envelope, result and transport failures without replay', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const id = '95dbde60-d5ab-4e2c-989f-fcd44a3ab479';
  const canary = 'PRIVATE_SQL_TRANSCRIPT_CANARY';
  const failure = { message: `no such table: ${canary}`, code: 7500 };
  for (const scenario of ['envelope', 'result', 'transport', 'non-json']) {
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      if (scenario === 'transport') throw new Error(canary);
      if (scenario === 'non-json') return new Response(canary, { status: 502 });
      return Response.json(scenario === 'envelope'
        ? { success: false, errors: [failure, { code: canary }, { code: -1 }, { code: 1.5 }] }
        : { success: true, result: [{ success: false, error: failure.message, errors: [failure, { code: canary }] }] },
      { status: scenario === 'envelope' ? 400 : 200 });
    };
    const db = diagnosticClient(PREVIEW_ACCOUNT_ID, 'private-token', { permit: async () => {} }).db(id);
    await assert.rejects(db.batch([{ sql: canary, params: [canary] }]), (error) => {
      assert.equal(error.d1SqlReason, ['envelope', 'result'].includes(scenario) ? 'missing-schema' : 'other');
      assert.equal(error.d1FailureKind, scenario === 'transport' ? 'transport'
        : scenario === 'result' ? 'statement' : 'http');
      assert.equal(error.providerStatus, scenario === 'transport' ? undefined
        : scenario === 'envelope' ? 400 : scenario === 'result' ? 200 : 502);
      assert.deepEqual(error.providerCodes, ['envelope', 'result'].includes(scenario) ? [7500] : []);
      assert.equal(error.d1NativeSignature, undefined);
      assert.ok(error.message.includes(id));
      assert.ok(error.message.includes('kind=batch'));
      assert.ok(!error.message.includes(canary));
      assert.ok(!JSON.stringify(error).includes(canary));
      if (['envelope', 'result'].includes(scenario)) assert.ok(error.message.includes('codes=7500'));
      return true;
    });
    assert.equal(requests, 1, 'an ambiguous failure must not replay a batch');
  }
});

test('REST D1 diagnostics retain bounded fixed native signatures and typed HTTP evidence without provider text', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const canary = 'PRIVATE_NATIVE_SIGNATURE_SQL_PROVIDER_CANARY';
  const signatures = [
    ['too many arguments on function private_function', 'limits', 'function-arguments'],
    ['Expression tree is too large (maximum depth 1000)', 'limits', 'expression-depth'],
    ['statement too long', 'limits', 'statement-length'],
    ['too many columns in result set', 'limits', 'column-limit'],
    ['JSON cannot hold BLOB values', 'type-error', 'json-blob'],
    ['no such function: private_function', 'missing-schema', 'function-unavailable'],
    ['not authorized: SQLITE_AUTH', 'other', 'authorization'],
    ['invalid UTF-8', 'other', 'invalid-utf8'],
    ['misuse of aggregate function COUNT()', 'other', 'aggregate-misuse'],
    ['parser stack overflow', 'limits', 'parser-stack-overflow'],
    ['unrecognized private provider condition', 'other', undefined],
    ['malformed JSON; statement too long', 'other', undefined],
    ['too many arguments on function json_array; Expression tree is too large', 'limits', undefined],
  ];
  for (const route of ['envelope', 'result']) {
    for (const [message, reason, signature] of signatures) {
      await context.test(`${route}: ${signature ?? message}`, async () => {
        let requests = 0;
        globalThis.fetch = async () => {
          requests += 1;
          const errors = Array.from({ length: 20 }, (_, index) => ({
            code: 7500 + index, ...(index ? {} : { message: `${message} ${canary}` }),
          }));
          errors.push({ code: canary }, { code: -1 }, { code: 1.5 }, { code: Number.MAX_SAFE_INTEGER + 1 });
          return Response.json(route === 'envelope' ? { success: false, errors }
            : { success: true, result: [{ success: false, error: `${message} ${canary}`, errors }] },
          { status: route === 'envelope' ? 400 : 200 });
        };
        const db = diagnosticClient(PREVIEW_ACCOUNT_ID, canary, { permit: async () => {} })
          .db('95dbde60-d5ab-4e2c-989f-fcd44a3ab479');
        await assert.rejects(db.query(canary, [canary]), (error) => {
          assert.equal(error.d1SqlReason, reason);
          assert.equal(error.d1NativeSignature, signature);
          assert.equal(error.providerStatus, route === 'envelope' ? 400 : 200);
          assert.deepEqual(error.providerCodes, Array.from({ length: 16 }, (_, index) => 7500 + index));
          assert.equal(error.d1FailureKind, route === 'envelope' ? 'http' : 'statement');
          assert.ok(error.message.includes(`native=${reason}`));
          assert.ok(!`${error.message} ${error.stack} ${JSON.stringify(error)}`.includes(canary));
          assert.ok(!error.message.includes('private_function'));
          assert.equal(error.cause, undefined);
          return true;
        });
        assert.equal(requests, 1, 'classification must not replay a rejected operation');
      });
    }
  }
});

test('copy preserves native rejection and retained source across semantic failure phases', async (context) => {
  for (const phase of ['copy-setup', 'copy-page-write', 'copy-page-readback', 'copy-fts-match', 'copy-source-delete-and-freeze']) {
    await context.test(phase, async (child) => {
      const f = await fixture(child);
      const original = block(801, 0);
      seedBlocks(f.source, [original]);
      const rejection = new Error('safe native rejection');
      rejection.d1SqlReason = 'missing-schema';
      rejection.d1Diagnostic = true;
      const db = phase === 'copy-source-delete-and-freeze' ? f.source : f.shards[0];
      for (const kind of ['query', 'batch']) {
        const native = db[kind].bind(db);
        db[kind] = async (...args) => {
          const sql = kind === 'query' ? args[0] : args[0].map((statement) => statement.sql).join('\n');
          const fail = phase === 'copy-setup' ? /^PRAGMA table_info/.test(sql)
            : phase === 'copy-page-write' ? kind === 'batch' && /INSERT INTO blocks \(/.test(sql)
              : phase === 'copy-page-readback' ? kind === 'query' && /WITH candidates AS MATERIALIZED/.test(sql)
                : phase === 'copy-fts-match' ? /blocks_fts MATCH/.test(sql)
                  : kind === 'batch' && /DELETE FROM blocks/.test(sql);
          if (fail) throw rejection;
          return native(...args);
        };
      }
      await assert.rejects(copyFrozenIndex(f.args()), (error) => {
        assert.equal(error, rejection);
        assert.equal(error.d1Phase, phase);
        assert.equal(error.d1SqlReason, 'missing-schema');
        return true;
      });
      assert.deepEqual(f.source.rows('SELECT * FROM blocks'), [original], 'no rejected phase authorizes source deletion');
      const state = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
      if (phase !== 'copy-setup') {
        assert.equal(state.rows, 0);
        assert.equal(state.pending.phase, phase === 'copy-source-delete-and-freeze' ? 'verified' : 'copying');
      }
    });
  }
});

test('retirement failure diagnostics preserve the native error and source checkpoint while exposing only bounded aggregates', async (context) => {
  const canary = 'PRIVATE_RETIRED_DATA_CANARY';
  for (const scenario of ['clean', 'mismatch', 'missing', 'mismatch-and-missing', 'query-failed', 'response-shape', 'request-budget', 'wide-mismatch', 'oversized']) {
    await context.test(scenario, async (child) => {
      const f = await fixture(child);
      const columns = [...BLOCK_COLUMNS];
      if (scenario === 'wide-mismatch') {
        const added = Array.from({ length: 100 - columns.length }, (_, index) => `public_future_${String(index).padStart(3, '0')}`);
        columns.push(...added);
        for (const db of [f.source, ...f.shards]) for (const column of added) {
          db.database.exec(`ALTER TABLE blocks ADD COLUMN ${quoted(column)} TEXT`);
        }
      }
      const hasMismatch = ['mismatch', 'mismatch-and-missing', 'wide-mismatch'].includes(scenario);
      const hasMissing = ['missing', 'mismatch-and-missing'].includes(scenario);
      const large = scenario === 'request-budget' ? '\u0000'.repeat(150_000)
        : scenario === 'oversized' ? 'x'.repeat(COPY_PAGE_BYTES + 2) : '';
      const originals = (scenario === 'wide-mismatch'
        ? Array.from({ length: 82 }, (_, index) => block(811 + index, index % 2))
        : large ? [block(811, 0, { text: `${canary} ${large}` })]
          : [block(811, 0, { text: `${canary}\u0000original_tail`, role: null }), block(812, 1)])
        .map((row) => ({ ...row, ...Object.fromEntries(columns.slice(BLOCK_COLUMNS.length).map((column) => [column, null])) }));
      seedBlocks(f.source, originals, columns);
      const rejection = new Error('safe native retirement rejection');
      rejection.d1SqlReason = 'malformed-json';
      let observedError, verified, diagnosticQueries = 0, retirementAttempts = 0;
      let expected = originals;
      const nativeBatch = f.source.batch.bind(f.source);
      f.source.batch = async (statements) => {
        if (!statements.some(({ sql }) => sql.includes('AS source_empty'))
          || !statements.some(({ sql }) => /DELETE FROM blocks/.test(sql))) return nativeBatch(statements);
        retirementAttempts += 1;
        if (!hasMismatch) { observedError = rejection; throw rejection; }
        try { return await nativeBatch(statements); }
        catch (error) { observedError = error; throw error; }
      };
      const nativeQuery = f.source.query.bind(f.source);
      f.source.query = async (sql, params) => {
        if (!sql.includes('compared AS MATERIALIZED')) return nativeQuery(sql, params);
        diagnosticQueries += 1;
        assert.ok(!isWrite(sql), 'failure diagnostics must be read-only');
        assert.equal(params.length, 1, 'reuse one already verified canonical snapshot');
        assert.ok(Buffer.byteLength(JSON.stringify({ sql, params })) <= COPY_PAGE_BYTES);
        if (scenario === 'query-failed') throw new Error(canary);
        if (scenario === 'response-shape') return [{ expected_rows: canary }];
        return nativeQuery(sql, params);
      };
      await assert.rejects(copyWithNativeParameters(f.args({ checkpointHook: async (state) => {
        if (state.pending?.phase !== 'verified') return;
        verified = state;
        assert.deepEqual(await readCheckpoint(f.shards[0], COPY_CHECKPOINT), state);
        if (scenario === 'wide-mismatch') {
          // Unique mismatch counts at every added ordinal catch column/group transposition.
          expected = originals.map((row, rowIndex) => ({ ...row, ...Object.fromEntries(
            columns.slice(BLOCK_COLUMNS.length).map((column, index) => [column, rowIndex <= index ? 'changed' : null]),
          ) }));
          for (const [index, column] of columns.slice(BLOCK_COLUMNS.length).entries()) {
            f.source.database.prepare(`UPDATE blocks SET ${quoted(column)} = ? WHERE id <= ?`)
              .run('changed', originals[index].id);
          }
        } else if (hasMismatch) {
          expected = [{ ...originals[0], role: '', text: `${canary}\u0000changed_tail` }, originals[1]];
          f.source.database.prepare('UPDATE blocks SET role = ?, text = ? WHERE id = ?')
            .run(expected[0].role, expected[0].text, expected[0].id);
        }
        if (hasMissing) {
          const removedId = hasMismatch ? originals[1].id : originals[0].id;
          expected = expected.filter(({ id }) => id !== removedId);
          f.source.database.prepare('DELETE FROM blocks WHERE id = ?').run(removedId);
        }
      } })), (error) => {
        assert.equal(error, observedError, 'diagnostic failures must never replace the original rejection');
        assert.equal(error.d1Phase, 'copy-source-delete-and-freeze');
        assert.equal(error.message, hasMismatch ? 'malformed JSON' : rejection.message);
        const comparison = error.d1SourceComparison;
        assert.ok(comparison, 'the historical copier must fail this load-bearing metadata assertion');
        assert.ok(!JSON.stringify(comparison).includes(canary));
        assert.ok(!JSON.stringify(comparison).includes('original_tail'));
        if (['query-failed', 'response-shape', 'request-budget', 'oversized'].includes(scenario)) {
          assert.deepEqual(comparison, { status: 'unavailable', reason: scenario === 'oversized' ? 'canonical-budget' : scenario });
        } else {
          assert.equal(comparison.status, scenario === 'wide-mismatch' ? 'mismatch' : scenario);
          assert.equal(comparison.expectedRows, originals.length);
          assert.equal(comparison.presentRows, expected.length);
          assert.equal(comparison.missingRows, hasMissing ? 1 : 0);
          assert.equal(comparison.mismatchingRows, scenario === 'wide-mismatch' ? originals.length : hasMismatch ? 1 : 0);
          assert.deepEqual(comparison.columns, scenario === 'wide-mismatch'
            ? columns.slice(BLOCK_COLUMNS.length).map((_, index) => ({
              index: BLOCK_COLUMNS.length + index, mismatchingRows: index + 1, typeMismatchRows: index + 1,
              byteMismatchRows: index + 1, lengthMismatchRows: index + 1,
              sourceTypes: ['text'], snapshotTypes: ['null'],
            })) : hasMismatch ? [
            { index: 5, mismatchingRows: 1, typeMismatchRows: 1, byteMismatchRows: 1, lengthMismatchRows: 1,
              sourceTypes: ['text'], snapshotTypes: ['null'] },
            { index: 12, mismatchingRows: 1, typeMismatchRows: 0, byteMismatchRows: 1, lengthMismatchRows: 1,
              sourceTypes: ['text'], snapshotTypes: ['text'] },
          ] : []);
        }
        return true;
      });
      assert.equal(retirementAttempts, 1, 'diagnostics never replay or ACK a rejected source batch');
      assert.equal(diagnosticQueries, ['request-budget', 'oversized'].includes(scenario) ? 0 : 1);
      assert.deepEqual(f.source.rows('SELECT * FROM blocks ORDER BY id'), expected, 'every remaining source tuple survives');
      assert.deepEqual(await readCheckpoint(f.shards[0], COPY_CHECKPOINT), verified, 'no diagnostic checkpoint advance');
    });
  }
});

test('retirement aggregate preserves exact storage classes and mixed storage byte flags on native adapters', async (context) => {
  for (const backend of ['sqlite', 'workerd']) {
    await context.test(backend, async (child) => {
      const f = backend === 'sqlite' ? await fixture(child) : await workerdFixture(child);
      const added = [['public_untyped', 'ANY'], ['public_text', 'TEXT'], ['public_integer', 'INTEGER']];
      const columns = [...BLOCK_COLUMNS, ...added.map(([name]) => name)];
      for (const db of [f.source, ...f.shards]) for (const [name, affinity] of added) {
        const sql = `ALTER TABLE blocks ADD COLUMN ${quoted(name)} ${affinity}`;
        if (backend === 'sqlite') db.database.exec(sql);
        else await db.batch([{ sql, params: [] }]);
      }
      await copyWithNativeParameters(f.args());
      await f.shards[0].batch([{ sql: 'DELETE FROM index_migration_state WHERE name = ?', params: [COPY_CHECKPOINT] }]);
      const values = ['same\u0000bytes', 11, 0.1, null, 'blob\u0000bytes', 7, 'number',
        '\uFEFFsame\u0000😀"\\tail', null, 'missing', 0.3];
      const originals = values.map((value, index) => block(1100 + index, index % 2, {
        role: index ? 'assistant' : null, text: '\uFEFFprivate_affinity\u0000searchtail 😀',
        public_untyped: value, public_text: '7', public_integer: 11,
      }));
      await f.source.batch([
        { sql: `UPDATE ${SOURCE_FREEZE_TABLE} SET state = 'copying' WHERE id = 1`, params: [] },
        { sql: `INSERT INTO blocks (${columns.map(quoted).join(',')})
          SELECT ${columns.map((_, index) => `json_extract(value,'$[${index}]')`).join(',')} FROM json_each(?)`,
        params: [JSON.stringify(originals.map((row) => columns.map((column) => row[column])))] },
        { sql: 'INSERT INTO blocks_fts (rowid, text) SELECT id, text FROM blocks', params: [] },
        { sql: `UPDATE ${SOURCE_FREEZE_TABLE} SET state = 'frozen' WHERE id = 1`, params: [] },
      ]);
      const physical = () => f.source.query(`SELECT id,${columns.flatMap((column, index) => [
        `typeof(${quoted(column)}) AS t${index}`, `hex(CAST(${quoted(column)} AS BLOB)) AS b${index}`,
      ]).join(',')} FROM blocks ORDER BY id`);
      const initialPhysical = await physical();
      // Independent native storage snapshots are the oracle, not CASE affinity
      // or hard-coded aggregate counts copied from the implementation's result.
      const expectedComparison = (snapshot, current) => {
        const types = ['null', 'integer', 'real', 'text', 'blob'];
        const found = new Map(current.map((row) => [row.id, row]));
        const cells = columns.map(() => [0, 0, 0, 0, 0, 0]);
        const mismatches = new Set();
        for (const copied of snapshot) {
          const stored = found.get(copied.id);
          if (!stored) continue;
          for (let index = 0; index < columns.length; index += 1) {
            const sourceType = stored[`t${index}`], snapshotType = copied[`t${index}`];
            const sourceBytes = sourceType === 'null' ? null : stored[`b${index}`];
            const snapshotBytes = snapshotType === 'null' ? null : copied[`b${index}`];
            if (sourceType === snapshotType && sourceBytes === snapshotBytes) continue;
            mismatches.add(copied.id);
            const cell = cells[index];
            cell[0] += 1;
            cell[1] += Number(sourceType !== snapshotType);
            cell[2] += Number(sourceBytes !== snapshotBytes);
            cell[3] += Number((sourceBytes?.length ?? null) !== (snapshotBytes?.length ?? null));
            cell[4] |= 1 << types.indexOf(sourceType);
            cell[5] |= 1 << types.indexOf(snapshotType);
          }
        }
        const present = snapshot.filter((row) => found.has(row.id)).length;
        const missing = snapshot.length - present;
        const aggregate = {
          status: mismatches.size ? missing ? 'mismatch-and-missing' : 'mismatch' : missing ? 'missing' : 'clean',
          expectedRows: snapshot.length, presentRows: present, missingRows: missing, mismatchingRows: mismatches.size,
          columns: cells.flatMap((cell, index) => cell[0] ? [{
            index, mismatchingRows: cell[0], typeMismatchRows: cell[1], byteMismatchRows: cell[2], lengthMismatchRows: cell[3],
            sourceTypes: types.filter((_, bit) => cell[4] & (1 << bit)),
            snapshotTypes: types.filter((_, bit) => cell[5] & (1 << bit)),
          }] : []),
        };
        return { aggregate, raw: [snapshot.length, present, missing, mismatches.size,
          Array.from({ length: Math.ceil(cells.length / 16) }, (_, index) => cells.slice(index * 16, index * 16 + 16))] };
      };
      let verified, retained, captured, originalError, originalMessage, retirementAttempts = 0, diagnosticQueries = 0;
      const nativeBatch = f.source.batch.bind(f.source), nativeQuery = f.source.query.bind(f.source);
      f.source.batch = async (statements) => {
        if (!statements.some(({ sql }) => sql.includes('AS source_empty'))
          || !statements.some(({ sql }) => /DELETE FROM blocks/.test(sql))) return nativeBatch(statements);
        retirementAttempts += 1;
        try { return await nativeBatch(statements); }
        catch (error) { originalError = error; originalMessage = error.message; throw error; }
      };
      f.source.query = async (sql, params) => {
        if (sql.includes('AS source_comparison FROM compared')) {
          diagnosticQueries += 1; captured = { sql, params };
          assert.ok(!isWrite(sql));
          assert.ok(Buffer.byteLength(sql) <= 100_000);
          assert.ok(Buffer.byteLength(JSON.stringify(captured)) <= COPY_PAGE_BYTES);
        }
        return nativeQuery(sql, params);
      };
      await assert.rejects(copyWithNativeParameters(f.args({ checkpointHook: async (state) => {
        if (state.pending?.phase !== 'verified') return;
        verified = state;
        await f.source.batch([
          { sql: `UPDATE ${SOURCE_FREEZE_TABLE} SET state = 'copying' WHERE id = 1`, params: [] },
          ...[[0, null], [1, 12], [2, 0.2], [3, 'new'], [10, 0.4]].map(([index, value]) => ({
            sql: `UPDATE blocks SET public_untyped = ${index === 1 ? 'CAST(? AS INTEGER)' : '?'} WHERE id = ?`,
            params: [value, originals[index].id],
          })),
          { sql: 'UPDATE blocks SET role = ? WHERE id = ?', params: ['', originals[0].id] },
          { sql: 'UPDATE blocks SET public_untyped = unhex(?) WHERE id = ?',
            params: [Buffer.from(originals[4].public_untyped).toString('hex'), originals[4].id] },
          { sql: 'UPDATE blocks SET public_untyped = CAST(? AS REAL) WHERE id = ?', params: [7, originals[5].id] },
          { sql: 'DELETE FROM blocks WHERE id = ?', params: [originals[9].id] },
          { sql: `UPDATE ${SOURCE_FREEZE_TABLE} SET state = 'frozen' WHERE id = 1`, params: [] },
        ]);
        retained = await physical();
      } })), (error) => {
        assert.equal(error, originalError); assert.equal(error.message, originalMessage);
        assert.equal(d1SqlFailureReason([error.message]), 'malformed-json');
        assert.deepEqual(error.d1SourceComparison, expectedComparison(initialPhysical, retained).aggregate);
        assert.ok(!JSON.stringify(error.d1SourceComparison).includes('private_affinity'));
        return true;
      });
      assert.equal(retirementAttempts, 1); assert.equal(diagnosticQueries, 1);
      assert.deepEqual(await physical(), retained);
      assert.deepEqual(await readCheckpoint(f.shards[0], COPY_CHECKPOINT), verified);
      assert.deepEqual(await f.source.query(`SELECT state FROM ${SOURCE_FREEZE_TABLE}`), [{ state: 'frozen' }]);
      // A separate read-only control changes only the public canonical snapshot.
      // Affinity-equal scalars must now expose the exact storage-class difference.
      const snapshot = JSON.parse(captured.params[0]);
      snapshot[6][19] = 7; snapshot[6][20] = '11';
      const response = await nativeQuery(captured.sql, [JSON.stringify(snapshot)]);
      const summary = JSON.parse(response[0].source_comparison);
      const counterfactual = initialPhysical.map((row, index) => index === 6 ? {
        ...row, t19: 'integer', b19: Buffer.from('7').toString('hex').toUpperCase(),
        t20: 'text', b20: Buffer.from('11').toString('hex').toUpperCase(),
      } : row);
      assert.deepEqual(summary, expectedComparison(counterfactual, retained).raw,
        'all flags and DISTINCT type bits must agree with independently read physical storage');
      assert.deepEqual(summary[4].flat()[0], [0, 0, 0, 0, 0, 0],
        'the joined primary key is never a mismatched cell');
      assert.deepEqual(await physical(), retained);
      assert.deepEqual(await readCheckpoint(f.shards[0], COPY_CHECKPOINT), verified);
    });
  }
});

test('row and malformed checkpoint validation do not disclose unknown metadata or payload bytes', async () => {
  const canary = 'PRIVATE_METADATA_TRANSCRIPT_CANARY';
  for (const action of [
    () => canonicalRow([canary], {}),
    () => canonicalRow([canary], { [canary]: true }),
    () => canonicalRow([canary], { [canary]: Infinity }),
  ]) assert.throws(action, (error) => !error.message.includes(canary));
  await assert.rejects(readCheckpoint({
    id: 'fixture', query: async () => [{ value: canary }],
  }, COPY_CHECKPOINT), (error) => !error.message.includes(canary));
});

test('checkpoint classification refuses missing, boolean and unknown workflow state enums instead of treating them as completion', () => {
  const source = { id: 'invalid-state-main' };
  const shards = [{ id: 'invalid-state-00' }, { id: 'invalid-state-01' }];
  const identity = { format: 1, layout: INDEX_LAYOUT, source: source.id, shards: shards.map(({ id }) => id) };
  const valid = { identity, state: 'complete' };
  for (const state of [undefined, null, true, false, 'active', 'verified', 'current']) {
    for (const key of ['copy', 'seed']) {
      assert.throws(() => classifyIndexMigration({
        source, shards, legacyTables: [], copy: valid, seed: valid,
        [key]: { identity, state },
      }), /invalid index migration checkpoint state/);
    }
  }
});

const sqliteCopyControlContexts = new WeakSet();

// Exercise the production REST client against native SQLite commits, including the
// boundary between a successful response and the next request's budget check.
function sqliteCopyControl(context, f, options = {}) {
  if (!sqliteCopyControlContexts.has(context)) {
    const originalFetch = globalThis.fetch;
    context.after(() => { globalThis.fetch = originalFetch; });
    sqliteCopyControlContexts.add(context);
  }
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const id = decodeURIComponent(new URL(url).pathname.match(/\/d1\/database\/([^/]+)\/query$/)[1]);
    const adapter = [f.source, ...f.shards].find((db) => db.id === id);
    assert.ok(adapter, 'REST requests must target a real fixture database');
    const body = JSON.parse(init.body);
    requests.push({ id, body, signal: init.signal });
    const results = body.batch
      ? await adapter.batch(body.batch)
      : [{ success: true, results: await adapter.query(body.sql, body.params) }];
    return Response.json({ success: true, result: results });
  };
  const client = indexControlClient(PREVIEW_ACCOUNT_ID, 'private-token', {
    permit: async () => {}, ...options,
  });
  return { requests, args: { source: client.db(f.source.id),
    shards: f.shards.map(({ id }) => client.db(id)), gate } };
}

test('copy pass budgets reject unsafe durations and expire synchronously at exact elapsed or wait boundaries', () => {
  for (const value of [0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1,
    '1', null, undefined]) {
    assert.throws(() => createCopyPassRequestGate(value), /positive.*safe integer/i);
  }
  for (const budget of [1, 1000, Number.MAX_SAFE_INTEGER]) {
    let time = 0;
    const requestGate = createCopyPassRequestGate(budget, { now: () => time });
    assert.equal(requestGate(), undefined, 'gate must not schedule asynchronous work');
    assert.equal(requestGate(budget - 1), undefined);
    assert.throws(() => requestGate(budget), CopyPassBudgetExhausted);
    time = budget;
    assert.throws(() => requestGate(), CopyPassBudgetExhausted);
  }
  let time = 50;
  const requestGate = createCopyPassRequestGate(1000, { now: () => time });
  time = 750;
  assert.equal(requestGate(299), undefined);
  assert.throws(() => requestGate(300), CopyPassBudgetExhausted);
});

test('REST budget gates stop before permit and after permit without fetching or sanitizing the budget identity', async (context) => {
  for (const boundary of ['before-permit', 'after-permit']) {
    await context.test(boundary, async (child) => {
      const f = await fixture(child);
      const original = block(40_101, 0);
      seedBlocks(f.source, [original]);
      let time = 0;
      let permits = 0;
      const budgetGate = createCopyPassRequestGate(10, { now: () => time });
      let rejection;
      const requestGate = (delay) => {
        try { return budgetGate(delay); }
        catch (error) { rejection = error; throw error; }
      };
      const control = sqliteCopyControl(child, f, { requestGate, permit: async () => {
        permits += 1;
        time = 10;
      } });
      if (boundary === 'before-permit') time = 10;
      await assert.rejects(control.args.source.query('SELECT * FROM blocks'), (error) => {
        assert.ok(error instanceof CopyPassBudgetExhausted);
        assert.equal(error, rejection, 'D1 sanitization must retain the precise budget exception');
        return true;
      });
      assert.equal(permits, boundary === 'before-permit' ? 0 : 1);
      assert.deepEqual(control.requests, []);
      assert.deepEqual(f.trace, []);
      assert.deepEqual(f.source.rows('SELECT * FROM blocks'), [original]);
    });
  }
});

test('budget-limited native copy passes resume committed copying and verified pages with full fidelity', async (context) => {
  const rows = [
    block(40_201, 0, { text: '\uFEFFbudget_needle_0 café\u0000tail_0 😀', row_hash: Number.MAX_SAFE_INTEGER }),
    block(40_202, 1, { text: 'budget_needle_1 会話\u0000tail_1', role: '', tool_name: null }),
    block(40_203, 0, { text: null, role: null, byte_start: null, byte_len: null }),
    block(40_204, 1, { text: '', media_byte_start: 2 ** 40, media_byte_len: 0, media_type: '' }),
  ];
  for (const boundary of ['before-first-request', 'committed-shard-write', 'committed-source-freeze']) {
    await context.test(boundary, async (child) => {
      const baseline = await fixture(child);
      seedBlocks(baseline.source, rows);
      const expected = await copyFrozenIndex(baseline.args());
      const f = await fixture(child);
      seedBlocks(f.source, rows);
      const verifiedRows = assertVerifiedBeforeDelete(f);
      const deletedRowCounts = [];
      const observeDeletedRows = () => {
        f.source.afterStatement = ({ sql }) => {
          if (/\bDELETE\s+FROM\s+"?blocks"?\b/i.test(sql)) {
            deletedRowCounts.push(f.source.rows('SELECT changes() AS n')[0].n);
          }
        };
      };
      observeDeletedRows();
      const initialShardSnapshots = f.shards.map(blockSnapshot);
      let time = 0;
      const requestGate = createCopyPassRequestGate(100, { now: () => time });
      let expiredAtCommit = false;
      if (boundary === 'committed-shard-write') {
        for (const shard of f.shards) shard.afterBatch = ({ statements, committed }) => {
          if (statements.some(({ sql }) => /\bINSERT\s+INTO\s+"?blocks"?\s*\(/i.test(sql))) {
            assert.equal(committed, true);
            expiredAtCommit = true;
            time = 100;
          }
        };
      } else if (boundary === 'committed-source-freeze') {
        f.source.afterBatch = ({ statements, committed }) => {
          if (statements.some(({ sql }) => /\bDELETE\s+FROM\s+"?blocks"?\b/i.test(sql))) {
            assert.equal(committed, true);
            assert.deepEqual(f.source.rows(`SELECT * FROM ${SOURCE_FREEZE_TABLE}`), [{ id: 1, state: 'frozen' }]);
            expiredAtCommit = true;
            time = 100;
          }
        };
      } else time = 100;
      const control = sqliteCopyControl(child, f, { requestGate });
      assert.deepEqual(await runCopyPass(control.args), { status: 'partial', reason: 'pass-budget-exhausted' });
      const saved = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
      if (boundary === 'before-first-request') {
        assert.equal(saved, null);
        assert.deepEqual(control.requests, []);
        assert.equal(destinationBatchCount(f), 0);
        assert.deepEqual(f.shards.map(blockSnapshot), initialShardSnapshots);
      } else {
        assert.equal(expiredAtCommit, true);
        assert.equal(saved.state, 'pending', 'partial must not publish complete');
        assert.equal(saved.rows, 0, 'no IDX00 retirement acknowledgement may cross the budget');
        assert.equal(saved.pending.phase, boundary === 'committed-shard-write' ? 'copying' : 'verified');
        assert.deepEqual(saved.pending.rows.map(({ id }) => id), rows.map(({ id }) => id));
        assertAtomicBlockBatches(f);
        if (boundary === 'committed-shard-write') {
          assert.deepEqual(f.shards[0].rows('SELECT * FROM blocks ORDER BY id'), rows.filter((row) =>
            indexShardForSessionId(row.session_id, 2) === 0));
          assert.deepEqual(blockSnapshot(f.shards[1]), initialShardSnapshots[1],
            'the next shard batch must not start once the previous commit exhausts the pass');
        }
      }
      assert.ok(f.trace.filter(({ kind }) => kind === 'batch').every(({ committed }) => committed),
        'budget exhaustion must never abort an in-flight native transaction');
      assert.ok(control.requests.every(({ signal }) => !signal.aborted));
      const retired = boundary === 'committed-source-freeze';
      assert.deepEqual(f.source.rows('SELECT * FROM blocks ORDER BY id'), retired ? [] : rows);
      assert.equal(verifiedRows(), retired ? rows.length : 0);
      const deletionsBeforeResume = sourceWrites(f).filter(({ sql }) => /\bDELETE\s+FROM\s+"?blocks"?\b/i.test(sql));
      assert.equal(deletionsBeforeResume.length, retired ? 1 : 0);
      const shardSnapshots = f.shards.map(blockSnapshot);
      const writesBeforeResume = destinationBatchCount(f);
      f.restart();
      assertVerifiedBeforeDelete(f);
      observeDeletedRows();
      time = 0;
      const resumed = sqliteCopyControl(child, f, {
        requestGate: createCopyPassRequestGate(100, { now: () => time }),
      });
      assert.deepEqual(await runCopyPass(resumed.args), {
        copiedRows: rows.length, state: 'complete', sha256: expected.sha256,
      });
      assertCopied(f, rows);
      assert.deepEqual(f.source.rows(`SELECT * FROM ${SOURCE_FREEZE_TABLE}`), [{ id: 1, state: 'frozen' }]);
      const completed = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
      assert.equal(completed.state, 'complete');
      assert.equal(completed.pending, null);
      assert.equal(completed.rows, rows.length);
      assert.equal(completed.sha256, expected.sha256);
      const deletions = sourceWrites(f).filter(({ sql }) => /\bDELETE\s+FROM\s+"?blocks"?\b/i.test(sql));
      assert.equal(deletions.length, 1);
      assert.deepEqual(deletedRowCounts, [rows.length],
        'a verified lost-response resume observes the commit without replaying source deletion');
      assert.equal(deletedRowCounts.reduce((sum, count) => sum + count, 0), rows.length);
      if (retired) {
        assert.equal(destinationBatchCount(f), writesBeforeResume);
        assert.deepEqual(f.shards.map(blockSnapshot), shardSnapshots,
          'verified resume must reuse committed block bytes and exact FTS postings');
      }
      assert.ok(f.trace.filter(({ kind }) => kind === 'batch').every(({ committed }) => committed));
    });
  }
});

test('valid 429 waits cannot reach or cross the copy pass deadline, but an affordable wait retries native reads', async (context) => {
  for (const remaining of [999, 1000, 1001]) {
    await context.test(`remaining=${remaining}`, async (child) => {
      const f = await fixture(child);
      seedBlocks(f.source, [block(40_301, 0)]);
      let time = 0;
      const waits = [];
      const control = sqliteCopyControl(child, f, {
        requestGate: createCopyPassRequestGate(2000, { now: () => time }),
        wait: async (delay) => { waits.push(delay); time += delay; },
      });
      const nativeFetch = globalThis.fetch;
      let attempts = 0;
      globalThis.fetch = async (...args) => {
        attempts += 1;
        if (attempts === 1) {
          time = 2000 - remaining;
          return new Response('rate limited', { status: 429, headers: { 'retry-after': '1' } });
        }
        return nativeFetch(...args);
      };
      if (remaining <= 1000) {
        assert.deepEqual(await runCopyPass(control.args), { status: 'partial', reason: 'pass-budget-exhausted' });
        assert.deepEqual(waits, []);
        assert.equal(attempts, 1);
        assert.deepEqual(f.trace, []);
        assert.equal(await readCheckpoint(f.shards[0], COPY_CHECKPOINT), null);
        assert.deepEqual(f.source.rows('SELECT * FROM blocks'), [block(40_301, 0)]);
      } else {
        assert.deepEqual(await control.args.source.query('SELECT id FROM blocks'), [{ id: 40_301 }]);
        assert.deepEqual(waits, [1000]);
        assert.equal(attempts, 2);
        assert.equal(time, 1999);
        assert.equal(control.requests.length, 1);
      }
    });
  }
});

test('copy pass never turns native HTTP 400 or ambiguous network failures into partial success or replays', async (context) => {
  for (const failure of ['native-400', 'network']) {
    await context.test(failure, async (child) => {
      const f = await fixture(child);
      const original = block(40_401, 0);
      seedBlocks(f.source, [original]);
      const control = sqliteCopyControl(child, f, {
        requestGate: createCopyPassRequestGate(100, { now: () => 0 }),
        wait: async () => assert.fail('terminal failures must not schedule retries'),
      });
      let attempts = 0;
      globalThis.fetch = async () => {
        attempts += 1;
        if (failure === 'network') throw new Error('private network failure');
        return Response.json({ success: false, errors: [{ code: 7500, message: 'no such table: private_table' }] },
          { status: 400 });
      };
      await assert.rejects(runCopyPass(control.args), (error) => {
        assert.ok(!(error instanceof CopyPassBudgetExhausted));
        assert.equal(error.d1Diagnostic, true);
        assert.equal(error.d1SqlReason, failure === 'native-400' ? 'missing-schema' : 'other');
        assert.ok(!error.message.includes('private'));
        return true;
      });
      assert.equal(attempts, 1);
      assert.deepEqual(f.trace, []);
      assert.equal(await readCheckpoint(f.shards[0], COPY_CHECKPOINT), null);
      assert.deepEqual(f.source.rows('SELECT * FROM blocks'), [original]);
    });
  }
});

const copyCliRevision = 'a'.repeat(40);
const copyCliStart = 10_000_000;
const copyCliCanary = 'PRIVATE_HEALTH_URL_HEADER_BODY_CAUSE_CANARY';
const copyCliController = process.env.INDEX_CONTROL_CLI_PATH
  ?? fileURLToPath(new URL('../../infra/cf/index-control.mjs', import.meta.url));

// Run the actual protected copy verb, retaining the existing native SQLite REST
// transaction adapter. The preload changes only fetch/clock boundaries, never SQL,
// copier results, acknowledgments, checkpoints, or health-gate implementation.
async function copyCliFixture(context) {
  const identities = ['5ff65cf3-89c8-4fe6-a3c2-a370293ecea6',
    ...Array.from({ length: 16 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)];
  const f = await fixture(context, { identities });
  const rows = [
    block(40_501, 0, { session_id: 'copy-health-session-0',
      text: '\uFEFFhealthneedle café\u0000tail 😀', row_hash: Number.MAX_SAFE_INTEGER }),
    block(40_502, 1, { session_id: 'copy-health-session-1',
      text: `healthlong ${'会話 😀\u0000'.repeat(4000)}healthtail`, role: '', tool_name: null }),
    block(40_503, 0, { session_id: 'copy-health-session-2',
      text: null, role: null, byte_start: null, byte_len: null }),
    block(40_504, 1, { session_id: 'copy-health-session-3',
      text: '', media_byte_start: 2 ** 40, media_byte_len: 0, media_type: '' }),
  ];
  seedBlocks(f.source, rows);
  const directory = path.dirname(f.source.filename);
  const configPath = path.join(directory, 'generated.json');
  const preload = path.join(directory, 'preload.mjs');
  const reportPath = path.join(directory, 'report.json');
  const config = {
    account_id: PRODUCTION_ACCOUNT_ID, name: 'sessions-hub',
    vars: { INDEX_SHARD_COUNT: '16', DEPLOYMENT_REVISION: copyCliRevision,
      VIEWER_HOST: `${copyCliCanary.toLowerCase()}.invalid`, INDEX_MODE: 'maintenance' },
    d1_databases: identities.map((id, index) => {
      const binding = index ? `IDX${String(index - 1).padStart(2, '0')}` : 'DB';
      return { binding, database_id: id,
        database_name: index ? `sessions-index-${binding.toLowerCase()}` : 'sessions-index' };
    }),
  };
  await writeFile(configPath, JSON.stringify(config));
  await writeCheckpoint(f.shards[0], 'index-maintenance-freeze-v1', {
    revision: copyCliRevision, cycle: '12345:1', observedAt: copyCliStart - 16 * 60 * 1000 - 1,
    source: f.source.id, shards: f.shards.map(({ id }) => id),
  });
  await writeCheckpoint(f.shards[0], 'index-rest-batch-atomicity-v1', {
    state: 'verified', databaseId: f.shards[0].id, textTransport: 'verified',
    textBytes: Buffer.byteLength(D1_BATCH_PROBE_TEXT, 'utf8'), revision: copyCliRevision,
    cycle: '12345:1', verifiedAt: copyCliStart - 1,
  });
  return {
    f, rows,
    async run(scenario = {}) {
      const budget = scenario.budget ?? 120_000;
      await writeFile(preload, `
        import assert from 'node:assert/strict';
        import { writeFileSync } from 'node:fs';
        import { DatabaseSync } from 'node:sqlite';
        const quoted = ${quoted.toString()};
        const sqliteParams = ${sqliteParams.toString()};
        const isWrite = ${isWrite.toString()};
        const selectsTable = ${selectsTable.toString()};
        ${plainRows.toString()}
        let nextTransaction = 0;
        ${SqliteD1.toString()}
        ${nativeSourceTokenRows.toString()}
        ${hasVerifiedReadback.toString()}
        ${assertVerifiedBeforeDelete.toString()}
        const scenario = ${JSON.stringify(scenario)};
        const budget = ${budget};
        const trace = [];
        const adapters = ${JSON.stringify([f.source, ...f.shards].map(({ id, filename }) => ({ id, filename })))}
          .map(({ id, filename }) => new SqliteD1(id, filename, trace));
        const f = { source: adapters[0], shards: adapters.slice(1), trace };
        const verifiedRows = assertVerifiedBeforeDelete(f);
        const checkpoint = () => {
          const saved = f.shards[0].rows('SELECT value FROM index_migration_state WHERE name = ?', [COPY_CHECKPOINT]);
          return saved.length ? JSON.parse(saved[0].value) : null;
        };
        const verifiedPending = () => {
          const saved = checkpoint();
          return saved?.pending?.phase === 'copying' && saved.pending.rows.every((item) => {
            const shard = f.shards[item.shard];
            return hasVerifiedReadback(f, saved, item)
              && trace.some((event) => event.db === shard.id && event.success
                && ['query', 'batch-statement'].includes(event.kind) && /\\bMATCH\\b/i.test(event.sql)
                && JSON.parse(event.params[0]).some(([, id]) => id === item.id));
          });
        };
        let now = ${copyCliStart};
        let copyStarted;
        let faultIndex = 0;
        let awaitingRetry = false;
        let expired = false;
        const requests = [];
        const healthCalls = [];
        const healthWaits = [];
        const signals = new WeakMap();
        Date.now = () => now;
        AbortSignal.timeout = (milliseconds) => {
          const signal = new AbortController().signal;
          signals.set(signal, milliseconds);
          return signal;
        };
        globalThis.setTimeout = (callback, delay, ...args) => {
          if (awaitingRetry) {
            healthWaits.push({ started: now, delay });
            awaitingRetry = false;
          }
          now += delay;
          queueMicrotask(() => callback(...args));
          return 0;
        };
        // Install the clock before importing the copier's transitive API pacer:
        // its process-wide permit function captures Date.now at module load.
        const { rowDigest, COPY_CHECKPOINT, SOURCE_FREEZE_TABLE } = await import(${JSON.stringify(new URL('../scripts/lib/index-migration.mjs', import.meta.url).href)});
        process.on('exit', () => {
          writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({
            now, copyStarted, requests, healthCalls, healthWaits, trace,
            verifiedRows: verifiedRows(), checkpoint: checkpoint(),
          }));
          for (const adapter of adapters) adapter.close();
        });
        const fail = (fault) => {
          awaitingRetry = fault === 'fetch' || fault === 'body';
          if (fault === 'fetch') throw new Error(${JSON.stringify(copyCliCanary)}, {
            cause: new Error('https://' + ${JSON.stringify(copyCliCanary)} + '/private?token=secret'),
          });
          if (fault === 'body') return new Response(new ReadableStream({
            start(controller) { controller.error(new Error(${JSON.stringify(copyCliCanary)})); },
          }), { status: 200 });
          if (fault === 'http') return new Response(${JSON.stringify(copyCliCanary)}, { status: scenario.httpStatus ?? 503 });
          if (fault === 'json') return new Response('{"' + ${JSON.stringify(copyCliCanary)}, { status: 200 });
          return Response.json({
            ok: true, environment: fault === 'environment' ? ${JSON.stringify(copyCliCanary)} : 'production',
            indexMode: fault === 'mode' ? 'active' : 'maintenance',
            deploymentRevision: fault === 'revision' ? ${JSON.stringify(copyCliCanary)} : ${JSON.stringify(copyCliRevision)},
            indexShardCount: fault === 'shards' ? 2 : 16,
          });
        };
        globalThis.fetch = async (input, init = {}) => {
          const url = new URL(input);
          const started = now;
          if (url.hostname === ${JSON.stringify(config.vars.VIEWER_HOST)} && url.pathname === '/healthz') {
            assert.equal(init.method ?? 'GET', 'GET');
            assert.equal(init.redirect, 'error');
            assert.equal(init.headers['cache-control'], 'no-cache');
            if (healthCalls.length === 1) copyStarted = now;
            const postVerification = verifiedPending();
            const fault = postVerification ? (scenario.faults ?? [])[faultIndex++] : undefined;
            healthCalls.push({ started, signalBudget: signals.get(init.signal), fault,
              postVerification, checkpointBefore: checkpoint(), sourceCount: f.source.rows('SELECT COUNT(*) AS n FROM blocks')[0].n });
            requests.push({ kind: 'health', started, aborted: init.signal.aborted });
            now += 7; // Deliberately unaligned with both pacing and retry intervals.
            if (postVerification && scenario.remaining !== undefined && fault) now = copyStarted + budget - scenario.remaining;
            return fail(fault);
          }
          assert.equal(url.hostname, 'api.cloudflare.com');
          assert.equal(init.method, 'POST');
          assert.ok(url.pathname.startsWith('/client/v4/accounts/${PRODUCTION_ACCOUNT_ID}/d1/database/'));
          const id = decodeURIComponent(url.pathname.match(/\\/d1\\/database\\/([^/]+)\\/query$/)[1]);
          const adapter = adapters.find((db) => db.id === id);
          assert.ok(adapter, 'D1 requests must address actual fixture databases');
          const body = JSON.parse(init.body);
          requests.push({ kind: 'd1', started, aborted: init.signal.aborted });
          const result = body.batch ? await adapter.batch(body.batch)
            : [{ success: true, results: await adapter.query(body.sql, body.params) }];
          now += 7;
          if (scenario.expireBeforeHealth && !expired && verifiedPending()) {
            expired = true;
            now = copyStarted + budget;
          }
          return Response.json({ success: true, result });
        };
      `);
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, copyCliController,
        'copy', '--config', configPath, '--pass-budget-ms', String(budget)], {
        encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, NODE_NO_WARNINGS: '1', GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push',
          GITHUB_REPOSITORY: 'pedropaulovc/agent-sessions-backup', GITHUB_REF: 'refs/heads/main',
          PROTECTED_PRODUCTION_MIGRATION: '1', GITHUB_SHA: copyCliRevision,
          GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1',
          CLOUDFLARE_ACCOUNT_ID: PRODUCTION_ACCOUNT_ID, CLOUDFLARE_API_TOKEN: copyCliCanary },
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      let report;
      try { report = JSON.parse(await readFile(reportPath, 'utf8')); }
      catch {
        const failure = result.stderr.includes('ERR_UNSUPPORTED_ESM_URL_SCHEME')
          ? 'unsupported-esm-url-scheme' : 'report-unavailable';
        throw new Error(`copy CLI fixture report unavailable: exit=${result.status} failure=${failure}`);
      }
      return { ...result, ...report, budget };
    },
  };
}

function assertCopyCliPrivate(result) {
  assert.ok(!`${result.stdout}${result.stderr}`.includes(copyCliCanary));
  assert.ok(!`${result.stdout}${result.stderr}`.includes(copyCliCanary.toLowerCase()));
}

function assertCopyCliRetained(f, rows, result) {
  assert.equal(result.verifiedRows, 0, 'unhealthy gates cannot authorize any source acknowledgment');
  assert.deepEqual(f.source.rows('SELECT * FROM blocks ORDER BY id'), rows);
  assert.equal(result.checkpoint.state, 'pending');
  assert.equal(result.checkpoint.rows, 0);
  assert.equal(result.checkpoint.after, -1);
  assert.equal(result.checkpoint.pending.phase, 'copying');
  assert.deepEqual(result.checkpoint.pending.rows, rows.map((row) => ({
    id: row.id, shard: indexShardForSessionId(row.session_id, 16),
    sha256: rowDigest(result.checkpoint.columns, row),
  })));
  assert.ok(!result.trace.some((event) => event.db === f.source.id && event.sql && isWrite(event.sql)),
    'no source barrier or DELETE may run before successful fresh health');
  for (let shard = 0; shard < f.shards.length; shard += 1) {
    assert.deepEqual(f.shards[shard].rows('SELECT * FROM blocks ORDER BY id'),
      rows.filter((row) => indexShardForSessionId(row.session_id, 16) === shard));
  }
}

test('copy CLI recovers read-only fetch and response-body interruptions only with fresh full-fidelity health', async (context) => {
  for (const faults of [[], ['fetch'], ['body'], ['fetch', 'body']]) {
    await context.test(faults.join('-') || 'no-fault-baseline', async (child) => {
      const { f, rows, run } = await copyCliFixture(child);
      const result = await run({ faults });
      assert.equal(result.status, 0, 'a recovered fresh health gate must complete the actual copy');
      assertCopyCliPrivate(result);
      const copied = JSON.parse(result.stdout.trim());
      assert.equal(copied.state, 'complete');
      assert.equal(copied.copiedRows, rows.length);
      assert.equal(result.checkpoint.sha256, copied.sha256);
      assert.equal(result.checkpoint.pending, null);
      assert.equal(result.verifiedRows, rows.length, 'native full-row readback and MATCH must precede source ACK');
      const attempts = result.healthCalls.filter(({ postVerification }) => postVerification);
      assert.equal(attempts.length, faults.length + 1);
      assert.deepEqual(attempts.map(({ fault }) => fault), [...faults, undefined]);
      assert.ok(attempts.every(({ sourceCount, checkpointBefore }) =>
        sourceCount === rows.length && checkpointBefore.pending.phase === 'copying'));
      assert.equal(result.healthWaits.length, faults.length);
      assert.ok(result.healthWaits.every(({ delay }) => delay === 1000));
      assertCopied(f, rows);
      assertAtomicBlockBatches({ ...f, trace: result.trace });
    });
  }
});

test('copy CLI exhausted health transport is sanitized and preserves the verified but unacknowledged native page', async (context) => {
  for (const fault of ['fetch', 'body']) {
    await context.test(fault, async (child) => {
      const { f, rows, run } = await copyCliFixture(child);
      const result = await run({ faults: [fault, fault, fault] });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      const attempts = result.healthCalls.filter(({ postVerification }) => postVerification);
      assert.equal(attempts.length, 3);
      assert.equal(result.healthWaits.length, 2);
      assertCopyCliRetained(f, rows, result);
      assert.deepEqual(result.checkpoint, attempts[0].checkpointBefore,
        'exhaustion cannot publish verification, advance a cursor, or discard the pending page');
      assertCopyCliPrivate(result);
      assert.equal(result.stderr.trim(), `health operation=revision-gate command=copy mode=maintenance failure=transport HTTP=${fault === 'body' ? 200 : 'unknown'} attempts=3`);
      const snapshots = f.shards.map((db) => db.rows('SELECT * FROM blocks ORDER BY id'));
      f.restart();
      const resumed = await run();
      assert.equal(resumed.status, 0, resumed.stderr);
      assert.equal(resumed.verifiedRows, rows.length);
      assertCopied(f, rows);
      assert.deepEqual(f.shards.map((db) => db.rows('SELECT * FROM blocks ORDER BY id')), snapshots,
        'durable copying-page resume retains every column while rebuilding and checking actual FTS');
    });
  }
});

test('copy CLI never retries HTTP, JSON, or fresh revision/layout mismatch into source authorization', async (context) => {
  for (const { faults, failure, httpStatus = 503 } of [
    { faults: ['fetch', 'revision'], failure: 'mismatch' },
    { faults: ['body', 'environment'], failure: 'mismatch' },
    { faults: ['mode'], failure: 'mismatch' },
    { faults: ['shards'], failure: 'mismatch' },
    { faults: ['http'], failure: 'http', httpStatus: 429 },
    { faults: ['http'], failure: 'http', httpStatus: 503 },
    { faults: ['json'], failure: 'json' },
  ]) {
    await context.test(`${faults.join('-')}-${httpStatus}`, async (child) => {
      const { f, rows, run } = await copyCliFixture(child);
      const result = await run({ faults, httpStatus });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      const attempts = result.healthCalls.filter(({ postVerification }) => postVerification);
      assert.equal(attempts.length, faults.length, 'invalid fresh responses are terminal, not transport retries');
      assert.equal(result.healthWaits.length, faults.length - 1);
      assertCopyCliRetained(f, rows, result);
      assert.deepEqual(result.checkpoint, attempts[0].checkpointBefore);
      assertCopyCliPrivate(result);
      assert.equal(result.stderr.trim(), `health operation=revision-gate command=copy mode=maintenance failure=${failure} HTTP=${failure === 'http' ? httpStatus : 200} attempts=${faults.length}`);
    });
  }
});

test('copy CLI shares the fresh soft budget with health starts and retry waits and resumes durable native state', async (context) => {
  for (const scenario of [
    { expireBeforeHealth: true },
    { faults: ['fetch'], remaining: 999 },
    { faults: ['body'], remaining: 1000 },
    { faults: ['fetch'], remaining: 1001 },
  ]) {
    await context.test(JSON.stringify(scenario), async (child) => {
      const { f, rows, run } = await copyCliFixture(child);
      const result = await run(scenario);
      assert.equal(result.status, 78, 'health boundary exhaustion must remain an explicit partial copy pass');
      assertCopyCliPrivate(result);
      assert.deepEqual(JSON.parse(result.stdout.trim()), { status: 'partial', reason: 'pass-budget-exhausted' });
      assert.equal(result.stderr, '');
      const attempts = result.healthCalls.filter(({ postVerification }) => postVerification);
      assert.equal(attempts.length, scenario.expireBeforeHealth ? 0 : scenario.remaining === 1001 ? 2 : 1);
      assert.equal(result.healthWaits.length, scenario.remaining === 1001 ? 1 : 0);
      const deadline = result.copyStarted + result.budget;
      assert.ok(result.requests.filter(({ started }) => started >= result.copyStarted)
        .every(({ started, aborted }) => started < deadline && !aborted),
      'neither health nor D1 may start after the shared boundary or cancel in-flight work');
      assert.ok(result.healthWaits.every(({ started, delay }) => started + delay < deadline));
      assert.ok(result.now <= deadline + 7, 'only an already-started response may cross the soft boundary');
      assertCopyCliRetained(f, rows, result);
      const snapshots = f.shards.map((db) => db.rows('SELECT * FROM blocks ORDER BY id'));
      f.restart();
      const resumed = await run();
      assert.equal(resumed.status, 0, resumed.stderr);
      assert.equal(resumed.verifiedRows, rows.length);
      assertCopied(f, rows);
      assert.deepEqual(f.shards.map((db) => db.rows('SELECT * FROM blocks ORDER BY id')), snapshots);
    });
  }
});

const scratchNonce = '0123456789abcdef01234567';
const scratchNames = ['source', 'idx00', 'idx01'].map((role) => `pr-42-copy-${scratchNonce}-${role}`);

// A stateful account registry, not an HTTP echo: every create/delete changes the
// resources subsequent list and identity reads observe. Faults model provider drift.
function scratchAccount(existing = [], faults = {}) {
  const resources = new Map(existing.map((database) => [database.uuid, { ...database }]));
  const created = [];
  const deleted = [];
  const adapters = new Map();
  let sequence = 0;
  const api = {
    async cf(pathname, init = {}) {
      const method = init.method ?? 'GET';
      if (pathname.startsWith('d1/database?') && method === 'GET') {
        const parameters = new URLSearchParams(pathname.split('?')[1]);
        const page = Number(parameters.get('page') ?? 1);
        const perPage = Number(parameters.get('per_page') ?? 100);
        const all = [...resources.values()];
        return {
          result: all.slice((page - 1) * perPage, page * perPage).map((database) => ({ ...database })),
          result_info: { page, per_page: perPage, total_count: all.length, total_pages: Math.ceil(all.length / perPage) },
        };
      }
      if (pathname === 'd1/database' && method === 'POST') {
        const { name } = JSON.parse(init.body);
        faults.beforeCreate?.(name, resources);
        assert.ok(![...resources.values()].some((database) => database.name === name), 'provider rejects duplicate names');
        const database = { uuid: `scratch-created-${++sequence}`, name };
        resources.set(database.uuid, database);
        created.push({ ...database });
        return faults.createResponse?.({ ...database }, resources) ?? { ...database };
      }
      const match = /^d1\/database\/([^/?]+)$/.exec(pathname);
      assert.ok(match, `unexpected registry resource ${pathname}`);
      const uuid = decodeURIComponent(match[1]);
      const database = resources.get(uuid);
      if (!database) throw Object.assign(new Error('private missing database'), { providerStatus: 404 });
      if (method === 'GET') return faults.identity ? faults.identity({ ...database }, resources) : { ...database };
      assert.equal(method, 'DELETE');
      faults.beforeDelete?.({ ...database }, resources);
      resources.delete(uuid);
      deleted.push({ ...database });
      return {};
    },
    db(uuid) {
      assert.ok(resources.has(uuid), 'native adapter requires an existing database');
      const adapter = { id: uuid };
      adapters.set(uuid, adapter);
      return adapter;
    },
  };
  return {
    api, resources, created, deleted, adapters,
    snapshot: () => [...resources.values()].map((database) => ({ ...database })).sort((a, b) => a.uuid.localeCompare(b.uuid)),
  };
}

function standingScratchResources(foreignCount = 2) {
  return [
    { uuid: 'persistent-main', name: 'pr-42-sessions-index' },
    { uuid: 'persistent-idx00', name: 'pr-42-sessions-index-idx00' },
    { uuid: 'persistent-idx01', name: 'pr-42-sessions-index-idx01' },
    ...Array.from({ length: foreignCount }, (_, index) => ({ uuid: `foreign-${index}`, name: `unrelated-account-db-${index}` })),
  ];
}

function allocateScratch(account, run) {
  return withScratchD1Databases({ api: account.api, pr: 42, nonce: scratchNonce, run });
}

async function rejectsPrivateScratchFailure(operation) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes('private'), 'allocator must sanitize provider and callback errors');
    return true;
  });
}

test('scratch allocator proves whole-account capacity before creation, including foreign databases', async (context) => {
  for (const foreignCount of [5, 7]) {
    await context.test(`${3 + foreignCount} existing databases`, async () => {
      const account = scratchAccount(standingScratchResources(foreignCount));
      const before = account.snapshot();
      await assert.rejects(allocateScratch(account, async () => assert.fail('exhausted account must not run')));
      assert.deepEqual(account.created, [], 'quota rejection must not transiently allocate any scratch database');
      assert.deepEqual(account.deleted, []);
      assert.deepEqual(account.snapshot(), before);
    });
  }
});

test('scratch allocator never adopts or deletes an exact generated-name collision', async () => {
  const account = scratchAccount([
    ...standingScratchResources(),
    { uuid: 'previous-interrupted-run', name: scratchNames[2] },
  ]);
  const before = account.snapshot();
  await assert.rejects(allocateScratch(account, async () => assert.fail('colliding run must not execute')));
  assert.deepEqual(account.created, []);
  assert.deepEqual(account.deleted, []);
  assert.deepEqual(account.snapshot(), before);
});

test('scratch allocator uses three unique native adapters at the exact capacity boundary and preserves all standing resources', async () => {
  const account = scratchAccount(standingScratchResources(4));
  const before = account.snapshot();
  const result = await allocateScratch(account, async ({ source, shards }) => {
    assert.equal(shards.length, 2);
    const native = [source, ...shards];
    assert.equal(new Set(native.map(({ id }) => id)).size, 3);
    assert.deepEqual(native.map(({ id }) => account.resources.get(id).name), scratchNames);
    for (const adapter of native) assert.equal(adapter, account.adapters.get(adapter.id));
    assert.equal(account.resources.size, 10);
    return { completed: true };
  });
  assert.deepEqual(result, { completed: true });
  assert.deepEqual(account.created.map(({ name }) => name), scratchNames);
  assert.deepEqual(account.snapshot(), before);
  assert.deepEqual(new Set(account.deleted.map(({ uuid }) => uuid)), new Set(account.created.map(({ uuid }) => uuid)));
});

test('scratch callback failure cleans all three owned databases and redacts callback details', async () => {
  const account = scratchAccount(standingScratchResources());
  const before = account.snapshot();
  let entered = false;
  await rejectsPrivateScratchFailure(allocateScratch(account, async ({ source, shards }) => {
    entered = true;
    assert.deepEqual([source, ...shards].map(({ id }) => account.resources.get(id).name), scratchNames);
    throw new Error('private callback payload');
  }));
  assert.equal(entered, true);
  assert.deepEqual(account.created.map(({ name }) => name), scratchNames);
  assert.deepEqual(account.snapshot(), before);
});

test('scratch partial creation failure cleans only validated known creations and never invokes the callback', async (context) => {
  for (const failingName of scratchNames.slice(1)) {
    await context.test(failingName, async () => {
      const account = scratchAccount(standingScratchResources(), {
        beforeCreate(name) {
          if (name === failingName) throw new Error('private provider creation error');
        },
      });
      const before = account.snapshot();
      await rejectsPrivateScratchFailure(allocateScratch(account, async () => assert.fail('partial allocation must not run')));
      assert.deepEqual(account.created.map(({ name }) => name), scratchNames.slice(0, scratchNames.indexOf(failingName)));
      assert.deepEqual(account.deleted.map(({ uuid }) => uuid).sort(), account.created.map(({ uuid }) => uuid).sort());
      assert.deepEqual(account.snapshot(), before);
    });
  }
});

test('scratch allocator refuses foreign create responses without adopting or deleting their identities', async (context) => {
  for (const responseKind of ['foreign-name', 'prior-uuid', 'duplicate-created-uuid', 'missing-uuid']) {
    await context.test(responseKind, async () => {
      const account = scratchAccount(standingScratchResources(), {
        createResponse(database, resources) {
          if (database.name !== scratchNames[1]) return database;
          if (responseKind === 'foreign-name') {
            resources.set(database.uuid, { ...database, name: 'foreign-response-database' });
            return { ...database, name: 'foreign-response-database' };
          }
          if (responseKind === 'prior-uuid') return { ...database, uuid: 'foreign-0' };
          if (responseKind === 'duplicate-created-uuid') return { ...database, uuid: 'scratch-created-1' };
          return { name: database.name };
        },
      });
      const before = account.snapshot();
      await assert.rejects(allocateScratch(account, async () => assert.fail('untrusted response must not run')));
      assert.deepEqual(account.created.map(({ name }) => name), scratchNames.slice(0, 2));
      assert.deepEqual(account.deleted, [account.created[0]]);
      assert.deepEqual(account.snapshot(), [
        ...before,
        { uuid: 'scratch-created-2', name: responseKind === 'foreign-name' ? 'foreign-response-database' : scratchNames[1] },
      ].sort((a, b) => a.uuid.localeCompare(b.uuid)));
    });
  }
});

test('scratch cleanup refuses identity drift while still removing every other known owned database', async (context) => {
  for (const drift of ['name', 'uuid', 'other-pr']) {
    await context.test(drift, async () => {
      let driftEnabled = false;
      const account = scratchAccount(standingScratchResources(), {
        identity(database) {
          return driftEnabled && database.uuid === 'scratch-created-1' && drift === 'uuid'
            ? { ...database, uuid: 'foreign-0' } : database;
        },
      });
      const before = account.snapshot();
      let entered = false;
      const survivorName = drift === 'name' ? 'foreign-renamed-database'
        : drift === 'other-pr' ? scratchNames[0].replace('pr-42-', 'pr-43-') : scratchNames[0];
      await assert.rejects(allocateScratch(account, async ({ source }) => {
        entered = true;
        driftEnabled = true;
        account.resources.set(source.id, { uuid: source.id, name: survivorName });
        return 'successful callback';
      }));
      assert.equal(entered, true);
      assert.deepEqual(account.deleted.map(({ name }) => name).sort(), scratchNames.slice(1).sort());
      assert.deepEqual(account.snapshot(), [
        ...before, { uuid: 'scratch-created-1', name: survivorName },
      ].sort((a, b) => a.uuid.localeCompare(b.uuid)));
    });
  }
});

test('scratch cleanup deletion failure fails successful work and attempts the remaining owned deletions', async () => {
  const account = scratchAccount(standingScratchResources(), {
    beforeDelete(database) {
      if (database.name === scratchNames[0]) throw new Error('private provider deletion error');
    },
  });
  const before = account.snapshot();
  let entered = false;
  await rejectsPrivateScratchFailure(allocateScratch(account, async () => { entered = true; return 'success'; }));
  assert.equal(entered, true);
  assert.deepEqual(account.deleted.map(({ name }) => name).sort(), scratchNames.slice(1).sort());
  assert.deepEqual(account.snapshot(), [...before, account.created[0]].sort((a, b) => a.uuid.localeCompare(b.uuid)));
});

test('scratch cleanup rejects successful null metadata without deleting that resource and cleans other owned databases', async () => {
  let nullMetadataEnabled = false;
  const account = scratchAccount(standingScratchResources(), {
    identity(database) {
      return nullMetadataEnabled && database.name === scratchNames[0] ? null : database;
    },
  });
  const before = account.snapshot();
  await assert.rejects(allocateScratch(account, async () => {
    nullMetadataEnabled = true;
    return 'successful callback';
  }), (error) => {
    assert.equal(error.nativeCopyPhase, 'cleanup');
    assert.equal(error.nativeCopyClass, 'ownership');
    return true;
  });
  assert.deepEqual(account.deleted.map(({ name }) => name).sort(), scratchNames.slice(1).sort());
  assert.deepEqual(account.snapshot(), [...before, account.created[0]].sort((a, b) => a.uuid.localeCompare(b.uuid)));
});

test('scratch cleanup accepts native HTTP 404 absence without touching standing resources', async () => {
  const account = scratchAccount(standingScratchResources());
  const before = account.snapshot();
  await allocateScratch(account, async ({ source }) => {
    assert.equal(account.resources.delete(source.id), true);
  });
  assert.deepEqual(account.deleted.map(({ name }) => name).sort(), scratchNames.slice(1).sort());
  assert.deepEqual(account.snapshot(), before);
});

async function nativeScratchFixture(context, faults = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'native-copy-control-test-'));
  const account = scratchAccount(standingScratchResources(), faults);
  const adapters = [];
  context.after(async () => {
    for (const adapter of adapters) adapter.close();
    await rm(directory, { recursive: true, force: true });
  });
  account.api.db = (uuid) => {
    assert.ok(account.resources.has(uuid));
    const adapter = new SqliteD1(uuid, path.join(directory, `${uuid}.sqlite`), []);
    // Preserve actual SQLite execution and errors, adding only the native
    // client's public SQL classification that the fence proof consumes.
    for (const method of ['query', 'batch']) {
      const execute = adapter[method].bind(adapter);
      adapter[method] = async (...args) => {
        try { return await execute(...args); }
        catch (error) {
          error.d1SqlReason = d1SqlFailureReason([{ message: error.message }]);
          throw error;
        }
      };
    }
    adapters.push(adapter);
    return adapter;
  };
  const indexMigrations = await migrations(path.join(hubRoot, 'migrations-index'));
  return { account, adapters, proof: {
    api: account.api,
    pr: 42,
    applySchema: async ({ source, shards }) => {
      for (const database of [source, ...shards]) {
        for (const migration of indexMigrations) database.database.exec(migration.sql);
      }
    },
  } };
}

test('native full-copy control runs real SQLite schema, copier, independent readback and scratch cleanup end to end', async (context) => {
  const { account, adapters, proof } = await nativeScratchFixture(context);
  const before = account.snapshot();
  let positiveTraces;
  const applySchema = proof.applySchema;
  proof.applySchema = async (databases) => {
    await applySchema(databases);
    databases.source.beforeQuery = ({ sql }) => {
      if (sql === "SELECT hex(unhex('61FF62')) AS bytes") positiveTraces = adapters.map((db) => db.trace.slice());
    };
  };
  const result = await verifyNativeCopyControl(proof);
  assert.equal(result.state, 'verified');
  assert.equal(result.probe, 'd1-native-full-copy');
  assert.equal(result.growthRows, 46);
  assert.equal(result.rows, result.denseRows + result.growthRows + 2, 'ordinary, dense, growth and huge rows all need full-copy proof');
  assert.equal(result.denseRows, 1461);
  assert.equal(result.columns, BLOCK_COLUMNS.length);
  assert.equal(result.shards, 2);
  assert.ok(result.splitFtsProbePages > 0);
  assert.ok(result.maxFtsParametersBytes <= COPY_PAGE_BYTES);
  assert.ok(result.maxUnsplitFtsParametersBytes > COPY_PAGE_BYTES);
  assert.equal(result.fallbackPages, 1);
  assert.equal(result.legacyProbeMatches, 0);
  assert.equal(result.nativeProbeMatches, 1);
  assert.equal(result.longTextBytes, 1_100_061);
  assert.equal(result.freezeTriggers, 3);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.ok(positiveTraces, 'the complete original positive proof must precede byte recovery');
  const [source, ...shards] = adapters.map((db, index) => Object.assign(Object.create(db), { trace: positiveTraces[index] }));
  const recovery = result.byteExactRecovery;
  assert.equal(recovery.outcome, 'verified');
  assert.equal(recovery.encoding, COPY_ENCODING);
  assert.equal(recovery.rows, 12);
  assert.equal(recovery.prefixRows, 3);
  assert.equal(recovery.legacyPendingRows, 3);
  assert.equal(recovery.legacyInvalidRows, 2);
  assert.equal(recovery.lossyReplicaCells, 2);
  assert.equal(recovery.recoveringCheckpoints, 1);
  assert.ok(recovery.invalidCells >= 8);
  assert.ok(recovery.rawSha256Matches > recovery.invalidCells);
  assert.deepEqual(recovery.longInvalidTextBytes, [300000, 1900000]);
  assert.equal(recovery.boundPages, 1);
  assert.ok(recovery.maxBoundParams <= 100);
  assert.ok(recovery.maxBoundRequestBytes <= 4 * 1024 * 1024);
  assert.ok(recovery.ftsMatches > 0);
  assert.equal(recovery.positiveRowsRetained, result.rows);
  assert.match(recovery.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(recovery.guard, {
    mutation: 'ff-to-fe', phase: 'copy-source-delete-and-freeze', nativeClass: 'malformed-json',
    comparison: { status: 'mismatch', expectedRows: 1, presentRows: 1, missingRows: 0, mismatchingRows: 1,
      columns: [{ index: 12, mismatchingRows: 1, typeMismatchRows: 0, byteMismatchRows: 1, lengthMismatchRows: 0,
        sourceTypes: ['text'], snapshotTypes: ['text'] }] },
    writesAfterFailure: 0, diagnosticQueries: 1, sourceRetention: 'retained', freezeRetention: 'frozen',
    checkpointRetention: 'retained', destinationRetention: 'retained', staleRerun: 'source-changed', restoredRun: 'complete',
  });
  assert.deepEqual(source.rows('SELECT id FROM blocks'), [], 'byte-exact recovery must finish, not report a green retained-data negative control');
  assert.deepEqual(source.rows(`SELECT state FROM ${SOURCE_FREEZE_TABLE}`), [{ state: 'frozen' }]);
  const copied = shards.flatMap((database) => database.rows('SELECT * FROM blocks'))
    .filter(({ id }) => id < 2_000_000 || id >= 2_001_000).sort((a, b) => a.id - b.id);
  assert.equal(copied.length, result.rows);
  assert.equal(sha256(JSON.stringify(copied.map((row) => JSON.parse(canonicalRow(BLOCK_COLUMNS, row))))), result.sha256);
  const dense = copied.filter(({ id }) => id >= 1 && id <= result.denseRows);
  const denseIds = Array.from({ length: result.denseRows }, (_, index) => index + 1);
  assert.deepEqual(dense.map(({ id }) => id), denseIds);
  assert.ok(dense.every(({ session_id }) => indexShardForSessionId(session_id, 2) === 1));
  const boundaryCases = nativeTokenizerBoundaryCases();
  for (const [index, row] of dense.entries()) {
    const boundary = boundaryCases[index];
    assert.equal(row.text, boundary?.only ? boundary.text
      : `${boundary?.text ?? `v${index}`}\u0000 nativedensesuffix`);
  }
  await assertNativeTokenizerBoundaryMatches(shards[1], dense);
  const growth = copied.filter(({ id }) => id > result.denseRows && id < INDEX_ID_SPAN - 1);
  assert.equal(growth.length, result.growthRows);
  for (const [index, row] of growth.entries()) {
    assert.equal(row.id, result.denseRows + index + 1);
    assert.equal(row.text, `a${'Ⱥ'.repeat(11000)}${index}`);
    assert.equal(indexShardForSessionId(row.session_id, 2), 1);
    await assertNativeLongWordIdentity(shards[1], row, [row.text]);
  }
  assert.deepEqual(shards[0].rows('SELECT id FROM blocks WHERE id < 2000000 OR id >= 2001000 ORDER BY id'), [{ id: 0 }]);
  assert.deepEqual(shards[1].rows('SELECT id FROM blocks WHERE id < 2000000 OR id >= 2001000 ORDER BY id'),
    [...denseIds, ...growth.map(({ id }) => id), INDEX_ID_SPAN - 1].map((id) => ({ id })));
  const seed = source.trace.find(({ kind }) => kind === 'batch');
  assert.equal(seed.statements.filter(({ sql }) => /^INSERT INTO blocks \(/.test(sql)).length, 4,
    'one ordinary row, the preserved dense phase, separate growth rows and the huge fallback must actually be seeded');
  assert.equal(seed.statements.filter(({ sql }) => /^INSERT INTO blocks_fts\b/.test(sql)).length, 1);
  const bulkSeed = seed.statements.filter(({ sql }) => /FROM json_each\(\?\)/.test(sql));
  assert.equal(bulkSeed.length, 2);
  assert.ok(bulkSeed.every(({ params }) => params.length === 1));
  assert.deepEqual(bulkSeed.flatMap(({ params }) => JSON.parse(params[0])),
    [...dense, ...growth].map((row) => BLOCK_COLUMNS.map((column) => row[column])));
  const sourceFtsWrites = source.trace.filter(({ sql }) => typeof sql === 'string'
    && isWrite(sql) && /\bblocks_fts\b/.test(sql));
  assert.equal(sourceFtsWrites.length, 1);
  assert.equal(sourceFtsWrites[0].transaction, seed.transaction,
    'source retirement must leave the originally seeded legacy FTS pages unchanged');
  const copying = shards[0].trace.filter(({ sql, params }) => /^INSERT INTO index_migration_state\b/.test(sql)
    && params[0] === COPY_CHECKPOINT && JSON.parse(params[1]).pending?.phase === 'copying')
    .map(({ params }) => JSON.parse(params[1]));
  assert.deepEqual(copying[0].pending.rows.map(({ id }) => id), [0, ...denseIds],
    'growth must not alter the original first dense source-page geometry');
  assert.deepEqual(copying.flatMap(({ pending }) => pending.rows.map(({ id }) => id)), copied.map(({ id }) => id));
  const writes = shards.flatMap(({ trace }) => trace.filter(({ kind, statements }) => kind === 'batch'
    && statements.some(({ sql }) => /^INSERT INTO blocks \(/.test(sql))));
  const ordinaryWrites = writes.filter(({ statements }) => statements.some(({ sql, params }) =>
    /^INSERT INTO blocks \(/.test(sql) && params.length === 1));
  assert.equal(result.ordinaryPages, ordinaryWrites.length, 'page aggregate must come from real ordinary writes, not an incidental pinned count');
  const probeGroups = shards.flatMap(({ trace }) => trace.filter(({ kind, sql, params }) =>
    kind === 'query' && /\bMATCH\b/.test(sql) && params.length === 1 && params[0].startsWith('[')));
  assert.equal(result.maxFtsParametersBytes, Math.max(...probeGroups.map(({ params }) => Buffer.byteLength(JSON.stringify(params)))));
  assert.ok(probeGroups.every(({ params }) => Buffer.byteLength(JSON.stringify(params)) <= COPY_PAGE_BYTES));
  let splitPages = 0;
  let maxUnsplitBytes = 0;
  for (const { pending } of copying) {
    let split = false;
    for (const [index, database] of shards.entries()) {
      const wanted = pending.rows.filter(({ shard }) => shard === index).map(({ id }) => id);
      const groups = probeGroups.filter(({ db, params }) => db === database.id
        && JSON.parse(params[0]).some(([, id]) => wanted.includes(id)));
      const pairs = groups.flatMap(({ params }) => JSON.parse(params[0]));
      assert.deepEqual(pairs.map(([, id]) => id), wanted);
      const bytes = Buffer.byteLength(JSON.stringify([JSON.stringify(pairs)]));
      maxUnsplitBytes = Math.max(maxUnsplitBytes, bytes);
      if (bytes > COPY_PAGE_BYTES) {
        assert.ok(groups.length > 1, 'an actual over-budget logical page needs multiple native groups');
        split = true;
      }
    }
    if (split) splitPages += 1;
  }
  assert.equal(result.maxUnsplitFtsParametersBytes, maxUnsplitBytes);
  assert.equal(result.splitFtsProbePages, splitPages);
  const sourcePoints = source.trace.filter(({ kind, sql, params }) =>
    kind === 'query' && /\bMATCH\b/.test(sql) && params.length === 2 && params[1] === 7);
  assert.ok(sourcePoints.some(({ params, rows }) => params[0] === '"alpha"' && rows.length === 0));
  assert.ok(sourcePoints.some(({ params, rows }) => params[0] === '"🫠alpha"'
    && JSON.stringify(rows) === JSON.stringify([{ rowid: 7 }])),
  'the pre-copy source oracle must prove the old alpha miss and native whole-term hit');
  const suffixIds = dense.filter(({ text }) => text.includes('\u0000 nativedensesuffix')).map(({ id }) => id);
  const independentMatches = shards.flatMap((database) => database.trace.filter(({ kind, sql, params }) =>
    ['query', 'batch-statement'].includes(kind) && /\bMATCH\b/.test(sql)
    && (params.length === 2 || params[0] === 'nativedensesuffix')));
  for (const [index, database] of shards.entries()) {
    const suffix = independentMatches.filter(({ db, params }) => db === database.id
      && params[0] === 'nativedensesuffix');
    assert.ok(suffix.length > 0, 'each shard needs actual independent after-NUL suffix evidence');
    for (const { rows } of suffix) assert.deepEqual(rows, (index === 1 ? suffixIds : []).map((rowid) => ({ rowid })));
  }
  for (const [index, { tokens }] of boundaryCases.entries()) {
    for (const term of tokens) assert.ok(independentMatches.some(({ db, params, rows }) => db === shards[1].id
      && params[0] === `"${term}"` && params[1] === index + 1
      && JSON.stringify(rows) === JSON.stringify([{ rowid: index + 1 }])),
    'all synthetic boundary points must have independent native positive results');
  }
  const growthIds = new Set(growth.map(({ id }) => id));
  const originalWordBatches = shards[1].trace.filter(({ kind, statements }) => kind === 'batch'
    && statements.length > 0 && statements.every(({ sql, params }) => /\bMATCH\b/.test(sql)
      && params.length === 2 && growthIds.has(params[1])));
  const growthPages = copying.filter(({ pending }) => pending.rows.some(({ id }) => growthIds.has(id)));
  assert.equal(originalWordBatches.length, growthPages.length + 1,
    'every real growth page needs independent ORIGINAL-word verification before ACK, plus final verification');
  for (const { statements, transaction } of originalWordBatches) {
    assert.ok(statements.length <= result.growthRows);
    assert.ok(Buffer.byteLength(JSON.stringify({ batch: statements })) <= COPY_PAGE_BYTES,
      'the entire independent point batch must fit the internal request budget');
    const calls = shards[1].trace.filter((event) => event.kind === 'batch-statement' && event.transaction === transaction);
    assert.equal(calls.length, statements.length);
    for (const call of calls) {
      const row = growth.find(({ id }) => id === call.params[1]);
      assert.equal(call.params[0], `"${row.text}"`, 'independent inputs must be ORIGINAL whole valid words, not copier completions');
      assert.equal(call.success, true);
      assert.deepEqual(call.rows, [{ rowid: row.id }], 'every statement needs its actual native posting identity');
    }
  }
  const sliceBatches = [source, ...shards].flatMap(({ trace }) => trace.filter(({ kind, statements }) => kind === 'batch'
    && statements.length > 0 && statements.every(({ sql }) => /^SELECT hex\(substr/.test(sql))));
  assert.ok(sliceBatches.length > 0, 'independent full-byte transport must execute actual native slice batches');
  for (const { db, statements, transaction, responseBytes } of sliceBatches) {
    assert.ok(statements.length <= 100);
    assert.ok(Buffer.byteLength(JSON.stringify({ batch: statements })) <= COPY_PAGE_BYTES);
    const reserve = 4096 + statements.reduce((bytes, { params }) => bytes + params[1] * 2 + 4096, 0);
    assert.ok(reserve <= COPY_PAGE_BYTES, 'known hex payloads plus conservative internal result/envelope reserves must stay bounded');
    assert.ok(responseBytes <= COPY_PAGE_BYTES, 'the aggregate ACTUAL native result JSON must also fit the response budget');
    const calls = [source, ...shards].find((adapter) => adapter.id === db).trace.filter((event) =>
      event.kind === 'batch-statement' && event.transaction === transaction);
    assert.equal(calls.length, statements.length);
    for (const call of calls) {
      assert.equal(call.success, true);
      assert.equal(call.rows.length, 1);
      assert.ok(call.params.every(Number.isSafeInteger));
      assert.ok(call.params[0] >= 1 && call.params[1] > 0 && call.params[1] <= 131072);
      assert.equal(call.rows[0].bytes.length, call.params[1] * 2);
      assert.match(call.rows[0].bytes, /^[0-9a-f]+$/i);
    }
  }
  assert.ok(sliceBatches.some(({ statements }) => statements.length > 1),
    'actual independent slice transport must batch multiple real native statements');
  assert.ok(sliceBatches.some(({ db, statements }, index) => {
    const next = sliceBatches[index + 1];
    const last = statements.at(-1);
    if (!next || next.db !== db || !growthIds.has(last.params[2])
      || next.statements[0].params[2] !== last.params[2] + 1) return false;
    const reserved = 4096 + statements.reduce((bytes, { params }) => bytes + params[1] * 2 + 4096, 0);
    return statements.length < 100 && reserved + next.statements[0].params[1] * 2 + 4096 > COPY_PAGE_BYTES;
  }), 'actual adjacent growth slices must cross the conservative response-byte boundary, not just a count cap');
  assert.equal(result.ftsMatches, independentMatches.reduce((count, { rows }) => count + rows.length, 0),
    'summary FTS evidence must count the actual independent positive point and suffix hits');
  const requests = [source, ...shards].flatMap(({ trace }) => trace.filter(({ kind }) => ['query', 'batch'].includes(kind)));
  assert.ok(requests.length <= 200 + result.growthRows * 6,
    `complete native proof must retain bulk copying with bounded independent growth point batches/slice checks, observed ${requests.length}`);
  const statements = [source, ...shards].flatMap(({ trace }) => trace.filter(({ kind }) => ['query', 'batch-statement'].includes(kind)));
  assert.ok(statements.every(({ params }) => params.length <= 100));
  assert.ok(statements.every(({ responseBytes }) => responseBytes === undefined || responseBytes <= 1_048_576),
    'full-row and independent readback responses stay within the ordinary response budget');
  const retainedCheckpoint = await readCheckpoint(shards[0], COPY_CHECKPOINT);
  assert.equal(retainedCheckpoint.state, 'complete');
  assert.equal(retainedCheckpoint.encoding, COPY_ENCODING);
  assert.equal(retainedCheckpoint.rows, recovery.rows);
  assert.equal(retainedCheckpoint.pending, null);
  assert.ok(shards[0].trace.some(({ sql, params }) => /^INSERT INTO index_migration_state\b/.test(sql)
    && params[0] === COPY_CHECKPOINT && JSON.parse(params[1]).state === 'complete'
    && JSON.parse(params[1]).rows === result.rows), 'the full positive proof must complete before its scratch-only checkpoint reset');
  assert.deepEqual(account.snapshot(), before);
  assert.equal(account.created.length, 3);
  assert.equal(new Set(account.created.map(({ name }) => name)).size, 3);
  for (const { name } of account.created) assert.match(name, /^pr-42-copy-[0-9a-f]{24}-(?:source|idx00|idx01)$/);
  assert.deepEqual(new Set(account.deleted.map(({ uuid }) => uuid)), new Set(account.created.map(({ uuid }) => uuid)));
});

test('native proof rejects an unrelated failure before byte-exact recovery instead of returning a verified negative control', async (context) => {
  const canary = 'PRIVATE_EARLY_RECOVERY_FAILURE_CANARY';
  const { account, adapters, proof } = await nativeScratchFixture(context);
  const beforeAccount = account.snapshot(), applySchema = proof.applySchema;
  let exercised = false, sourceBefore, checkpointBefore, sourceTraceStart;
  proof.applySchema = async (databases) => {
    await applySchema(databases);
    databases.source.beforeQuery = async ({ sql }) => {
      if (exercised || sql !== "SELECT hex(unhex('61FF62')) AS bytes") return;
      exercised = true;
      sourceBefore = blockSnapshot(databases.source);
      checkpointBefore = await readCheckpoint(databases.shards[0], COPY_CHECKPOINT);
      sourceTraceStart = databases.source.trace.length;
      assert.equal(checkpointBefore.state, 'complete');
      assert.equal(checkpointBefore.rows, 1509);
      throw Object.assign(new Error(`syntax error ${canary}`), { d1FailureKind: 'statement' });
    };
  };
  await assert.rejects(verifyNativeCopyControl(proof), (error) => {
    assert.equal(error.nativeCopyPhase, 'byte-exact-recovery');
    assert.equal(error.nativeCopyClass, 'sql-syntax');
    assert.equal(error.nativeCopyFailureKind, 'statement');
    assert.equal(error.cause, undefined);
    assert.ok(!`${error.message} ${error.stack} ${JSON.stringify(error)}`.includes(canary));
    return true;
  });
  assert.equal(exercised, true);
  assert.deepEqual(blockSnapshot(adapters[0]), sourceBefore);
  assert.deepEqual(await readCheckpoint(adapters[1], COPY_CHECKPOINT), checkpointBefore);
  assert.deepEqual(adapters[0].trace.slice(sourceTraceStart).filter(({ sql }) => sql && isWrite(sql)), []);
  assert.deepEqual(adapters[0].rows('SELECT id FROM blocks'), []);
  assert.deepEqual(adapters[0].rows(`SELECT state FROM ${SOURCE_FREEZE_TABLE}`), [{ state: 'frozen' }]);
  assert.equal(adapters.slice(1).reduce((count, db) => count + db.rows('SELECT COUNT(*) AS n FROM blocks')[0].n, 0), 1509);
  assert.deepEqual(account.snapshot(), beforeAccount);
  assert.equal(account.created.length, 3);
  assert.equal(account.deleted.length, 3);
});

test('native byte-exact recovery refuses nullable transport and false or unavailable diagnostic evidence without further writes', async (context) => {
  for (const scenario of ['null-transport', 'wrong-aggregate', 'query-failed', 'invalid-evidence', 'malformed-summary']) {
    await context.test(scenario, async (child) => {
      const canary = 'PRIVATE_BYTE_EXACT_PROVIDER_CANARY';
      const { account, adapters, proof } = await nativeScratchFixture(child);
      const beforeAccount = account.snapshot(), applySchema = proof.applySchema;
      let exercised = false, sourceBefore, checkpointBefore, sourceTraceStart;
      const capture = async (databases) => {
        exercised = true;
        sourceBefore = await publicRawSnapshot(databases.source);
        checkpointBefore = await readCheckpoint(databases.shards[0], COPY_CHECKPOINT);
        sourceTraceStart = databases.source.trace.length;
      };
      proof.applySchema = async (databases) => {
        await applySchema(databases);
        databases.source.beforeQuery = async ({ sql }) => {
          if (exercised || !['query-failed', 'invalid-evidence'].includes(scenario)
            || !sql.includes('AS source_comparison FROM compared')) return;
          await capture(databases);
          try { databases.source.database.prepare(`SELECT * FROM "${canary}"`).all(); }
          catch (error) {
            Object.assign(error, scenario === 'invalid-evidence'
              ? { providerStatus: canary, providerCodes: [canary], d1FailureKind: canary, d1Phase: canary }
              : { providerStatus: 400, providerCodes: [7500], d1FailureKind: 'http' });
            throw error;
          }
          assert.fail('the absent relation must reject natively');
        };
        databases.source.transformQuery = async ({ sql }, rows) => {
          if (exercised) return rows;
          if (scenario === 'null-transport' && /^\s*WITH sized AS MATERIALIZED/.test(sql)
            && sql.includes('hex(CAST(') && rows.some((row) => row.id === 2_000_011)) {
            await capture(databases);
            return rows.map((row) => row.id === 2_000_011 ? { ...row, text: null } : row);
          }
          if (!['wrong-aggregate', 'malformed-summary'].includes(scenario)
            || !sql.includes('AS source_comparison FROM compared')) return rows;
          await capture(databases);
          if (scenario === 'malformed-summary') return [{ source_comparison: `{${canary}` }];
          const summary = JSON.parse(rows[0].source_comparison);
          assert.deepEqual(summary.slice(0, 4), [1, 1, 0, 1]);
          const cell = summary[4][0][12];
          assert.deepEqual(cell, [1, 0, 1, 0, 8, 8]);
          cell[3] = 1;
          return [{ ...rows[0], source_comparison: JSON.stringify(summary), providerPayload: canary }];
        };
      };
      await assert.rejects(verifyNativeCopyControl(proof), (error) => {
        assert.equal(error.nativeCopyClass, 'assertion');
        assert.equal(error.nativeCopyPhase, scenario === 'null-transport' ? 'copy-source-page-read' : 'byte-exact-guard');
        if (scenario === 'null-transport') assert.equal(error.nativeCopyInvariant, 'long-length');
        if (['query-failed', 'invalid-evidence'].includes(scenario)) {
          assert.deepEqual(error.nativeCopySourceComparison, { status: 'unavailable', reason: 'query-failed' });
        }
        if (scenario === 'malformed-summary') {
          assert.deepEqual(error.nativeCopySourceComparison, { status: 'unavailable', reason: 'response-shape' });
        }
        assert.ok(!`${error.message} ${error.stack} ${JSON.stringify(error)}`.includes(canary));
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(exercised, true);
      assert.deepEqual(await publicRawSnapshot(adapters[0]), sourceBefore);
      assert.deepEqual(await readCheckpoint(adapters[1], COPY_CHECKPOINT), checkpointBefore);
      assert.deepEqual(adapters[0].trace.slice(sourceTraceStart).filter(({ sql }) => sql && isWrite(sql)), [],
        'a failed raw read or aggregate must never repair, delete or ACK by a fallback');
      assert.deepEqual(adapters[0].rows(`SELECT state FROM ${SOURCE_FREEZE_TABLE}`), [{ state: 'frozen' }]);
      assert.deepEqual(account.snapshot(), beforeAccount);
      assert.equal(account.created.length, 3);
      assert.equal(account.deleted.length, 3);
    });
  }
});


test('native proof actual batched BLOB slice faults retain growth source and block acknowledgment', async (context) => {
  for (const fault of ['missing-result', 'failed-statement', 'missing-row', 'truncated-hex', 'invalid-hex', 'invalid-utf8', 'reordered-results']) {
    await context.test(fault, async (child) => {
      const { account, adapters, proof } = await nativeScratchFixture(child);
      const beforeAccount = account.snapshot();
      const applySchema = proof.applySchema;
      let exercised = false;
      let sourceBefore;
      let checkpointBefore;
      let sourceTraceStart;
      proof.applySchema = async (databases) => {
        await applySchema(databases);
        const shard = databases.shards[1];
        const execute = shard.batch.bind(shard);
        shard.batch = async (statements) => {
          const actual = await execute(statements);
          if (exercised || !statements.length || !statements.every(({ sql }) => /^SELECT hex\(substr/.test(sql))
            || !statements.some(({ params }) => params[2] > 1461 && params[2] < INDEX_ID_SPAN - 1)) return actual;
          const checkpoint = await readCheckpoint(databases.shards[0], COPY_CHECKPOINT);
          if (checkpoint?.pending?.phase !== 'verified') return actual;
          checkpointBefore = checkpoint;
          sourceBefore = blockSnapshot(databases.source);
          sourceTraceStart = databases.source.trace.length;
          assert.equal(actual.length, statements.length);
          assert.ok(actual.every(({ success, results }) => success && results.length === 1
            && typeof results[0].bytes === 'string' && results[0].bytes.length > 2),
          'faults must alter genuine executed SQLite slice results, never mock expected bytes');
          exercised = true;
          if (fault === 'missing-result') return actual.slice(1);
          if (fault === 'failed-statement') return actual.map((result, index) =>
            index ? result : { ...result, success: false });
          if (fault === 'missing-row') return actual.map((result, index) =>
            index ? result : { ...result, results: [] });
          if (fault === 'reordered-results') {
            assert.notEqual(actual[0].results[0].bytes, actual[1].results[0].bytes);
            [actual[0], actual[1]] = [actual[1], actual[0]];
          } else {
            const row = actual[0].results[0];
            row.bytes = fault === 'truncated-hex' ? row.bytes.slice(0, -2)
              : `${fault === 'invalid-hex' ? 'GG' : 'FF'}${row.bytes.slice(2)}`;
          }
          return actual;
        };
      };
      await assert.rejects(verifyNativeCopyControl(proof), (error) => {
        assert.equal(error.nativeCopyPhase, 'growth-before-ack');
        assert.equal(error.nativeCopyClass, 'assertion');
        assert.equal(error.cause, undefined);
        assert.ok(!`${error.message} ${error.stack} ${JSON.stringify(error)}`.includes('Ⱥ'.repeat(32)));
        return true;
      });
      assert.equal(exercised, true);
      assert.deepEqual(blockSnapshot(adapters[0]), sourceBefore, 'a rejected native slice batch must retain every exact source field and physical FTS page');
      assert.deepEqual(await readCheckpoint(adapters[1], COPY_CHECKPOINT), checkpointBefore);
      assert.deepEqual(adapters[0].trace.slice(sourceTraceStart).filter(({ sql }) => sql && isWrite(sql)), [],
        'no source ACK or fence write may follow rejected independent full-byte evidence');
      assert.deepEqual(account.snapshot(), beforeAccount);
      assert.equal(account.deleted.length, 3);
    });
  }
});

test('scratch double failure preserves the primary diagnostic and attempts every safe owned cleanup', async (context) => {
  const canary = 'PRIVATE_DOUBLE_FAILURE_CANARY';
  for (const failingOperation of ['identity', 'delete']) {
    await context.test(failingOperation, async () => {
      let cleanupEnabled = false;
      const identities = [];
      const deletions = [];
      const account = scratchAccount(standingScratchResources(), {
        identity(database) {
          if (cleanupEnabled) {
            identities.push(database.uuid);
            if (failingOperation === 'identity' && database.name === scratchNames[0]) {
              throw new Error(`${canary} identity provider body`);
            }
          }
          return database;
        },
        beforeDelete(database) {
          deletions.push(database.uuid);
          if (failingOperation === 'delete' && database.name === scratchNames[0]) {
            throw new Error(`${canary} deletion provider body`);
          }
        },
      });
      const before = account.snapshot();
      await assert.rejects(allocateScratch(account, async () => {
        cleanupEnabled = true;
        throw Object.assign(new Error(`${canary} SQL/parameter/provider bytes`), {
          d1Phase: 'copy-page-write', d1SqlReason: 'capacity', d1FailureKind: 'statement', cause: new Error(canary),
        });
      }), (error) => {
        assert.equal(error.nativeCopyPhase, 'copy-page-write', 'cleanup must not replace the first semantic phase');
        assert.equal(error.nativeCopyClass, 'capacity');
        assert.equal(error.nativeCopyFailureKind, 'statement');
        assert.equal(error.nativeCopyCleanup, 'failed');
        assert.equal(error.nativeCopyCleanupClass, 'other');
        assert.match(error.message, /cleanup=failed cleanupClass=other/);
        assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(canary));
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.deepEqual(identities, account.created.map(({ uuid }) => uuid));
      assert.deepEqual(deletions, account.created.slice(failingOperation === 'identity' ? 1 : 0).map(({ uuid }) => uuid));
      assert.deepEqual(account.deleted, account.created.slice(1));
      assert.deepEqual(account.snapshot(), [...before, account.created[0]].sort((a, b) => a.uuid.localeCompare(b.uuid)));
    });
  }
});

test('scratch unknown failure fields cannot become public diagnostic identities', async () => {
  const canary = 'PRIVATE_UNKNOWN_FAILURE_CANARY';
  const account = scratchAccount(standingScratchResources());
  const before = account.snapshot();
  await assert.rejects(allocateScratch(account, async () => {
    throw Object.assign(new Error(canary), { d1Phase: canary, d1SqlReason: canary, code: canary });
  }), (error) => {
    assert.equal(error.nativeCopyPhase, 'control');
    assert.equal(error.nativeCopyClass, 'other');
    assert.equal(error.nativeCopyInvariant, undefined);
    assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(canary));
    return true;
  });
  assert.deepEqual(account.snapshot(), before);
});

test('copier invariant codes identify physical FTS and SHA failures and an incomplete committed delete response', async (context) => {
  for (const [fault, code, phase] of [
    ['fts', 'fts-match', 'copy-fts-match'],
    ['sha', 'readback-sha256', 'copy-page-readback'],
    ['delete-response', 'source-delete', 'copy-source-delete-and-freeze'],
  ]) {
    await context.test(fault, async (child) => {
      const f = await fixture(child);
      const original = block(51_001, 0);
      seedBlocks(f.source, [original]);
      let mutated = false;
      if (fault === 'delete-response') {
        const batch = f.source.batch.bind(f.source);
        f.source.batch = async (statements) => {
          const results = await batch(statements);
          if (statements.some(({ sql }) => /\bDELETE FROM blocks\b/.test(sql))) {
            mutated = true;
            return results.slice(0, -1);
          }
          return results;
        };
      } else {
        f.shards[0].afterBatch = ({ statements, committed }) => {
          if (!statements.some(({ sql }) => /^INSERT INTO blocks \(/.test(sql))) return;
          assert.equal(committed, true);
          mutated = true;
          if (fault === 'fts') {
            f.shards[0].database.exec("INSERT INTO blocks_fts (blocks_fts, rowid, text) SELECT 'delete', id, text FROM blocks");
          } else {
            f.shards[0].database.prepare('UPDATE blocks SET tool_name = ?').run('PRIVATE_INVARIANT_CANARY');
          }
        };
      }
      await assert.rejects(copyWithNativeParameters(f.args()), (error) => {
        assert.equal(error.code, code);
        assert.equal(error.d1Phase, phase);
        assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes('PRIVATE_INVARIANT_CANARY'));
        return true;
      });
      assert.equal(mutated, true);
      assert.deepEqual(f.source.rows('SELECT * FROM blocks'), fault === 'delete-response' ? [] : [original]);
      const state = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
      assert.equal(state.rows, 0);
      assert.equal(state.pending.phase, fault === 'delete-response' ? 'verified' : 'copying');
      if (fault === 'delete-response') {
        assert.deepEqual(f.source.rows(`SELECT state FROM ${SOURCE_FREEZE_TABLE}`), [{ state: 'frozen' }]);
      }
    });
  }
});

test('native proof preserves copier assertion identity from real schema, FTS and full-row SHA failures', async (context) => {
  for (const [fault, invariant, phase] of [
    ['schema', 'schema-columns', 'copy-setup'],
    ['fts', 'fts-match', 'copy-fts-match'],
    ['sha', 'readback-sha256', 'copy-page-readback'],
    ['sha-cleanup', 'readback-sha256', 'copy-page-readback'],
  ]) {
    await context.test(fault, async (child) => {
      const cleanupAttempts = [];
      const { account, adapters, proof } = await nativeScratchFixture(child, {
        beforeDelete(database) {
          cleanupAttempts.push(database.uuid);
          if (fault === 'sha-cleanup' && /-source$/.test(database.name)) {
            throw new Error('PRIVATE_SCHEMA_CANARY cleanup provider body');
          }
        },
      });
      const before = account.snapshot();
      let mutated = false;
      const applySchema = proof.applySchema;
      proof.applySchema = async (databases) => {
        await applySchema(databases);
        const shard = databases.shards[0];
        if (fault === 'schema') {
          shard.database.exec('ALTER TABLE blocks ADD COLUMN PRIVATE_SCHEMA_CANARY TEXT');
          mutated = true;
        } else {
          shard.afterBatch = ({ statements, committed }) => {
            if (!statements.some(({ sql }) => /^INSERT INTO blocks \(/.test(sql))) return;
            assert.equal(committed, true);
            mutated = true;
            if (fault === 'fts') {
              shard.database.exec("INSERT INTO blocks_fts (blocks_fts, rowid, text) SELECT 'delete', id, text FROM blocks");
            } else {
              shard.database.prepare('UPDATE blocks SET tool_name = ?').run('PRIVATE_SCHEMA_CANARY');
            }
          };
        }
      };
      await assert.rejects(verifyNativeCopyControl(proof), (error) => {
        assert.equal(error.nativeCopyPhase, phase);
        assert.equal(error.nativeCopyClass, 'assertion');
        assert.equal(error.nativeCopyInvariant, invariant);
        if (fault === 'sha-cleanup') {
          assert.equal(error.nativeCopyCleanup, 'failed');
          assert.equal(error.nativeCopyCleanupClass, 'other');
        }
        assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes('PRIVATE_SCHEMA_CANARY'));
        return true;
      });
      assert.equal(mutated, true);
      const seed = adapters[0].trace.find(({ kind }) => kind === 'batch');
      const seededRows = seed.statements.filter(({ sql }) => /^INSERT INTO blocks \(/.test(sql))
        .reduce((count, { params }) => count + (params.length === 1 ? JSON.parse(params[0]).length : 1), 0);
      assert.deepEqual(adapters[0].rows('SELECT COUNT(*) AS rows FROM blocks'), [{ rows: seededRows }]);
      assert.deepEqual(cleanupAttempts, account.created.map(({ uuid }) => uuid));
      assert.deepEqual(account.snapshot(), fault === 'sha-cleanup'
        ? [...before, account.created[0]].sort((a, b) => a.uuid.localeCompare(b.uuid)) : before);
      assert.equal(account.deleted.length, fault === 'sha-cleanup' ? 2 : 3);
    });
  }
});

test('shared copier transport invariants preserve source and destination readback phases across real SQLite pages', async (context) => {
  const canary = 'PRIVATE_PHASE_TRANSPORT_CANARY';
  for (const side of ['source-initial', 'source-pending', 'destination']) {
    for (const invariant of ['row-identity', 'long-column', 'long-length', 'long-slice', 'changed-slice', 'value', 'number']) {
      await context.test(`${side} ${invariant}`, async (child) => {
        const f = await fixture(child);
        const original = block(61_001, 0, { text: `\ufeff${canary} ${'α😀'.repeat(30_000)}\u0000suffix` });
        seedBlocks(f.source, [original]);
        const before = blockSnapshot(f.source);
        const db = side === 'destination' ? f.shards[0] : f.source;
        const marker = `__long_${BLOCK_COLUMNS.indexOf('text')}`;
        let fullReads = 0;
        let exercised = 0;
        db.transformQuery = ({ params }, rows) => {
          const fullRow = rows.some((row) => Object.hasOwn(row, marker) && BLOCK_COLUMNS.every((column) => Object.hasOwn(row, column)));
          const slice = params.length === 3 && rows.length === 1 && typeof rows[0].bytes === 'string';
          if (fullRow) fullReads += 1;
          if (exercised || side === 'source-pending' && fullReads < 2) return rows;
          if (['long-slice', 'changed-slice'].includes(invariant)) {
            if (!slice) return rows;
            assert.equal(rows.length, 1);
            assert.ok(rows[0].bytes.length > 2, 'the fault must alter a real nonempty SQLite BLOB slice');
            exercised += 1;
            return [{ bytes: invariant === 'long-slice' ? rows[0].bytes.slice(0, -2) : `EE${rows[0].bytes.slice(2)}` }];
          }
          if (!fullRow) return rows;
          assert.equal(rows.length, 1);
          assert.equal(rows[0].id, original.id);
          assert.equal(rows[0][marker], Buffer.byteLength(original.text));
          exercised += 1;
          if (invariant === 'row-identity') return [...rows, { ...rows[0] }];
          if (invariant === 'long-column') delete rows[0][marker];
          if (invariant === 'long-length') rows[0][marker] = 0;
          if (invariant === 'value') rows[0].file_id = true;
          if (invariant === 'number') rows[0].row_hash = Number.MAX_SAFE_INTEGER + 1;
          return rows;
        };
        await assert.rejects(copyWithNativeParameters(f.args()), (error) => {
          assert.equal(error.code, invariant === 'changed-slice'
            ? side === 'destination' ? 'readback-sha256' : 'source-changed'
            : invariant === 'value' && side === 'destination' ? 'readback-sha256' : invariant);
          assert.equal(error.d1Phase, side === 'destination' ? 'copy-page-readback' : 'copy-source-page-read');
          assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(canary));
          assert.equal(error.cause, undefined);
          return true;
        });
        assert.equal(exercised, 1, 'the requested genuine readback boundary must reach the corruption');
        assert.deepEqual(blockSnapshot(f.source), before, 'an invariant rejection cannot authorize source deletion or FTS mutation');
        assert.deepEqual(sourceWrites(f), []);
        assert.deepEqual(f.shards[1].rows('SELECT * FROM blocks'), []);
        const state = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
        assert.equal(state.rows, 0);
        assert.equal(state.pending?.phase ?? null,
          side === 'source-initial' && invariant !== 'changed-slice' ? null : 'copying');
        assert.deepEqual(f.shards[0].rows('SELECT * FROM blocks'), side === 'destination' ? [original] : []);
      });
    }
  }
});

test('native proof preserves source-versus-readback phase for real copier scalar and long-slice rejection', async (context) => {
  for (const side of ['source', 'destination']) {
    for (const invariant of ['value', 'long-slice']) {
      await context.test(`${side} ${invariant}`, async (child) => {
        const { account, adapters, proof } = await nativeScratchFixture(child);
        const before = account.snapshot();
        let exercised = 0;
        let authoritativeRows;
        let armedCheckpoint;
        const applySchema = proof.applySchema;
        proof.applySchema = async (databases) => {
          await applySchema(databases);
          const db = side === 'source' ? databases.source : databases.shards[invariant === 'value' ? 0 : 1];
          let copierLongIds = new Set();
          db.transformQuery = ({ params }, rows) => {
            if (exercised) return rows;
            const fullRow = rows.some((row) => Object.hasOwn(row, `__long_${BLOCK_COLUMNS.indexOf('text')}`)
              && BLOCK_COLUMNS.every((column) => Object.hasOwn(row, column)));
            if (fullRow) {
              const marker = `__long_${BLOCK_COLUMNS.indexOf('text')}`;
              copierLongIds = new Set(rows.filter((row) => row.text === null
                && Number.isSafeInteger(row[marker]) && row[marker] > 0).map(({ id }) => id));
            }
            const scalar = invariant === 'value' && fullRow;
            const slice = invariant === 'long-slice' && params.length === 3 && rows.length === 1
              && typeof rows[0].bytes === 'string' && typeof params[2] === 'string'
              && JSON.parse(params[2]).some((id) => copierLongIds.has(id));
            if (!scalar && !slice) return rows;
            // Independent seed/growth/final readers also use hex slices. Only a
            // long row observed in the copier's sized read and expected pending
            // phase may arm; a checkpoint alone is not a copier-readback oracle.
            const checkpoint = databases.shards[0].rows(
              'SELECT value FROM index_migration_state WHERE name = ?', [COPY_CHECKPOINT],
            )[0];
            if (!checkpoint) return rows;
            const state = JSON.parse(checkpoint.value);
            if (state.state !== 'pending'
              || (state.pending?.phase ?? null) !== (side === 'destination' ? 'copying' : null)) return rows;
            assert.equal(state.identity.source, databases.source.id);
            assert.equal(state.state, 'pending');
            assert.equal(state.pending?.phase ?? null, side === 'destination' ? 'copying' : null);
            authoritativeRows = databases.source.rows('SELECT * FROM blocks ORDER BY id');
            armedCheckpoint = state;
            if (scalar) {
              assert.ok(rows.length > 0, 'the scalar fault must alter a row returned by the actual copier');
              const authoritativeIds = new Set(authoritativeRows.map(({ id }) => id));
              assert.ok(rows.every(({ id }) => authoritativeIds.has(id)));
              if (side === 'destination') {
                const shard = databases.shards.indexOf(db);
                assert.deepEqual(rows.map(({ id }) => id),
                  state.pending.rows.filter((row) => row.shard === shard).map(({ id }) => id));
              }
              exercised += 1;
              rows[0].file_id = { private: 'PRIVATE_NATIVE_PHASE_CANARY' };
            } else {
              assert.equal(rows.length, 1);
              assert.ok(rows[0].bytes.length > 2);
              exercised += 1;
              rows[0].bytes = rows[0].bytes.slice(0, -2);
            }
            return rows;
          };
        };
        await assert.rejects(verifyNativeCopyControl(proof), (error) => {
          assert.equal(error.nativeCopyPhase, side === 'source' ? 'copy-source-page-read' : 'copy-page-readback');
          assert.equal(error.nativeCopyClass, 'assertion');
          assert.equal(error.nativeCopyInvariant, invariant === 'value' && side === 'destination' ? 'readback-sha256' : invariant);
          assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes('PRIVATE_NATIVE_PHASE_CANARY'));
          assert.equal(error.cause, undefined);
          return true;
        });
        assert.equal(exercised, 1);
        assert.ok(authoritativeRows.length > 0);
        assert.deepEqual(adapters[0].rows('SELECT * FROM blocks ORDER BY id'), authoritativeRows,
          'every full source row at the rejected boundary remains authoritative, including dense rows on the pending page');
        const checkpoint = await readCheckpoint(adapters[1], COPY_CHECKPOINT);
        assert.deepEqual(checkpoint, armedCheckpoint, 'rejection cannot advance or verify the durable copy checkpoint');
        assert.equal(checkpoint.pending?.phase ?? null, side === 'destination' ? 'copying' : null);
        if (invariant === 'long-slice') {
          assert.ok(checkpoint.rows > 0, 'the earlier complete ordinary page must have been verified and retired');
        } else {
          assert.equal(checkpoint.rows, 0, 'the rejected first ordinary page cannot retire any source rows');
        }
        if (checkpoint.pending) {
          const retainedIds = new Set(authoritativeRows.map(({ id }) => id));
          assert.ok(checkpoint.pending.rows.every(({ id }) => retainedIds.has(id)),
            'the entire actual durable pending page remains in the source');
        }
        assert.deepEqual(account.snapshot(), before);
        assert.deepEqual(new Set(account.deleted.map(({ uuid }) => uuid)), new Set(account.created.map(({ uuid }) => uuid)));
      });
    }
  }
});

test('real HTTP D1 failures distinguish transport, HTTP, statement and shape without retry or status spoofing', async (context) => {
  const canary = 'PRIVATE_HTTP_FAILURE_CANARY';
  const id = '95dbde60-d5ab-4e2c-989f-fcd44a3ab479';
  const originalFetch = globalThis.fetch;
  let scenario;
  const requests = [];
  let bodyDropResponse;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')), scenario });
    if (scenario.transport) { request.socket.destroy(); return; }
    response.writeHead(scenario.status ?? 200, {
      'content-type': 'application/json',
      ...(scenario.retryAfter === undefined ? {} : { 'retry-after': scenario.retryAfter }),
    });
    if (scenario.bodyTransport) {
      bodyDropResponse = response;
      response.write(canary);
      response.flushHeaders();
      return;
    }
    response.end(scenario.raw ?? JSON.stringify(scenario.envelope));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  globalThis.fetch = async (url, init) => {
    const response = await originalFetch(`${endpoint}${new URL(url).pathname}`, init);
    if (scenario.bodyTransport) {
      assert.equal(response.status, scenario.status ?? 200, 'actual headers must arrive before the server drops the body');
      bodyDropResponse.destroy();
    }
    return response;
  };
  context.after(async () => {
    globalThis.fetch = originalFetch;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const scenarios = [
    { transport: true, failure: 'transport', http: 'unknown' },
    { bodyTransport: true, failure: 'transport', http: 200 },
    { bodyTransport: true, status: 503, failure: 'transport', http: 503 },
    ...[undefined, 'invalid', '0', '1.5', '3601'].map((retryAfter) => ({
      status: 429, retryAfter, raw: canary, failure: 'http', http: 429,
    })),
    { status: 503, envelope: { success: false, errors: [{ message: canary }] }, failure: 'http', http: 503 },
    { status: 502, raw: canary, failure: 'http', http: 502 },
    { envelope: { success: false, errors: [{ message: canary }] }, failure: 'statement', http: 200 },
    { envelope: { success: true, result: [{ success: false, error: canary }] }, failure: 'statement', http: 200 },
    { raw: canary, failure: 'shape', http: 200 },
    { envelope: { success: true }, failure: 'shape', http: 200 },
    { envelope: { success: true, result: {} }, failure: 'shape', http: 200 },
    { envelope: { success: true, result: [] }, failure: 'shape', http: 200 },
    { envelope: { success: true, result: [{ success: true }] }, failure: 'shape', http: 200 },
    { envelope: { success: true, result: [{ success: true, results: {} }] }, failure: 'shape', http: 200 },
    { envelope: { success: true, result: [{ success: true, results: [] }, { success: true, results: [] }] }, failure: 'shape', http: 200 },
    { envelope: { success: true, actualHTTPstatus: 599, result: [{ success: false, error: canary }] }, failure: 'statement', http: 200 },
  ];
  for (const [index, selected] of scenarios.entries()) {
    await context.test(`${index}: ${selected.bodyTransport ? 'body-drop ' : ''}${selected.failure} HTTP=${selected.http}`, async () => {
      scenario = selected;
      const before = requests.length;
      const db = diagnosticClient(PREVIEW_ACCOUNT_ID, 'private-token', { permit: async () => {},
        wait: async () => assert.fail('these terminal errors must not retry') }).db(id);
      await assert.rejects(db.query(canary, [canary]), (error) => {
        assert.equal(error.d1FailureKind, scenario.failure);
        assert.equal(error.d1SqlReason, 'other', 'private/unrecognized provider text cannot invent a native class');
        assert.equal(error.providerStatus, scenario.http === 'unknown' ? undefined : scenario.http,
          'typed HTTP evidence must use the actual response, never an envelope status field');
        assert.deepEqual(error.providerCodes, []);
        assert.equal(error.d1NativeSignature, undefined);
        assert.ok(error.message.includes(`failure=${scenario.failure}`));
        assert.ok(error.message.includes(`HTTP=${scenario.http}`));
        assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(canary));
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(requests.length - before, 1, 'no ambiguous operation may be replayed');
      assert.deepEqual(requests.at(-1).body, { sql: canary, params: [canary] });
    });
  }
});

test('real HTTP scratch inventory, create, identity and cleanup failures retain allowlisted client kinds without replay or foreign mutation', async (context) => {
  const canary = 'PRIVATE_SCRATCH_HTTP_CANARY';
  const token = 'private-scratch-token';
  const originalFetch = globalThis.fetch;
  let arm;
  let resources;
  let created;
  let deleted;
  let faultReached;
  let bodyDropResponse;
  const requests = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const pathname = new URL(request.url, 'http://scratch.fixture').pathname;
    const target = pathname.slice(`/client/v4/accounts/${PREVIEW_ACCOUNT_ID}/d1/database`.length);
    const uuid = target.split('/')[1];
    const operation = target.endsWith('/query') ? 'query'
      : !target ? request.method === 'POST' ? 'create' : 'inventory'
        : request.method === 'DELETE' ? 'delete' : 'identity';
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    requests.push({ operation, uuid, body });
    if (operation === 'query') {
      assert.ok(arm.secondaryCleanup && resources.has(uuid));
      assert.deepEqual(body, { sql: canary, params: [canary] });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ success: false, errors: [{ message: `SQLITE_FULL ${canary}` }] }));
      return;
    }
    if (!faultReached && operation === arm.operation
      && (!['identity', 'delete'].includes(operation) || uuid === 'scratch-http-1')) {
      faultReached = true;
      if (arm.failure === 'transport' && !arm.bodyTransport) { request.socket.destroy(); return; }
      response.writeHead(arm.status ?? 200, { 'content-type': 'application/json' });
      if (arm.bodyTransport) {
        bodyDropResponse = response;
        response.write(canary);
        response.flushHeaders();
      } else {
        response.end(arm.failure === 'shape' ? canary
          : JSON.stringify({ success: false, actualHTTPstatus: 599, errors: [{ message: canary }] }));
      }
      return;
    }
    let result;
    if (operation === 'inventory') result = [...resources.values()];
    else if (operation === 'create') {
      const database = { uuid: `scratch-http-${created.length + 1}`, name: body.name };
      assert.ok(scratchNames.includes(database.name));
      resources.set(database.uuid, database);
      created.push(database);
      result = database;
    } else if (operation === 'identity') {
      assert.ok(resources.has(uuid));
      result = resources.get(uuid);
    } else {
      assert.equal(operation, 'delete');
      assert.ok(created.some((database) => database.uuid === uuid), 'only identities actually returned by this invocation may be deleted');
      assert.ok(resources.delete(uuid));
      deleted.push(uuid);
      result = {};
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ success: true, result, ...(operation === 'inventory'
      ? { result_info: { total_count: result.length } } : {}) }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  globalThis.fetch = async (url, init) => {
    const response = await originalFetch(`${endpoint}${new URL(url).pathname}`, init);
    if (bodyDropResponse) {
      assert.equal(response.status, 200, 'body transport loss must follow actual HTTP headers');
      bodyDropResponse.destroy();
      bodyDropResponse = null;
    }
    return response;
  };
  context.after(async () => {
    globalThis.fetch = originalFetch;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  for (const operation of ['inventory', 'create', 'identity', 'delete', 'secondary-delete']) {
    for (const fault of [
      { failure: 'transport' }, { failure: 'transport', bodyTransport: true },
      { failure: 'http', status: 403 }, { failure: 'http', status: 404 },
      { failure: 'http', status: 429 }, { failure: 'statement' }, { failure: 'shape' },
    ]) {
      await context.test(`${operation} ${fault.failure} ${fault.status ?? (fault.bodyTransport ? 'body' : '')}`, async () => {
        arm = { ...fault, operation: operation === 'secondary-delete' ? 'delete' : operation,
          secondaryCleanup: operation === 'secondary-delete' };
        resources = new Map(standingScratchResources().map((database) => [database.uuid, database]));
        const before = [...resources.values()];
        created = [];
        deleted = [];
        faultReached = false;
        requests.length = 0;
        let entered = false;
        const api = diagnosticClient(PREVIEW_ACCOUNT_ID, token, {
          permit: async () => {}, wait: async () => assert.fail('terminal CF failures must not retry'),
        });
        await assert.rejects(withScratchD1Databases({ api, pr: 42, nonce: scratchNonce, run: async ({ source }) => {
          entered = true;
          if (arm.secondaryCleanup) await source.query(canary, [canary]);
          return 'successful work';
        } }), (error) => {
          assert.equal(error.nativeCopyPhase, arm.secondaryCleanup ? 'control'
            : { inventory: 'preflight', create: 'create', identity: 'identity', delete: 'cleanup' }[arm.operation]);
          assert.equal(error.nativeCopyClass, arm.secondaryCleanup ? 'capacity' : 'other',
            'HTTP 404 is not an inventory-shape error, empty inventory or successful deletion');
          assert.equal(error.nativeCopyFailureKind, arm.secondaryCleanup ? 'statement' : arm.failure);
          if (arm.secondaryCleanup) {
            assert.equal(error.nativeCopyCleanup, 'failed');
            assert.equal(error.nativeCopyCleanupClass, 'other');
            assert.equal(error.nativeCopyCleanupFailureKind, arm.failure);
            assert.ok(error.message.includes(`cleanupFailure=${arm.failure}`));
          }
          assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(canary));
          assert.equal(error.cause, undefined);
          return true;
        });
        assert.equal(faultReached, true);
        assert.equal(entered, arm.operation === 'delete');
        assert.equal(requests.filter((request) => request.operation === arm.operation).length,
          arm.operation === 'identity' ? 4 : arm.operation === 'delete' ? 3 : 1,
          'one terminal failure is not replayed; separate safe cleanup still visits each owned identity');
        assert.equal(requests.filter((request) => request.operation === 'create').length,
          arm.operation === 'inventory' ? 0 : arm.operation === 'create' ? 1 : 3);
        assert.deepEqual(deleted, arm.operation === 'identity' ? created.map(({ uuid }) => uuid)
          : arm.operation === 'delete' ? created.slice(1).map(({ uuid }) => uuid) : []);
        assert.deepEqual([...resources.values()], arm.operation === 'delete' ? [...before, created[0]] : before,
          'failed/refused cleanup may leave only its known owned database; every standing and foreign identity remains unchanged');
      });
    }
  }
});

// These fixtures contain public synthetic bytes only. INDEX_COPY_MODULE_PATH
// runs the same consumer assertions against an exact historical core revision.
const PUBLIC_INVALID_TEXT = Buffer.from('efbbbf2061ff62206162f09f98636400656e64', 'hex');
const PUBLIC_RAW_COLUMNS = ['role', 'btype', 'tool_name', 'ts', 'text', 'media_type'];

async function seedPublicRawBlocks(db, rows, cells, { frozen = false } = {}) {
  const ids = JSON.stringify(rows.map((row) => row.id));
  const statements = frozen ? [{ sql: `UPDATE ${SOURCE_FREEZE_TABLE} SET state = 'copying' WHERE id = 1`, params: [] }] : [];
  statements.push({ sql: `INSERT INTO blocks (${BLOCK_COLUMNS.map(quoted).join(',')})
    SELECT ${BLOCK_COLUMNS.map((_, index) => `json_extract(value,'$[${index}]')`).join(',')} FROM json_each(?)`,
  params: [JSON.stringify(rows.map((row) => BLOCK_COLUMNS.map((column) => row[column])))] });
  for (const [id, values] of cells) for (const [column, bytes] of Object.entries(values)) {
    // The fixture's bind is deliberately smaller than D1's scalar-string cap;
    // the copier must discover/reconstruct its own independent read/write chunks.
    statements.push({ sql: `UPDATE blocks SET ${quoted(column)} = CAST(unhex(?) AS TEXT) WHERE id = ?`,
      params: [bytes.toString('hex'), id] });
  }
  statements.push({ sql: `INSERT INTO blocks_fts (rowid, text)
    SELECT id, text FROM blocks WHERE id IN (SELECT value FROM json_each(?))`, params: [ids] });
  if (frozen) statements.push({ sql: `UPDATE ${SOURCE_FREEZE_TABLE} SET state = 'frozen' WHERE id = 1`, params: [] });
  await db.batch(statements);
}

async function publicRawSnapshot(db, columns = BLOCK_COLUMNS) {
  return db.rows(`SELECT ${columns.flatMap((column, index) => [
    `typeof(${quoted(column)}) AS ${quoted(`t${index}`)}`,
    `CASE WHEN typeof(${quoted(column)}) = 'text' THEN hex(CAST(${quoted(column)} AS BLOB))
      ELSE ${quoted(column)} END AS ${quoted(`v${index}`)}`,
  ]).join(',')} FROM blocks ORDER BY id`);
}

async function assertPublicRawFts(db, row, bytes) {
  const [{ sql }] = await db.rows("SELECT sql FROM sqlite_master WHERE name = 'blocks_fts'");
  const oracle = new DatabaseSync(':memory:');
  try {
    oracle.exec('CREATE TABLE blocks(id INTEGER PRIMARY KEY,text TEXT)');
    oracle.exec(sql);
    oracle.exec("CREATE VIRTUAL TABLE public_raw_terms USING fts5vocab(blocks_fts, 'instance')");
    const insert = oracle.prepare('INSERT INTO blocks_fts (rowid,text) VALUES (1,CAST(? AS TEXT))');
    const terms = () => oracle.prepare('SELECT DISTINCT hex(CAST(term AS BLOB)) AS h FROM public_raw_terms ORDER BY h').all().map(({ h }) => h);
    insert.run(bytes);
    const raw = terms();
    oracle.exec("INSERT INTO blocks_fts(blocks_fts) VALUES ('delete-all')");
    insert.run(Buffer.from(bytes.toString('utf8')));
    const replacementOnly = terms().filter((hex) => !raw.includes(hex));
    for (const [set, present] of [[raw, true], [replacementOnly, false]]) for (const hex of set) {
      const term = Buffer.from(hex, 'hex').toString('latin1');
      const phrase = Buffer.from(`"${term.replaceAll('"', '""')}"`, 'latin1').toString('hex');
      assert.deepEqual(await db.rows(`SELECT rowid FROM blocks_fts
        WHERE blocks_fts MATCH CAST(unhex(?) AS TEXT) AND rowid = CAST(? AS INTEGER)`, [phrase, row.id]),
      present ? [{ rowid: row.id }] : [], 'physical FTS must index original bytes, never replacement-rendering-only terms');
    }
    assert.ok(raw.length > 0);
  } finally { oracle.close(); }
}

test('canonical raw TEXT tags are unambiguous and leave every valid scalar digest unchanged', () => {
  for (const value of [null, '', '\ufeffbom\u0000suffix', '会話😀', 0, -1, 1.5]) {
    assert.equal(canonicalRow(['v'], { v: value }), JSON.stringify([value]));
    assert.equal(rowDigest(['v'], { v: value }), sha256(JSON.stringify([value])));
  }
  assert.equal(canonicalRow(['v'], { v: { x: 'ff' } }), '[{"x":"ff"}]');
  for (const value of [{}, [], { x: '' }, { x: 'f' }, { x: 'FF' }, { x: '00' }, { x: 'efbbbf' },
    { x: 'ff', extra: 1 }, { r: 1 }, Object.assign(Object.create({ extra: 1 }), { x: 'ff' })]) {
    assert.throws(() => canonicalRow(['v'], { v: value }), /unsupported|noncanonical/);
  }
});

for (const [backend, createFixture] of [['SQLite', fixture], ['workerd', workerdFixture]]) {
  test(`byte-exact ${backend} copier retains valid UTF-8 session identity bytes, routing and scalar hashes`, async (context) => {
    const f = await createFixture(context);
    const rows = PUBLIC_SESSION_IDS.map((session_id, index) =>
      block(92_001 + index, 0, { session_id, text: `publicidentityneedle_${index}` }));
    const homes = new Map(rows.map((row) => {
      let hash = 0x811c9dc5;
      for (const byte of Buffer.from(row.session_id)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
      for (const count of [2, 16]) assert.equal(indexShardForSessionId(row.session_id, count), hash % count);
      return [row.id, hash % 2];
    }));
    await seedPublicRawBlocks(f.source, rows, new Map());
    const before = await publicRawSnapshot(f.source), sourceFts = await storedBlockSnapshot(f.source);
    let verified = 0;
    const result = await copyWithNativeParameters(f.args({ checkpointHook: async (state) => {
      if (state.pending?.phase !== 'verified') return;
      verified += state.pending.rows.length;
      const remaining = await publicRawSnapshot(f.source);
      for (const item of state.pending.rows) {
        const original = rows.find((row) => row.id === item.id);
        const expected = before.find((row) => row.v0 === item.id);
        assert.equal(item.shard, homes.get(item.id));
        assert.equal(item.sha256, sha256(JSON.stringify(BLOCK_COLUMNS.map((column) => original[column]))));
        assert.deepEqual(remaining.find((row) => row.v0 === item.id), expected);
        assert.deepEqual((await publicRawSnapshot(f.shards[item.shard])).find((row) => row.v0 === item.id), expected);
        assert.equal(expected.v1, Buffer.from(original.session_id).toString('hex').toUpperCase());
        assert.deepEqual(await f.shards[item.shard].rows(`SELECT rowid FROM blocks_fts
          WHERE blocks_fts MATCH ? AND rowid = CAST(? AS INTEGER)`, [`"${original.text}"`, item.id]), [{ rowid: item.id }]);
      }
    } }));
    assert.equal(result.state, 'complete');
    assert.equal(verified, rows.length);
    const after = await storedBlockSnapshot(f.source);
    assert.deepEqual(after.blocks, []);
    assert.deepEqual(after.ftsData, sourceFts.ftsData);
    assert.deepEqual(after.ftsIndex, sourceFts.ftsIndex);
    for (let shard = 0; shard < f.shards.length; shard += 1) {
      assert.deepEqual(await f.shards[shard].rows('SELECT * FROM blocks ORDER BY id'), rows.filter((row) => homes.get(row.id) === shard));
    }
  });

  test(`byte-exact ${backend} REAL transport expansion preserves logical checkpoints and atomic multi-group source CAS`, async (context) => {
    const f = await createFixture(context);
    for (const db of [f.source, ...f.shards]) {
      const sql = 'ALTER TABLE blocks ADD COLUMN future_real REAL';
      if (db instanceof SqliteD1) db.database.exec(sql);
      else await db.batch([{ sql, params: [] }]);
    }
    const columns = [...BLOCK_COLUMNS, 'future_real'];
    const tail = Buffer.concat([Buffer.alloc(720, 0x61), Buffer.from([0xff]), Buffer.from(' tail')]);
    const rows = nativeDenseRows(1100);
    const originals = new Map(rows.map((row) => [row.id, { ...row, future_real: 1,
      text: { x: Buffer.concat([Buffer.from(`realexpand${row.id} `), tail]).toString('hex') } }]));
    await f.source.batch([
      { sql: `INSERT INTO blocks (${BLOCK_COLUMNS.map(quoted).join(',')})
        SELECT ${BLOCK_COLUMNS.map((_, index) => `json_extract(value,'$[${index}]')`).join(',')} FROM json_each(?)`,
      params: [JSON.stringify(rows.map((row) => BLOCK_COLUMNS.map((column) => row[column])))] },
      { sql: `UPDATE blocks SET future_real=CAST(1 AS REAL),
        text='realexpand'||id||' '||CAST(unhex(?) AS TEXT)`, params: [tail.toString('hex')] },
      { sql: 'INSERT INTO blocks_fts(rowid,text) SELECT id,text FROM blocks', params: [] },
    ]);
    const before = await publicRawSnapshot(f.source, columns), sourceFts = await storedBlockSnapshot(f.source);
    assert.ok(before.every((row) => row.t18 === 'real' && row.v18 === 1));
    f.trace.length = 0;
    const copyingStop = new Error('public copying checkpoint boundary');
    await assert.rejects(copyWithNativeParameters(f.args({ checkpointHook: (state) => {
      if (state.pending?.phase === 'copying') throw copyingStop;
    } })), (error) => error === copyingStop);
    const copying = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
    const originalPage = copying.pending.rows.map(({ id }) => originals.get(id));
    const canonicalBytes = Buffer.byteLength(JSON.stringify(originalPage.map((row) => columns.map((column) => row[column]))));
    const typedBytes = Buffer.byteLength(JSON.stringify(originalPage.map((row) => columns.map((column) =>
      column === 'future_real' ? { r: row[column] } : row[column]))));
    assert.ok(canonicalBytes <= COPY_PAGE_BYTES && typedBytes > COPY_PAGE_BYTES,
      'actual native malformed-TEXT expansion must fill a valid canonical page whose REAL wrappers cross the transport cap');
    for (const item of copying.pending.rows) {
      assert.equal(item.sha256, sha256(JSON.stringify(columns.map((column) => originals.get(item.id)[column]))));
    }
    const verifiedStop = new Error('public verified checkpoint boundary');
    await assert.rejects(copyWithNativeParameters(f.args({ checkpointHook: (state) => {
      if (state.pending?.phase === 'verified') throw verifiedStop;
    } })), (error) => error === verifiedStop);
    const verified = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
    assert.deepEqual(verified.pending.rows, copying.pending.rows, 'transport groups cannot trim or rehash a durable logical page');
    assert.deepEqual(verified.pending.types, copying.pending.types);
    assert.deepEqual(await publicRawSnapshot(f.source, columns), before);
    const pendingIds = new Set(verified.pending.rows.map(({ id }) => id));
    const destination = await publicRawSnapshot(f.shards[1], columns), destinationFts = await storedBlockSnapshot(f.shards[1]);
    assert.deepEqual(destination, before.filter((row) => pendingIds.has(row.v0)));
    const nativeBatch = f.source.batch.bind(f.source);
    const lateId = verified.pending.rows.at(-1).id;
    let groups, changed, provisionallyDeleted = false;
    if (f.source instanceof SqliteD1) f.source.afterStatement = ({ sql }) => {
      if (provisionallyDeleted || !/\bDELETE\s+FROM\s+blocks\b/i.test(sql)) return;
      const remaining = new Set(f.source.rows('SELECT id FROM blocks').map(({ id }) => id));
      assert.ok(groups[0].every((id) => !remaining.has(id)), 'the first native subgroup must execute before the later CAS fails');
      provisionallyDeleted = true;
    };
    f.source.batch = async (statements) => {
      const deletes = statements.filter(({ sql }) => /\bDELETE\s+FROM\s+blocks\b/i.test(sql));
      if (!changed && deletes.length) {
        groups = deletes.map(({ params }) => JSON.parse(params[0]).map((row) => row[0]));
        assert.ok(groups.length > 1, 'source CAS must split actual typed transport, not fail or drop the overflow rows');
        assert.deepEqual(groups.flat(), verified.pending.rows.map(({ id }) => id));
        assert.ok(!groups[0].includes(lateId) && groups.at(-1).includes(lateId));
        for (const { params } of deletes) assert.ok(Buffer.byteLength(params[0]) <= COPY_PAGE_BYTES);
        await f.source.query('UPDATE blocks SET future_real=CAST(2 AS REAL) WHERE id=CAST(? AS INTEGER)', [lateId]);
        changed = await publicRawSnapshot(f.source, columns);
        assert.deepEqual(changed, before.map((row) => row.v0 === lateId ? { ...row, v18: 2 } : row));
      }
      return nativeBatch(statements);
    };
    await assert.rejects(copyWithNativeParameters(f.args()));
    f.source.batch = nativeBatch;
    f.source.afterStatement = null;
    assert.ok(changed, 'a later-group row must really change after durable verification');
    if (f.source instanceof SqliteD1) assert.equal(provisionallyDeleted, true);
    assert.deepEqual(await publicRawSnapshot(f.source, columns), changed,
      'a failed later CAS must roll back every earlier subgroup deletion');
    assert.deepEqual(await readCheckpoint(f.shards[0], COPY_CHECKPOINT), verified);
    assert.deepEqual(await f.source.rows('SELECT name FROM sqlite_master WHERE name=?', [SOURCE_FREEZE_TABLE]), [],
      'no first-page freeze may commit after partial subgroup retirement');
    const failed = f.trace.find((event) => event.db === f.source.id && event.kind === 'batch'
      && event.statements.some(({ sql }) => /\bDELETE\s+FROM\s+blocks\b/i.test(sql)));
    assert.equal(failed.committed, false);
    assert.deepEqual(await publicRawSnapshot(f.shards[1], columns), destination);
    const afterFailureFts = await storedBlockSnapshot(f.shards[1]);
    assert.deepEqual(afterFailureFts.ftsData, destinationFts.ftsData);
    assert.deepEqual(afterFailureFts.ftsIndex, destinationFts.ftsIndex);
    await f.source.query('UPDATE blocks SET future_real=CAST(1 AS REAL) WHERE id=CAST(? AS INTEGER)', [lateId]);
    const pages = [verified.pending.rows];
    const result = await copyWithNativeParameters(f.args({ checkpointHook: (state) => {
      if (state.pending?.phase !== 'copying') return;
      for (const item of state.pending.rows) {
        assert.equal(item.sha256, sha256(JSON.stringify(columns.map((column) => originals.get(item.id)[column]))));
      }
      pages.push(state.pending.rows);
    } }));
    assert.equal(result.state, 'complete');
    assert.equal(result.rows, rows.length);
    assert.equal(result.after, rows.at(-1).id);
    assert.equal(result.sha256, pages.reduce((chain, page) => sha256(`${chain}:${JSON.stringify(page)}`), sha256('')),
      'retired-prefix chaining uses each original full logical page, not typed subgroups');
    assert.deepEqual(await publicRawSnapshot(f.source, columns), []);
    assert.deepEqual(await publicRawSnapshot(f.shards[1], columns), before);
    assert.deepEqual(await publicRawSnapshot(f.shards[0], columns), []);
    for (const id of [rows[0].id, rows.at(-1).id]) {
      await assertPublicRawFts(f.shards[1], { id }, Buffer.from(originals.get(id).text.x, 'hex'));
    }
    const after = await storedBlockSnapshot(f.source);
    assert.deepEqual(after.ftsData, sourceFts.ftsData);
    assert.deepEqual(after.ftsIndex, sourceFts.ftsIndex);
    for (const event of f.trace) {
      if (event.kind === 'batch' || event.kind === 'query') {
        const request = event.kind === 'batch' ? event.statements : { sql: event.sql, params: event.params };
        assert.ok(Buffer.byteLength(JSON.stringify(request)) + 4096 <= 4 * 1024 * 1024);
      }
      if (event.kind === 'batch-statement' || event.kind === 'query') {
        assert.ok(event.params.length <= 100);
        assert.ok(Buffer.byteLength(event.sql) <= 100_000);
        assert.ok(event.params.every((value) => typeof value !== 'string' || Buffer.byteLength(value) <= 2_000_000));
      }
    }
  });

  test(`byte-exact ${backend} copier preserves short and sliced malformed TEXT in every scalar text column and exact FTS`, async (context) => {
    const f = await createFixture(context);
    for (const db of [f.source, ...f.shards]) {
      const changes = ['ALTER TABLE blocks ADD COLUMN public_extra TEXT', 'ALTER TABLE blocks ADD COLUMN public_any ANY'];
      if (db instanceof SqliteD1) for (const sql of changes) db.database.exec(sql);
      else await db.batch(changes.map((sql) => ({ sql, params: [] })));
    }
    const columns = [...BLOCK_COLUMNS, 'public_extra', 'public_any'];
    const long = Buffer.concat([Buffer.from('\ufeffpubliclong a'), Buffer.from([0xff]),
      Buffer.alloc(180_000, 0x20), Buffer.from('ab'), Buffer.from([0xf0, 0x9f, 0x98]), Buffer.from('cd\u0000tail')]);
    const rows = [block(90_001, 1, { text: 'public valid\u0000tail' }), block(90_002, 0)];
    const cells = new Map(rows.map((row, index) => [row.id,
      Object.fromEntries([...PUBLIC_RAW_COLUMNS, 'public_extra'].map((column) =>
        [column, index === 1 ? long : PUBLIC_INVALID_TEXT]))]));
    await seedPublicRawBlocks(f.source, rows, cells);
    await f.source.query('UPDATE blocks SET public_any = CAST(1 AS REAL)');
    const before = await publicRawSnapshot(f.source, columns);
    let verified = 0;
    const result = await copyWithNativeParameters(f.args({ checkpointHook: async (state) => {
      if (state.pending?.phase !== 'verified') return;
      verified += state.pending.rows.length;
      assert.deepEqual(await publicRawSnapshot(f.source, columns), before.filter((row) =>
        state.pending.rows.some((item) => item.id === row.v0) || row.v0 > state.pending.rows.at(-1).id));
      for (const item of state.pending.rows) {
        const expected = before.find((row) => row.v0 === item.id);
        const stored = (await publicRawSnapshot(f.shards[item.shard], columns)).find((row) => row.v0 === item.id);
        assert.deepEqual(stored, expected);
        await assertPublicRawFts(f.shards[item.shard], { id: item.id }, cells.get(item.id).text);
      }
    } }));
    assert.equal(result.state, 'complete');
    assert.equal(verified, 2);
    assert.equal((await publicRawSnapshot(f.source, columns)).length, 0);
    for (const db of f.shards) for (const row of await publicRawSnapshot(db, columns)) {
      assert.deepEqual(row, before.find((item) => item.v0 === row.v0));
    }
    for (const event of f.trace.filter((event) => event.kind === 'batch-statement')) {
      assert.ok(event.params.length <= 100);
      assert.ok(Buffer.byteLength(event.sql) <= 100_000);
      assert.ok(event.params.every((value) => typeof value !== 'string' || Buffer.byteLength(value) <= 2_000_000));
    }
  });
}

async function publicLegacyPending(context, createFixture, { count = 420, phase = 'verified' } = {}) {
  const f = await createFixture(context);
  const prefixRows = [block(7, 0), block(8, 1), block(9, 0)];
  await seedPublicRawBlocks(f.source, prefixRows, new Map());
  const prefix = await copyFrozenIndex(f.args());
  const rows = Array.from({ length: count }, (_, index) => block(1001 + index, index % 2,
    { text: index === 2 ? '\ufeffpublic valid\u0000suffix' : `public_pending_${index}` }));
  const cells = new Map([[rows[0].id, { text: PUBLIC_INVALID_TEXT }],
    [rows[1].id, { tool_name: PUBLIC_INVALID_TEXT }]]);
  await seedPublicRawBlocks(f.source, rows, cells, { frozen: true });
  const legacyRows = await f.source.rows('SELECT * FROM blocks ORDER BY id');
  for (let shard = 0; shard < f.shards.length; shard += 1) {
    await seedPublicRawBlocks(f.shards[shard], legacyRows.filter((row) => indexShardForSessionId(row.session_id, 2) === shard), new Map());
  }
  const pendingRows = legacyRows.map((row) => ({ id: row.id, shard: indexShardForSessionId(row.session_id, 2),
    sha256: rowDigest(BLOCK_COLUMNS, row) }));
  const state = { ...prefix, state: 'pending', pending: { phase, rows: pendingRows } };
  delete state.encoding;
  await writeCheckpoint(f.shards[0], COPY_CHECKPOINT, state);
  const exactRows = rows.map((row) => ({ ...row, ...Object.fromEntries(Object.entries(cells.get(row.id) ?? {})
    .map(([column, bytes]) => [column, { x: bytes.toString('hex') }])) }));
  return Object.assign(f, { prefix, legacy: state, rows, cells, exactPending: exactRows.map((row) =>
    ({ id: row.id, shard: indexShardForSessionId(row.session_id, 2), sha256: rowDigest(BLOCK_COLUMNS, row) })) });
}

for (const [backend, createFixture] of [['SQLite', fixture], ['workerd', workerdFixture]]) {
  test(`byte-exact ${backend} one-time upgrade repairs a legacy 420-row verified pending page without rewriting its retired prefix`, async (context) => {
    const f = await publicLegacyPending(context, createFixture);
    const before = await publicRawSnapshot(f.source);
    let recovering = false;
    const copied = await copyWithNativeParameters(f.args({ checkpointHook: (state) => {
      if (state.pending?.phase !== 'recovering') return;
      recovering = true;
      assert.equal(state.after, f.prefix.after);
      assert.equal(state.rows, f.prefix.rows);
      assert.equal(state.sha256, f.prefix.sha256);
      assert.deepEqual(state.pending.recovery.legacyRows, f.legacy.pending.rows);
      assert.deepEqual(state.pending.rows, f.exactPending);
      assert.equal(state.pending.rows.filter((item, index) => item.sha256 !== f.legacy.pending.rows[index].sha256).length, 2);
    } }));
    assert.equal(recovering, true);
    assert.equal(copied.rows, f.prefix.rows + 420);
    assert.equal(copied.sha256, sha256(`${f.prefix.sha256}:${JSON.stringify(f.exactPending)}`));
    for (const row of before) {
      const shard = indexShardForSessionId(Buffer.from(row.v1, 'hex').toString('utf8'), 2);
      assert.deepEqual((await publicRawSnapshot(f.shards[shard])).find((item) => item.v0 === row.v0), row);
    }
    await assertPublicRawFts(f.shards[0], f.rows[0], PUBLIC_INVALID_TEXT);
  });
}

test('byte-exact legacy recovery resumes every durable checkpoint and ambiguous committed write/delete without replaying exact repairs', async (context) => {
  for (const stage of ['recovering', 'repair-write', 'verified', 'source-delete', 'acknowledged']) {
    await context.test(stage, async (child) => {
      const f = await publicLegacyPending(child, fixture, { count: 4 });
      const expected = await publicRawSnapshot(f.source);
      const crash = new Error('public recovery crash');
      let armed = false, crashed = false;
      for (const db of f.shards) {
        const batch = db.batch.bind(db);
        db.batch = async (statements) => {
          const repair = armed && statements.some(({ sql }) => /INSERT INTO blocks \(/.test(sql));
          const result = await batch(statements);
          if (repair && stage === 'repair-write' && !crashed) { crashed = true; throw crash; }
          return result;
        };
      }
      const batch = f.source.batch.bind(f.source);
      f.source.batch = async (statements) => {
        const result = await batch(statements);
        if (stage === 'source-delete' && !crashed && statements.some(({ sql }) => sql.includes('AS source_empty'))) {
          crashed = true; throw crash;
        }
        return result;
      };
      await assert.rejects(copyWithNativeParameters(f.args({ checkpointHook: (state) => {
        if (state.pending?.phase === 'recovering') armed = true;
        const hit = state.pending?.phase === stage || stage === 'acknowledged' && !state.pending && state.rows > f.prefix.rows;
        if (hit && !crashed) { crashed = true; throw crash; }
      } })), (error) => error === crash);
      assert.equal(crashed, true);
      const blockWrites = () => f.trace.filter((event) => event.kind === 'batch'
        && event.db !== f.source.id && event.statements.some(({ sql }) => /\bINSERT\s+INTO\s+blocks\s*\(/i.test(sql))).length;
      const writes = blockWrites();
      const sourceAfterCrash = blockSnapshot(f.source);
      const alreadyExact = new Set();
      if (stage === 'repair-write') {
        for (const shard of f.shards) {
          const stored = await publicRawSnapshot(shard);
          const owned = expected.filter((row) =>
            indexShardForSessionId(Buffer.from(row.v1, 'hex').toString('utf8'), 2) === f.shards.indexOf(shard));
          if (owned.every((row) => stored.some((found) => JSON.stringify(found) === JSON.stringify(row)))) alreadyExact.add(shard.id);
        }
        assert.ok(alreadyExact.size > 0, 'the ambiguous repair response must follow a real exact shard commit');
      }
      f.restart();
      const resumedAt = f.trace.length;
      const resumed = await copyWithNativeParameters(f.args());
      assert.equal(resumed.state, 'complete');
      assert.equal(resumed.sha256, sha256(`${f.prefix.sha256}:${JSON.stringify(f.exactPending)}`));
      if (['verified', 'source-delete', 'acknowledged'].includes(stage)) assert.equal(blockWrites(), writes);
      if (['source-delete', 'acknowledged'].includes(stage)) {
        assert.deepEqual(f.trace.slice(resumedAt).filter((event) =>
          event.db === f.source.id && event.sql && isWrite(event.sql)), [],
        'a committed page is observed after restart without any repeated source mutation');
        assert.deepEqual(blockSnapshot(f.source), sourceAfterCrash);
      }
      if (stage === 'repair-write') assert.deepEqual(f.trace.slice(resumedAt).filter((event) =>
        alreadyExact.has(event.db) && event.sql && isWrite(event.sql) && /\bblocks(?:_fts)?\b/i.test(event.sql)), [],
        'an already exact shard repair is observed, not replayed after its lost response');
      for (const row of expected) {
        const shard = indexShardForSessionId(Buffer.from(row.v1, 'hex').toString('utf8'), 2);
        assert.deepEqual((await publicRawSnapshot(f.shards[shard])).find((item) => item.v0 === row.v0), row);
      }
    });
  }
});

test('byte-exact legacy recovery refuses source/destination tamper, physical FTS failure, partial absence and unknown encodings', async (context) => {
  for (const fault of ['source', 'destination', 'physical-fts', 'partial-source', 'unknown-encoding', 'unknown-recovery',
    'same-rendering-source', 'recovery-destination']) {
    await context.test(fault, async (child) => {
      const f = await publicLegacyPending(child, fixture, { count: 4 });
      if (['unknown-recovery', 'same-rendering-source', 'recovery-destination'].includes(fault)) {
        await assert.rejects(copyWithNativeParameters(f.args({ checkpointHook: (state) => {
          if (state.pending?.phase === 'recovering') throw new Error('public stop');
        } })), /public stop/);
      }
      const state = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
      if (fault === 'unknown-encoding') { state.encoding = 'future-unknown'; await writeCheckpoint(f.shards[0], COPY_CHECKPOINT, state); }
      if (fault === 'unknown-recovery') { state.pending.recovery.unknown = true; await writeCheckpoint(f.shards[0], COPY_CHECKPOINT, state); }
      if (fault === 'destination' || fault === 'recovery-destination') await f.shards[0].query("UPDATE blocks SET role = 'changed' WHERE id = ?", [f.rows[0].id]);
      if (fault === 'physical-fts') await f.shards[0].query(
        "INSERT INTO blocks_fts (blocks_fts,rowid,text) SELECT 'delete',id,text FROM blocks WHERE id = ?", [f.rows[0].id]);
      if (['source', 'partial-source', 'same-rendering-source'].includes(fault)) await f.source.batch([
        { sql: `UPDATE ${SOURCE_FREEZE_TABLE} SET state = 'copying' WHERE id = 1`, params: [] },
        { sql: fault === 'partial-source' ? 'DELETE FROM blocks WHERE id = ?'
          : fault === 'same-rendering-source' ? `UPDATE blocks SET text = CAST(unhex('${PUBLIC_INVALID_TEXT.toString('hex').replace('ff', 'fe')}') AS TEXT) WHERE id = ?`
            : "UPDATE blocks SET role = 'changed' WHERE id = ?", params: [f.rows[0].id] },
        { sql: `UPDATE ${SOURCE_FREEZE_TABLE} SET state = 'frozen' WHERE id = 1`, params: [] },
      ]);
      const before = await publicRawSnapshot(f.source);
      const checkpoint = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
      f.trace.length = 0;
      await assert.rejects(copyWithNativeParameters(f.args()));
      assert.deepEqual(await publicRawSnapshot(f.source), before);
      assert.deepEqual(await readCheckpoint(f.shards[0], COPY_CHECKPOINT), checkpoint);
      assert.deepEqual(sourceWrites(f), []);
      assert.ok(!f.trace.some((event) => event.kind === 'batch' && event.statements.some(({ sql }) => /INSERT INTO blocks \(/.test(sql))),
        'invalid recovery proof cannot authorize a destination repair');
    });
  }
});

test('byte-exact invalid routing identity fails closed instead of coercing a raw tag', async (context) => {
  const f = await fixture(context);
  await seedPublicRawBlocks(f.source, [block(91_001)], new Map([[91_001, { session_id: PUBLIC_INVALID_TEXT }]]));
  const before = await publicRawSnapshot(f.source);
  f.trace.length = 0;
  await assert.rejects(copyWithNativeParameters(f.args()), (error) => error.code === 'row-identity');
  assert.deepEqual(await publicRawSnapshot(f.source), before);
  assert.deepEqual(sourceWrites(f), []);
  assert.ok(f.shards.every((db) => db.rows('SELECT id FROM blocks').length === 0));
});

test('byte-exact legacy copying checkpoint resumes proven present and absent shard replicas without resetting the prefix', async (context) => {
  const f = await publicLegacyPending(context, fixture, { count: 4, phase: 'copying' });
  await f.shards[0].batch([
    { sql: "INSERT INTO blocks_fts (blocks_fts,rowid,text) SELECT 'delete',id,text FROM blocks WHERE id > 1000", params: [] },
    { sql: 'DELETE FROM blocks WHERE id > 1000', params: [] },
  ]);
  const expected = await publicRawSnapshot(f.source);
  const result = await copyWithNativeParameters(f.args());
  assert.equal(result.state, 'complete');
  assert.equal(result.sha256, sha256(`${f.prefix.sha256}:${JSON.stringify(f.exactPending)}`));
  for (const row of expected) {
    const shard = indexShardForSessionId(Buffer.from(row.v1, 'hex').toString('utf8'), 2);
    assert.deepEqual((await publicRawSnapshot(f.shards[shard])).find((item) => item.v0 === row.v0), row);
  }
});

test('catalog copy rejects malformed stored UTF-8 before scalar builders or identity routing can coerce it', async (context) => {
  for (const field of ['metadata', 'identity']) {
    await context.test(field, async (child) => {
      const f = await catalogFixture(child, [], 2);
      const statement = field === 'metadata'
        ? "UPDATE sessions SET title = CAST(unhex('61ff6200') AS TEXT) WHERE session_id = 'catalog-00'"
        : "UPDATE session_catalog_versions SET session_id = CAST(unhex('61ff62') AS TEXT) WHERE session_id = 'catalog-00'";
      await f.source.query(statement);
      const before = f.shards.map(catalogSnapshot);
      const outbox = f.source.rows('SELECT * FROM session_catalog_outbox ORDER BY seq');
      const seed = nativeParameters.seedFrozenCatalog ?? seedFrozenCatalog;
      await assert.rejects(seed(f.args()), (error) => ['value', 'row-identity'].includes(error.code));
      assert.deepEqual(f.shards.map(catalogSnapshot), before);
      assert.deepEqual(f.source.rows('SELECT * FROM session_catalog_outbox ORDER BY seq'), outbox);
    });
  }
});
