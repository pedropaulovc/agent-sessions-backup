import { randomUUID } from 'node:crypto';

export const D1_BATCH_PROBE_TEXT = '\ufeffD1-α😀\u0000会話-café-e\u0301';
const PROBE_TEXT_BYTES = Buffer.byteLength(D1_BATCH_PROBE_TEXT, 'utf8');

export const D1_SQL_FAILURE_REASONS = Object.freeze([
  'malformed-json', 'capacity', 'sql-syntax', 'missing-schema', 'limits', 'type-error',
  'quota', 'transient-reset', 'storage-timeout', 'overloaded', 'memory-limit', 'cpu-limit',
  'writer-fence', 'other',
]);
export const D1_FAILURE_KINDS = Object.freeze(['transport', 'http', 'statement', 'shape']);

function atomicityFailure(error, phase, failure = 'assertion') {
  error.d1AtomicityPhase = phase;
  error.d1AtomicityFailure = D1_FAILURE_KINDS.includes(error.d1FailureKind) ? error.d1FailureKind : failure;
  return error;
}

/** An actual REST-batch positive control on an index database, never on source DB. */
export async function verifyD1BatchAtomicity(db) {
  const table = `__index_batch_probe_${randomUUID().replaceAll('-', '')}`;
  let phase = 'ownership';
  const call = async (kind, ...args) => {
    try { return await db[kind](...args); }
    catch (error) { throw atomicityFailure(error, phase, 'other'); }
  };
  const reject = (message) => { throw atomicityFailure(new Error(message), phase); };
  const exists = async () => (await call('query',
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table],
  )).length !== 0;
  if (await exists()) reject('D1 atomicity probe name already exists; refusing ownership');
  const create = { sql: `CREATE TABLE "${table}" (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`, params: [] };
  const insert = { sql: `INSERT INTO "${table}" (id, value) VALUES (?, ?)`, params: [1, D1_BATCH_PROBE_TEXT] };
  const remove = async () => await call('query', `DROP TABLE "${table}"`);
  const read = {
    sql: `SELECT id, value, length(CAST(value AS BLOB)) AS value_bytes FROM "${table}"`, params: [],
  };
  const assertTextReadback = (rows, readback) => {
    if (rows?.length !== 1 || rows[0]?.id !== 1 || rows[0]?.value !== D1_BATCH_PROBE_TEXT
      || rows[0]?.value_bytes !== PROBE_TEXT_BYTES) {
      reject(`D1 successful batch positive control failed ${readback} text/byte readback`);
    }
  };
  let failure;
  try {
    // Prove this transport actually executes successful native batches before
    // interpreting the deliberately rejected batch as a rollback positive control.
    phase = 'batch-positive';
    const committed = await call('batch', [create, insert, read]);
    if (committed.length !== 3) {
      reject('D1 successful batch positive control returned unexpected result count');
    }
    assertTextReadback(committed[2]?.results, 'batch');
    phase = 'independent-positive';
    const readback = await call('query', read.sql, read.params);
    assertTextReadback(readback, 'independent');
    phase = 'cleanup';
    await remove();
    if (await exists()) reject('D1 successful batch probe cleanup failed');
    phase = 'rollback-negative';
    let rejection;
    try {
      await call('batch', [
        create, insert,
        { sql: "SELECT json('index_batch_atomicity_intentional_invalid_json')", params: [] },
      ]);
    } catch (error) {
      rejection = error;
    }
    const retained = await exists();
    if (retained) {
      phase = 'cleanup';
      await remove();
      phase = 'rollback-negative';
      reject('D1 REST batch partially committed before a failing statement; source copy forbidden');
    }
    if (!rejection || rejection.d1SqlReason !== 'malformed-json') {
      if (rejection) throw rejection;
      reject('D1 REST batch did not return the expected SQL rejection; atomicity unproven');
    }
    return { state: 'verified', probe: 'd1-rest-batch-atomicity', databaseId: db.id,
      textTransport: 'verified', textBytes: PROBE_TEXT_BYTES };
  } catch (error) {
    failure = error;
  }
  // The name was proven absent before this invocation wrote anything. Never
  // touch session data or another invocation's/user's table during cleanup.
  phase = 'cleanup';
  try { if (await exists()) await remove(); }
  catch (error) { failure.d1AtomicityCleanupFailure = error.d1AtomicityFailure; }
  throw failure;
}

/** Classify native tokens only; provider codes (including 7500) imply no SQL cause. */
export function d1SqlFailureReason(errors) {
  const reasons = new Set();
  for (const error of Array.isArray(errors) ? errors : []) {
    const message = typeof error === 'string' ? error : error?.message;
    if (typeof message !== 'string') continue;
    for (const [reason, pattern] of [
      ['malformed-json', /\bmalformed JSON\b/i],
      ['writer-fence', /\bindex_migration_frozen\b/],
      ['capacity', /\b(?:SQLITE_FULL|database or disk is full|Exceeded maximum DB size|Your account has exceeded D1's maximum account storage limit)\b/i],
      ['sql-syntax', /\b(?:syntax error|incomplete input|unrecognized token)\b/i],
      ['missing-schema', /\b(?:D1_COLUMN_NOTFOUND|no such (?:table|column|module)|has no column named)\b/i],
      ['limits', /\b(?:too many SQL variables|too many terms in compound SELECT|Expression tree is too large|string or blob too big|SQLITE_TOOBIG|statement too long)\b/i],
      ['type-error', /\bD1_TYPE_ERROR\b/],
      ['quota', /\bYour account has exceeded D1's free tier daily row (?:read|write) limit\b/i],
      ['transient-reset', /\b(?:D1 DB reset because its code was updated|Internal error (?:while starting up|in) D1 DB storage caused object to be reset|Network connection lost|Replica disconnected from primary|Cannot resolve D1 DB due to transient issue on remote node|Can't read from request stream because client disconnected)\b/i],
      ['storage-timeout', /\bD1 DB storage operation exceeded timeout which caused object to be reset\b/i],
      ['overloaded', /\bD1 DB is overloaded\. (?:Requests queued for too long|Too many requests queued)\b/i],
      ['memory-limit', /\bD1 DB's isolate exceeded its memory limit and was reset\b/i],
      ['cpu-limit', /\bD1 DB exceeded its CPU time limit and was reset\b/i],
    ]) {
      if (pattern.test(message)) reasons.add(reason);
    }
  }
  // Conflicting tokens are not evidence for a single cause.
  return reasons.size === 1 ? [...reasons][0] : 'other';
}
