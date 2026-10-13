import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  ACTIVATION_CHECKPOINT, COPY_CHECKPOINT, READY_CHECKPOINT, SEED_CHECKPOINT, SOURCE_FREEZE_TABLE,
  assertActivationProof, assertMaintenanceHealth, assertReadyProof, buildActivationProof, buildReadyProof, canonicalRow,
  classifyIndexMigration, copyFrozenIndex, initializeShardLayouts, readCheckpoint, reconcileIndexCatalog, rowDigest,
  seedFrozenCatalog, sourceCopyForecast, verifyIndexRecords, writeCheckpoint,
} from '../scripts/lib/index-migration.mjs';
import {
  BLOCK_COLUMNS, INDEX_ID_SPAN, INDEX_LAYOUT, SESSION_CATALOG_COLUMNS,
  STAR_CATALOG_COLUMNS, indexIdBase, indexShardForSessionId,
} from '../src/index-layout.mjs';
import {
  cloudflareRetryDelay, indexControlClient, pauseConsumers, requireProtectedProduction, verifyActiveIndex, verifyReadyIndex,
} from '../../infra/cf/index-control.mjs';
import { PREVIEW_ACCOUNT_ID, PRODUCTION_ACCOUNT_ID } from '../../infra/cf/preview-trust.mjs';
import { D1_BATCH_PROBE_TEXT, d1SqlFailureReason, verifyD1BatchAtomicity } from '../../infra/cf/d1-batch-atomicity.mjs';
import { CLOUDFLARE_REQUEST_RATE_PER_SECOND } from '../scripts/lib/cloudflare-api-budget.mjs';

// Historical controls replace only classification, so older modules missing the new proof
// exports still execute the load-bearing pending/active assertions rather than failing import.
const classifyActivation = process.env.INDEX_CLASSIFICATION_MODULE_PATH
  ? (await import(process.env.INDEX_CLASSIFICATION_MODULE_PATH)).classifyIndexMigration : classifyIndexMigration;
const copyWithNativeParameters = process.env.INDEX_COPY_MODULE_PATH
  ? (await import(process.env.INDEX_COPY_MODULE_PATH)).copyFrozenIndex : copyFrozenIndex;
const consumerControl = process.env.INDEX_CONTROL_MODULE_PATH
  ? await import(process.env.INDEX_CONTROL_MODULE_PATH) : { pauseConsumers };

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

