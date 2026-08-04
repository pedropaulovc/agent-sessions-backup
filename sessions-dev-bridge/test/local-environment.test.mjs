import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { executeD1Migrations, splitSqliteStatements } from '../src/sqlite-statements.mjs';

const EDGE_CASE_MIGRATION = `
-- Leading comments may contain semicolons; without becoming statements.
CREATE TABLE [source;table] ("value;text" TEXT);
/* A block comment between statements; has a semicolon. */
CREATE TABLE audit_log (message TEXT);
CREATE TRIGGER \`source;audit\` AFTER INSERT ON [source;table]
BEGIN
  INSERT INTO audit_log(message)
    SELECT CASE WHEN NEW."value;text" = 'it''s;fine'
      THEN 'quoted;value' ELSE 'other' END;
  -- This semicolon is still inside the trigger body;
  UPDATE audit_log SET message = message || ';updated';
  /* Nor does this comment end the trigger; */
END;
SELECT 'done;still one';
`;

test('SQLite tokenizer preserves comments, quoted semicolons, multiline statements, and trigger bodies', () => {
  const statements = splitSqliteStatements(EDGE_CASE_MIGRATION);
  assert.equal(statements.length, 4);
  assert.match(statements[0], /CREATE TABLE \[source;table\]/);
  assert.match(statements[1], /block comment between statements;[\s\S]*CREATE TABLE audit_log/);
  assert.match(statements[2], /CREATE TRIGGER[\s\S]*CASE[\s\S]*UPDATE audit_log[\s\S]*END;$/);
  assert.match(statements[3], /SELECT 'done;still one';$/);
});

test('migration executor prepares complete statements and batches each migration', async () => {
  const prepared = [];
  const batches = [];
  const database = {
    prepare(sql) {
      const statement = { sql };
      prepared.push(statement);
      return statement;
    },
    async batch(statements) { batches.push(statements); },
  };

  await executeD1Migrations(database, [
    { name: 'comments.sql', sql: '-- no executable SQL;\n/* still none; */' },
    { name: 'edge-cases.sql', sql: EDGE_CASE_MIGRATION },
  ]);

  assert.equal(prepared.length, 4);
  assert.deepEqual(batches, [prepared]);
});

test('actual checked-in migrations apply to a fresh Miniflare D1', async () => {
  const migrationsDirectory = fileURLToPath(new URL('../../hub/migrations/', import.meta.url));
  const names = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_[A-Za-z0-9_-]+\.sql$/.test(name))
    .sort();
  const migrations = await Promise.all(names.map(async (name) => ({
    name,
    sql: await readFile(new URL(`../../hub/migrations/${name}`, import.meta.url), 'utf8'),
  })));
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    compatibilityDate: '2026-07-10',
    d1Databases: { DB: 'bridge-migration-test' },
  });

  try {
    const { DB } = await miniflare.getBindings();
    await executeD1Migrations(DB, migrations);
    await executeD1Migrations(DB, [{ name: 'edge-cases.sql', sql: EDGE_CASE_MIGRATION }]);
    await DB.prepare("INSERT INTO [source;table] ([value;text]) VALUES (?1)").bind("it's;fine").run();

    const schema = await DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    assert.ok(schema.results.some((row) => row.name === 'debug_import_jobs'));
    const usageColumns = await DB.prepare('PRAGMA table_info(usage)').all();
    assert.ok(usageColumns.results.some((row) => row.name === 'priced_version'));
    const audit = await DB.prepare('SELECT message FROM audit_log').all();
    assert.deepEqual(audit.results, [{ message: 'quoted;value;updated' }]);
  } finally {
    await miniflare.dispose();
  }
});
