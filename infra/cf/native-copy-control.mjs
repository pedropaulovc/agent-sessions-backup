import { createHash, randomBytes } from 'node:crypto';
import {
  PREVIEW_D1_DATABASE_LIMIT, paginatedList, positiveInteger,
  previewCopyScratchNames, previewResourceOwner,
} from './preview-trust.mjs';
import {
  COPY_CHECKPOINT, COPY_INVARIANTS, COPY_PAGE_BYTES, COPY_PAGE_ROWS, COPY_PHASES, SOURCE_FREEZE_TABLE, canonicalRow,
  copyFrozenIndex, readCheckpoint,
} from '../../hub/scripts/lib/index-migration.mjs';
import { BLOCK_COLUMNS, INDEX_ID_SPAN, indexShardForSessionId } from '../../hub/src/index-layout.mjs';
import { D1_FAILURE_KINDS, D1_SQL_FAILURE_REASONS } from './d1-batch-atomicity.mjs';

const copyPhases = Object.freeze(Object.values(COPY_PHASES));
const copyInvariants = Object.freeze(Object.values(COPY_INVARIANTS));

// No causes/stacks from a provider or subprocess are retained in public diagnostics.
export class NativeCopyControlError extends Error {
  constructor(phase, failureClass, { invariant, failureKind, cleanupClass, cleanupFailureKind } = {}) {
    super(`native copy control phase=${phase} class=${failureClass}`
      + (invariant ? ` invariant=${invariant}` : '')
      + (failureKind ? ` failure=${failureKind}` : '')
      + (cleanupClass ? ` cleanup=failed cleanupClass=${cleanupClass}` : '')
      + (cleanupFailureKind ? ` cleanupFailure=${cleanupFailureKind}` : ''));
    this.name = 'NativeCopyControlError';
    this.nativeCopyPhase = phase;
    this.nativeCopyClass = failureClass;
    if (invariant) this.nativeCopyInvariant = invariant;
    if (failureKind) this.nativeCopyFailureKind = failureKind;
    if (cleanupClass) {
      this.nativeCopyCleanup = 'failed';
      this.nativeCopyCleanupClass = cleanupClass;
      if (cleanupFailureKind) this.nativeCopyCleanupFailureKind = cleanupFailureKind;
    }
  }
}
const reject = (phase, failureClass = 'assertion') => { throw new NativeCopyControlError(phase, failureClass); };
const requireProof = (condition, phase) => { if (!condition) reject(phase); };
function safeFailure(error, phase) {
  if (error instanceof NativeCopyControlError) return error;
  const invariant = copyInvariants.includes(error?.code) ? error.code : undefined;
  return new NativeCopyControlError(copyPhases.includes(error?.d1Phase) ? error.d1Phase : phase,
    invariant ? 'assertion' : D1_SQL_FAILURE_REASONS.includes(error?.d1SqlReason) ? error.d1SqlReason : 'other',
    { invariant, failureKind: D1_FAILURE_KINDS.includes(error?.d1FailureKind) ? error.d1FailureKind : undefined });
}

function ownedIdentity(database, pr, names) {
  const owner = previewResourceOwner(database?.name, 'd1');
  return owner?.pr === pr && owner.scope === 'copy-probe' && owner.legacy === false
    && names.includes(database.name) && typeof database.uuid === 'string' && database.uuid.length > 0;
}
async function databaseIdentity(api, database, pr, names, absentPolicy = 'required') {
  let current;
  try { current = await api.cf(`d1/database/${encodeURIComponent(database.uuid)}`); }
  catch (error) {
    if (absentPolicy === 'allow' && error?.providerStatus === 404) return null;
    throw error;
  }
  if (!ownedIdentity(current, pr, names) || current.uuid !== database.uuid || current.name !== database.name) {
    reject(absentPolicy === 'allow' ? 'cleanup' : 'identity', 'ownership');
  }
  return current;
}

