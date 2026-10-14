import { createHash } from 'node:crypto';
import {
  INDEX_ID_SPAN, INDEX_LAYOUT, SHARD_META_INIT_SQL, indexIdBase,
  SESSION_CATALOG_COLUMNS, STAR_CATALOG_COLUMNS, SESSION_CATALOG_RETIRE_SQL, sessionCatalogBatches,
  indexShardForSessionId,
} from '../../src/index-layout.mjs';
import { CLOUDFLARE_REQUEST_RATE_PER_SECOND } from './cloudflare-api-budget.mjs';

export const COPY_CHECKPOINT = 'full-fidelity-index-copy-v1';
export const SEED_CHECKPOINT = 'full-fidelity-index-catalog-v1';
export const READY_CHECKPOINT = 'full-fidelity-index-ready-v1';
export const ACTIVATION_CHECKPOINT = 'full-fidelity-index-activated-v1';
export const DRAIN_MILLISECONDS = 16 * 60 * 1000;
export const SOURCE_FREEZE_TABLE = 'index_migration_freeze';
export const COPY_PAGE_ROWS = 2048;
export const COPY_PAGE_BYTES = 1024 * 1024;

export const COPY_PHASES = Object.freeze({
  SETUP: 'copy-setup',
  CHECKPOINT_READ: 'copy-checkpoint-read',
  CHECKPOINT_WRITE: 'copy-checkpoint-write',
  SOURCE_PAGE_READ: 'copy-source-page-read',
  PAGE_WRITE: 'copy-page-write',
  PAGE_READBACK: 'copy-page-readback',
  FTS_MATCH: 'copy-fts-match',
  DISCARD_PAGE: 'copy-discard-page',
  SOURCE_FREEZE_READ: 'copy-source-freeze-read',
  SOURCE_FREEZE_INSTALL: 'copy-source-freeze-install',
  SOURCE_DELETE_AND_FREEZE: 'copy-source-delete-and-freeze',
  GENERAL_CHECKPOINT_READ: 'checkpoint-read',
  GENERAL_CHECKPOINT_WRITE: 'checkpoint-write',
});
export const COPY_INVARIANTS = Object.freeze({
  COLUMN: 'column', VALUE: 'value', NUMBER: 'number', CHECKPOINT_PAYLOAD: 'checkpoint-payload',
  SHARD_LAYOUT: 'shard-layout', SCHEMA_MISSING: 'schema-missing', SCHEMA_COLUMNS: 'schema-columns',
  CHECKPOINT_STATE: 'checkpoint-state', CHECKPOINT_IDENTITY: 'checkpoint-identity',
  FREEZE_SCHEMA: 'freeze-schema', FREEZE_STATE: 'freeze-state', FREEZE_MISSING: 'freeze-missing',
  FTS_SHAPE: 'fts-shape', FTS_IDENTITY: 'fts-identity', FTS_MATCH: 'fts-match',
  COLUMN_LAYOUT: 'column-layout', COLUMN_BUDGET: 'column-budget', PAGE_METADATA: 'page-metadata',
  ROW_CAP: 'row-cap', DUPLICATE_IDS: 'duplicate-ids', SIZE_IDENTITY: 'size-identity',
  ROW_IDENTITY: 'row-identity', LONG_COLUMN: 'long-column', LONG_LENGTH: 'long-length',
  LONG_SLICE: 'long-slice', LONG_UTF8: 'long-utf8', SOURCE_PAGE_MISSING: 'source-page-missing',
  PAGE_BYTES: 'page-bytes', DESTINATION_IDENTITY: 'destination-identity',
  READBACK_SHA256: 'readback-sha256', SOURCE_CHANGED: 'source-changed',
  SOURCE_MISSING: 'source-missing', SOURCE_DELETE: 'source-delete',
  SOURCE_REAPPEARED: 'source-reappeared', SOURCE_RANGE: 'source-range',
  SOURCE_COLUMNS: 'source-columns', SOURCE_BEHIND_CURSOR: 'source-behind-cursor',
});

function copyInvariant(code, message, phase) {
  const error = new Error(message);
  error.code = code;
  if (phase) error.d1Phase = phase;
  return error;
}
const CATALOG_PAGE_ROWS = 16;
const SEED_PAGE_ROWS = 96;
const SMALL_ROW_BYTES = 65536;
const LONG_SLICE_BYTES = 131072;
const RESPONSE_ENVELOPE_BYTES = 4096;
const JSON_IDS_SQL = 'SELECT value FROM json_each(?)';
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const inList = (count) => Array.from({ length: count }, () => '?').join(',');
const DIAGNOSTIC_DB = Symbol('diagnostic-db');
const DIAGNOSTIC_PHASE = Symbol('diagnostic-phase');

// Only callers below supply literal operation names. Preserve the original rejection
// and transaction behavior; diagnostics never authorize retry or change checkpoints.
function phaseDb(db, phase) {
  db = db[DIAGNOSTIC_DB] ?? db;
  const call = async (kind, args) => {
    try { return await db[kind](...args); }
    catch (error) {
      if (!error.d1Phase) {
        error.d1Phase = phase;
        if (error.d1Diagnostic) error.message += ` phase=${phase}`;
      }
      throw error;
    }
  };
  return { [DIAGNOSTIC_DB]: db, [DIAGNOSTIC_PHASE]: phase, id: db.id, query: (...args) => call('query', args), batch: (...args) => call('batch', args) };
}

const sourceFreezeTriggers = ['insert', 'update', 'delete'].map((event) => ({
  sql: `CREATE TRIGGER IF NOT EXISTS index_migration_blocks_${event} BEFORE ${event.toUpperCase()} ON blocks
    WHEN COALESCE((SELECT state FROM ${SOURCE_FREEZE_TABLE} WHERE id = 1), 'frozen') = 'frozen'
    BEGIN SELECT RAISE(ABORT, 'index_migration_frozen'); END`,
  params: [],
}));

async function sourceFreezePhase(source) {
  source = phaseDb(source, COPY_PHASES.SOURCE_FREEZE_READ);
  const objects = await source.query(`SELECT type, name FROM sqlite_master
    WHERE name IN ('${SOURCE_FREEZE_TABLE}', 'index_migration_blocks_insert',
      'index_migration_blocks_update', 'index_migration_blocks_delete')`);
  if (!objects.length) return 'absent';
  if (objects.length !== 4 || objects.filter((row) => row.type === 'table').length !== 1
    || objects.filter((row) => row.type === 'trigger').length !== 3) {
    throw copyInvariant(COPY_INVARIANTS.FREEZE_SCHEMA, 'source block freeze schema is incomplete', COPY_PHASES.SOURCE_FREEZE_READ);
  }
  const rows = await source.query(`SELECT id, state FROM ${SOURCE_FREEZE_TABLE}`);
  if (rows.length !== 1 || rows[0].id !== 1 || rows[0].state !== 'frozen') {
    throw copyInvariant(COPY_INVARIANTS.FREEZE_STATE, 'source block freeze is not durably frozen', COPY_PHASES.SOURCE_FREEZE_READ);
  }
  return 'frozen';
}

function sourceFreezeInstall() {
  return [
    { sql: `CREATE TABLE IF NOT EXISTS ${SOURCE_FREEZE_TABLE}
      (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL CHECK (state IN ('frozen', 'copying'))) STRICT`, params: [] },
    { sql: `INSERT INTO ${SOURCE_FREEZE_TABLE} (id, state) VALUES (1, 'copying')
      ON CONFLICT (id) DO UPDATE SET state = excluded.state`, params: [] },
    ...sourceFreezeTriggers,
  ];
}

function sourceEmptyAssertion(ids = null) {
  return {
    // Invalid JSON makes the transaction abort if any compared row survived. This is
    // deliberately before first guard DDL, so no allocation follows a failed compare.
    sql: `SELECT json(CASE WHEN EXISTS (SELECT 1 FROM blocks
      ${ids ? `WHERE id IN (${JSON_IDS_SQL})` : ''} LIMIT 1)
      THEN 'index_migration_source_changed' ELSE 'null' END) AS source_empty`,
    params: ids ? [JSON.stringify(ids)] : [],
  };
}

