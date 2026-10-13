import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SESSION_CATALOG_COLUMNS } from '../src/index-layout.mjs';

const migrationsDir = path.resolve(import.meta.dirname, '../migrations');
const catalogPath = process.env.CATALOG_MIGRATION_PATH ?? path.join(migrationsDir, '0036_session_catalog_outbox.sql');
const dropPath = process.env.DROP_LEGACY_MIGRATION_PATH ?? path.join(migrationsDir, '0035_drop_legacy_blocks.sql');

async function legacyDatabase() {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    const manifest = JSON.parse(await readFile(path.join(migrationsDir, 'manifest.json'), 'utf8'));
    for (const migration of manifest.migrations) {
      if (migration.sequence > 34) break;
      database.exec(await readFile(path.join(migrationsDir, migration.filename), 'utf8'));
    }
    database.exec(`
      INSERT INTO machines (machine_id, os) VALUES ('test-machine', 'linux');
      INSERT INTO files (id, machine_id, store, relpath, r2_key, size, content_hash)
      VALUES (1, 'test-machine', 'test', 'session.jsonl', 'test-key', 1, 'test-hash');
    `);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function pending(database) {
  return database.prepare('SELECT EXISTS (SELECT 1 FROM session_catalog_outbox) AS pending').get().pending;
}
function version(database, sessionId = 'catalog-session') {
  return database.prepare('SELECT version FROM session_catalog_versions WHERE session_id = ?').get(sessionId).version;
}
function retire(database) {
  database.exec('DELETE FROM session_catalog_outbox');
}

// This is the same correlated subtotal refresh executed by refreshSessionCostStatement: it must
// still match the row when totals stay unchanged, without falsely making search pending.
const refreshCostSql = `UPDATE sessions
  SET cost_usd = (SELECT SUM(u.usd) FROM usage u WHERE u.session_id = sessions.session_id),
      cost_calls = (SELECT COUNT(*) FROM usage u WHERE u.session_id = sessions.session_id),
      cost_priced_calls = (SELECT COUNT(u.usd) FROM usage u WHERE u.session_id = sessions.session_id)
  WHERE session_id = 'catalog-session'`;

test('0036 unchanged pricing refresh keeps search current; changed and NULL totals require replication', async () => {
  const database = await legacyDatabase();
  try {
    database.exec(await readFile(dropPath, 'utf8'));
    database.exec(await readFile(catalogPath, 'utf8'));
    database.exec("INSERT INTO sessions (session_id, harness) VALUES ('catalog-session', 'omp')");
    database.exec("INSERT INTO usage (session_id, turn_index, model, usd) VALUES ('catalog-session', 1, 'test-model', 0.25)");
    database.exec(refreshCostSql);
    retire(database);
    const before = version(database);
    database.exec(refreshCostSql);
    assert.equal(pending(database), 0, 'unchanged pricing must not block search');
    assert.equal(version(database), before, 'unchanged pricing must not advance catalog version');
    database.exec('UPDATE sessions SET ' + SESSION_CATALOG_COLUMNS.map((column) => `${column} = ${column}`).join(', '));
    assert.equal(pending(database), 0, 'a full-row no-op must not block search');
    assert.equal(version(database), before);

    for (const usd of [0.5, null, 0]) {
      const previous = version(database);
      database.prepare('UPDATE usage SET usd = ?').run(usd);
      database.exec(refreshCostSql);
      assert.equal(database.prepare('SELECT cost_usd FROM sessions').get().cost_usd, usd);
      assert.equal(pending(database), 1, 'changed subtotal must prevent stale search');
      assert.ok(version(database) > previous, 'changed subtotal must advance catalog version');
      retire(database);
    }
  } finally {
    database.close();
  }
});

test('0036 every mirrored session value queues a new version, including nullable non-cost values and rekeys', async () => {
  const database = await legacyDatabase();
  try {
    database.exec(await readFile(dropPath, 'utf8'));
    database.exec(await readFile(catalogPath, 'utf8'));
    database.exec("INSERT INTO sessions (session_id, harness) VALUES ('catalog-session', 'omp')");
    retire(database);
    const columns = database.prepare('PRAGMA table_info(sessions)').all();
    for (const column of SESSION_CATALOG_COLUMNS.filter((name) => name !== 'session_id')) {
      const info = columns.find(({ name }) => name === column);
      assert.ok(info, `missing mirrored column ${column}`);
      const original = database.prepare(`SELECT ${column} AS value FROM sessions WHERE session_id = ?`).get('catalog-session').value;
      const changed = info.type === 'TEXT' ? `${column}-changed` : column === 'canonical_file_id' ? 1 : 7;
      for (const value of [changed, original]) {
        const previous = version(database);
        database.prepare(`UPDATE sessions SET ${column} = ? WHERE session_id = ?`).run(value, 'catalog-session');
        assert.equal(pending(database), 1, `${column} must prevent stale search`);
        assert.ok(version(database) > previous, `${column} must advance version`);
        retire(database);
      }
    }
    const previous = version(database);
    database.exec("UPDATE sessions SET session_id = 'catalog-rekeyed' WHERE session_id = 'catalog-session'");
    assert.ok(version(database, 'catalog-rekeyed') > previous);
    assert.ok(version(database) > previous, 'old id needs a tombstone version');
    assert.deepEqual(database.prepare('SELECT DISTINCT session_id FROM session_catalog_outbox ORDER BY session_id').all().map(({ session_id }) => session_id), ['catalog-rekeyed', 'catalog-session']);
  } finally {
    database.close();
  }
});

test('0035 refuses populated legacy blocks without losing rows or searchable FTS, then upgrades an empty source', async () => {
  const database = await legacyDatabase();
  try {
    database.exec(`
      INSERT INTO blocks (id, session_id, file_id, turn_index, block_index, btype, text)
      VALUES (101, 'legacy-session', 1, 0, 0, 'text', 'preservedfirst'),
             (102, 'legacy-session', 1, 1, 0, 'text', 'preservedsecond');
      INSERT INTO blocks_fts (rowid, text) SELECT id, text FROM blocks;
    `);
    const beforeRows = database.prepare('SELECT * FROM blocks ORDER BY id').all();
    const sql = await readFile(dropPath, 'utf8');
    database.exec('BEGIN');
    try {
      assert.throws(() => database.exec(sql), /legacy_blocks_not_empty/);
    } finally {
      database.exec('ROLLBACK');
    }
    assert.deepEqual(database.prepare('SELECT * FROM blocks ORDER BY id').all(), beforeRows);
    assert.deepEqual(database.prepare("SELECT rowid, text FROM blocks_fts WHERE blocks_fts MATCH 'preservedfirst OR preservedsecond' ORDER BY rowid").all().map(({ rowid, text }) => ({ rowid, text })), [
      { rowid: 101, text: 'preservedfirst' }, { rowid: 102, text: 'preservedsecond' },
    ]);
    database.exec("INSERT INTO blocks_fts (blocks_fts) VALUES ('integrity-check')");
    // Verified source deletion is external to retirement, just as in the protected copier.
    database.exec('DELETE FROM blocks');
    database.exec('BEGIN');
    try {
      database.exec(sql);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE name IN ('blocks', 'blocks_fts', 'legacy_blocks_retirement_guard')").all(), []);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM files').get().count, 1);
  } finally {
    database.close();
  }
});
