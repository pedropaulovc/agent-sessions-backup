import { createHash, randomBytes } from 'node:crypto';
import {
  PREVIEW_D1_DATABASE_LIMIT, paginatedList, positiveInteger,
  previewCopyScratchNames, previewResourceOwner,
} from './preview-trust.mjs';
import {
  COPY_CHECKPOINT, COPY_PAGE_BYTES, SOURCE_FREEZE_TABLE, canonicalRow,
  copyFrozenIndex, readCheckpoint,
} from '../../hub/scripts/lib/index-migration.mjs';
import { BLOCK_COLUMNS, INDEX_ID_SPAN, indexShardForSessionId } from '../../hub/src/index-layout.mjs';

const COPY_PHASES = new Set([
  'copy-setup', 'copy-checkpoint-read', 'copy-checkpoint-write', 'copy-source-page-read',
  'copy-page-write', 'copy-page-readback', 'copy-fts-match', 'copy-discard-page',
  'copy-source-freeze-read', 'copy-source-freeze-install', 'copy-source-delete-and-freeze',
  'checkpoint-read', 'checkpoint-write',
]);
const NATIVE_CLASSES = new Set([
  'malformed-json', 'capacity', 'sql-syntax', 'missing-schema', 'limits', 'type-error',
  'quota', 'transient-reset', 'storage-timeout', 'overloaded', 'memory-limit', 'cpu-limit',
  'writer-fence', 'other',
]);

// No causes/stacks from a provider or subprocess are retained in public diagnostics.
export class NativeCopyControlError extends Error {
  constructor(phase, failureClass) {
    super(`native copy control phase=${phase} class=${failureClass}`);
    this.name = 'NativeCopyControlError';
    this.nativeCopyPhase = phase;
    this.nativeCopyClass = failureClass;
  }
}
const reject = (phase, failureClass = 'assertion') => { throw new NativeCopyControlError(phase, failureClass); };
const requireProof = (condition, phase) => { if (!condition) reject(phase); };
function safeFailure(error, phase) {
  if (error instanceof NativeCopyControlError) return error;
  return new NativeCopyControlError(COPY_PHASES.has(error?.d1Phase) ? error.d1Phase : phase,
    NATIVE_CLASSES.has(error?.d1SqlReason) ? error.d1SqlReason : 'other');
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
  try {
    ownerPr = positiveInteger(pr, 'PR number');
    names = previewCopyScratchNames(ownerPr, nonce);
    const databases = await paginatedList(api.cf, 'd1/database', {
      pagination: 'page', rowsOf: (envelope) => envelope.result,
    });
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
    return await run({ source: adapters[0], shards: adapters.slice(1), gate,
      identities: created.map(({ name, uuid }) => ({ name, id: uuid })) });
  } catch (error) {
    throw safeFailure(error, phase);
  } finally {
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
    if (cleanupFailure) throw cleanupFailure;
  }
}

const quote = (column) => `"${column.replaceAll('"', '""')}"`;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const rowsSha256 = (rows) => sha256(`[${rows.map((row) => canonicalRow(BLOCK_COLUMNS, row)).join(',')}]`);
const INSERT_BLOCK = `INSERT INTO blocks (${BLOCK_COLUMNS.map(quote).join(',')}) VALUES (${BLOCK_COLUMNS.map(() => '?').join(',')})`;
const blockStatement = (row) => ({ sql: INSERT_BLOCK, params: BLOCK_COLUMNS.map((column) => row[column]) });
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
  requireProof(Buffer.byteLength(canonicalRow(BLOCK_COLUMNS, ordinary)) < COPY_PAGE_BYTES, 'fixture');
  requireProof(Buffer.byteLength(canonicalRow(BLOCK_COLUMNS, long)) > COPY_PAGE_BYTES
    && BLOCK_COLUMNS.reduce((bytes, column) => bytes + (long[column] === null ? 0 : Buffer.byteLength(String(long[column]))), 0) < 2_000_000,
  'fixture');
  return [ordinary, long];
}