async function freezeEmptySource(source) {
  source = phaseDb(source, COPY_PHASES.SOURCE_FREEZE_INSTALL);
  if (await sourceFreezePhase(source) === 'frozen') return;
  await source.batch([
    sourceEmptyAssertion(), ...sourceFreezeInstall(),
    { sql: `UPDATE ${SOURCE_FREEZE_TABLE} SET state = 'frozen' WHERE id = 1`, params: [] },
  ]);
}

export function canonicalRow(columns, row, phase) {
  return JSON.stringify(columns.map((column) => {
    if (!Object.hasOwn(row, column)) throw copyInvariant(COPY_INVARIANTS.COLUMN, 'D1 omitted column', phase);
    const value = row[column];
    if (value !== null && !['string', 'number'].includes(typeof value)) {
      throw copyInvariant(COPY_INVARIANTS.VALUE, 'unsupported D1 value', phase);
    }
    if (typeof value === 'number' && (!Number.isFinite(value)
      || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
      throw copyInvariant(COPY_INVARIANTS.NUMBER, 'unsafe D1 number', phase);
    }
    return value;
  }));
}

export function rowDigest(columns, row, phase) { return sha(canonicalRow(columns, row, phase)); }

export function assertMaintenanceHealth(health, revision, count) {
  if (health?.ok !== true || health.environment !== 'production'
    || health.indexMode !== 'maintenance' || health.deploymentRevision !== revision
    || health.indexShardCount !== count) {
    throw new Error('live maintenance revision/layout does not match; refusing index writes');
  }
}

export async function readCheckpoint(db, name) {
  if (!db[DIAGNOSTIC_DB]) db = phaseDb(db, COPY_PHASES.GENERAL_CHECKPOINT_READ);
  const rows = await db.query('SELECT value FROM index_migration_state WHERE name = ?', [name]);
  if (!rows.length) return null;
  let value;
  try { value = JSON.parse(rows[0].value); }
  catch { throw copyInvariant(COPY_INVARIANTS.CHECKPOINT_PAYLOAD, 'invalid index migration checkpoint payload'); }
  // Only a missing row is absence. Stored null/primitives/arrays are corruption,
  // never permission to initialize or overwrite a workflow checkpoint.
  if (!isProofRecord(value)) throw copyInvariant(COPY_INVARIANTS.CHECKPOINT_PAYLOAD, 'invalid index migration checkpoint payload');
  return value;
}

export async function writeCheckpoint(db, name, value) {
  if (!db[DIAGNOSTIC_DB]) db = phaseDb(db, COPY_PHASES.GENERAL_CHECKPOINT_WRITE);
  await db.query(`INSERT INTO index_migration_state (name, value) VALUES (?, ?)
    ON CONFLICT (name) DO UPDATE SET value = excluded.value`, [name, JSON.stringify(value)]);
}

export async function initializeShardLayouts(shards) {
  for (let index = 0; index < shards.length; index += 1) {
    const db = shards[index];
    await db.query(SHARD_META_INIT_SQL, [index, shards.length, INDEX_LAYOUT, indexIdBase(index)]);
    const rows = await db.query('SELECT * FROM shard_meta WHERE id = 1');
    const meta = rows[0];
    if (rows.length !== 1 || Number(meta.shard_index) !== index
      || Number(meta.shard_count) !== shards.length || meta.layout !== INDEX_LAYOUT
      || !Number.isSafeInteger(Number(meta.next_block_id))
      || Number(meta.next_block_id) < indexIdBase(index)
      || Number(meta.next_block_id) >= indexIdBase(index) + INDEX_ID_SPAN) {
      throw copyInvariant(COPY_INVARIANTS.SHARD_LAYOUT, `immutable shard layout mismatch on shard ${index}`, COPY_PHASES.SETUP);
    }
  }
}

async function columnsFor(db, table) {
  const rows = await db.query(`PRAGMA table_info(${quote(table)})`);
  if (!rows.length) throw copyInvariant(COPY_INVARIANTS.SCHEMA_MISSING, `missing ${table} table`, COPY_PHASES.SETUP);
  return rows.map((row) => row.name);
}

async function assertColumns(shards, table, columns) {
  for (const db of shards) {
    if (JSON.stringify(await columnsFor(db, table)) !== JSON.stringify(columns)) {
      throw copyInvariant(COPY_INVARIANTS.SCHEMA_COLUMNS, `source/destination ${table} columns differ; refusing lossy copy`, COPY_PHASES.SETUP);
    }
  }
}

function copyIdentity(source, shards) {
  return { format: 1, layout: INDEX_LAYOUT, source: source.id, shards: shards.map((db) => db.id) };
}

function assertIdentity(state, identity) {
  if (!['pending', 'complete'].includes(state.state)) throw copyInvariant(COPY_INVARIANTS.CHECKPOINT_STATE, 'invalid index migration checkpoint state');
  if (JSON.stringify(state.identity) !== JSON.stringify(identity)) {
    throw copyInvariant(COPY_INVARIANTS.CHECKPOINT_IDENTITY, 'durable checkpoint identifies different databases/layout');
  }
}

const isProofRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const isSha256 = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isCounter = (value) => Number.isSafeInteger(value) && value >= 0;

// Sort every object key so checkpoint/proof hashes survive JSON roundtrips and key ordering.
// Hash the complete checkpoints, not only their status or aggregate counts.
function proofJson(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)
    && (!Number.isInteger(value) || Number.isSafeInteger(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, proofJson).join(',')}]`;
  if (isProofRecord(value)) return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${proofJson(value[key])}`).join(',')}}`;
  throw new Error('invalid durable proof JSON value');
}

function completedProofBindings({ source, shards, copy, seed }) {
  if (typeof source?.id !== 'string' || !source.id || !Array.isArray(shards) || !shards.length
    || shards.some((db) => typeof db?.id !== 'string' || !db.id)
    || new Set([source.id, ...shards.map((db) => db.id)]).size !== shards.length + 1) {
    throw new Error('invalid durable proof database identity');
  }
  const identity = copyIdentity(source, shards);
  if (!isProofRecord(copy) || !isProofRecord(seed)) throw new Error('durable proof requires completed copy and seed checkpoints');
  assertIdentity(copy, identity);
  assertIdentity(seed, identity);
  if (copy.state !== 'complete' || seed.state !== 'complete' || copy.pending !== null
    || !isSha256(copy.sha256) || !isCounter(copy.rows) || !isCounter(seed.rows)
    || !Number.isSafeInteger(copy.after) || copy.after < -1 || copy.after >= INDEX_ID_SPAN
    || (copy.rows === 0 ? copy.after !== -1 : copy.after < 0) || typeof seed.after !== 'string'
    || !Array.isArray(copy.columns) || !copy.columns.length || copy.columns.length > 100
    || !copy.columns.includes('id') || copy.columns.some((column) => typeof column !== 'string' || !column)
    || new Set(copy.columns).size !== copy.columns.length) {
    throw new Error('invalid completed copy or seed snapshot for durable proof');
  }
  return {
    identity,
    copy: { columns: [...copy.columns], sha256: copy.sha256, rows: copy.rows, after: copy.after,
      checkpointSha256: sha(proofJson(copy)) },
    seed: { rows: seed.rows, checkpointSha256: sha(proofJson(seed)) },
  };
}

function assertProofProvenance(revision, cycle, verifiedAt) {
  if (typeof revision !== 'string' || !/^[a-f0-9]{40}$/.test(revision)
    || typeof cycle !== 'string' || !/^[1-9]\d*:[1-9]\d*$/.test(cycle)
    || !Number.isSafeInteger(verifiedAt) || verifiedAt <= 0) {
    throw new Error('invalid durable proof revision, cycle or verification timestamp');
  }
}

function evidenceDigest(evidence) {
  if (!isProofRecord(evidence) || !Object.keys(evidence).length) throw new Error('durable proof requires verification evidence');
  return sha(proofJson(evidence));
}

function readyProofBody({ source, shards, copy, seed, revision, cycle, verifiedAt, evidenceSha256 }) {
  assertProofProvenance(revision, cycle, verifiedAt);
  if (!isSha256(evidenceSha256)) throw new Error('invalid ready proof evidence digest');
  return { format: 1, state: 'ready', ...completedProofBindings({ source, shards, copy, seed }),
    revision, cycle, verifiedAt, evidenceSha256 };
}

function sealProof(body) { return { ...body, digest: sha(proofJson(body)) }; }

function assertSealedProof(proof, body, name) {
  if (!isSha256(proof.digest) || proofJson(proof) !== proofJson(sealProof(body))) {
    throw new Error(`${name} proof integrity or snapshot binding mismatch`);
  }
}

/** Pure durable readiness binding; the controller supplies actual frozen verification evidence. */
export function buildReadyProof({ source, shards, copy, seed, revision, cycle, verifiedAt, evidence }) {
  return sealProof(readyProofBody({ source, shards, copy, seed, revision, cycle, verifiedAt,
    evidenceSha256: evidenceDigest(evidence) }));
}

export function assertReadyProof({ source, shards, copy, seed, ready, revision, cycle }) {
  if (!isProofRecord(ready) || ready.format !== 1 || ready.state !== 'ready') throw new Error('invalid ready proof state or format');
  const body = readyProofBody({ source, shards, copy, seed, revision: ready.revision, cycle: ready.cycle,
    verifiedAt: ready.verifiedAt, evidenceSha256: ready.evidenceSha256 });
  assertSealedProof(ready, body, 'ready');
  if ((revision !== undefined && revision !== ready.revision) || (cycle !== undefined && cycle !== ready.cycle)) {
    throw new Error('ready proof does not identify the current revision/cycle');
  }
}

function activationProofBody({ source, shards, ready, revision, cycle, verifiedAt, evidenceSha256 }) {
  assertProofProvenance(revision, cycle, verifiedAt);
  if (revision !== ready.revision || cycle !== ready.cycle || verifiedAt < ready.verifiedAt
    || !isSha256(evidenceSha256)) throw new Error('invalid activation proof provenance, timestamp or evidence digest');
  return {
    format: 1, state: 'active', identity: copyIdentity(source, shards), revision, cycle, verifiedAt,
    copySha256: ready.copy.sha256, copyCheckpointSha256: ready.copy.checkpointSha256,
    seedCheckpointSha256: ready.seed.checkpointSha256, readyDigest: ready.digest, evidenceSha256,
  };
}

/** Call only after the controller completes active health/index/login checks; no DB side effects. */
export function buildActivationProof({ source, shards, copy, seed, ready, revision, cycle, verifiedAt, evidence }) {
  assertReadyProof({ source, shards, copy, seed, ready, revision, cycle });
  return sealProof(activationProofBody({ source, shards, ready, revision, cycle, verifiedAt,
    evidenceSha256: evidenceDigest(evidence) }));
}

export function assertActivationProof({ source, shards, copy, seed, ready, activation }) {
  assertReadyProof({ source, shards, copy, seed, ready });
  if (!isProofRecord(activation) || activation.format !== 1 || activation.state !== 'active') {
    throw new Error('invalid activation proof state or format');
  }
  assertSealedProof(activation, activationProofBody({ source, shards, ready, revision: activation.revision,
    cycle: activation.cycle, verifiedAt: activation.verifiedAt, evidenceSha256: activation.evidenceSha256 }), 'activation');
}

function firstMatchToken(text) {
  return typeof text === 'string'
    ? text.match(/[\p{L}\p{N}\p{Co}_.-][\p{L}\p{N}\p{M}\p{Co}_.-]*/u)?.[0] ?? null
    : null;
}

async function verifyFts(db, rows) {
  db = phaseDb(db, COPY_PHASES.FTS_MATCH);
  const probes = rows.map((row) => ({ id: row.id, token: firstMatchToken(row.text) }));
  const statements = [];
  for (let offset = 0; offset < probes.length; offset += 48) {
    const chunk = probes.slice(offset, offset + 48);
    // FTS5 can omit the equality recheck for REAL-bound integral ids. These ids are
    // already validated safe integers; make their SQL storage class normative too.
    statements.push({
      sql: chunk.map(() => 'SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ? AND rowid = CAST(? AS INTEGER)').join(' UNION ALL '),
      params: chunk.flatMap(({ id, token }) => [
        token ? `"${token.replaceAll('"', '""')}"` : '"index-migration-tokenless-probe"', id,
      ]),
    });
  }
  if (!statements.length) return;
  let matches;
  if (statements.length === 1) {
    matches = await db.query(statements[0].sql, statements[0].params);
  } else {
    const results = await db.batch(statements);
    if (results.length !== statements.length || results.some((result) => !Array.isArray(result.results))) {
      throw copyInvariant(COPY_INVARIANTS.FTS_SHAPE, 'FTS MATCH batch returned incomplete results', COPY_PHASES.FTS_MATCH);
    }
    matches = results.flatMap((result) => result.results);
  }
  const expected = new Set(probes.map((probe) => probe.id));
  const found = new Set();
  for (const row of matches) {
    if (!Number.isSafeInteger(row.rowid) || !expected.has(row.rowid) || found.has(row.rowid)) {
      throw copyInvariant(COPY_INVARIANTS.FTS_IDENTITY, 'FTS MATCH readback cardinality/identity mismatch', COPY_PHASES.FTS_MATCH);
    }
    found.add(row.rowid);
  }
  for (const { id, token } of probes) {
    if (token && !found.has(id)) throw copyInvariant(COPY_INVARIANTS.FTS_MATCH, 'FTS MATCH verification failed', COPY_PHASES.FTS_MATCH);
  }
}

