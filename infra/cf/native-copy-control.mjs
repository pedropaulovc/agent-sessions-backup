import { createHash, randomBytes } from 'node:crypto';
import {
  PREVIEW_D1_DATABASE_LIMIT, paginatedList, positiveInteger,
  previewCopyScratchNames, previewResourceOwner,
} from './preview-trust.mjs';
import {
  COPY_INVARIANTS, COPY_PAGE_BYTES, COPY_PAGE_ROWS, COPY_PHASES, SOURCE_FREEZE_TABLE, canonicalRow,
  copyFrozenIndex, readCopyCheckpoint, writeCopyCheckpoint,
} from '../../hub/scripts/lib/index-migration.mjs';
import { BLOCK_COLUMNS, INDEX_ID_SPAN, indexShardForSessionId } from '../../hub/src/index-layout.mjs';
import { D1_FAILURE_KINDS, D1_SQL_FAILURE_REASONS } from './d1-batch-atomicity.mjs';

const copyPhases = Object.freeze(Object.values(COPY_PHASES));
const copyInvariants = Object.freeze(Object.values(COPY_INVARIANTS));
const readCopyState = async (db) => (await readCopyCheckpoint(db))?.state ?? null;

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
// Independent of the copier under test: the contract's canonical row is the JSON
// array of column values, with malformed TEXT as its exact {x} byte tag.
function canonical(row) {
  requireProof(BLOCK_COLUMNS.every((column) => Object.hasOwn(row, column)), 'canonical');
  return JSON.stringify(BLOCK_COLUMNS.map((column) => row[column]));
}
const rowsSha256 = (rows) => sha256(`[${rows.map(canonical).join(',')}]`);
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const LOSSY_UTF8 = new TextDecoder('utf-8', { ignoreBOM: true });
// The copy contract's only representation of stored malformed TEXT: its exact
// lowercase bytes. Valid TEXT, including BOM/NUL, stays an ordinary string.
function storedText(bytes) {
  try { return STRICT_UTF8.decode(bytes); } catch { return { x: bytes.toString('hex') }; }
}
const storedBytes = (value) => (typeof value === 'string' ? Buffer.from(value) : Buffer.from(value.x, 'hex'));
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
    row[column] = storedText(bytes);
  }
}

