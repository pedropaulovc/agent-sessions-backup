import { randomUUID } from 'node:crypto';

/** An actual REST-batch positive control on an index database, never on source DB. */
export async function verifyD1BatchAtomicity(db) {
  const table = `__index_batch_probe_${randomUUID().replaceAll('-', '')}`;
  const exists = async () => (await db.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table],
  )).length !== 0;
  if (await exists()) throw new Error('D1 atomicity probe name already exists; refusing ownership');
  const create = { sql: `CREATE TABLE "${table}" (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`, params: [] };
  const insert = { sql: `INSERT INTO "${table}" (id, value) VALUES (?, ?)`, params: [1, 'committed'] };
  const remove = async () => await db.query(`DROP TABLE "${table}"`);
  try {
    // Prove this transport actually executes successful native batches before
    // interpreting the deliberately rejected batch as a rollback positive control.
    const committed = await db.batch([
      create, insert, { sql: `SELECT id, value FROM "${table}"`, params: [] },
    ]);
    if (committed.length !== 3 || committed[2]?.results?.length !== 1
      || committed[2].results[0].id !== 1 || committed[2].results[0].value !== 'committed') {
      throw new Error('D1 successful batch positive control returned unexpected evidence');
    }
    const readback = await db.query(`SELECT id, value FROM "${table}"`);
    if (readback.length !== 1 || readback[0].id !== 1 || readback[0].value !== 'committed') {
      throw new Error('D1 successful batch positive control failed independent readback');
    }
    await remove();
    if (await exists()) throw new Error('D1 successful batch probe cleanup failed');
    let rejection;
    try {
      await db.batch([
        create, insert,
        { sql: "SELECT json('index_batch_atomicity_intentional_invalid_json')", params: [] },
      ]);
    } catch (error) {
      rejection = error;
    }
    const retained = await exists();
    if (retained) {
      await remove();
      throw new Error('D1 REST batch partially committed before a failing statement; source copy forbidden');
    }
    if (!rejection || rejection.d1SqlReason !== 'malformed-json') {
      throw new Error('D1 REST batch did not return the expected SQL rejection; atomicity unproven');
    }
    return { state: 'verified', probe: 'd1-rest-batch-atomicity', databaseId: db.id };
  } catch (error) {
    // The name was proven absent before this invocation wrote anything. Never
    // touch session data or another invocation's/user's table during cleanup.
    if (await exists()) await remove();
    throw error;
  }
}

/** Preserve only a safe SQL-rejection enum; never expose provider SQL/error text. */
export function d1SqlFailureReason(errors) {
  return errors.some((error) => {
    const message = typeof error === 'string' ? error : error?.message;
    return typeof message === 'string' && /\bmalformed JSON\b/i.test(message);
  }) ? 'malformed-json' : 'other';
}