/** Never adopt an existing name/ID, and never make room by deleting another resource. */
export async function withScratchD1Databases({ api, pr, nonce = randomBytes(12).toString('hex'), run }) {
  const created = [];
  let phase = 'preflight';
  let ownerPr;
  let names;
  let result;
  let failure;
  try {
    ownerPr = positiveInteger(pr, 'PR number');
    names = previewCopyScratchNames(ownerPr, nonce);
    const databases = await paginatedList(async (...args) => {
      const envelope = await api.cf(...args);
      if (!Array.isArray(envelope?.result)) reject('preflight', 'shape');
      return envelope;
    }, 'd1/database', { pagination: 'page', rowsOf: (envelope) => envelope.result });
    if (databases.some((database) => names.includes(database?.name))) reject(phase, 'ownership');
    if (databases.length + names.length > PREVIEW_D1_DATABASE_LIMIT) reject(phase, 'quota');
    const knownIds = new Set(databases.map((database) => database?.uuid));
    for (const name of names) {
      phase = 'create';
      const database = await api.cf('d1/database', { method: 'POST', body: JSON.stringify({ name }) });
      if (!ownedIdentity(database, ownerPr, names) || database.name !== name || knownIds.has(database.uuid)) {
        reject(phase, 'ownership');
      }
      // Record a proven returned identity before subsequent metadata reads can fail.
      created.push({ name, uuid: database.uuid });
      knownIds.add(database.uuid);
    }
    const gate = async () => {
      for (const database of created) await databaseIdentity(api, database, ownerPr, names);
    };
    phase = 'identity';
    await gate();
    const adapters = created.map((database) => api.db(database.uuid));
    if (adapters.some((db, index) => db?.id !== created[index].uuid)) reject(phase, 'ownership');
    phase = 'control';
    result = await run({ source: adapters[0], shards: adapters.slice(1), gate,
      identities: created.map(({ name, uuid }) => ({ name, id: uuid })) });
  } catch (error) {
    failure = safeFailure(error, phase);
  }
  let cleanupFailure;
  for (const database of created) {
    try {
      if (!ownedIdentity(database, ownerPr, names)) reject('cleanup', 'ownership');
      if (await databaseIdentity(api, database, ownerPr, names, 'allow')) {
        await api.cf(`d1/database/${encodeURIComponent(database.uuid)}`, { method: 'DELETE' });
      }
    } catch (error) {
      // One refused/failed deletion must not skip the remaining known owned DBs.
      cleanupFailure ??= safeFailure(error, 'cleanup');
    }
  }
  if (cleanupFailure) {
    failure = failure ? new NativeCopyControlError(failure.nativeCopyPhase, failure.nativeCopyClass, {
      invariant: failure.nativeCopyInvariant, failureKind: failure.nativeCopyFailureKind,
      cleanupClass: cleanupFailure.nativeCopyClass,
      cleanupFailureKind: cleanupFailure.nativeCopyFailureKind,
    }) : cleanupFailure;
  }
  if (failure) throw failure;
  return result;
}

const quote = (column) => `"${column.replaceAll('"', '""')}"`;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const rowsSha256 = (rows) => sha256(`[${rows.map((row) => canonicalRow(BLOCK_COLUMNS, row)).join(',')}]`);
const INSERT_BLOCK = `INSERT INTO blocks (${BLOCK_COLUMNS.map(quote).join(',')}) VALUES (${BLOCK_COLUMNS.map(() => '?').join(',')})`;
const blockStatement = (row) => ({ sql: INSERT_BLOCK, params: BLOCK_COLUMNS.map((column) => row[column]) });
const DENSE_ROWS = 1461;
const DENSE_SUFFIX_TOKEN = 'nativedensesuffix';
const DENSE_TOKENIZER_CASES = [
  { text: 'nativevariedalpha', tokens: ['nativevariedalpha'] },
  { text: 'nativevariedbravo', tokens: ['nativevariedbravo'] },
  { text: 'nativevariedcharlie', tokens: ['nativevariedcharlie'] },
  { text: 'nativevarieddelta', tokens: ['nativevarieddelta'] },
  { text: 'nativevariedecho', tokens: ['nativevariedecho'] },
  { text: 'nativevariedfoxtrot', tokens: ['nativevariedfoxtrot'] },
  { text: '🫠alpha', tokens: ['🫠alpha'], absent: ['alpha'] },
  { text: '🫠 alpha', tokens: ['🫠', 'alpha'] },
  { text: '🧮alpha', tokens: ['🧮alpha'], absent: ['alpha'] },
  { text: '🧠alpha', tokens: ['🧠alpha'], absent: ['alpha'] },
  { text: '🛠alpha', tokens: ['🛠alpha'], absent: ['alpha'] },
  { text: 'al🫠pha', tokens: ['al🫠pha'], absent: ['al'] },
  { text: '₿alpha', tokens: ['₿alpha'], absent: ['alpha'] },
  { text: '\u{1CF00}alpha', tokens: ['\u{1CF00}alpha'], absent: ['alpha'] },
  { text: '🫠', tokens: ['🫠'], only: true },
  { text: '! ? : ; ( ) [ ] { } \t\n\u0000', tokens: [], absent: ['index-migration-tokenless-probe', '🫠', 'alpha'], only: true },
  ...[
    `a${'中'.repeat(11000)}`,
    `a${'🫠'.repeat(8250)}`,
    `a${'Ж'.repeat(16500)}`,
    `a${'ø'.repeat(16500)}`,
  ].map((text) => ({ text, tokens: [text], only: true })),
];
const GROWTH_ROWS = 46;
const GROWTH_WORD = `a${'Ⱥ'.repeat(11000)}`;
const READBACK_PAGE_ROWS = 256;
// Fold-growth words would otherwise create a multi-MiB hex response at 256
// rows. Only this independent proof reader uses the existing slice transport
// above 16 KiB; the copier's source/readback budgets are unchanged.
const READBACK_INLINE_BYTES = 16384;
const READBACK_BATCH_STATEMENTS = 100;
const READBACK_RESPONSE_RESERVE_BYTES = 4096;
function sessionOn(shard) {
  for (let index = 0; ; index += 1) {
    const sessionId = `native-copy-会話-${shard}-${index}`;
    if (indexShardForSessionId(sessionId, 2) === shard) return sessionId;
  }
}
function fixtures() {
  const ordinary = {
    id: 0, session_id: sessionOn(0), file_id: Number.MAX_SAFE_INTEGER,
    turn_index: 0, block_index: 2_147_483_647, role: null, btype: 'text',
    tool_name: '\ufefftool-α😀\u0000suffix', ts: null, byte_start: Number.MIN_SAFE_INTEGER,
    byte_len: 0, truncated: 0, text: '\ufeffnativeordinaryvisible café 会話 😀 e\u0301\u0000 nativeordinarysuffix',
    on_main_path: 1, row_hash: Number.MAX_SAFE_INTEGER,
    media_byte_start: null, media_byte_len: 0, media_type: '',
  };
  const long = {
    id: INDEX_ID_SPAN - 1, session_id: sessionOn(1), file_id: 4_294_967_297,
    turn_index: 4_294_967_295, block_index: 0, role: '', btype: 'text', tool_name: null,
    ts: '', byte_start: Number.MAX_SAFE_INTEGER, byte_len: 1_100_000, truncated: 1,
    text: `\ufeffnativelongvisible café 会話 😀 e\u0301 ${' '.repeat(1_100_000)}\u0000 nativelongsuffix`,
    on_main_path: 0, row_hash: Number.MIN_SAFE_INTEGER,
    media_byte_start: 4_294_967_311, media_byte_len: null, media_type: 'image/α😀',
  };
  // One source page contains the ordinary row on IDX00 and all 1,461 dense
  // rows on IDX01, including four 33,001-byte no-tail words. Compact remaining
  // prefixes keep that geometry bounded; the long row keeps its fallback page.
  const dense = Array.from({ length: DENSE_ROWS }, (_, index) => ({
    id: index + 1, session_id: long.session_id, file_id: 0,
    turn_index: 0, block_index: index, role: null, btype: 'text', tool_name: null,
    ts: '', byte_start: 0, byte_len: 0, truncated: 0,
    text: DENSE_TOKENIZER_CASES[index]?.only ? DENSE_TOKENIZER_CASES[index].text
      : `${DENSE_TOKENIZER_CASES[index]?.text ?? `v${index}`}\u0000 ${DENSE_SUFFIX_TOKEN}`,
    on_main_path: 1, row_hash: index + 1,
    media_byte_start: null, media_byte_len: 0, media_type: '',
  }));
  const growth = Array.from({ length: GROWTH_ROWS }, (_, index) => ({
    ...dense[0], id: DENSE_ROWS + index + 1, block_index: DENSE_ROWS + index,
    row_hash: DENSE_ROWS + index + 1, text: `${GROWTH_WORD}${index}`,
  }));
  const ordinaryRows = [ordinary, ...dense];
  requireProof(ordinaryRows.length <= COPY_PAGE_ROWS
    && Buffer.byteLength(`[${ordinaryRows.map((row) => canonicalRow(BLOCK_COLUMNS, row)).join(',')}]`) < COPY_PAGE_BYTES,
  'fixture');
  requireProof(Buffer.byteLength(canonicalRow(BLOCK_COLUMNS, ordinary)) < COPY_PAGE_BYTES, 'fixture');
  requireProof(Buffer.byteLength(canonicalRow(BLOCK_COLUMNS, long)) > COPY_PAGE_BYTES
    && BLOCK_COLUMNS.reduce((bytes, column) => bytes + (long[column] === null ? 0 : Buffer.byteLength(String(long[column]))), 0) < 2_000_000,
  'fixture');
  return { ordinary, long, dense, growth, rows: [...ordinaryRows, ...growth, long] };
}