function blockPageLayout(columns) {
  if (columns.length > 100 || !columns.includes('id')) throw copyInvariant(COPY_INVARIANTS.COLUMN_LAYOUT, 'unsupported block column layout', COPY_PHASES.SETUP);
  const quoted = columns.map(quote);
  const qualified = quoted.map((column) => `b.${column}`);
  const paths = columns.map((_, index) => `'$[${index}]'`);
  const markerNames = columns.map((_, index) => `__long_${index}`);
  // Canonical arrays omit object keys. REST rows include every key and every long-value
  // marker, including null markers; dense short rows must budget these bytes too.
  const responseOverhead = columns.reduce((bytes, column, index) => bytes
    + Buffer.byteLength(JSON.stringify(column)) + 1
    + Buffer.byteLength(JSON.stringify(markerNames[index])) + 6, 0);
  // Even an unusually wide single row remains bounded when many individually short
  // TEXT columns need escaping. Larger values use the same lossless hex transport.
  const inlineBytes = Math.min(SMALL_ROW_BYTES, Math.floor(
    (COPY_PAGE_BYTES - RESPONSE_ENVELOPE_BYTES - responseOverhead - columns.length * 32)
      / (6 * columns.length),
  ));
  if (inlineBytes < 1) throw copyInvariant(COPY_INVARIANTS.COLUMN_BUDGET, 'block column names exceed the bounded response budget', COPY_PHASES.SETUP);
  // SQLite length(TEXT) stops at an embedded NUL. BLOB lengths count every stored UTF-8
  // byte, including JSON-escaped NULs in the response budget below.
  const selectors = quoted.flatMap((column, index) => {
    const long = `typeof(${column}) = 'text' AND length(CAST(${column} AS BLOB)) >
      CASE WHEN "__copy_raw_bytes" > ${SMALL_ROW_BYTES} THEN ${inlineBytes} ELSE ${SMALL_ROW_BYTES} END`;
    return [
      `CASE WHEN ${long} THEN NULL ELSE ${column} END AS ${column}`,
      `CASE WHEN ${long} THEN length(CAST(${column} AS BLOB)) ELSE NULL END AS ${quote(markerNames[index])}`,
    ];
  }).join(',');
  return {
    quoted, paths, markerNames, inlineBytes, responseOverhead, selectors,
    rawSize: qualified.map((column) => `COALESCE(length(CAST(${column} AS BLOB)),0)`).join('+'),
    hasBlob: qualified.map((column) => `typeof(${column}) = 'blob'`).join(' OR '),
    jsonSize: `${qualified.map((column) => `length(CAST(json_quote(${column}) AS BLOB))`).join('+')}+${columns.length + 1}`,
  };
}