/** Independent native readback: TEXT is hex transported, long TEXT in bounded BLOB slices. */
async function readRows(db, phase, { after: start = -1, before = INDEX_ID_SPAN } = {}) {
  const selectors = BLOCK_COLUMNS.flatMap((column, index) => {
    const name = quote(column);
    return [
      `CASE WHEN typeof(${name}) = 'text' THEN CASE WHEN length(CAST(${name} AS BLOB)) <= ${READBACK_INLINE_BYTES} THEN hex(CAST(${name} AS BLOB)) ELSE NULL END ELSE ${name} END AS ${name}`,
      `typeof(${name}) AS "__type_${index}"`,
      `CASE WHEN typeof(${name}) = 'text' THEN length(CAST(${name} AS BLOB)) ELSE NULL END AS "__bytes_${index}"`,
    ];
  });
  const rows = [];
  let after = start;
  for (;;) {
    const result = await db.query(`SELECT ${selectors.join(',')} FROM blocks
      WHERE id > CAST(? AS INTEGER) AND id < CAST(? AS INTEGER) ORDER BY id LIMIT ?`, [after, before, READBACK_PAGE_ROWS]);
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
        row[column] = storedText(bytes);
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

// ---- Byte-exact malformed TEXT copy and one-time legacy checkpoint recovery ----
// Runs only after the complete positive proof, on the same owned scratch
// databases. Every fixture byte is public and synthetic. Malformed TEXT is
// written and read back only as SQL hex; public output is counts and digests.
const RECOVERY_BASE_ID = 2_000_000;
const RECOVERY_SPAN = 1_000;
const TRUNCATED_EMOJI = [0xf0, 0x9f, 0x98];
const GUARD_UNIT = 40;
const fixtureBytes = (...parts) => Buffer.concat(parts.map((part) => Buffer.from(part)));
const MATCH_RAW = 'SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH CAST(unhex(?) AS TEXT) AND rowid = CAST(? AS INTEGER)';

function recoveryRow(offset, shard, cells) {
  const id = RECOVERY_BASE_ID + offset;
  return {
    id, session_id: fixtureBytes(sessionOn(shard)), file_id: id, turn_index: 0, block_index: offset,
    role: null, btype: fixtureBytes('text'), tool_name: null, ts: null, byte_start: 0, byte_len: 0, truncated: 0,
    text: null, on_main_path: 1, row_hash: id, media_byte_start: null, media_byte_len: 0, media_type: fixtureBytes(''),
    ...cells,
  };
}

// Long malformed TEXT is grown natively from one bounded unit, then framed by
// its exact head/tail; no request carries the whole cell during seeding.
function longRecoveryRow({ offset, shard, total, unit, head, tail }) {
  const bodyLength = total - head.length - tail.length;
  let doublings = 0;
  while (unit * 2 ** doublings < bodyLength) doublings += 1;
  const pattern = Buffer.alloc(unit, 0x20);
  pattern[unit - 1] = 0xff;
  const body = Buffer.alloc(unit * 2 ** doublings);
  for (let at = 0; at < body.length; at += unit) pattern.copy(body, at);
  const row = recoveryRow(offset, shard, { text: Buffer.concat([head, body.subarray(0, bodyLength), tail]) });
  return { row, head, tail, unit, pattern, doublings, bodyLength };
}

function recoveryFixtures() {
  const prefix = [1, 2, 3].map((k) => recoveryRow(k, k % 2, { text: fixtureBytes(`nativeprefixretired${k}`) }));
  const legacy = [
    recoveryRow(10, 0, { tool_name: fixtureBytes('tool-α'), text: fixtureBytes('\ufeffnativelegacyvalid café e\u0301', [0], ' x') }),
    recoveryRow(11, 1, { text: fixtureBytes('nivsa', TRUNCATED_EMOJI, 'nivsb nativelegacyshort ', [0xff], ' end') }),
    recoveryRow(12, 0, { tool_name: fixtureBytes('tool', [0xff], 'x'), text: fixtureBytes('nativelegacytool') }),
  ];
  const long = [
    longRecoveryRow({ offset: 20, shard: 1, total: 300_000, unit: 4096,
      head: fixtureBytes('\ufeffnivla', TRUNCATED_EMOJI, 'nivlb nativelonginvalidhead ', [0xed, 0xa0, 0x80], ' ', [0], ' '),
      tail: fixtureBytes(' nativelonginvalidtail ', TRUNCATED_EMOJI) }),
    // Near the bounded 2,000,000-byte cell cap: its copy is a ~3.8 MB chunked request.
    longRecoveryRow({ offset: 21, shard: 0, total: 1_900_000, unit: 3750,
      head: fixtureBytes('nivma', TRUNCATED_EMOJI, 'nivmb nativemaxinvalidhead ', [0xc0, 0x80], ' '),
      tail: fixtureBytes(' nativemaxinvalidtail ', [0xff]) }),
  ];
  const short = [
    recoveryRow(30, 0, { role: fixtureBytes('assistant', [0xc0, 0x80]), text: fixtureBytes('nativeshortrole') }),
    recoveryRow(31, 1, { btype: fixtureBytes('text', [0xed, 0xa0, 0x80]), ts: fixtureBytes('2026-10-14', [0xfe]),
      text: fixtureBytes('nativeshortbtype') }),
    recoveryRow(32, 0, { media_type: fixtureBytes('image/', [0xff]),
      text: fixtureBytes('\ufeffnivsc', [0xe4, 0xb8], 'nivsd ', [0x80, 0], ' nativeshortmedia') }),
    recoveryRow(33, 1, { tool_name: fixtureBytes(TRUNCATED_EMOJI), text: fixtureBytes([0xff]) }),
  ];
  const [guarded] = long;
  const guard = { row: guarded.row, offset: guarded.head.length + GUARD_UNIT * guarded.unit + guarded.unit - 1 };
  requireProof(guard.offset > 131_072 && guard.row.text[guard.offset] === 0xff, 'byte-exact-fixture');
  // Truncated F0 9F 98 reads as one letter inside a raw-byte FTS token but as a
  // separator in its lossy rendering, so raw and lossy terms are disjoint.
  const fts = [
    { row: legacy[1], region: legacy[1].text, raw: fixtureBytes('nivsa', TRUNCATED_EMOJI, 'nivsb'),
      valid: 'nivsa\u07d8nivsb', lossy: ['nivsa', 'nivsb'], common: ['nativelegacyshort'] },
    { row: long[0].row, region: long[0].head, raw: fixtureBytes('nivla', TRUNCATED_EMOJI, 'nivlb'),
      valid: 'nivla\u07d8nivlb', lossy: ['nivla', 'nivlb'], common: ['nativelonginvalidhead', 'nativelonginvalidtail'] },
    { row: long[1].row, region: long[1].head, raw: fixtureBytes('nivma', TRUNCATED_EMOJI, 'nivmb'),
      valid: 'nivma\u07d8nivmb', lossy: ['nivma', 'nivmb'], common: ['nativemaxinvalidhead', 'nativemaxinvalidtail'] },
    { row: short[2], region: short[2].text, raw: fixtureBytes('nivsc', [0xe4, 0xb8], 'nivsd'),
      lossy: ['nivsc', 'nivsd'], common: ['nativeshortmedia'] },
  ].map((item, index) => ({ ...item, controlId: RECOVERY_BASE_ID + 100 + index, control: LOSSY_UTF8.decode(item.region) }));
  requireProof(fts.every((item) => item.control.includes('\ufffd')), 'byte-exact-fixture');
  const words = [
    ...prefix.map((row) => [row, row.text.toString()]),
    [legacy[0], 'nativelegacyvalid'], [legacy[2], 'nativelegacytool'], [short[0], 'nativeshortrole'], [short[1], 'nativeshortbtype'],
  ];
  return { prefix, legacy, long, short, guard, fts, words };
}

function exactInsert(row, override = {}) {
  const params = [];
  const values = BLOCK_COLUMNS.map((column) => {
    const value = Object.hasOwn(override, column) ? override[column] : row[column];
    if (!Buffer.isBuffer(value)) {
      params.push(value);
      return '?';
    }
    if (!value.length) return "''";
    params.push(value.toString('hex'));
    return 'CAST(unhex(?) AS TEXT)';
  });
  return { sql: `INSERT INTO blocks (${BLOCK_COLUMNS.map(quote).join(',')}) VALUES (${values.join(',')})`, params };
}

// Independent native FTS oracle: each byte-exact phrase is reconstructed by
// SQLite from hex, so its tokens are derived from exact stored bytes.
async function ftsProbes(db, probes, phase) {
  const statements = probes.map(({ term, rowid }) => {
    const bytes = Buffer.from(term);
    requireProof(bytes.length > 0 && !bytes.includes(0x22), phase);
    return { sql: MATCH_RAW, params: [fixtureBytes('"', bytes, '"').toString('hex'), rowid] };
  });
  requireProof(Buffer.byteLength(JSON.stringify({ batch: statements })) <= COPY_PAGE_BYTES, phase);
  const results = await db.batch(statements);
  requireProof(Array.isArray(results) && results.length === probes.length, phase);
  for (const [index, { rowid, hit }] of probes.entries()) {
    const rows = results[index]?.results;
    requireProof(results[index]?.success === true && Array.isArray(rows) && rows.length === Number(hit)
      && rows.every((row) => row.rowid === rowid), phase);
  }
  return probes.length;
}

// Only validated aggregate vocabulary/counts may escape on a failed proof.
function measuredComparison(actual) {
  const count = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1;
  const types = ['null', 'integer', 'real', 'text', 'blob'];
  const safeTypes = (values) => Array.isArray(values) && values.length <= types.length
    && values.every((value) => types.includes(value)) && new Set(values).size === values.length;
  if (actual?.status === 'unavailable'
    && ['canonical-budget', 'request-budget', 'query-failed', 'response-shape'].includes(actual.reason)) {
    return { status: 'unavailable', reason: actual.reason };
  }
  if (['clean', 'mismatch', 'missing', 'mismatch-and-missing'].includes(actual?.status)
    && ['expectedRows', 'presentRows', 'missingRows', 'mismatchingRows'].every((key) => count(actual[key]))
    && Array.isArray(actual.columns) && actual.columns.length <= BLOCK_COLUMNS.length
    && actual.columns.every((column) => Number.isSafeInteger(column?.index)
      && column.index >= 0 && column.index < BLOCK_COLUMNS.length
      && ['mismatchingRows', 'typeMismatchRows', 'byteMismatchRows', 'lengthMismatchRows'].every((key) => count(column[key]))
      && safeTypes(column.sourceTypes) && safeTypes(column.snapshotTypes))) {
    return { status: actual.status, expectedRows: actual.expectedRows, presentRows: actual.presentRows,
      missingRows: actual.missingRows, mismatchingRows: actual.mismatchingRows,
      columns: actual.columns.map((column) => ({
        index: column.index, mismatchingRows: column.mismatchingRows, typeMismatchRows: column.typeMismatchRows,
        byteMismatchRows: column.byteMismatchRows, lengthMismatchRows: column.lengthMismatchRows,
        sourceTypes: [...column.sourceTypes], snapshotTypes: [...column.snapshotTypes],
      })) };
  }
  return undefined;
}

// The legacy checkpoint is lossy: its pending hashes came from the old reader's
// rendering of malformed TEXT, and those bytes are not recoverable from it. The
// copier must prove that rendering from the still-frozen authoritative source,
// then copy and CAS-retire the source's exact bytes, retaining the prefix chain.
async function proveByteExactRecovery({ source, shards, gate, positive, positiveRows }) {
  let phase = 'byte-exact-seed';
  // First statement of this phase; the deployment harness uses it as the marker.
  const decoded = await source.query("SELECT hex(unhex('61FF62')) AS bytes");
  requireProof(decoded.length === 1 && decoded[0].bytes === '61FF62', phase);
  requireProof(positive?.state === 'complete' && positive.identity, phase);
  const { prefix, legacy, long, short, guard, fts, words } = recoveryFixtures();
  const longRows = long.map(({ row }) => row);
  const pendingRows = [...legacy, ...longRows, ...short];
  const allRows = [...prefix, ...pendingRows];
  const fixtureById = new Map(allRows.map((row) => [row.id, row]));
  const exactRow = (row) => Object.fromEntries(BLOCK_COLUMNS.map((column) =>
    [column, Buffer.isBuffer(row[column]) ? storedText(row[column]) : row[column]]));
  const exactById = new Map(allRows.map((row) => [row.id, exactRow(row)]));
  const exactRows = (rows) => rows.map((row) => exactById.get(row.id));
  const exactDigest = (id) => sha256(canonical(exactById.get(id)));
  const shardOf = (row) => indexShardForSessionId(row.session_id.toString(), shards.length);
  const ids = (rows) => rows.map(({ id }) => id);
  const invalid = (row) => BLOCK_COLUMNS.filter((column) => typeof exactById.get(row.id)[column] === 'object'
    && exactById.get(row.id)[column] !== null);
  requireProof([...prefix, legacy[0]].every((row) => invalid(row).length === 0)
    && [legacy[1], legacy[2], ...longRows, ...short].every((row) => invalid(row).length > 0)
    && Math.max(...longRows.map((row) => row.text.length)) < 2_000_000, 'byte-exact-fixture');
  const fence = (state) => ({ sql: `UPDATE ${SOURCE_FREEZE_TABLE} SET state = '${state}' WHERE id = 1`, params: [] });
  const fenced = (statements) => source.batch([fence('copying'), ...statements, fence('frozen')]);
  const indexRows = (rows) => ({
    sql: 'INSERT INTO blocks_fts (rowid, text) SELECT id, text FROM blocks WHERE id IN (SELECT value FROM json_each(?))',
    params: [JSON.stringify(ids(rows))],
  });
  await assertFrozen(source);
  requireProof((await source.query('SELECT COUNT(*) AS rows FROM blocks'))[0]?.rows === 0, phase);
  // Lossy U+FFFD controls are FTS-only rows: they show the old rendering's terms.
  await fenced([...legacy, ...short].map((row) => exactInsert(row)).concat(indexRows([...legacy, ...short]),
    fts.map(({ controlId, control }) => ({
      sql: 'INSERT INTO blocks_fts (rowid, text) VALUES (CAST(? AS INTEGER), ?)', params: [controlId, control],
    }))));
  for (const { row, head, tail, pattern, doublings, bodyLength } of long) {
    await fenced([
      exactInsert(row, { text: pattern }),
      ...Array.from({ length: doublings }, () => ({
        sql: 'UPDATE blocks SET text = CAST(CAST(text AS BLOB) || CAST(text AS BLOB) AS TEXT) WHERE id = CAST(? AS INTEGER)',
        params: [row.id],
      })),
      {
        sql: `UPDATE blocks SET text = CAST(unhex(?) || substr(CAST(text AS BLOB), 1, ?) || unhex(?) AS TEXT)
          WHERE id = CAST(? AS INTEGER)`,
        params: [head.toString('hex'), bodyLength, tail.toString('hex'), row.id],
      },
      indexRows([row]),
    ]);
  }
  await assertFrozen(source);
  phase = 'byte-exact-seed-readback';
  const sourceBefore = await readRows(source, phase, { after: RECOVERY_BASE_ID, before: RECOVERY_BASE_ID + RECOVERY_SPAN });
  requireProof(rowsSha256(sourceBefore) === rowsSha256(exactRows(pendingRows)), phase);
  phase = 'byte-exact-fts-before';
  let ftsMatches = 0;
  for (const item of fts) {
    const terms = [item.raw, ...(item.valid ? [item.valid] : [])];
    ftsMatches += await ftsProbes(source, [
      ...terms.map((term) => ({ term, rowid: item.row.id, hit: true })),
      ...item.lossy.map((term) => ({ term, rowid: item.row.id, hit: false })),
      ...item.common.map((term) => ({ term, rowid: item.row.id, hit: true })),
      ...terms.map((term) => ({ term, rowid: item.controlId, hit: false })),
      ...item.lossy.map((term) => ({ term, rowid: item.controlId, hit: true })),
    ], phase);
  }

  // Synthesize exactly what the old copier left: its reader's rendering of the
  // pending source page, a destination replica of that rendering, and a verified
  // checkpoint without an encoding after an already retired valid prefix.
  phase = 'byte-exact-legacy-seed';
  const legacyRead = await source.query(`SELECT ${BLOCK_COLUMNS.map(quote).join(',')} FROM blocks
    WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`, [JSON.stringify(ids(legacy))]);
  requireProof(legacyRead.length === legacy.length && legacyRead.every((row, index) => row.id === legacy[index].id
    && BLOCK_COLUMNS.every((column) => row[column] === null || ['string', 'number'].includes(typeof row[column]))), phase);
  const legacyItems = legacyRead.map((row) => ({
    id: row.id, shard: indexShardForSessionId(row.session_id, shards.length), sha256: sha256(canonical(row)),
  }));
  // Valid rows keep their legacy hash; only malformed TEXT changes representation.
  requireProof(legacyItems.every((item, index) => item.shard === shardOf(legacy[index])
    && (item.sha256 === exactDigest(item.id)) === (index === 0)), phase);
  const replica = [
    ...prefix.map((row) => ({ id: row.id, shard: shardOf(row), canonical: canonical(exactById.get(row.id)) })),
    ...legacyRead.map((row, index) => ({ id: row.id, shard: legacyItems[index].shard, canonical: canonical(row) })),
  ];
  for (const [index, db] of shards.entries()) {
    const page = replica.filter((row) => row.shard === index);
    if (!page.length) continue;
    await db.batch([
      {
        sql: `INSERT INTO blocks (${BLOCK_COLUMNS.map(quote).join(',')})
          SELECT ${BLOCK_COLUMNS.map((_, column) => `json_extract(value, '$[${column}]')`).join(',')} FROM json_each(?)`,
        params: [`[${page.map(({ canonical }) => canonical).join(',')}]`],
      },
      indexRows(page),
    ]);
  }
  const prefixItems = prefix.map((row) => ({ id: row.id, shard: shardOf(row), sha256: exactDigest(row.id) }));
  const legacyState = {
    identity: positive.identity, columns: [...BLOCK_COLUMNS], after: prefix.at(-1).id, rows: prefix.length,
    sha256: sha256(`${sha256('')}:${JSON.stringify(prefixItems)}`),
    pending: { phase: 'verified', rows: legacyItems }, state: 'pending',
  };
  // Native generation fence: one valid compare-and-set with its RETURNING witness,
  // then a stale replay of that transition and a stale insert-if-absent must each
  // match zero rows, surface as the fence invariant (never as a transport failure,
  // never retried) and leave the durable envelope byte-identical.
  phase = 'byte-exact-checkpoint-fence';
  const positiveStored = await readCopyCheckpoint(shards[0]);
  requireProof(JSON.stringify(positiveStored?.state) === JSON.stringify(positive), phase);
  const fencedGeneration = await writeCopyCheckpoint(shards[0], legacyState, positiveStored.generation);
  requireProof(fencedGeneration === positiveStored.generation + 1, phase);
  const staleFences = [];
  for (const expected of [positiveStored.generation, 0]) {
    try { await writeCopyCheckpoint(shards[0], positive, expected); } catch (error) {
      if (error?.code !== COPY_INVARIANTS.CHECKPOINT_FENCE) throw safeFailure(error, phase);
      requireProof(error.d1Phase === COPY_PHASES.CHECKPOINT_WRITE && error.d1FailureKind === undefined, phase);
      staleFences.push(expected);
    }
  }
  requireProof(staleFences.length === 2, phase);
  const fencedStored = await readCopyCheckpoint(shards[0]);
  requireProof(fencedStored.generation === fencedGeneration
    && JSON.stringify(fencedStored.state) === JSON.stringify(legacyState), phase);
  phase = 'byte-exact-legacy-loss';
  let lossyReplicaCells = 0;
  for (const [index, row] of legacy.entries()) {
    const db = shards[shardOf(row)];
    const rendered = await db.query(`SELECT ${BLOCK_COLUMNS.map(quote).join(',')} FROM blocks WHERE id = CAST(? AS INTEGER)`, [row.id]);
    requireProof(rendered.length === 1 && sha256(canonical(rendered[0])) === legacyItems[index].sha256, phase);
    const [stored] = await readRows(db, phase, { after: row.id - 1, before: row.id + 1 });
    for (const column of BLOCK_COLUMNS.filter((name) => Buffer.isBuffer(row[name]))) {
      const same = stored?.[column] != null && storedBytes(stored[column]).equals(row[column]);
      requireProof(same === !invalid(row).includes(column), phase);
      lossyReplicaCells += Number(!same);
    }
  }
  requireProof(lossyReplicaCells === 2, phase);
  ftsMatches += await ftsProbes(shards[shardOf(fts[0].row)], [fts[0].raw, fts[0].valid]
    .map((term) => ({ term, rowid: fts[0].row.id, hit: false })), phase);

  phase = 'byte-exact-recovery';
  const guardComparison = {
    status: 'mismatch', expectedRows: 1, presentRows: 1, missingRows: 0, mismatchingRows: 1,
    columns: [{ index: BLOCK_COLUMNS.indexOf('text'), mismatchingRows: 1, typeMismatchRows: 0, byteMismatchRows: 1,
      lengthMismatchRows: 0, sourceTypes: ['text'], snapshotTypes: ['text'] }],
  };
  // FF and FE have the same lossy rendering: only an exact-byte CAS sees the change.
  const setGuardByte = async (byte) => {
    await fenced([{
      sql: `UPDATE blocks SET text = CAST(substr(CAST(text AS BLOB), 1, ?) || unhex(?) || substr(CAST(text AS BLOB), ?) AS TEXT)
        WHERE id = CAST(? AS INTEGER)`,
      params: [guard.offset, byte, guard.offset + 2, guard.row.id],
    }]);
    await assertGuardByte(byte);
  };
  const assertGuardByte = async (byte) => {
    const probe = await source.query(`SELECT typeof(text) AS storage_type, length(CAST(text AS BLOB)) AS byte_length,
      hex(substr(CAST(text AS BLOB), ?, 1)) AS byte FROM blocks WHERE id = CAST(? AS INTEGER)`, [guard.offset + 1, guard.row.id]);
    requireProof(probe.length === 1 && probe[0].storage_type === 'text' && probe[0].byte_length === guard.row.text.length
      && probe[0].byte === byte.toUpperCase(), phase);
  };
  const trace = {
    failure: undefined, sourceWrites: 0, shardWrites: 0, hooks: 0, writesAfterFailure: 0, diagnosticQueries: 0,
    retirements: [], pages: [], jsonPages: 0, boundPages: 0, maxBoundParams: 0, maxBoundRequestBytes: 0,
  };
  let guardMutated = false;
  let recovering = 0;
  let verifiedSnapshot;
  let lastVerified = null;
  let chain = legacyState.sha256;
  let chainRows = legacyState.rows;
  const observedSource = {
    id: source.id,
    async query(sql, params = []) {
      if (trace.failure) {
        trace.diagnosticQueries += 1;
        requireProof(/^\s*WITH verified\b/.test(sql), 'byte-exact-guard');
      }
      return await source.query(sql, params);
    },
    async batch(statements) {
      if (trace.failure) trace.writesAfterFailure += 1;
      trace.sourceWrites += 1;
      let armed = false;
      if (statements.some(({ sql }) => /\bDELETE FROM blocks\b/.test(sql))) {
        const durable = await readCopyState(shards[0]);
        requireProof(durable?.pending?.phase === 'verified' && JSON.stringify(durable) === verifiedSnapshot, phase);
        await assertFrozen(source);
        const retiring = ids(durable.pending.rows);
        trace.retirements.push(retiring);
        if (!guardMutated && retiring.length === 1 && retiring[0] === guard.row.id) {
          // A real byte change after verification and before the CAS retirement.
          await setGuardByte('fe');
          guardMutated = true;
          armed = true;
        }
      }
      let result;
      try { result = await source.batch(statements); }
      catch (error) {
        if (armed) trace.failure = error;
        throw error;
      }
      requireProof(!armed, 'byte-exact-guard');
      return result;
    },
  };
  const observedShards = shards.map((db) => ({
    id: db.id,
    query: (sql, params) => db.query(sql, params),
    async batch(statements) {
      if (trace.failure) trace.writesAfterFailure += 1;
      trace.shardWrites += 1;
      const insert = statements.find(({ sql }) => /^INSERT INTO blocks \(/.test(sql));
      if (insert?.params.length === 1 && /FROM json_each\(\?\)/.test(insert.sql)) trace.jsonPages += 1;
      else if (insert && /VALUES \(/.test(insert.sql) && insert.params.length <= 100) {
        trace.boundPages += 1;
        trace.maxBoundParams = Math.max(trace.maxBoundParams, insert.params.length);
        trace.maxBoundRequestBytes = Math.max(trace.maxBoundRequestBytes, Buffer.byteLength(JSON.stringify(statements)));
      } else if (insert) reject('copy-write-shape');
      return await db.batch(statements);
    },
  }));
  const checkpointHook = async (checkpoint) => {
    trace.hooks += 1;
    requireProof(!trace.failure, 'byte-exact-guard');
    const durable = await readCopyState(shards[0]);
    requireProof(JSON.stringify(durable) === JSON.stringify(checkpoint), 'checkpoint-observation');
    const pending = checkpoint.pending;
    if (recovering === 0 && pending?.phase !== 'recovering') {
      // A copier without the one-time recovery (the old lossy reader) is only
      // observed: it must still fail closed at its own native boundary, and run 1
      // below then requires the recovery it skipped.
      if (pending?.phase === 'verified') verifiedSnapshot = JSON.stringify(checkpoint);
      return;
    }
    requireProof(typeof positive.encoding === 'string' && positive.encoding.length > 0
      && checkpoint.encoding === positive.encoding
      && JSON.stringify(checkpoint.identity) === JSON.stringify(legacyState.identity), 'byte-exact-encoding');
    if (pending?.phase === 'recovering') {
      // Persisted once, before any write, with the retired prefix chain untouched.
      requireProof(recovering === 0 && trace.shardWrites === 0 && trace.sourceWrites === 0
        && checkpoint.after === legacyState.after && checkpoint.rows === legacyState.rows
        && checkpoint.sha256 === legacyState.sha256
        && JSON.stringify(pending.recovery?.legacyRows) === JSON.stringify(legacyItems)
        && pending.rows.length === legacyItems.length
        && pending.rows.every((item, index) => item.id === legacyItems[index].id
          && item.shard === legacyItems[index].shard && item.sha256 === exactDigest(item.id)), 'legacy-recovery');
      recovering += 1;
      return;
    }
    if (pending) {
      requireProof(['copying', 'verified'].includes(pending.phase) && checkpoint.state === 'pending'
        && checkpoint.rows === chainRows && checkpoint.sha256 === chain && pending.rows.length > 0
        && pending.rows.every((item) => fixtureById.has(item.id) && item.id > checkpoint.after
          && item.shard === shardOf(fixtureById.get(item.id)) && item.sha256 === exactDigest(item.id)), 'byte-exact-geometry');
      if (pending.phase === 'copying') trace.pages.push(ids(pending.rows));
      else {
        verifiedSnapshot = JSON.stringify(checkpoint);
        lastVerified = pending.rows;
      }
      return;
    }
    if (lastVerified) {
      requireProof(checkpoint.state === 'pending' && checkpoint.sha256 === sha256(`${chain}:${JSON.stringify(lastVerified)}`)
        && checkpoint.rows === chainRows + lastVerified.length && checkpoint.after === lastVerified.at(-1).id, 'byte-exact-chain');
      chain = checkpoint.sha256;
      chainRows = checkpoint.rows;
      lastVerified = null;
    } else {
      requireProof(checkpoint.state === 'complete' && checkpoint.sha256 === chain && checkpoint.rows === chainRows, 'byte-exact-chain');
    }
  };
  const copy = () => copyFrozenIndex({ source: observedSource, shards: observedShards, gate, checkpointHook });
  const resetRun = () => Object.assign(trace, {
    failure: undefined, sourceWrites: 0, shardWrites: 0, hooks: 0, writesAfterFailure: 0, diagnosticQueries: 0,
  });

  // Run 1: one-time legacy recovery, then the exact-byte CAS rejects the mutation.
  let failure;
  try { await copy(); } catch (error) { failure = error; }
  phase = 'byte-exact-guard';
  // An earlier rejection never reached the guard: keep its actual public phase/class.
  if (!trace.failure) throw failure === undefined ? new NativeCopyControlError(phase, 'assertion') : safeFailure(failure, 'byte-exact-recovery');
  requireProof(failure === trace.failure && failure.d1Phase === COPY_PHASES.SOURCE_DELETE_AND_FREEZE
    && failure.d1SqlReason === 'malformed-json' && trace.writesAfterFailure === 0 && trace.diagnosticQueries === 1
    && recovering === 1 && JSON.stringify(trace.retirements) === JSON.stringify([ids(legacy), [guard.row.id]])
    && JSON.stringify(trace.pages) === JSON.stringify([[guard.row.id]]), phase);
  if (JSON.stringify(failure.d1SourceComparison) !== JSON.stringify(guardComparison)) {
    // Never attach the raw provider error, SQL response or byte descriptors.
    const measured = measuredComparison(failure.d1SourceComparison);
    const error = new NativeCopyControlError(phase, 'assertion');
    if (measured) {
      error.nativeCopySourceComparison = measured;
      error.message += ` sourceRetirementComparison=${JSON.stringify(measured)}`;
    }
    throw error;
  }
  requireProof(JSON.stringify(await readCopyState(shards[0])) === verifiedSnapshot, phase);
  const remaining = await source.query('SELECT id FROM blocks ORDER BY id');
  requireProof(JSON.stringify(ids(remaining)) === JSON.stringify(ids([...longRows, ...short])), phase);
  await assertGuardByte('fe');
  await assertFrozen(source);
  const guardCopy = await readRows(shards[shardOf(guard.row)], phase, { after: guard.row.id - 1, before: guard.row.id + 1 });
  requireProof(guardCopy.length === 1 && rowsSha256(guardCopy) === rowsSha256(exactRows([guard.row])), phase);

  // Run 2: an unrestored source is refused before any write.
  phase = 'byte-exact-stale';
  resetRun();
  let stale;
  try { await copy(); } catch (error) { stale = error; }
  if (stale?.code !== COPY_INVARIANTS.SOURCE_CHANGED) throw stale ? safeFailure(stale, phase) : new NativeCopyControlError(phase, 'assertion');
  requireProof(trace.sourceWrites === 0 && trace.shardWrites === 0 && trace.hooks === 0
    && JSON.stringify(await readCopyState(shards[0])) === verifiedSnapshot, phase);
  await assertGuardByte('fe');

  // Run 3: the restored authoritative bytes complete from the retained checkpoint.
  phase = 'byte-exact-complete';
  await setGuardByte('ff');
  resetRun();
  const state = await copy();
  requireProof(state.state === 'complete' && state.pending === null && state.encoding === positive.encoding
    && state.rows === allRows.length && chainRows === state.rows && state.after === short.at(-1).id && state.sha256 === chain
    && JSON.stringify(trace.pages) === JSON.stringify([[guard.row.id], [longRows[1].id], ids(short)])
    && JSON.stringify(trace.retirements) === JSON.stringify([ids(legacy), [guard.row.id], [guard.row.id], [longRows[1].id], ids(short)])
    && trace.boundPages === 1 && trace.jsonPages >= 3 && trace.maxBoundParams <= 100, phase);
  requireProof(JSON.stringify(await readCopyState(shards[0])) === JSON.stringify(state), phase);
  requireProof((await source.query('SELECT COUNT(*) AS rows FROM blocks'))[0]?.rows === 0, 'source-empty');
  await assertFrozen(source);

  phase = 'byte-exact-readback';
  const sourceById = new Map(sourceBefore.map((row) => [row.id, row]));
  const digestOf = (value) => (typeof value === 'string' || typeof value?.x === 'string' ? sha256(storedBytes(value)) : null);
  let invalidCells = 0;
  let rawSha256Matches = 0;
  const copied = [];
  for (const [index, db] of shards.entries()) {
    const rows = await readRows(db, phase, { after: RECOVERY_BASE_ID, before: RECOVERY_BASE_ID + RECOVERY_SPAN });
    const wanted = allRows.filter((row) => shardOf(row) === index);
    requireProof(rows.length === wanted.length && rowsSha256(rows) === rowsSha256(exactRows(wanted)), phase);
    for (const row of rows) {
      const fixture = fixtureById.get(row.id);
      for (const column of BLOCK_COLUMNS.filter((name) => Buffer.isBuffer(fixture[name]))) {
        const digest = sha256(fixture[column]);
        requireProof(digestOf(row[column]) === digest
          && (!sourceById.has(row.id) || digestOf(sourceById.get(row.id)[column]) === digest), phase);
        rawSha256Matches += 1;
        invalidCells += Number(typeof row[column] !== 'string');
      }
    }
    copied.push(...rows);
    // The positive proof's destination rows are untouched by this phase.
    const [retained] = await db.query(`SELECT COUNT(*) AS rows FROM blocks
      WHERE id < CAST(? AS INTEGER) OR id >= CAST(? AS INTEGER)`, [RECOVERY_BASE_ID, RECOVERY_BASE_ID + RECOVERY_SPAN]);
    requireProof(retained?.rows === positiveRows.filter((row) => indexShardForSessionId(row.session_id, shards.length) === index).length, phase);
  }
  const recoveredSha256 = rowsSha256(exactRows(allRows));
  requireProof(rowsSha256(copied.sort((a, b) => a.id - b.id)) === recoveredSha256
    && invalidCells === allRows.reduce((total, row) => total + invalid(row).length, 0), phase);

  phase = 'byte-exact-fts-after';
  for (const item of fts) {
    ftsMatches += await ftsProbes(shards[shardOf(item.row)], [
      ...[item.raw, ...(item.valid ? [item.valid] : []), ...item.common].map((term) => ({ term, rowid: item.row.id, hit: true })),
      ...item.lossy.map((term) => ({ term, rowid: item.row.id, hit: false })),
    ], phase);
  }
  for (const [index, db] of shards.entries()) {
    const own = words.filter(([row]) => shardOf(row) === index);
    if (own.length) ftsMatches += await ftsProbes(db, own.map(([row, term]) => ({ term, rowid: row.id, hit: true })), phase);
  }
  return {
    outcome: 'verified', encoding: state.encoding, rows: allRows.length, prefixRows: prefix.length,
    legacyPendingRows: legacy.length, legacyInvalidRows: legacy.filter((row) => invalid(row).length).length,
    lossyReplicaCells, recoveringCheckpoints: recovering, invalidCells, rawSha256Matches,
    longInvalidTextBytes: longRows.map((row) => row.text.length), boundPages: trace.boundPages,
    maxBoundParams: trace.maxBoundParams, maxBoundRequestBytes: trace.maxBoundRequestBytes, ftsMatches,
    guard: {
      mutation: 'ff-to-fe', phase: COPY_PHASES.SOURCE_DELETE_AND_FREEZE, nativeClass: 'malformed-json',
      comparison: guardComparison, writesAfterFailure: 0, diagnosticQueries: 1,
      sourceRetention: 'retained', freezeRetention: 'frozen', checkpointRetention: 'retained',
      destinationRetention: 'retained', staleRerun: COPY_INVARIANTS.SOURCE_CHANGED, restoredRun: 'complete',
    },
    sha256: recoveredSha256, positiveRowsRetained: positiveRows.length,
  };
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
        const durable = await readCopyState(shards[0]);
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
          else if (/VALUES \(/.test(insert.sql) && insert.params.length <= 100) fallbackPages += 1;
          else reject('copy-write-shape');
        }
        return await db.batch(statements);
      },
    }));
    phase = 'copy';
    const state = await copyFrozenIndex({
      source: observedSource, shards: observedShards, gate,
      checkpointHook: async (checkpoint) => {
        const durable = await readCopyState(shards[0]);
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
    requireProof(JSON.stringify(await readCopyState(shards[0])) === JSON.stringify(state), phase);
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
    requireProof(JSON.stringify(await readCopyState(shards[0])) === JSON.stringify(state), 'checkpoint-proof');
    phase = 'byte-exact-recovery';
    const byteExactRecovery = await proveByteExactRecovery({ source, shards, gate, positive: state, positiveRows: expected });
    await gate();
    return { state: 'verified', probe: 'd1-native-full-copy', rows: expected.length, columns: BLOCK_COLUMNS.length,
      shards: shards.length, denseRows: dense.length, growthRows: growth.length, ordinaryPages, fallbackPages,
      ftsMatches, freezeTriggers: 3, maxFtsParametersBytes, maxUnsplitFtsParametersBytes, splitFtsProbePages,
      legacyProbeMatches: legacyProbe.length, nativeProbeMatches: nativeProbe.length,
      longTextBytes: Buffer.byteLength(long.text), sha256: expectedSha256, byteExactRecovery };
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