// Execute the same native per-cell slices, packing requests AND their known hex
// responses. The 4 KiB per-result/outer reserves are conservative internal policy,
// not a native API limit; never widen the inline pages to hide response growth.
async function readLongCells(db, cells, phase) {
  let statements = [];
  let slices = [];
  let requestBytes = 12; // {"batch":[]}
  let responseBytes = READBACK_RESPONSE_RESERVE_BYTES;
  const flush = async () => {
    const results = await db.batch(statements);
    requireProof(Array.isArray(results) && results.length === slices.length
      && Buffer.byteLength(JSON.stringify(results)) <= COPY_PAGE_BYTES, phase);
    for (const [index, result] of results.entries()) {
      const parts = result?.results;
      const { cell, count, offset } = slices[index];
      requireProof(result?.success === true && Array.isArray(parts) && parts.length === 1
        && typeof parts[0].bytes === 'string' && parts[0].bytes.length === count * 2
        && /^[0-9a-f]+$/i.test(parts[0].bytes) && cell.written === offset
        && offset + count <= cell.length, phase);
      requireProof(cell.bytes.write(parts[0].bytes, offset, count, 'hex') === count, phase);
      cell.written += count;
    }
    statements = [];
    slices = [];
    requestBytes = 12;
    responseBytes = READBACK_RESPONSE_RESERVE_BYTES;
  };
  for (const cell of cells) {
    requireProof(Number.isSafeInteger(cell.row.id) && Number.isSafeInteger(cell.length)
      && cell.length > READBACK_INLINE_BYTES && cell.bytes.length === cell.length, phase);
    for (let offset = 0; offset < cell.length; offset += 131072) {
      const count = Math.min(131072, cell.length - offset);
      const statement = {
        sql: `SELECT hex(substr(CAST(${quote(cell.column)} AS BLOB), ?, ?)) AS bytes FROM blocks WHERE id = CAST(? AS INTEGER)`,
        params: [offset + 1, count, cell.row.id],
      };
      const bytes = Buffer.byteLength(JSON.stringify(statement));
      const replyBytes = count * 2 + READBACK_RESPONSE_RESERVE_BYTES;
      requireProof(12 + bytes <= COPY_PAGE_BYTES
        && READBACK_RESPONSE_RESERVE_BYTES + replyBytes <= COPY_PAGE_BYTES, phase);
      if (statements.length && (statements.length === READBACK_BATCH_STATEMENTS
        || requestBytes + bytes + 1 > COPY_PAGE_BYTES || responseBytes + replyBytes > COPY_PAGE_BYTES)) await flush();
      requestBytes += bytes + (statements.length ? 1 : 0);
      responseBytes += replyBytes;
      statements.push(statement);
      slices.push({ cell, count, offset });
    }
  }
  if (statements.length) await flush();
  for (const { row, column, length, bytes, written } of cells) {
    requireProof(written === length, phase);
    try { row[column] = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { reject(phase); }
  }
}

/** Independent native readback: TEXT is hex transported, long TEXT in bounded BLOB slices. */
async function readRows(db, phase) {
  const selectors = BLOCK_COLUMNS.flatMap((column, index) => {
    const name = quote(column);
    return [
      `CASE WHEN typeof(${name}) = 'text' THEN CASE WHEN length(CAST(${name} AS BLOB)) <= ${READBACK_INLINE_BYTES} THEN hex(CAST(${name} AS BLOB)) ELSE NULL END ELSE ${name} END AS ${name}`,
      `typeof(${name}) AS "__type_${index}"`,
      `CASE WHEN typeof(${name}) = 'text' THEN length(CAST(${name} AS BLOB)) ELSE NULL END AS "__bytes_${index}"`,
    ];
  });
  const rows = [];
  let after = -1;
  for (;;) {
    const result = await db.query(`SELECT ${selectors.join(',')} FROM blocks WHERE id > CAST(? AS INTEGER) ORDER BY id LIMIT ?`,
      [after, READBACK_PAGE_ROWS]);
    requireProof(result.length <= READBACK_PAGE_ROWS, phase);
    const longCells = [];
    for (const encoded of result) {
      requireProof(Number.isSafeInteger(encoded.id) && encoded.id > after, phase);
      const row = {};
      for (const [index, column] of BLOCK_COLUMNS.entries()) {
        const type = encoded[`__type_${index}`];
        const length = encoded[`__bytes_${index}`];
        const value = encoded[column];
        if (type !== 'text') {
          requireProof((type === 'null' && value === null) || (type === 'integer' && Number.isSafeInteger(value)), phase);
          row[column] = value;
          continue;
        }
        requireProof(Number.isSafeInteger(length) && length >= 0 && length < 2_000_000, phase);
        let bytes;
        if (length <= READBACK_INLINE_BYTES) {
          requireProof(typeof value === 'string' && value.length === length * 2 && /^[0-9a-f]*$/i.test(value), phase);
          bytes = Buffer.from(value, 'hex');
        } else {
          requireProof(value === null, phase);
          longCells.push({ row, column, length, bytes: Buffer.allocUnsafe(length), written: 0 });
          continue;
        }
        row[column] = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      }
      rows.push(row);
      after = row.id;
    }
    if (longCells.length) await readLongCells(db, longCells, phase);
    if (result.length < READBACK_PAGE_ROWS) break;
  }
  return rows;
}

// Preserve the independent ORIGINAL whole-word point SQL, but send the fixture's
// at-most-46 statements in one bounded native read batch instead of 46 paced RPCs.
// Neither these inputs nor these actual rowid results come from the copier oracle.
async function matchOriginalGrowthWords(db, rows, phase) {
  requireProof(rows.length > 0 && rows.length <= GROWTH_ROWS, phase);
  const statements = rows.map((row) => ({
    sql: 'SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ? AND rowid = CAST(? AS INTEGER)',
    params: [`"${row.text.replaceAll('"', '""')}"`, row.id],
  }));
  requireProof(Buffer.byteLength(JSON.stringify({ batch: statements })) <= COPY_PAGE_BYTES, phase);
  const results = await db.batch(statements);
  requireProof(Array.isArray(results) && results.length === rows.length, phase);
  const found = new Set();
  for (const [index, result] of results.entries()) {
    const hits = result?.results;
    requireProof(result?.success === true && Array.isArray(hits) && hits.length === 1
      && Number.isSafeInteger(hits[0].rowid) && hits[0].rowid === rows[index].id
      && !found.has(hits[0].rowid), phase);
    found.add(hits[0].rowid);
  }
  return found.size;
}
async function assertFrozen(source) {
  const objects = await source.query(`SELECT type, name FROM sqlite_master WHERE name IN (
    '${SOURCE_FREEZE_TABLE}', 'index_migration_blocks_insert', 'index_migration_blocks_update', 'index_migration_blocks_delete')`);
  requireProof(objects.length === 4 && objects.filter((object) => object.type === 'table' && object.name === SOURCE_FREEZE_TABLE).length === 1
    && objects.filter((object) => object.type === 'trigger').length === 3, 'source-fence');
  const rows = await source.query(`SELECT id, state FROM ${SOURCE_FREEZE_TABLE}`);
  requireProof(rows.length === 1 && rows[0].id === 1 && rows[0].state === 'frozen', 'source-fence');
}

// Run only after the complete public positive proof, reusing its owned scratch
// databases. Raw invalid TEXT never crosses the REST response or public output:
// only the copier itself attempts that transport; retention uses SQL hex().
async function proveNativeRetirementDiagnostic({ source, shards, gate, ordinary, expected }) {
  const phase = 'retirement-diagnostic';
  const probe = { ...ordinary, id: INDEX_ID_SPAN - 2, text: 'nativeinvalidtext' };
  requireProof(!expected.some((row) => row.id === probe.id), phase);
  const decoded = await source.query("SELECT hex(unhex('61FF62')) AS bytes");
  requireProof(decoded.length === 1 && decoded[0].bytes === '61FF62', phase);
  // Only this disposable copy checkpoint is reset; no catalog/activation state
  // and no destination rows from the 1,509-row proof are removed.
  await shards[0].query('DELETE FROM index_migration_state WHERE name = ?', [COPY_CHECKPOINT]);
  requireProof(await readCheckpoint(shards[0], COPY_CHECKPOINT) === null, phase);
  const textIndex = BLOCK_COLUMNS.indexOf('text');
  await source.batch([
    { sql: `UPDATE ${SOURCE_FREEZE_TABLE} SET state = 'copying' WHERE id = 1`, params: [] },
    {
      sql: `INSERT INTO blocks (${BLOCK_COLUMNS.map(quote).join(',')})
        VALUES (${BLOCK_COLUMNS.map((_, index) => index === textIndex ? "CAST(X'61FF62' AS TEXT)" : '?').join(',')})`,
      params: BLOCK_COLUMNS.filter((_, index) => index !== textIndex).map((column) => probe[column]),
    },
    { sql: `UPDATE ${SOURCE_FREEZE_TABLE} SET state = 'frozen' WHERE id = 1`, params: [] },
  ]);
  const rawSource = () => source.query(
    'SELECT id, typeof(text) AS storage_type, hex(CAST(text AS BLOB)) AS bytes FROM blocks ORDER BY id');
  const before = await rawSource();
  requireProof(before.length === 1 && before[0].id === probe.id
    && before[0].storage_type === 'text' && before[0].bytes === '61FF62', phase);
  await assertFrozen(source);
  let checkpointSnapshot = JSON.stringify(null);
  let originalError;
  let retirementBatches = 0;
  let diagnosticQueries = 0;
  let writesAfterFailure = 0;
  const observedSource = {
    id: source.id,
    async query(sql, params = []) {
      if (originalError) {
        diagnosticQueries += 1;
        requireProof(/^\s*WITH verified\b/.test(sql), phase);
      }
      return await source.query(sql, params);
    },
    async batch(statements) {
      if (originalError) writesAfterFailure += 1;
      const retirement = statements.some(({ sql }) => /\bDELETE FROM blocks\b/.test(sql));
      if (retirement) {
        retirementBatches += 1;
        requireProof(statements.length === 5
          && statements.reduce((count, statement) => count + statement.params.length, 0) === 3, phase);
        const durable = await readCheckpoint(shards[0], COPY_CHECKPOINT);
        requireProof(durable?.pending?.phase === 'verified'
          && JSON.stringify(durable) === checkpointSnapshot, phase);
        await assertFrozen(source);
      }
      try { return await source.batch(statements); }
      catch (error) {
        if (retirement) originalError = error;
        throw error;
      }
    },
  };
  let failure;
  try {
    await copyFrozenIndex({
      source: observedSource, shards, gate,
      checkpointHook: async (checkpoint) => {
        const durable = await readCheckpoint(shards[0], COPY_CHECKPOINT);
        requireProof(JSON.stringify(durable) === JSON.stringify(checkpoint), phase);
        checkpointSnapshot = JSON.stringify(durable);
      },
    });
  } catch (error) { failure = error; }
  requireProof(failure !== undefined && writesAfterFailure === 0, phase);
  requireProof(JSON.stringify(await rawSource()) === JSON.stringify(before), phase);
  await assertFrozen(source);
  const retained = await readCheckpoint(shards[0], COPY_CHECKPOINT);
  requireProof(JSON.stringify(retained) === checkpointSnapshot, phase);
  // The negative copy can add its collision-free row, but must not change any
  // original destination value or its native FTS entry.
  for (const [index, db] of shards.entries()) {
    const rows = (await readRows(db, phase)).filter((row) => row.id !== probe.id);
    const wanted = expected.filter((row) => indexShardForSessionId(row.session_id, shards.length) === index);
    requireProof(rows.length === wanted.length && rowsSha256(rows) === rowsSha256(wanted), phase);
    const indexed = await db.query('SELECT rowid FROM blocks_fts WHERE rowid != CAST(? AS INTEGER) ORDER BY rowid', [probe.id]);
    requireProof(indexed.length === wanted.length
      && indexed.every((row, offset) => row.rowid === wanted[offset].id), phase);
  }
  if (!retirementBatches) {
    // REST may reject invalid TEXT before the verified retirement transaction.
    // Report that public boundary honestly, rather than claiming the diagnostic
    // was exercised. Only allowlisted native classification leaves this helper.
    const safe = safeFailure(failure, phase);
    return { outcome: 'rejected-before-retirement', phase: safe.nativeCopyPhase,
      nativeClass: safe.nativeCopyClass,
      ...(safe.nativeCopyInvariant ? { invariant: safe.nativeCopyInvariant } : {}),
      ...(safe.nativeCopyFailureKind ? { failureKind: safe.nativeCopyFailureKind } : {}),
      sourceRetention: 'retained', freezeRetention: 'frozen', checkpointRetention: 'retained',
      positiveRowsRetained: expected.length };
  }
  requireProof(retirementBatches === 1 && failure === originalError
    && failure.d1Phase === COPY_PHASES.SOURCE_DELETE_AND_FREEZE
    && failure.d1SqlReason === 'malformed-json' && diagnosticQueries === 1
    && retained?.pending?.phase === 'verified' && retained.rows === 0
    && retained.pending.rows.length === 1 && retained.pending.rows[0].id === probe.id, phase);
  const comparison = {
    status: 'mismatch', expectedRows: 1, presentRows: 1, missingRows: 0, mismatchingRows: 1,
    columns: [{ index: textIndex, mismatchingRows: 1, typeMismatchRows: 0,
      byteMismatchRows: 1, lengthMismatchRows: 1, sourceTypes: ['text'], snapshotTypes: ['text'] }],
  };
  requireProof(JSON.stringify(failure.d1SourceComparison) === JSON.stringify(comparison), phase);
  return { outcome: 'verified', phase: COPY_PHASES.SOURCE_DELETE_AND_FREEZE,
    nativeClass: 'malformed-json', statements: 5, binds: 3, comparison,
    sourceRetention: 'retained', freezeRetention: 'frozen', checkpointRetention: 'retained',
    positiveRowsRetained: expected.length };
}

async function proveNativeCopy({ source, shards, gate }) {
  let phase = 'seed';
  try {
    const { ordinary, long, dense, growth, rows: expected } = fixtures();
    const expectedSha256 = rowsSha256(expected);
    await source.batch([
      blockStatement(ordinary),
      {
        sql: `INSERT INTO blocks (${BLOCK_COLUMNS.map(quote).join(',')})
          SELECT ${BLOCK_COLUMNS.map((_, index) => `json_extract(value,'$[${index}]')`).join(',')} FROM json_each(?)`,
        params: [`[${dense.map((row) => canonicalRow(BLOCK_COLUMNS, row)).join(',')}]`],
      },
      {
        sql: `INSERT INTO blocks (${BLOCK_COLUMNS.map(quote).join(',')})
          SELECT ${BLOCK_COLUMNS.map((_, index) => `json_extract(value,'$[${index}]')`).join(',')} FROM json_each(?)`,
        params: [`[${growth.map((row) => canonicalRow(BLOCK_COLUMNS, row)).join(',')}]`],
      },
      blockStatement(long),
      { sql: 'INSERT INTO blocks_fts (rowid, text) SELECT id, text FROM blocks', params: [] },
    ]);
    phase = 'seed-readback';
    requireProof(rowsSha256(await readRows(source, 'seed-readback')) === expectedSha256, 'seed-readback');
    phase = 'tokenizer-before';
    // A native negative control, not another implementation of the old regex:
    // for this public adjacent-emoji row, alpha is not an indexed first term.
    const boundaryRow = dense[6];
    const legacyProbe = await source.query('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ? AND rowid = CAST(? AS INTEGER)',
      ['"alpha"', boundaryRow.id]);
    const nativeProbe = await source.query('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ? AND rowid = CAST(? AS INTEGER)',
      ['"🫠alpha"', boundaryRow.id]);
    requireProof(legacyProbe.length === 0 && nativeProbe.length === 1 && nativeProbe[0].rowid === boundaryRow.id, phase);
    let verifiedCheckpoint;
    let deletedRows = 0;
    let ordinaryPages = 0;
    let fallbackPages = 0;
    let maxFtsParametersBytes = 0;
    let maxUnsplitFtsParametersBytes = 0;
    let splitFtsProbePages = 0;
    let growthVerifiedRows = 0;
    const pageProbes = shards.map(() => []);
    const pageGroups = shards.map(() => 0);
    const observedSource = {
      id: source.id, query: (...args) => source.query(...args),
      async batch(statements) {
        const retiresRows = statements.some(({ sql }) => /\bDELETE FROM blocks\b/.test(sql));
        if (!retiresRows) return await source.batch(statements);
        const durable = await readCheckpoint(shards[0], COPY_CHECKPOINT);
        requireProof(durable?.pending?.phase === 'verified' && verifiedCheckpoint !== undefined
          && JSON.stringify(durable.pending) === verifiedCheckpoint, 'source-retirement');
        const before = (await source.query('SELECT COUNT(*) AS rows FROM blocks'))[0]?.rows;
        requireProof(before === expected.length - deletedRows, 'source-retirement');
        const result = await source.batch(statements);
        const after = (await source.query('SELECT COUNT(*) AS rows FROM blocks'))[0]?.rows;
        requireProof(after === before - durable.pending.rows.length, 'source-retirement');
        deletedRows += durable.pending.rows.length;
        verifiedCheckpoint = undefined;
        await assertFrozen(source);
        return result;
      },
    };
    const observedShards = shards.map((db, index) => ({
      id: db.id,
      async query(sql, params = []) {
        if (/\bMATCH\b/.test(sql)) {
          const bytes = Buffer.byteLength(JSON.stringify(params));
          requireProof(params.length === 1 && bytes <= COPY_PAGE_BYTES, 'fts-parameter-budget');
          maxFtsParametersBytes = Math.max(maxFtsParametersBytes, bytes);
          pageProbes[index].push(...JSON.parse(params[0]));
          pageGroups[index] += 1;
        }
        return await db.query(sql, params);
      },
      async batch(statements) {
        const insert = statements.find(({ sql }) => /^INSERT INTO blocks \(/.test(sql));
        if (insert) {
          if (insert.params.length === 1 && /FROM json_each\(\?\)/.test(insert.sql)) ordinaryPages += 1;
          else if (insert.params.length === BLOCK_COLUMNS.length && /VALUES \(/.test(insert.sql)) fallbackPages += 1;
          else reject('copy-write-shape');
        }
        return await db.batch(statements);
      },
    }));
    phase = 'copy';
    const state = await copyFrozenIndex({
      source: observedSource, shards: observedShards, gate,
      checkpointHook: async (checkpoint) => {
        const durable = await readCheckpoint(shards[0], COPY_CHECKPOINT);
        requireProof(JSON.stringify(durable) === JSON.stringify(checkpoint), 'checkpoint-observation');
        if (checkpoint.pending?.phase === 'copying') {
          const wanted = expected.slice(checkpoint.rows, checkpoint.rows + checkpoint.pending.rows.length);
          requireProof(wanted.length > 0 && checkpoint.pending.rows.length === wanted.length
            && checkpoint.pending.rows.every((row, index) => row.id === wanted[index].id
              && row.shard === indexShardForSessionId(wanted[index].session_id, 2)), 'copy-page-geometry');
          if (checkpoint.rows === 0) {
            requireProof(wanted.length === dense.length + 1 && wanted.at(-1).id === dense.at(-1).id,
              'copy-page-geometry');
          }
          // Subsequent pages are derived from the real source response budget,
          // not a guessed count. The huge row must retain its own fallback page.
          if (wanted.some((row) => row.id === long.id)) requireProof(wanted.length === 1, 'copy-page-geometry');
          for (const probes of pageProbes) probes.length = 0;
          pageGroups.fill(0);
        }
        if (checkpoint.pending?.phase === 'verified') {
          let split = false;
          for (const [index, probes] of pageProbes.entries()) {
            const wanted = checkpoint.pending.rows.filter((row) => row.shard === index).map(({ id }) => id);
            requireProof(probes.length === wanted.length
              && probes.every((probe, offset) => probe[1] === wanted[offset]), 'fts-probe-geometry');
            const unsplitBytes = Buffer.byteLength(JSON.stringify([JSON.stringify(probes)]));
            maxUnsplitFtsParametersBytes = Math.max(maxUnsplitFtsParametersBytes, unsplitBytes);
            requireProof(unsplitBytes <= COPY_PAGE_BYTES || pageGroups[index] > 1, 'fts-parameter-budget');
            if (unsplitBytes > COPY_PAGE_BYTES && pageGroups[index] > 1) split = true;
          }
          if (split) splitFtsProbePages += 1;
          const wantedGrowth = growth.filter((row) => checkpoint.pending.rows.some((item) => item.id === row.id));
          if (wantedGrowth.length) {
            const ids = new Set(wantedGrowth.map(({ id }) => id));
            const stored = (await readRows(shards[1], 'growth-before-ack')).filter((row) => ids.has(row.id));
            requireProof(stored.length === wantedGrowth.length && rowsSha256(stored) === rowsSha256(wantedGrowth),
              'growth-before-ack');
            growthVerifiedRows += await matchOriginalGrowthWords(shards[1], wantedGrowth, 'growth-before-ack');
          }
          verifiedCheckpoint = JSON.stringify(checkpoint.pending);
        }
      },
    });
    requireProof(state.state === 'complete' && state.rows === expected.length && state.pending === null
      && JSON.stringify(state.columns) === JSON.stringify(BLOCK_COLUMNS)
      && deletedRows === expected.length && ordinaryPages >= 3 && fallbackPages === 1
      && growthVerifiedRows === growth.length && splitFtsProbePages > 0
      && maxFtsParametersBytes <= COPY_PAGE_BYTES, 'copy-complete');
    phase = 'checkpoint-proof';
    requireProof(JSON.stringify(await readCheckpoint(shards[0], COPY_CHECKPOINT)) === JSON.stringify(state), phase);
    requireProof((await source.query('SELECT COUNT(*) AS rows FROM blocks'))[0]?.rows === 0, 'source-empty');
    await assertFrozen(source);
    phase = 'destination-readback';
    const copied = [];
    for (const [index, db] of shards.entries()) {
      const rows = await readRows(db, phase);
      const wanted = expected.filter((row) => indexShardForSessionId(row.session_id, 2) === index);
      requireProof(rows.length === wanted.length && rowsSha256(rows) === rowsSha256(wanted), phase);
      copied.push(...rows);
    }
    requireProof(rowsSha256(copied.sort((a, b) => a.id - b.id)) === expectedSha256, phase);
    phase = 'independent-fts';
    let ftsMatches = growthVerifiedRows;
    for (const [row, tokens] of [
      [ordinary, ['nativeordinaryvisible', 'nativeordinarysuffix']],
      [long, ['nativelongvisible', 'nativelongsuffix']],
    ]) {
      const db = shards[indexShardForSessionId(row.session_id, 2)];
      for (const token of tokens) {
        const matches = await db.query('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ? AND rowid = CAST(? AS INTEGER)', [token, row.id]);
        requireProof(matches.length === 1 && matches[0].rowid === row.id, phase);
        ftsMatches += 1;
      }
    }
    // Public Unicode and UTF-8 truncation boundaries share the same dense shard.
    // Long no-tail words are probed in their full original valid form, not with
    // the copier's completion; all point checks are independent of its probes.
    for (const [index, { tokens, absent = [] }] of DENSE_TOKENIZER_CASES.entries()) {
      const row = dense[index];
      const db = shards[indexShardForSessionId(row.session_id, 2)];
      for (const [terms, required] of [[tokens, true], [absent, false]]) {
        for (const term of terms) {
          const matches = await db.query('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ? AND rowid = CAST(? AS INTEGER)',
            [`"${term.replaceAll('"', '""')}"`, row.id]);
          requireProof(required ? matches.length === 1 && matches[0].rowid === row.id : matches.length === 0, phase);
          if (required) ftsMatches += 1;
        }
      }
    }
    ftsMatches += await matchOriginalGrowthWords(shards[1], growth, phase);
    // Independent after-NUL common-token queries prove the complete routed ID
    // subset; deliberately suffix-free rows have separate whole-word checks above.
    for (const [index, db] of shards.entries()) {
      const wanted = dense.filter((row) => indexShardForSessionId(row.session_id, 2) === index
        && row.text.includes(DENSE_SUFFIX_TOKEN));
      const matches = await db.query('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ? ORDER BY rowid', [DENSE_SUFFIX_TOKEN]);
      requireProof(matches.length === wanted.length
        && matches.every((row, offset) => Number.isSafeInteger(row.rowid) && row.rowid === wanted[offset].id), phase);
      ftsMatches += matches.length;
    }
    // The identical INSERT must first succeed in copying state with all three
    // triggers installed. Remove it before freezing so a duplicate key cannot
    // masquerade as the expected fence rejection.
    phase = 'writer-fence';
    const probe = { ...expected[0], id: 1, text: 'nativefencepositive' };
    const write = blockStatement(probe);
    await source.query(`UPDATE ${SOURCE_FREEZE_TABLE} SET state = 'copying' WHERE id = 1`);
    await source.query(write.sql, write.params);
    requireProof(rowsSha256(await readRows(source, phase)) === rowsSha256([probe]), phase);
    await source.batch([
      { sql: 'DELETE FROM blocks WHERE id = CAST(? AS INTEGER)', params: [probe.id] },
      { sql: `UPDATE ${SOURCE_FREEZE_TABLE} SET state = 'frozen' WHERE id = 1`, params: [] },
    ]);
    const beforeRejectedWrite = rowsSha256(await readRows(source, phase));
    requireProof(beforeRejectedWrite === rowsSha256([]), phase);
    await assertFrozen(source);
    let rejected;
    try { await source.query(write.sql, write.params); }
    catch (error) { rejected = error; }
    requireProof(rejected?.d1SqlReason === 'writer-fence', phase);
    requireProof(rowsSha256(await readRows(source, phase)) === beforeRejectedWrite, phase);
    requireProof((await source.query('SELECT COUNT(*) AS rows FROM blocks'))[0]?.rows === 0, 'source-empty');
    await assertFrozen(source);
    requireProof(JSON.stringify(await readCheckpoint(shards[0], COPY_CHECKPOINT)) === JSON.stringify(state), 'checkpoint-proof');
    phase = 'retirement-diagnostic';
    const retirementDiagnostic = await proveNativeRetirementDiagnostic({ source, shards, gate, ordinary, expected });
    await gate();
    return { state: 'verified', probe: 'd1-native-full-copy', rows: expected.length, columns: BLOCK_COLUMNS.length,
      shards: shards.length, denseRows: dense.length, growthRows: growth.length, ordinaryPages, fallbackPages,
      ftsMatches, freezeTriggers: 3, maxFtsParametersBytes, maxUnsplitFtsParametersBytes, splitFtsProbePages,
      legacyProbeMatches: legacyProbe.length, nativeProbeMatches: nativeProbe.length,
      longTextBytes: Buffer.byteLength(long.text), sha256: expectedSha256, retirementDiagnostic };
  } catch (error) {
    throw safeFailure(error, phase);
  }
}

/** Schema setup uses the existing trusted migration runner, never a copied/mock DDL. */
export async function verifyNativeCopyControl({ api, pr, applySchema }) {
  return await withScratchD1Databases({ api, pr, run: async (databases) => {
    try { await applySchema(databases); }
    catch (error) { throw safeFailure(error, 'schema'); }
    return await proveNativeCopy(databases);
  } });
}