async function blockCandidates(db, layout, { after, ids, descending = false }) {
  const order = descending ? 'DESC' : 'ASC';
  const where = ids ? `b.id IN (${JSON_IDS_SQL})` : 'b.id > ?';
  const params = ids ? [JSON.stringify(ids), COPY_PAGE_ROWS] : [after, COPY_PAGE_ROWS];
  // CASE is deliberately outside the materialized raw-size scan: never JSON-quote a
  // multi-megabyte value or a BLOB just to decide how to transport it.
  return db.query(`WITH candidates AS MATERIALIZED (
    SELECT b.id, (${layout.rawSize}) AS raw_bytes, (${layout.hasBlob}) AS has_blob
    FROM blocks AS b WHERE ${where} ORDER BY b.id ${order} LIMIT ?
  ) SELECT candidates.id, raw_bytes,
    CASE WHEN raw_bytes > ${SMALL_ROW_BYTES} OR has_blob THEN NULL
      ELSE (${layout.jsonSize}) END AS row_bytes
    FROM candidates JOIN blocks AS b ON b.id = candidates.id ORDER BY candidates.id ${order}`, params);
}

function boundedCandidatePage(candidates, layout, start = 0, phase) {
  const selected = [];
  let bytes = RESPONSE_ENVELOPE_BYTES + 2;
  for (let index = start; index < candidates.length && selected.length < COPY_PAGE_ROWS; index += 1) {
    const candidate = candidates[index];
    if (!Number.isSafeInteger(candidate.id) || !Number.isSafeInteger(candidate.raw_bytes)
      || candidate.raw_bytes < 0 || (candidate.row_bytes !== null
        && (!Number.isSafeInteger(candidate.row_bytes) || candidate.row_bytes < 0))) {
      throw copyInvariant(COPY_INVARIANTS.PAGE_METADATA, 'invalid block page size metadata', phase);
    }
    if (candidate.row_bytes === null) {
      if (!selected.length) selected.push(candidate);
      break;
    }
    const rowBytes = candidate.row_bytes + layout.responseOverhead + 1;
    if (selected.length && bytes + rowBytes > COPY_PAGE_BYTES) break;
    selected.push(candidate);
    bytes += rowBytes;
  }
  return selected;
}

async function readBlockRows(db, columns, ids, layout = blockPageLayout(columns), candidates = null) {
  const phase = db[DIAGNOSTIC_PHASE];
  if (!ids.length) return [];
  if (ids.length > COPY_PAGE_ROWS) throw copyInvariant(COPY_INVARIANTS.ROW_CAP, 'block readback exceeds the copy row cap', phase);
  if (new Set(ids).size !== ids.length) throw copyInvariant(COPY_INVARIANTS.DUPLICATE_IDS, 'duplicate block readback IDs', phase);
  // Checkpoints retain their original schema. Recompute bounded response pages on
  // resume/readback rather than trusting an old or smaller copier's page dimensions.
  const sizes = candidates ?? await blockCandidates(db, layout, { ids });
  if (sizes.length > COPY_PAGE_ROWS) throw copyInvariant(COPY_INVARIANTS.ROW_CAP, 'block readback exceeds the copy row cap', phase);
  const expected = new Set(ids);
  const sized = new Set();
  for (const candidate of sizes) {
    if (!expected.has(candidate.id) || sized.has(candidate.id)) throw copyInvariant(COPY_INVARIANTS.SIZE_IDENTITY, 'block size readback identity mismatch', phase);
    sized.add(candidate.id);
  }
  const rows = [];
  const seen = new Set();
  for (let offset = 0; offset < sizes.length;) {
    const page = boundedCandidatePage(sizes, layout, offset, phase);
    const pageIds = page.map((candidate) => candidate.id);
    const wanted = new Map(page.map((candidate) => [candidate.id, candidate.raw_bytes]));
    const found = await db.query(`WITH sized AS MATERIALIZED (
      SELECT b.*, (${layout.rawSize}) AS "__copy_raw_bytes" FROM blocks AS b
      WHERE b.id IN (${JSON_IDS_SQL})
    ) SELECT ${layout.selectors} FROM sized ORDER BY id`, [JSON.stringify(pageIds)]);
    for (const row of found) {
      if (!wanted.has(row.id) || seen.has(row.id)) throw copyInvariant(COPY_INVARIANTS.ROW_IDENTITY, 'block readback cardinality/identity mismatch', phase);
      seen.add(row.id);
      const inlineBytes = wanted.get(row.id) > SMALL_ROW_BYTES ? layout.inlineBytes : SMALL_ROW_BYTES;
      let rowIdsJson;
      for (let index = 0; index < columns.length; index += 1) {
        const marker = layout.markerNames[index];
        if (!Object.hasOwn(row, columns[index]) || !Object.hasOwn(row, marker)) {
          throw copyInvariant(COPY_INVARIANTS.LONG_COLUMN, 'D1 omitted a block column or long-column marker', phase);
        }
        const length = row[marker];
        delete row[marker];
        if (length === null) continue;
        if (!Number.isSafeInteger(length) || length <= inlineBytes || row[columns[index]] !== null) {
          throw copyInvariant(COPY_INVARIANTS.LONG_LENGTH, 'invalid long-column byte length metadata', phase);
        }
        const chunks = [];
        rowIdsJson ??= JSON.stringify([row.id]);
        for (let byteOffset = 0; byteOffset < length; byteOffset += LONG_SLICE_BYTES) {
          const sliceBytes = Math.min(LONG_SLICE_BYTES, length - byteOffset);
          const parts = await db.query(`SELECT hex(substr(CAST(${layout.quoted[index]} AS BLOB), ?, ?)) AS bytes
            FROM blocks WHERE id IN (${JSON_IDS_SQL})`, [byteOffset + 1, sliceBytes, rowIdsJson]);
          if (parts.length !== 1 || typeof parts[0].bytes !== 'string'
            || parts[0].bytes.length !== sliceBytes * 2 || !/^[0-9a-f]+$/i.test(parts[0].bytes)) {
            throw copyInvariant(COPY_INVARIANTS.LONG_SLICE, 'incomplete or invalid long-column byte slice', phase);
          }
          chunks.push(Buffer.from(parts[0].bytes, 'hex'));
        }
        try {
          row[columns[index]] = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, length));
        } catch {
          throw copyInvariant(COPY_INVARIANTS.LONG_UTF8, 'invalid long-column UTF-8', phase);
        }
      }
      rows.push(row);
    }
    offset += page.length;
  }
  return rows;
}

function canonicalPage(columns, rows, phase) {
  const canonical = rows.map((row) => canonicalRow(columns, row, phase));
  const sizes = canonical.map((row) => Buffer.byteLength(row));
  let count = 0;
  let bytes = 2;
  while (count < rows.length) {
    const next = sizes[count] + (count ? 1 : 0);
    if (count && bytes + next > COPY_PAGE_BYTES) break;
    bytes += next;
    count += 1;
  }
  canonical.length = count;
  sizes.length = count;
  return { rows: count === rows.length ? rows : rows.slice(0, count), canonical, sizes,
    json: bytes <= COPY_PAGE_BYTES ? `[${canonical.join(',')}]` : null, bytes };
}