/** Independent native readback: TEXT is hex transported, long TEXT in bounded BLOB slices. */
async function readRows(db, phase) {
  const selectors = BLOCK_COLUMNS.flatMap((column, index) => {
    const name = quote(column);
    return [
      `CASE WHEN typeof(${name}) = 'text' THEN CASE WHEN length(CAST(${name} AS BLOB)) <= 65536 THEN hex(CAST(${name} AS BLOB)) ELSE NULL END ELSE ${name} END AS ${name}`,
      `typeof(${name}) AS "__type_${index}"`,
      `CASE WHEN typeof(${name}) = 'text' THEN length(CAST(${name} AS BLOB)) ELSE NULL END AS "__bytes_${index}"`,
    ];
  });
  const result = await db.query(`SELECT ${selectors.join(',')} FROM blocks ORDER BY id`);
  const rows = [];
  for (const encoded of result) {
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
      if (length <= 65536) {
        requireProof(typeof value === 'string' && value.length === length * 2 && /^[0-9a-f]*$/i.test(value), phase);
        bytes = Buffer.from(value, 'hex');
      } else {
        requireProof(value === null, phase);
        const chunks = [];
        for (let offset = 0; offset < length; offset += 131072) {
          const count = Math.min(131072, length - offset);
          const parts = await db.query(`SELECT hex(substr(CAST(${quote(column)} AS BLOB), ?, ?)) AS bytes FROM blocks WHERE id = CAST(? AS INTEGER)`,
            [offset + 1, count, encoded.id]);
          requireProof(parts.length === 1 && typeof parts[0].bytes === 'string'
            && parts[0].bytes.length === count * 2 && /^[0-9a-f]+$/i.test(parts[0].bytes), phase);
          chunks.push(Buffer.from(parts[0].bytes, 'hex'));
        }
        bytes = Buffer.concat(chunks, length);
      }
      row[column] = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    }
    rows.push(row);
  }
  return rows;
}
async function assertFrozen(source) {
  const objects = await source.query(`SELECT type, name FROM sqlite_master WHERE name IN (
    '${SOURCE_FREEZE_TABLE}', 'index_migration_blocks_insert', 'index_migration_blocks_update', 'index_migration_blocks_delete')`);
  requireProof(objects.length === 4 && objects.filter((object) => object.type === 'table' && object.name === SOURCE_FREEZE_TABLE).length === 1
    && objects.filter((object) => object.type === 'trigger').length === 3, 'source-fence');
  const rows = await source.query(`SELECT id, state FROM ${SOURCE_FREEZE_TABLE}`);
  requireProof(rows.length === 1 && rows[0].id === 1 && rows[0].state === 'frozen', 'source-fence');
}

async function proveNativeCopy({ source, shards, gate }) {
  let phase = 'seed';
  try {
    const expected = fixtures();
    const expectedSha256 = rowsSha256(expected);
    await source.batch(expected.map(blockStatement));
    phase = 'seed-readback';
    requireProof(rowsSha256(await readRows(source, 'seed-readback')) === expectedSha256, 'seed-readback');
    let verifiedCheckpoint;
    let deletedRows = 0;
    let ordinaryPages = 0;
    let fallbackPages = 0;
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
    const observedShards = shards.map((db) => ({
      id: db.id, query: (...args) => db.query(...args),
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
        if (checkpoint.pending?.phase === 'verified') verifiedCheckpoint = JSON.stringify(checkpoint.pending);
      },
    });
    requireProof(state.state === 'complete' && state.rows === expected.length && state.pending === null
      && JSON.stringify(state.columns) === JSON.stringify(BLOCK_COLUMNS)
      && deletedRows === expected.length && ordinaryPages > 0 && fallbackPages > 0, 'copy-complete');
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
    let ftsMatches = 0;
    for (const [index, row] of expected.entries()) {
      const tokens = index === 0 ? ['nativeordinaryvisible', 'nativeordinarysuffix'] : ['nativelongvisible', 'nativelongsuffix'];
      const db = shards[indexShardForSessionId(row.session_id, 2)];
      for (const token of tokens) {
        const matches = await db.query('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ? AND rowid = CAST(? AS INTEGER)', [token, row.id]);
        requireProof(matches.length === 1 && matches[0].rowid === row.id, phase);
        ftsMatches += 1;
      }
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
    await gate();
    return { state: 'verified', probe: 'd1-native-full-copy', rows: expected.length, columns: BLOCK_COLUMNS.length,
      shards: shards.length, ordinaryPages, fallbackPages, ftsMatches, freezeTriggers: 3,
      longTextBytes: Buffer.byteLength(expected[1].text), sha256: expectedSha256 };
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