async function fixture(context) {
  const directory = await mkdtemp(path.join(tmpdir(), 'index-migration-test-'));
  const trace = [];
  const identities = ['main-database', 'index-database-00', 'index-database-01'];
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

function blockSnapshot(db) {
  return {
    blocks: db.rows('SELECT * FROM blocks ORDER BY id'),
    // External-content SELECT/count alone cannot reveal missing or duplicate postings.
    ftsData: db.rows('SELECT * FROM blocks_fts_data ORDER BY id'),
    ftsIndex: db.rows('SELECT * FROM blocks_fts_idx ORDER BY segid, term'),
  };
}

function assertCopied(f, rows) {
  assert.deepEqual(f.source.rows('SELECT * FROM blocks'), []);
  for (let index = 0; index < f.shards.length; index += 1) {
    const shard = f.shards[index];
    const expected = rows.filter((row) => indexShardForSessionId(row.session_id, 2) === index)
      .sort((left, right) => left.id - right.id);
    assert.deepEqual(shard.rows('SELECT * FROM blocks ORDER BY id'), expected);
    for (const row of expected.filter((row) => row.text)) {
      const token = row.text.match(/[\p{L}\p{N}\p{Co}_.-][\p{L}\p{N}\p{M}\p{Co}_.-]*/u)?.[0];
      if (token) assert.deepEqual(shard.rows(
        'SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ? AND rowid = ?',
        [`"${token.replaceAll('"', '""')}"`, row.id],
      ), [{ rowid: row.id }]);
    }
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

function assertVerifiedBeforeDelete(f) {
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
      const reads = f.trace.filter((event) => event.db === shard.id
        && ['query', 'batch-statement'].includes(event.kind) && event.success && selectsTable(event.sql, 'blocks'));
      assert.ok(reads.some((event) => event.rows.some((row) => row.id === item.id
        && Object.hasOwn(row, 'text') && rowDigest(checkpoint.columns, row) === item.sha256)),
      `block ${item.id} must have a successful full-row adapter readback before source deletion`);
      const destination = shard.rows('SELECT * FROM blocks WHERE id = ?', [item.id])[0];
      const hasToken = typeof destination.text === 'string'
        && /[\p{L}\p{N}\p{Co}_.-]/u.test(destination.text);
      assert.ok(f.trace.some((event) => event.db === shard.id && ['query', 'batch-statement'].includes(event.kind)
        && event.success && /\bMATCH\b/i.test(event.sql) && event.params.includes(item.id)
        && (!hasToken || event.rows.some((row) => row.rowid === item.id))),
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
      // Retain the original CAS matrix's pre-mutation shared-term/NUL values, width and
      // numeric/null edges. Each populated shard stays below one 48-probe MATCH chunk.
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

test('actual copier MATCH SQL preserves shared-term row identities with native Number-bound parameters', async (context) => {
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
      assert.ok(params.some((value) => typeof value === 'number' && Number.isSafeInteger(value)));
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

test('actual configured FTS tokenizer preserves empty, punctuation, Unicode and shared after-NUL copy results', async (context) => {
  const f = await fixture(context);
  const cases = [
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
  const rows = cases.map(({ text }, index) => block(800 + index, index % 2, {
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
      const { tokens } = cases[row.id - 800];
      for (const token of tokens.length ? tokens : ['index-migration-tokenless-probe']) {
        assert.deepEqual(db.rows('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ? AND rowid = ?',
          [`"${token}"`, row.id]), tokens.length ? [{ rowid: row.id }] : [],
        'actual row-scoped MATCH must agree before and after copy, including punctuation tokenchars and NUL suffixes');
      }
    }
  };
  seedBlocks(f.source, rows);
  assertBytesAndMatches(f.source, rows);
  const protectedRows = assertVerifiedBeforeDelete(f);
  let verifiedBeforeRetirement = false;
  const copied = await copyFrozenIndex(f.args({ checkpointHook: (state) => {
    if (state.pending?.phase !== 'verified') return;
    verifiedBeforeRetirement = true;
    assertBytesAndMatches(f.source, rows);
    for (let index = 0; index < f.shards.length; index += 1) {
      assertBytesAndMatches(f.shards[index], rows.filter((row) => indexShardForSessionId(row.session_id, 2) === index));
    }
  } }));
  assert.equal(verifiedBeforeRetirement, true);
  assert.equal(copied.state, 'complete');
  assert.equal(copied.rows, rows.length);
  assert.equal(protectedRows(), rows.length);
  assertCopied(f, rows);
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

test('crash checkpoints survive reopened databases and reuse verified blocks plus FTS without rewriting', async (context) => {
  for (const stage of ['before-copy', 'verified-before-delete', 'after-delete']) {
    await context.test(stage, async (child) => {
      const f = await fixture(child);
      const rows = [block(11, 0, { on_main_path: 0, text: 'resume_needle 会話 😀' })];
      seedBlocks(f.source, rows);
      const deleted = assertVerifiedBeforeDelete(f);
      const crash = new Error(`simulated process crash ${stage}`);
      let crashed = false;
      await assert.rejects(copyFrozenIndex(f.args({ checkpointHook: (state) => {
        const target = stage === 'before-copy' ? state.pending?.phase === 'copying'
          : stage === 'verified-before-delete' ? state.pending?.phase === 'verified'
            : !state.pending && state.rows > 0 && state.state === 'pending';
        if (target && !crashed) { crashed = true; throw crash; }
      } })), (error) => error === crash);
      assert.equal(crashed, true);
      const saved = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
      const snapshots = f.shards.map(blockSnapshot);
      const batchesBeforeRestart = destinationBatchCount(f);
      assert.equal(deleted(), stage === 'after-delete' ? 1 : 0);
      assert.equal(f.source.rows('SELECT COUNT(*) AS n FROM blocks')[0].n, stage === 'after-delete' ? 0 : rows.length);
      assert.equal(saved.pending?.phase ?? null, stage === 'before-copy' ? 'copying'
        : stage === 'verified-before-delete' ? 'verified' : null);
      if (stage === 'before-copy') assert.equal(batchesBeforeRestart, 0);
      else assert.equal(batchesBeforeRestart, 1);
      f.restart();
      assert.deepEqual(await readCheckpoint(f.shards[0], COPY_CHECKPOINT), saved);
      assertVerifiedBeforeDelete(f);
      const result = await copyFrozenIndex(f.args());
      assert.equal(result.rows, rows.length);
      assert.equal(result.state, 'complete');
      assertCopied(f, rows);
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
      await assert.rejects(copyFrozenIndex(f.args()), /readback|omitted|SHA-256/i);
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

test('a real missing FTS posting blocks deletion despite intact content and row hash', async (context) => {
  const f = await fixture(context);
  const row = block(41, 1, { text: 'missing_match_needle café Unicode会話' });
  seedBlocks(f.source, [row]);
  f.shards[1].afterBatch = () => {
    f.shards[1].database.prepare('INSERT INTO blocks_fts (blocks_fts, rowid, text) VALUES (?, ?, ?)')
      .run('delete', row.id, row.text);
  };
  await assert.rejects(copyFrozenIndex(f.args()), /FTS MATCH verification failed/);
  assert.deepEqual(f.shards[1].rows('SELECT * FROM blocks'), [row]);
  assert.deepEqual(f.shards[1].rows('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ?', ['"missing_match_needle"']), []);
  assert.deepEqual(f.source.rows('SELECT * FROM blocks'), [row]);
  assert.deepEqual(sourceWrites(f), []);
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

function assertCatalogAcknowledgement(f, expected) {
  let acknowledgements = 0;
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
      const outbox = f.source.rows('SELECT * FROM session_catalog_outbox ORDER BY seq');
      let exercised = false;
      f.shards[1].transformQuery = ({ sql }, rows) => {
        if (!selectsTable(sql, table) || !rows.length) return rows;
        exercised = true;
        return rows.map((row, index) => index ? row : table === 'starred_turns'
          ? { ...row, turn_key: 'not-the-authoritative-content-key' }
          : { ...row, presence: row.presence === 'deleted' ? 'present' : 'deleted' });
      };
      await assert.rejects(seedFrozenCatalog(f.args()), /star catalog readback differs|version\/tombstone readback mismatch/);
      assert.equal(exercised, true);
      assert.deepEqual(f.source.rows('SELECT * FROM session_catalog_outbox ORDER BY seq'), outbox);
      assert.deepEqual(sourceWrites(f), []);
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
  await assert.rejects(copyFrozenIndex(f.args()), /lost response after committed source deletion/);
  assert.deepEqual(f.source.rows('SELECT * FROM blocks'), []);
  const saved = await readCheckpoint(f.shards[0], COPY_CHECKPOINT);
  assert.equal(saved.pending.phase, 'verified');
  assert.equal(saved.rows, 0);
  const snapshots = f.shards.map(blockSnapshot);
  const batches = destinationBatchCount(f);
  f.restart();
  assertVerifiedBeforeDelete(f);
  const result = await copyFrozenIndex(f.args());
  assert.equal(result.rows, rows.length);
  assert.equal(result.state, 'complete');
  assertCopied(f, rows);
  assert.equal(destinationBatchCount(f), batches);
  assert.deepEqual(f.shards.map(blockSnapshot), snapshots);
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
      if (corruption === 'copying-state') {
        f.source.database.exec(`UPDATE ${SOURCE_FREEZE_TABLE} SET state = 'copying' WHERE id = 1`);
      } else if (corruption === 'missing-trigger') {
        f.source.database.exec('DROP TRIGGER index_migration_blocks_insert');
      } else {
        f.source.database.exec(`DELETE FROM ${SOURCE_FREEZE_TABLE} WHERE id = 1`);
      }
      const before = f.source.rows('SELECT * FROM blocks ORDER BY id');
      const controlBefore = f.source.rows(`SELECT * FROM ${SOURCE_FREEZE_TABLE}`);
      f.trace.length = 0;
      await assert.rejects(copyFrozenIndex(f.args()), /freeze schema is incomplete|not durably frozen/);
      assert.deepEqual(f.source.rows('SELECT * FROM blocks ORDER BY id'), before);
      assert.deepEqual(before, rows.slice(saved.rows));
      assert.deepEqual(f.source.rows(`SELECT * FROM ${SOURCE_FREEZE_TABLE}`), controlBefore);
      assert.deepEqual(sourceWrites(f), [], 'invalid committed barrier state must not be repaired into permission to delete');
      assert.equal((await readCheckpoint(f.shards[0], COPY_CHECKPOINT)).pending.phase, 'verified');
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
      'ordinary serialized D1 parameters must stay within the actual 1 MiB JSON budget');
    if (responseBytes !== undefined) assert.ok(responseBytes <= 1024 * 1024,
      'readback must budget object keys and long markers, not only canonical row values');
  }
  for (const event of f.trace.filter((call) => call.kind === 'batch')) {
    assert.ok(Buffer.byteLength(JSON.stringify(event.statements)) <= 1024 * 1024,
      'ordinary native batch JSON must remain within the 1 MiB transport budget');
  }
}

test('a dense 600-row copy uses native JSON bulk writes/deletion and bounded MATCH batches rather than one RPC per row', async (context) => {
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
  const matchBatches = f.trace.filter((event) => event.kind === 'batch'
    && event.statements.every(({ sql }) => /\bMATCH\b/i.test(sql)));
  assert.equal(matchBatches.length, 2, 'all MATCH chunks of a populated shard share one native read transaction');
  assert.ok(matchBatches.every((event) => event.committed && event.statements.length > 1));
  const matches = f.trace.filter((event) => ['query', 'batch-statement'].includes(event.kind) && /\bMATCH\b/i.test(event.sql));
  assert.ok(matches.every((event) => event.params.length <= 96), '48 probes bind at most 96 MATCH/id parameters');
  assert.equal(Math.max(...matches.map((event) => event.params.length)), 96);
  assert.deepEqual(new Set(matches.flatMap((event) => event.rows.map(({ rowid }) => rowid))),
    new Set(rows.map(({ id }) => id)));
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
        await assert.rejects(verifyD1BatchAtomicity(db), new RegExp(`failed ${phase} text/byte readback`));
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
      await assert.rejects(verifyD1BatchAtomicity(db), /unexpected result count/);
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
  await assert.rejects(verifyD1BatchAtomicity(db), /partially committed before a failing statement; source copy forbidden/);
  assert.deepEqual(probeTables(db), []);
  assert.deepEqual(db.rows('SELECT * FROM user_owned_atomicity_sentinel'), [{ value: 'keep' }]);
  const drops = f.trace.filter((event) => event.kind === 'query' && /^\s*DROP TABLE\b/i.test(event.sql));
  assert.equal(drops.length, 2, 'successful proof table and detected partial-commit table are both owned and cleaned');
  assert.ok(drops.every(({ sql }) => sql.includes('__index_batch_probe_')));
  assert.ok(f.trace.every((event) => event.db === db.id));
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
      await assert.rejects(verifyD1BatchAtomicity(db), /expected SQL rejection; atomicity unproven/);
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
  await assert.rejects(verifyD1BatchAtomicity(db), /no such function: index_atomicity_unsupported_capability/);
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
  await assert.rejects(verifyD1BatchAtomicity(db), /name already exists; refusing ownership/);
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
  ]) assert.equal(d1SqlFailureReason(errors), 'other');
  for (const [message, reason] of [
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
  ]) assert.equal(d1SqlFailureReason([{ message, code: 7500 }]), reason);
  assert.equal(d1SqlFailureReason([{ code: 7500 }]), 'other');
  assert.equal(d1SqlFailureReason(['database or disk is full; malformed JSON']), 'other');
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
    const db = indexControlClient(PREVIEW_ACCOUNT_ID, 'private-token', { permit: async () => {} }).db(id);
    await assert.rejects(db.batch([{ sql: canary, params: [canary] }]), (error) => {
      assert.equal(error.d1SqlReason, ['envelope', 'result'].includes(scenario) ? 'missing-schema' : 'other');
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