async function readCopyPage(db, columns, layout, candidates) {
  const selected = boundedCandidatePage(candidates, layout, 0, db[DIAGNOSTIC_PHASE]);
  const ids = selected.map((candidate) => candidate.id);
  const rows = await readBlockRows(db, columns, ids, layout, selected);
  if (rows.length !== ids.length) throw copyInvariant(COPY_INVARIANTS.SOURCE_PAGE_MISSING, 'frozen source page disappeared', COPY_PHASES.SOURCE_PAGE_READ);
  // A trim never advances the checkpoint over excluded IDs: the next keyset scan
  // starts at the last actually copied row, not the last candidate or transport row.
  return canonicalPage(columns, rows, db[DIAGNOSTIC_PHASE]);
}

async function replaceShardPage(db, columns, rows, layout) {
  db = phaseDb(db, COPY_PHASES.PAGE_WRITE);
  const idsJson = JSON.stringify(rows.map((row) => row.id));
  const page = canonicalPage(columns, rows, COPY_PHASES.PAGE_WRITE);
  if (page.rows.length !== rows.length) throw copyInvariant(COPY_INVARIANTS.PAGE_BYTES, 'shard page exceeds the canonical JSON byte cap', COPY_PHASES.PAGE_WRITE);
  const insert = page.bytes <= COPY_PAGE_BYTES
    ? { sql: `INSERT INTO blocks (${layout.quoted.join(',')})
        SELECT ${layout.paths.map((path) => `json_extract(value,${path})`).join(',')} FROM json_each(?)`, params: [page.json] }
    : { sql: `INSERT INTO blocks (${layout.quoted.join(',')}) VALUES (${inList(columns.length)})`,
        params: columns.map((column) => rows[0][column]) };
  // Ordinary pages use exactly four statements, independent of their row count.
  await db.batch([
    { sql: `INSERT INTO blocks_fts (blocks_fts, rowid, text)
      SELECT 'delete', id, text FROM blocks WHERE id IN (${JSON_IDS_SQL})`, params: [idsJson] },
    { sql: `DELETE FROM blocks WHERE id IN (${JSON_IDS_SQL})`, params: [idsJson] },
    insert,
    { sql: `INSERT INTO blocks_fts (rowid, text)
      SELECT id, text FROM blocks WHERE id IN (${JSON_IDS_SQL})`, params: [idsJson] },
  ]);
}

async function discardUnacknowledgedPage(shards, pending) {
  const idsByShard = shards.map(() => []);
  for (const row of pending.rows) idsByShard[row.shard].push(row.id);
  for (let index = 0; index < shards.length; index += 1) {
    if (!idsByShard[index].length) continue;
    const idsJson = JSON.stringify(idsByShard[index]);
    await phaseDb(shards[index], COPY_PHASES.DISCARD_PAGE).batch([
      { sql: `INSERT INTO blocks_fts (blocks_fts, rowid, text)
        SELECT 'delete', id, text FROM blocks WHERE id IN (${JSON_IDS_SQL})`, params: [idsJson] },
      { sql: `DELETE FROM blocks WHERE id IN (${JSON_IDS_SQL})`, params: [idsJson] },
    ]);
  }
}

async function pendingSourceChanged(source, state, layout) {
  const rows = await readBlockRows(source, state.columns, state.pending.rows.map((row) => row.id), layout);
  if (rows.length !== state.pending.rows.length) return true;
  const originals = new Map(rows.map((row) => [row.id, row]));
  return state.pending.rows.some((item) => !originals.has(item.id)
    || rowDigest(state.columns, originals.get(item.id), source[DIAGNOSTIC_PHASE]) !== item.sha256);
}

async function verifyPending(source, shards, state, layout) {
  const ids = state.pending.rows.map((row) => row.id);
  const remaining = new Map((await readBlockRows(source, state.columns, ids, layout)).map((row) => [row.id, row]));
  const verified = new Map();
  for (let shard = 0; shard < shards.length; shard += 1) {
    const items = state.pending.rows.filter((row) => row.shard === shard);
    if (!items.length) continue;
    const expected = new Set(items.map((item) => item.id));
    const destination = await readBlockRows(phaseDb(shards[shard], COPY_PHASES.PAGE_READBACK), state.columns, [...expected], layout);
    const found = new Map(destination.map((row) => [row.id, row]));
    if (destination.length !== items.length || found.size !== items.length
      || destination.some((row) => !expected.has(row.id))) {
      throw copyInvariant(COPY_INVARIANTS.DESTINATION_IDENTITY, 'destination readback cardinality/identity mismatch; source retained', COPY_PHASES.PAGE_READBACK);
    }
    for (const item of items) {
      if (!found.has(item.id) || rowDigest(state.columns, found.get(item.id), COPY_PHASES.PAGE_READBACK) !== item.sha256) {
        throw copyInvariant(COPY_INVARIANTS.READBACK_SHA256, 'readback SHA-256 mismatch; source retained', COPY_PHASES.PAGE_READBACK);
      }
      const original = remaining.get(item.id);
      if (original && rowDigest(state.columns, original, source[DIAGNOSTIC_PHASE]) !== item.sha256) {
        throw copyInvariant(COPY_INVARIANTS.SOURCE_CHANGED, 'frozen source changed; refusing deletion', COPY_PHASES.SOURCE_PAGE_READ);
      }
      if (!original && state.pending.phase !== 'verified') {
        throw copyInvariant(COPY_INVARIANTS.SOURCE_MISSING, 'unverified source block disappeared', COPY_PHASES.SOURCE_PAGE_READ);
      }
    }
    await verifyFts(shards[shard], destination);
    for (const row of destination) verified.set(row.id, row);
  }
  return verified;
}

async function finishPending(source, shards, state, gate, checkpoint, layout) {
  if (state.pending.phase === 'copying') {
    const rows = await readBlockRows(source, state.columns, state.pending.rows.map((row) => row.id), layout);
    const found = new Map(rows.map((row) => [row.id, row]));
    for (const item of state.pending.rows) {
      if (!found.has(item.id) || rowDigest(state.columns, found.get(item.id), source[DIAGNOSTIC_PHASE]) !== item.sha256) {
        throw copyInvariant(COPY_INVARIANTS.SOURCE_CHANGED, 'source block changed before copy', COPY_PHASES.SOURCE_PAGE_READ);
      }
    }
    const routed = shards.map(() => []);
    for (const row of rows) routed[indexShardForSessionId(row.session_id, shards.length)].push(row);
    for (let shard = 0; shard < shards.length; shard += 1) {
      if (routed[shard].length) await replaceShardPage(shards[shard], state.columns, routed[shard], layout);
    }
  }
  const verified = await verifyPending(source, shards, state, layout);
  await gate();
  state.pending.phase = 'verified';
  await checkpoint(state);
  // No source FTS DML: it can allocate new index pages on a database already at its cap.
  // The frozen, unreachable legacy FTS is dropped by the subsequent main migration.
  const ids = state.pending.rows.map((row) => row.id);
  const phase = await sourceFreezePhase(source);
  if (state.rows > 0 && phase !== 'frozen') throw copyInvariant(COPY_INVARIANTS.FREEZE_MISSING, 'source freeze vanished after verified deletion', COPY_PHASES.SOURCE_FREEZE_READ);
  const page = canonicalPage(state.columns, ids.map((id) => verified.get(id)), COPY_PHASES.SOURCE_DELETE_AND_FREEZE);
  if (page.rows.length !== ids.length) throw copyInvariant(COPY_INVARIANTS.PAGE_BYTES, 'verified source page exceeds the canonical JSON byte cap', COPY_PHASES.SOURCE_DELETE_AND_FREEZE);
  const idIndex = state.columns.indexOf('id');
  const statements = [page.bytes <= COPY_PAGE_BYTES ? {
    sql: `WITH verified(id,row) AS MATERIALIZED (
      SELECT json_extract(value,${layout.paths[idIndex]}), value FROM json_each(?)
    ) DELETE FROM blocks WHERE id IN (SELECT id FROM verified)
      AND EXISTS (SELECT 1 FROM verified WHERE verified.id = blocks.id
        AND ${layout.quoted.map((column, index) => `blocks.${column} IS json_extract(verified.row,${layout.paths[index]})`).join(' AND ')})`,
    params: [page.json],
  } : {
    sql: `DELETE FROM blocks WHERE ${layout.quoted.map((column) => `${column} IS ?`).join(' AND ')}`,
    params: state.columns.map((column) => page.rows[0][column]),
  }];
  if (phase === 'frozen') statements.unshift({
    sql: `UPDATE ${SOURCE_FREEZE_TABLE} SET state = 'copying' WHERE id = 1`, params: [],
  });
  statements.push(sourceEmptyAssertion(ids));
  if (phase === 'absent') statements.push(...sourceFreezeInstall());
  statements.push(
    { sql: `UPDATE ${SOURCE_FREEZE_TABLE} SET state = 'frozen' WHERE id = 1`, params: [] },
    { sql: `SELECT id FROM blocks WHERE id IN (${JSON_IDS_SQL})`, params: [JSON.stringify(ids)] },
  );
  // The temporary copying state and every delete are one transaction. Old HTTP
  // invocations never observe an unfrozen commit or delete newly changed row content.
  const deletion = await phaseDb(source, COPY_PHASES.SOURCE_DELETE_AND_FREEZE).batch(statements);
  if (deletion.length !== statements.length || !Array.isArray(deletion.at(-1)?.results)
    || deletion.at(-1).results.length) throw copyInvariant(COPY_INVARIANTS.SOURCE_DELETE, 'verified source deletion did not remove the whole page', COPY_PHASES.SOURCE_DELETE_AND_FREEZE);
  state.after = ids.at(-1);
  state.rows += ids.length;
  state.sha256 = sha(`${state.sha256}:${JSON.stringify(state.pending.rows)}`);
  state.pending = null;
  await checkpoint(state);
}

/** Frozen, bounded, resumable full-column copy. No source writes occur before verified readback. */
export async function copyFrozenIndex({ source, shards, gate, checkpointHook }) {
  source = phaseDb(source, COPY_PHASES.SOURCE_PAGE_READ);
  shards = shards.map((db) => phaseDb(db, COPY_PHASES.SETUP));
  await gate();
  const identity = copyIdentity(source, shards);
  const checkpoint = async (state) => {
    await writeCheckpoint(phaseDb(shards[0], COPY_PHASES.CHECKPOINT_WRITE), COPY_CHECKPOINT, state);
    await checkpointHook?.(structuredClone(state));
  };
  let state = await readCheckpoint(phaseDb(shards[0], COPY_PHASES.CHECKPOINT_READ), COPY_CHECKPOINT);
  if (state) assertIdentity(state, identity);
  if (state?.state === 'complete') {
    const tables = await source.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'blocks'");
    if (tables.length && (await source.query('SELECT id FROM blocks LIMIT 1')).length) {
      throw copyInvariant(COPY_INVARIANTS.SOURCE_REAPPEARED, 'source blocks reappeared after completed cutover', COPY_PHASES.SOURCE_PAGE_READ);
    }
    if (tables.length) await freezeEmptySource(source);
    return state;
  }
  const columns = await columnsFor(phaseDb(source, COPY_PHASES.SETUP), 'blocks');
  const layout = blockPageLayout(columns);
  await assertColumns(shards, 'blocks', columns);
  if (!state) {
    const [range] = await source.query('SELECT MIN(id) AS first_id, MAX(id) AS last_id FROM blocks');
    if ((range.first_id !== null && (!Number.isSafeInteger(range.first_id) || range.first_id < 0))
      || (range.last_id !== null && (!Number.isSafeInteger(range.last_id) || range.last_id >= INDEX_ID_SPAN))) {
      throw copyInvariant(COPY_INVARIANTS.SOURCE_RANGE, 'legacy block IDs exceed reserved safe copy range', COPY_PHASES.SOURCE_PAGE_READ);
    }
    state = { identity, columns, after: -1, rows: 0, sha256: sha(''), pending: null, state: 'pending' };
    await checkpoint(state);
  } else if (JSON.stringify(state.columns) !== JSON.stringify(columns)) {
    throw copyInvariant(COPY_INVARIANTS.SOURCE_COLUMNS, 'source columns changed since the frozen copy checkpoint', COPY_PHASES.SETUP);
  }
  if (state.rows === 0 && state.pending && await sourceFreezePhase(source) === 'absent'
    && await pendingSourceChanged(source, state, layout)) {
    // Entry-only recovery: absence of the transactionally installed guard proves
    // the first source DELETE never committed. Replan only changed/missing source
    // content; a still-valid pending verification must reuse its physical FTS copy.
    // Discard old replicas too, so authoritative source deletions leave no orphans.
    // A CAS failure in this invocation still throws without changing its checkpoint.
    await discardUnacknowledgedPage(shards, state.pending);
    state.pending = null;
    await checkpoint(state);
  }
  for (;;) {
    await gate();
    if (state.pending) await finishPending(source, shards, state, gate, checkpoint, layout);
    // The first bounded, verified page makes room for the atomic source-write barrier.
    const candidates = await blockCandidates(source, layout, { after: state.after });
    if (!candidates.length) {
      if ((await source.query('SELECT id FROM blocks LIMIT 1')).length) {
        throw copyInvariant(COPY_INVARIANTS.SOURCE_BEHIND_CURSOR, 'source contains rows behind the checkpoint; freeze invariant violated', COPY_PHASES.SOURCE_PAGE_READ);
      }
      await freezeEmptySource(source);
      state.state = 'complete';
      await checkpoint(state);
      return state;
    }
    const selected = await readCopyPage(source, columns, layout, candidates);
    const page = selected.rows.map((row, index) => ({
      id: row.id, shard: indexShardForSessionId(row.session_id, shards.length), sha256: sha(selected.canonical[index]),
    }));
    state.pending = { phase: 'copying', rows: page };
    await checkpoint(state);
  }
}

/** Read-only sampled cost estimate, not a throughput or completion-time promise. */
export async function sourceCopyForecast({ source, shards }) {
  const columns = await columnsFor(source, 'blocks');
  const layout = blockPageLayout(columns);
  // COUNT scans only the narrow row/index representation, never every text value.
  const [count] = await source.query('SELECT COUNT(*) AS rows FROM blocks');
  if (!count || !Number.isSafeInteger(count.rows) || count.rows < 0) throw new Error('invalid source row count');
  const remainingRows = count.rows;
  let sampledRows = 0;
  let sampledPages = 0;
  let totalRowBytes = 0;
  let maximumRowBytes = 0;
  let maximumPageRows = 0;
  let totalShardFanout = 0;
  let maximumShardFanout = 0;
  let totalLongSlices = 0;
  if (remainingRows) {
    const [range] = await source.query('SELECT MIN(id) AS first_id, MAX(id) AS last_id FROM blocks');
    if (!range || !Number.isSafeInteger(range.first_id) || range.first_id < 0
      || !Number.isSafeInteger(range.last_id) || range.last_id >= INDEX_ID_SPAN) {
      throw new Error('invalid source forecast range');
    }
    const scans = [{ after: -1 }];
    if (remainingRows > COPY_PAGE_ROWS) {
      scans.push({ after: Math.floor((range.first_id + range.last_id) / 2) - 1 });
      scans.push({ after: -1, descending: true });
    }
    const sampled = new Set();
    for (const scan of scans) {
      const candidates = await blockCandidates(source, layout, scan);
      if (!candidates.length) continue;
      const page = await readCopyPage(source, columns, layout, candidates);
      const sampleKey = page.rows.map((row) => row.id).join(',');
      if (sampled.has(sampleKey)) continue;
      sampled.add(sampleKey);
      const fanout = new Set();
      const rawBytesById = new Map(candidates.map((candidate) => [candidate.id, candidate.raw_bytes]));
      for (let index = 0; index < page.rows.length; index += 1) {
        const row = page.rows[index];
        fanout.add(indexShardForSessionId(row.session_id, shards.length));
        totalRowBytes += page.sizes[index];
        maximumRowBytes = Math.max(maximumRowBytes, page.sizes[index]);
        const inlineBytes = rawBytesById.get(row.id) > SMALL_ROW_BYTES ? layout.inlineBytes : SMALL_ROW_BYTES;
        for (const column of columns) {
          if (typeof row[column] !== 'string') continue;
          const bytes = Buffer.byteLength(row[column]);
          if (bytes > inlineBytes) totalLongSlices += Math.ceil(bytes / LONG_SLICE_BYTES);
        }
      }
      sampledRows += page.rows.length;
      sampledPages += 1;
      maximumPageRows = Math.max(maximumPageRows, page.rows.length);
      totalShardFanout += fanout.size;
      maximumShardFanout = Math.max(maximumShardFanout, fanout.size);
    }
  }
  const meanPageRows = sampledPages ? sampledRows / sampledPages : 0;
  const meanFanout = sampledPages ? totalShardFanout / sampledPages : 0;
  const meanLongSlices = sampledPages ? totalLongSlices / sampledPages : 0;
  const estimatedRemainingPages = meanPageRows ? Math.ceil(remainingRows / meanPageRows) : 0;
  // One ordinary page has a constant source/checkpoint cost plus four native RPCs
  // per occupied shard. Long values are read four times through verification.
  // Startup/cleanup, gate calls, latency and shared Cloudflare quota contention are
  // excluded. Dividing estimated API requests by the quota is only a lower bound.
  const estimatedRemainingRequests = Math.ceil(estimatedRemainingPages * (12 + 4 * meanFanout + 4 * meanLongSlices));
  return {
    kind: 'estimate', remainingRows, shardCount: shards.length,
    rowCap: COPY_PAGE_ROWS, byteCap: COPY_PAGE_BYTES, sampledRows, sampledPages,
    observedRowBytes: { total: totalRowBytes, mean: sampledRows ? totalRowBytes / sampledRows : 0, max: maximumRowBytes },
    observedPageRows: { mean: meanPageRows, max: maximumPageRows },
    observedShardFanout: { mean: meanFanout, max: maximumShardFanout },
    estimatedRemainingPages, estimatedRemainingRequests, requestRatePerSecond: CLOUDFLARE_REQUEST_RATE_PER_SECOND,
    estimatedApiTimeLowerBoundSeconds: estimatedRemainingRequests / CLOUDFLARE_REQUEST_RATE_PER_SECOND,
  };
}


/** Full metadata/stars seed after main DDL; a page is acknowledged only after all shards agree. */
export async function seedFrozenCatalog({ source, shards, gate, checkpointHook }) {
  await gate();
  const copied = await readCheckpoint(shards[0], COPY_CHECKPOINT);
  const identity = copyIdentity(source, shards);
  if (copied?.state !== 'complete') throw new Error('catalog seed requires a completed verified index copy');
  assertIdentity(copied, identity);
  let state = await readCheckpoint(shards[0], SEED_CHECKPOINT);
  if (state !== null) assertIdentity(state, identity);
  const ready = await readCheckpoint(shards[0], READY_CHECKPOINT);
  const activation = await readCheckpoint(shards[0], ACTIVATION_CHECKPOINT);
  if (activation !== null) {
    assertActivationProof({ source, shards, copy: copied, seed: state, ready, activation });
    throw new Error('initial activation is already proven; refusing catalog reseed');
  }
  if (ready !== null) assertReadyProof({ source, shards, copy: copied, seed: state, ready });
  const sessionColumns = await columnsFor(source, 'sessions');
  const starColumns = await columnsFor(source, 'starred_turns');
  await assertColumns(shards, 'sessions', sessionColumns);
  await assertColumns(shards, 'starred_turns', starColumns);
  if (JSON.stringify(sessionColumns) !== JSON.stringify(SESSION_CATALOG_COLUMNS)
    || JSON.stringify(starColumns) !== JSON.stringify(STAR_CATALOG_COLUMNS)) {
    throw new Error('catalog schema differs from the shared replication column contract');
  }
  // A deliberate pre-activation reseed invalidates its old READY before the seed snapshot
  // becomes pending. A crash at either boundary must classify pending, not as a corrupt proof.
  // Never clear an initial activation, and never discard malformed or foreign proofs.
  if (ready !== null) await shards[0].query('DELETE FROM index_migration_state WHERE name = ?', [READY_CHECKPOINT]);
  if (!state || state.state === 'complete') state = { identity, after: '', rows: 0, state: 'pending' };
  const checkpoint = async () => {
    await writeCheckpoint(shards[0], SEED_CHECKPOINT, state);
    await checkpointHook?.(structuredClone(state));
  };
  await checkpoint();
  for (;;) {
    await gate();
    let versions = await source.query(`SELECT session_id, version FROM session_catalog_versions
      WHERE session_id > ? ORDER BY session_id LIMIT ?`, [state.after, SEED_PAGE_ROWS]);
    const advancingScan = versions.length > 0;
    if (!advancingScan) {
      // Old HTTP metadata writes may finish after the queue/cron drain. Their outbox
      // entries, including versions behind the durable scan cursor, must be seeded too.
      versions = await source.query(`SELECT session_id, version FROM session_catalog_versions
        WHERE session_id IN (SELECT session_id FROM session_catalog_outbox
          GROUP BY session_id ORDER BY MIN(seq) LIMIT ?) ORDER BY session_id`, [SEED_PAGE_ROWS]);
      if (!versions.length) {
        if ((await source.query('SELECT seq FROM session_catalog_outbox LIMIT 1')).length) {
          throw new Error('outbox entry lacks an authoritative catalog version');
        }
        break;
      }
    }
    const ids = versions.map((row) => row.session_id);
    const snapshot = await source.batch([
      { sql: `SELECT session_id, version FROM session_catalog_versions WHERE session_id IN (${inList(ids.length)}) ORDER BY session_id`, params: ids },
      { sql: `SELECT * FROM sessions WHERE session_id IN (${inList(ids.length)}) ORDER BY session_id`, params: ids },
      { sql: `SELECT * FROM starred_turns WHERE session_id IN (${inList(ids.length)}) ORDER BY session_id, turn_key`, params: ids },
    ]);
    if (snapshot.length !== 3 || snapshot.some((result) => !Array.isArray(result.results))
      || JSON.stringify(snapshot[0].results.map((row) => [row.session_id, row.version]))
        !== JSON.stringify(versions.map((row) => [row.session_id, row.version]))) {
      throw new Error('frozen catalog version snapshot changed');
    }
    const sessions = snapshot[1].results;
    const stars = snapshot[2].results;
    const existing = new Set(sessions.map((row) => row.session_id));
    const sessionsById = new Map(sessions.map((row) => [row.session_id, row]));
    const entries = versions.map((row) => ({
      sessionId: row.session_id, version: row.version, session: sessionsById.get(row.session_id) ?? null,
      stars: stars.filter((star) => star.session_id === row.session_id),
    }));
    const batches = sessionCatalogBatches(entries);
    for (const db of shards) {
      for (const batch of batches) await db.batch(batch.statements);
      const readback = await db.batch([
        { sql: `SELECT * FROM sessions WHERE session_id IN (${inList(ids.length)}) ORDER BY session_id`, params: ids },
        { sql: `SELECT * FROM starred_turns WHERE session_id IN (${inList(ids.length)}) ORDER BY session_id, turn_key`, params: ids },
        { sql: `SELECT session_id, version, presence FROM catalog_versions
          WHERE session_id IN (${inList(ids.length)}) ORDER BY session_id`, params: ids },
      ]);
      if (readback.length !== 3 || readback.some((result) => !Array.isArray(result.results))) {
        throw new Error('catalog readback batch returned incomplete results');
      }
      const [catalog, copiedStars, copiedVersions] = readback.map((result) => result.results);
      if (sha(JSON.stringify(catalog.map((row) => canonicalRow(sessionColumns, row))))
        !== sha(JSON.stringify(sessions.map((row) => canonicalRow(sessionColumns, row))))) {
        throw new Error('session catalog readback differs from authoritative main');
      }
      if (sha(JSON.stringify(copiedStars.map((row) => canonicalRow(starColumns, row))))
        !== sha(JSON.stringify(stars.map((row) => canonicalRow(starColumns, row))))) {
        throw new Error('star catalog readback differs from authoritative main');
      }
      if (JSON.stringify(copiedVersions.map((row) => [row.session_id, row.version, row.presence]))
        !== JSON.stringify(versions.map((row) => [row.session_id, row.version, existing.has(row.session_id) ? 'present' : 'deleted']))) {
        throw new Error('catalog version/tombstone readback mismatch');
      }
    }
    await gate();
    await source.query(SESSION_CATALOG_RETIRE_SQL, [JSON.stringify(versions.map((row) => [row.session_id, row.version]))]);
    if (advancingScan) state.after = ids.at(-1);
    state.rows += ids.length;
    await checkpoint();
  }
  await gate();
  if ((await source.query('SELECT seq FROM session_catalog_outbox LIMIT 1')).length) {
    throw new Error('catalog changed while frozen; refusing active deployment');
  }
  state.state = 'complete';
  await checkpoint();
  return state;
}

/** Read-only bounded operational evidence; exact full-copy proof lives in COPY_CHECKPOINT. */
export async function verifyIndexRecords({ source, shards, catalogConsistency = 'observe' }) {
  if (!['required', 'observe'].includes(catalogConsistency)) throw new Error('invalid catalog consistency mode');
  const [main] = await source.query(`SELECT
    (SELECT COUNT(*) FROM sessions) AS sessions,
    (SELECT COUNT(*) FROM starred_turns) AS stars`);
  const evidence = [];
  for (let index = 0; index < shards.length; index += 1) {
    const db = shards[index];
    const [meta] = await db.query('SELECT * FROM shard_meta WHERE id = 1');
    if (!meta || meta.shard_index !== index || meta.shard_count !== shards.length || meta.layout !== INDEX_LAYOUT) {
      throw new Error('live index shard layout mismatch');
    }
    const [counts] = await db.query(`SELECT
      (SELECT COUNT(*) FROM blocks) AS blocks,
      (SELECT COUNT(*) FROM sessions) AS sessions,
      (SELECT COUNT(*) FROM starred_turns) AS stars`);
    if (catalogConsistency === 'required' && (counts.sessions !== main.sessions || counts.stars !== main.stars)) {
      throw new Error('frozen complete catalog counts differ from main');
    }
    const columns = await columnsFor(db, 'blocks');
    const ids = (await db.query('SELECT id FROM blocks ORDER BY id LIMIT 4')).map((row) => row.id);
    const blocks = ids.length ? await readBlockRows(db, columns, ids) : [];
    for (const row of blocks) {
      if (indexShardForSessionId(row.session_id, shards.length) !== index) throw new Error('sampled block is routed to the wrong shard');
      if (row.id >= INDEX_ID_SPAN && (row.id < indexIdBase(index) || row.id >= indexIdBase(index) + INDEX_ID_SPAN)) {
        throw new Error('sampled block has an invalid shard allocator ID');
      }
    }
    if (blocks.length) await verifyFts(db, blocks);
    else await db.query('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ? LIMIT 1', ['\"index-migration-empty-probe\"']);
    const catalog = await db.query(`SELECT s.*, c.version AS __version, c.presence AS __presence
      FROM sessions s LEFT JOIN catalog_versions c USING (session_id) ORDER BY s.session_id LIMIT 4`);
    if (catalog.some((row) => !Number.isSafeInteger(row.__version) || row.__version < 1 || row.__presence !== 'present')) {
      throw new Error('sampled live catalog version/tombstone mismatch');
    }
    evidence.push({ shard: index, blockCount: counts.blocks, sessionCount: counts.sessions, starCount: counts.stars,
      blockSampleSha256: sha(JSON.stringify(blocks.map((row) => canonicalRow(columns, row)))),
      catalogSampleSha256: sha(JSON.stringify(catalog.map((row) => canonicalRow(SESSION_CATALOG_COLUMNS, row)))) });
  }
  return { mainSessions: main.sessions, mainStars: main.stars, shards: evidence };
}

export function classifyIndexMigration({ source, shards, legacyTables, copy, seed, ready, activation }) {
  const identity = copyIdentity(source, shards);
  if (copy !== undefined && copy !== null) assertIdentity(copy, identity);
  if (seed !== undefined && seed !== null) assertIdentity(seed, identity);
  if (ready !== undefined && ready !== null) assertReadyProof({ source, shards, copy, seed, ready });
  if (activation !== undefined && activation !== null) assertActivationProof({ source, shards, copy, seed, ready, activation });
  if (legacyTables.includes('blocks') || legacyTables.includes('blocks_fts')) return copy ? 'pending' : 'legacy';
  if (copy?.state === 'complete' && seed?.state === 'complete' && activation
    && !legacyTables.includes(SOURCE_FREEZE_TABLE)) return 'active';
  if (copy?.state === 'complete') return 'pending';
  throw new Error('main has no legacy source and no completed verified copy; refusing deployment');
}

/** One bounded active-mode outbox page, using exactly the Worker's monotonic builders. */
export async function reconcileIndexCatalog({ source, shards }) {
  const pending = await source.query(`SELECT session_id FROM session_catalog_outbox
    GROUP BY session_id ORDER BY MIN(seq) LIMIT ?`, [CATALOG_PAGE_ROWS]);
  if (!pending.length) return { state: 'current', synced: 0 };
  const ids = pending.map((row) => row.session_id);
  const snapshot = await source.batch([
    { sql: `SELECT session_id, version FROM session_catalog_versions WHERE session_id IN (${inList(ids.length)}) ORDER BY session_id`, params: ids },
    { sql: `SELECT * FROM sessions WHERE session_id IN (${inList(ids.length)}) ORDER BY session_id`, params: ids },
    { sql: `SELECT * FROM starred_turns WHERE session_id IN (${inList(ids.length)}) ORDER BY session_id, turn_key`, params: ids },
  ]);
  if (snapshot.length !== 3 || snapshot.some((result) => !Array.isArray(result.results))
    || snapshot[0].results.length !== ids.length) throw new Error('outbox catalog snapshot is incomplete');
  const [versions, sessions, stars] = snapshot.map((result) => result.results);
  const byId = new Map(sessions.map((row) => [row.session_id, row]));
  const versionById = new Map(versions.map((row) => [row.session_id, row.version]));
  const batches = sessionCatalogBatches(versions.map((row) => ({
    sessionId: row.session_id, version: row.version, session: byId.get(row.session_id) ?? null,
    stars: stars.filter((star) => star.session_id === row.session_id),
  })));
  let synced = 0;
  for (const batch of batches) {
    for (const db of shards) await db.batch(batch.statements);
    await source.query(SESSION_CATALOG_RETIRE_SQL, [
      JSON.stringify(batch.sessionIds.map((id) => [id, versionById.get(id)])),
    ]);
    synced += batch.sessionIds.length;
  }
  const remaining = await source.query('SELECT seq FROM session_catalog_outbox LIMIT 1');
  return { state: remaining.length ? 'pending' : 'current', synced };
}
