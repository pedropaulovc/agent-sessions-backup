import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { migrationDigest } from '../scripts/lib/migration-manifest.mjs';
import {
  PREVIEW_ACCOUNT_ID,
  PRODUCTION_ACCOUNT_ID,
  previewIndexLayout,
  resourceNames,
  sha256Bytes,
  stableJson,
} from '../../infra/cf/preview-trust.mjs';
import { D1_BATCH_PROBE_TEXT } from '../../infra/cf/d1-batch-atomicity.mjs';

const SHA = 'a'.repeat(40);
const SEED = 'synthetic-preview-seed-for-deployment-regression';
const PR = 150;
const NAMES = resourceNames(PR);
const LAYOUT = previewIndexLayout(NAMES);
const controller = process.env.PREVIEW_CONTROL_PATH
  ?? fileURLToPath(new URL('../../infra/cf/preview-control.mjs', import.meta.url));
const manifestModule = new URL('../scripts/lib/migration-manifest.mjs', import.meta.url).href;
const layoutModule = new URL('../src/index-layout.mjs', import.meta.url).href;
const SCHEMA_DIGESTS = [
  { binding: 'DB', digest: 'd'.repeat(64) },
  { binding: 'IDX00', digest: 'e'.repeat(64) },
  { binding: 'IDX01', digest: 'e'.repeat(64) },
];
const PROBE_TEXT_BYTES = Buffer.byteLength(D1_BATCH_PROBE_TEXT, 'utf8');

function plainRows(database, sql, params = [], statement = database.prepare(sql)) {
  const columns = statement.columns();
  const quoted = (name) => `"${name.replaceAll('"', '""')}"`;
  // Read stored TEXT through BLOBs: Node's TEXT getter can stop at embedded NUL.
  // Retain each SQLite storage type so BLOBs, nulls and numbers are not coerced.
  if (/^\s*PRAGMA\b/i.test(sql)) return statement.all(...params).map((row) => ({ ...row }));
  const aliases = columns.map((_, index) => quoted(`__column_${index}`));
  const selectors = aliases.flatMap((column, index) => [
    `CASE WHEN typeof(${column}) = 'text' THEN CAST(${column} AS BLOB)
      ELSE ${column} END AS ${quoted(`__value_${index}`)}`,
    `typeof(${column}) AS ${quoted(`__type_${index}`)}`,
  ]);
  const transport = database.prepare(`WITH "__d1_result" (${aliases.join(',')}) AS MATERIALIZED (
    ${sql.replace(/;\s*$/, '')}
  ) SELECT ${selectors.join(',')} FROM "__d1_result"`);
  return transport.all(...params).map((row) => Object.fromEntries(columns.map(({ name }, index) => [
    name, row[`__type_${index}`] === 'text'
      ? Buffer.from(row[`__value_${index}`]).toString('utf8') : row[`__value_${index}`],
  ])));
}

function textEvidence(value) {
  return typeof value === 'string'
    ? { utf8Bytes: Buffer.byteLength(value, 'utf8'), sha256: createHash('sha256').update(value, 'utf8').digest('hex') }
    : value;
}

async function runController(command, scenario = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'preview-deployment-test-'));
  const hub = path.join(temporary, 'hub');
  const eventPath = path.join(temporary, 'events.jsonl');
  const reportPath = path.join(temporary, 'report.json');
  const preload = path.join(temporary, 'preload.mjs');
  const wrangler = path.join(temporary, 'wrangler.mjs');
  const migrationsCli = path.join(temporary, 'migrations.mjs');
  const native = command === 'native-copy-proof';
  const sqliteDirectory = path.join(temporary, 'sqlite');
  const manifests = {};
  try {
    await mkdir(path.join(hub, 'src'), { recursive: true });
    await mkdir(sqliteDirectory);
    await writeFile(path.join(hub, 'src', 'preview.ts'), 'export default {};\n');
    await writeFile(path.join(hub, 'package-lock.json'), '{}\n');
    await writeFile(eventPath, '');
    for (const [directory, filename, ledgerStartsAt] of [
      ['migrations', '0001_main.sql', 2],
      ['migrations-index', '0001_index.sql', 1],
    ]) {
      const root = path.join(hub, directory);
      const sql = `CREATE TABLE ${directory === 'migrations' ? 'meta' : 'shard_meta'} (id INTEGER);\n`;
      const manifest = {
        formatVersion: 1, hashEncoding: 'sha256-canonical-lf', reservedSequences: [], ledgerStartsAt,
        migrations: [{ sequence: 1, filename, sha256: sha256Bytes(sql) }],
      };
      manifests[directory] = manifest;
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, filename), sql);
      await writeFile(path.join(root, 'manifest.json'), stableJson(manifest));
      await writeFile(path.join(root, 'source-baseline.json'), stableJson(manifest));
      if (directory === 'migrations') await writeFile(path.join(root, 'historical-baseline.json'), '{}');
    }
    if (native) {
      const source = fileURLToPath(new URL('../migrations-index/', import.meta.url));
      for (const filename of await readdir(source)) {
        await writeFile(path.join(hub, 'migrations-index', filename), await readFile(path.join(source, filename)));
      }
      await rm(path.join(hub, 'migrations-index', '0001_index.sql'));
      manifests['migrations-index'] = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
    }
    await writeFile(wrangler, `
      import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
      import path from 'node:path';
      const args = process.argv.slice(2);
      const option = (name) => args[args.indexOf('--' + name) + 1];
      const config = JSON.parse(readFileSync(option('config'), 'utf8'));
      const eventPath = ${JSON.stringify(eventPath)};
      const emit = (event) => appendFileSync(eventPath, JSON.stringify(event) + '\\n');
      if (args.includes('--dry-run')) {
        emit({ kind: 'build', config });
        mkdirSync(option('outdir'), { recursive: true });
        writeFileSync(path.join(option('outdir'), 'worker.js'), 'export default { fetch() {} };');
        writeFileSync(option('metafile'), JSON.stringify({ inputs: { [config.main]: { bytes: 1 } } }));
      } else {
        emit({ kind: 'deploy', config });
        console.log('https://' + ${JSON.stringify(NAMES.host)});
      }
    `);
    await writeFile(migrationsCli, `
      import { appendFileSync, readFileSync } from 'node:fs';
      import { migrationDigest } from ${JSON.stringify(manifestModule)};
      import { DatabaseSync } from 'node:sqlite';
      import path from 'node:path';
      const scenario = ${JSON.stringify(scenario)};
      const [command, ...args] = process.argv.slice(2);
      const options = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, index) =>
        [args[index * 2].slice(2), args[index * 2 + 1]]));
      const config = JSON.parse(readFileSync(options.config, 'utf8'));
      appendFileSync(${JSON.stringify(eventPath)}, JSON.stringify({ kind: 'migrate', command, options, config }) + '\\n');
      const manifest = JSON.parse(readFileSync(options.manifest, 'utf8'));
      if (${native} && !scenario.pending && !scenario.wrongDigest) {
        const binding = config.d1_databases.find((database) => database.binding === options.database);
        if (binding.database_id !== options['database-id'] || binding.migrations_dir !== options['migrations-dir']
          || config.account_id !== ${JSON.stringify(PREVIEW_ACCOUNT_ID)}) throw new Error('invalid native schema identity');
        const database = new DatabaseSync(path.join(${JSON.stringify(sqliteDirectory)}, binding.database_id + '.sqlite'));
        for (const migration of manifest.migrations) database.exec(readFileSync(path.join(options['migrations-dir'], migration.filename), 'utf8'));
        database.close();
      }
      console.log(JSON.stringify({
        pendingMigrations: scenario.pending === options.database ? 1 : 0,
        schemaDigest: options.database === 'DB' ? 'd'.repeat(64) : 'e'.repeat(64),
        migrationDigest: scenario.wrongDigest === options.database ? '0'.repeat(64) : migrationDigest(manifest),
      }));
    `);
    await writeFile(preload, `
      import { appendFileSync, writeFileSync } from 'node:fs';
      import { createHash } from 'node:crypto';
      import { DatabaseSync } from 'node:sqlite';
      import { INDEX_LAYOUT } from ${JSON.stringify(layoutModule)};
      ${plainRows.toString()}
      ${textEvidence.toString()}
      const scenario = ${JSON.stringify(scenario)};
      const names = ${JSON.stringify(NAMES)};
      const layout = ${JSON.stringify(LAYOUT)};
      const manifests = ${JSON.stringify(manifests)};
      const databaseNames = layout.databases.map((database) => database.name);
      const databases = Array.from({ length: scenario.foreignCount ?? 0 }, (_, index) => ({
        name: 'pr-' + (900 + index) + '-sessions-index', uuid: 'foreign-' + index,
      }));
      if (scenario.existing) databases.push(...databaseNames.flatMap((name, index) =>
        scenario.legacy && index !== 0 ? [] : [{ name, uuid: 'existing-' + index }]));
      databases.push(...(scenario.extraDatabases ?? []));
      if (scenario.partial) databases.splice(databases.findIndex((database) => database.name === names.indexShards[1]), 1);
      if (scenario.untrustedNames) databases.push(
        { name: 'sessions-index', uuid: 'production-looking-name' },
        { name: 'pr-150-sessions-index-idx02', uuid: 'unexpected-shard' },
        { name: 'pr-150-app', uuid: 'wrong-kind' },
      );
      let workerExists = !!scenario.existing && !scenario.missingWorker;
      let created = 0;
      const shardRows = new Map();
      const probeDatabases = new Map();
      let rejectedAtomicityBatch = false;
      const eventPath = ${JSON.stringify(eventPath)};
      const emit = (event) => appendFileSync(eventPath, JSON.stringify(event) + '\\n');
      const response = (result) => Response.json({ success: true, result });
      const missing = () => Response.json({ success: false, errors: [{ message: 'not found' }] }, { status: 404 });
      process.on('exit', () => {
        const probeEvidence = [...probeDatabases].map(([databaseId, database]) => ({
          databaseId,
          tables: database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name),
          unrelatedValues: database.prepare("SELECT name FROM sqlite_master WHERE name = 'unrelated_user_table'").get()
            ? database.prepare('SELECT value FROM unrelated_user_table').all().map((row) => row.value) : [],
        }));
        for (const database of probeDatabases.values()) database.close();
        writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ databases, probeEvidence }));
      });
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(input);
        const method = init.method ?? 'GET';
        const body = init.body ? JSON.parse(init.body) : null;
        const probeRequest = body?.batch || body?.sql?.includes('__index_batch_probe_')
          || body?.params?.some((value) => typeof value === 'string' && value.startsWith('__index_batch_probe_'));
        const evidenceStatement = (statement) => ({
          ...statement, params: (statement.params ?? []).map(textEvidence),
        });
        const evidenceBody = probeRequest
          ? body.batch ? { batch: body.batch.map(evidenceStatement) } : evidenceStatement(body)
          : body;
        emit({ kind: 'request', url: url.href, method, body: evidenceBody });
        if (url.hostname === names.host && url.pathname === '/healthz') return new Response('ok');
        if (url.hostname === 'api.github.com') {
          const number = Number(url.pathname.split('/').at(-1));
          return Response.json({ state: number === 150 ? 'closed' : 'open' });
        }
        if (url.hostname !== 'api.cloudflare.com') throw new Error('Unexpected host ' + url.hostname);
        const prefix = '/client/v4/accounts/' + ${JSON.stringify(PREVIEW_ACCOUNT_ID)} + '/';
        if (!url.pathname.startsWith(prefix)) throw new Error('Unexpected account ' + url.pathname);
        const target = decodeURIComponent(url.pathname.slice(prefix.length));
        if (target === 'd1/database' && method === 'GET') {
          if (scenario.databaseListError) {
            return Response.json({ success: false, errors: [{ message: 'permission denied' }] }, { status: 403 });
          }
          const name = url.searchParams.get('name');
          const rows = name ? databases.filter((database) => database.name === name) : databases;
          return Response.json({ success: true, result: rows, result_info: { total_count: rows.length } });
        }
        if (target === 'd1/database' && method === 'POST') {
          const database = { name: body.name, uuid: 'created-' + (++created) };
          databases.push(database);
          return response(database);
        }
        if (target.startsWith('d1/database/') && method === 'GET' && !target.endsWith('/query')) {
          const database = databases.find((entry) => entry.uuid === target.slice('d1/database/'.length));
          return database ? response(database) : missing();
        }
        if (target.startsWith('d1/database/') && method === 'DELETE') {
          const id = target.slice('d1/database/'.length);
          const index = databases.findIndex((database) => database.uuid === id);
          if (index !== -1) databases.splice(index, 1);
          return response({});
        }
        if (target.startsWith('d1/database/') && target.endsWith('/query')) {
          const id = target.split('/')[2];
          const database = databases.find((entry) => entry.uuid === id);
          if (!database) throw new Error('Unknown database ' + id);
          // Keep the existing transport fixture, but execute the probe's ACTUAL SQL
          // against SQLite. Success evidence and rollback are never fabricated echoes.
          if (probeRequest || ${native}) {
            let native = probeDatabases.get(id);
            if (!native) {
              native = new DatabaseSync(${native} ? ${JSON.stringify(sqliteDirectory)} + '/' + id + '.sqlite' : ':memory:');
              if (!${native}) native.exec("CREATE TABLE unrelated_user_table (value TEXT NOT NULL); INSERT INTO unrelated_user_table VALUES ('untouched')");
              probeDatabases.set(id, native);
            }
            const statements = body.batch ?? [{ sql: body.sql, params: body.params ?? [] }];
            const execute = ({ sql, params = [] }) => {
              const statement = native.prepare(sql);
              const rows = statement.columns().length ? plainRows(native, sql, params, statement)
                : (statement.run(...params), []);
              emit({ kind: 'probe-sql', databaseId: id, sql, params: params.map(textEvidence),
                rows: rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, textEvidence(value)]))) });
              return { success: true, results: rows };
            };
            const failureBatch = body.batch?.some((statement) =>
              statement.sql.includes('index_batch_atomicity_intentional_invalid_json'));
            if (failureBatch && scenario.atomicityWrongReason) {
              return Response.json({ success: false, errors: [{ message: 'atomicity-private-provider-text' }] }, { status: 403 });
            }
            if (body.batch && !failureBatch && scenario.atomicityNoExecution) {
              return response(statements.map(() => ({ success: true, results: [] })));
            }
            if (scenario.atomicityCleanupFailure && rejectedAtomicityBatch
              && statements.some(({ sql }) => /^DROP TABLE "__index_batch_probe_[0-9a-f]+"$/.test(sql))) {
              emit({ kind: 'probe-cleanup-fault', databaseId: id, sql: statements[0].sql });
              return Response.json({ success: false, errors: [{ message: 'ATOMICITY_CLEANUP_PRIVATE_CANARY' }] }, { status: 503 });
            }
            const transactional = body.batch && !scenario.atomicityPartialCommit;
            if (transactional) native.exec('BEGIN');
            try {
              const results = statements.map(execute);
              if (transactional) native.exec('COMMIT');
              const phase = body.batch ? 'batch' : 'independent';
              if (!failureBatch && scenario.atomicityReadback?.phase === phase) {
                const readIndex = statements.findIndex(({ sql }) => sql.startsWith('SELECT id, value'));
                if (readIndex !== -1) {
                  const result = results[readIndex];
                  const row = result.results[0];
                  const { corruption } = scenario.atomicityReadback;
                  switch (corruption) {
                    case 'missing-result': results.splice(readIndex, 1); break;
                    case 'extra-result': results.push({ success: true, results: [] }); break;
                    case 'malformed-rows': result.results = {}; break;
                    case 'missing-rows': delete result.results; break;
                    case 'missing-row': result.results = []; break;
                    case 'duplicate-row': result.results.push({ ...row }); break;
                    case 'malformed-text': row.value = { private: 'atomicity-private-provider-text' }; break;
                    case 'missing-text': delete row.value; break;
                    case 'nul-truncated-text': row.value = row.value.slice(0, row.value.indexOf('\\u0000')); break;
                    case 'bom-stripped-text': row.value = row.value.slice(1); break;
                    case 'normalized-text': row.value = row.value.normalize('NFC'); break;
                    case 'truncated-text-and-bytes':
                      row.value = row.value.slice(0, row.value.indexOf('\\u0000'));
                      row.value_bytes = Buffer.byteLength(row.value, 'utf8');
                      break;
                    case 'missing-byte-count': delete row.value_bytes; break;
                    case 'malformed-byte-count': row.value_bytes = String(row.value_bytes); break;
                    case 'incorrect-byte-count': row.value_bytes -= 1; break;
                    default: throw new Error('Unknown atomicity readback corruption');
                  }
                  emit({ kind: 'probe-readback-fault', databaseId: id, phase, corruption });
                }
              }
              return response(results);
            } catch (error) {
              if (transactional) native.exec('ROLLBACK');
              if (failureBatch) rejectedAtomicityBatch = true;
              return Response.json({ success: false, errors: [{ message: error.message }] }, { status: 400 });
            }
          }
          const index = databaseNames.indexOf(database.name);
          const manifest = manifests[index === 0 ? 'migrations' : 'migrations-index'];
          if (scenario.queryError === layout.databases[index].binding) {
            return Response.json({ success: false, errors: [{ message: 'permission denied' }] }, { status: 403 });
          }
          let rows = [];
          if (body.sql.includes('FROM d1_migrations')) {
            if (!id.startsWith('existing-')) {
              return Response.json({ success: false, errors: [{ message: 'no such table: d1_migrations' }] }, { status: 400 });
            }
            rows = manifest.migrations.map((entry) => ({ name: entry.filename }));
            if (scenario.removed === layout.databases[index].binding) rows.push({ name: '0002_removed.sql' });
          } else if (body.sql.startsWith('SELECT value')) {
            if (body.params[0] === 'preview_index_layout') {
              if (id.startsWith('existing-') && !scenario.legacy) {
                const recordedLayout = 'recordedLayout' in scenario ? scenario.recordedLayout : layout;
                if (recordedLayout !== null) rows = [{ value: JSON.stringify(recordedLayout) }];
              }
            } else if (id.startsWith('existing-')) {
              const ledger = Object.fromEntries(manifest.migrations.map((entry) => [entry.filename,
                scenario.edited === layout.databases[index].binding ? '0'.repeat(64) : entry.sha256]));
              rows = [{ value: JSON.stringify(scenario.unproven === layout.databases[index].binding ? {} : ledger) }];
            }
          } else if (body.sql.startsWith('INSERT INTO shard_meta')) {
            if (!shardRows.has(id)) shardRows.set(id, {
              shard_index: body.params[0], shard_count: body.params[1], layout: body.params[2],
            });
          } else if (body.sql.startsWith('SELECT shard_index')) {
            const row = shardRows.get(id) ?? (id.startsWith('existing-') && !scenario.legacy ? {
              shard_index: scenario.shardIndex ?? index - 1, shard_count: scenario.shardCount ?? 2,
              layout: scenario.shardHash ?? INDEX_LAYOUT,
            } : null);
            rows = row ? [row] : [];
          }
          return response([{ success: true, results: rows }]);
        }
        if (target === 'workers/scripts') return response(workerExists ? [{ id: names.app }] : []);
        if (target.endsWith('/settings')) {
          if (scenario.settingsError) {
            return Response.json({ success: false, errors: [{ message: 'permission denied' }] }, { status: 403 });
          }
          if (!workerExists) return missing();
          const bindings = scenario.legacy || scenario.sourceLegacy ? [{ name: 'DB', type: 'd1', id: 'existing-0' }] : [
            { name: 'INDEX_SHARD_COUNT', type: 'plain_text', text: String(scenario.sourceCount ?? 2) },
            ...layout.databases.map(({ binding }, index) => ({
              name: binding, type: 'd1', id: scenario.foreignBinding === binding ? 'foreign-0' : 'existing-' + index,
            })),
          ];
          return response({ bindings: scenario.sourceBindings ?? bindings });
        }
        if (target.startsWith('workers/scripts/') && method === 'DELETE') {
          workerExists = false;
          return response({});
        }
        if (target.endsWith('/objects')) return response([{ key: 'raw/fixture.jsonl' }]);
        if (target.includes('/objects/') && method === 'DELETE') return response({});
        if (target === 'r2/buckets') return response({ buckets: [{ name: names.r2 }] });
        if (target.startsWith('r2/buckets/')) return response({ name: names.r2 });
        if (target === 'storage/kv/namespaces') return response([{ title: names.kv, id: 'kv-id' }]);
        if (target.startsWith('storage/kv/namespaces/')) return response({});
        if (target === 'queues') return response([names.queue, names.dlq, names.rollupQueue]
          .map((queue_name, index) => ({ queue_name, queue_id: 'queue-' + index })));
        if (target.endsWith('/consumers') && method === 'GET') {
          const queueId = target.split('/')[1];
          return response(scenario.queueConsumers?.[queueId] ?? [{ consumer_id: 'consumer', type: 'worker',
            script: scenario.foreignOwnerQueue === queueId ? 'pr-151-app' : names.app }]);
        }
        if (target.startsWith('queues/')) return response({});
        throw new Error('Unexpected request ' + method + ' ' + target);
      };
    `);
    const args = command === 'provision' || native ? [
      '--head-sha', scenario.headSha ?? SHA, '--hub', hub, '--wrangler', wrangler, '--migrations-cli', migrationsCli,
      ...(native ? ['--artifact-digest', scenario.artifactDigest ?? 'c'.repeat(64)] : []),
    ] : [];
    const result = spawnSync(process.execPath, [
      '--import', pathToFileURL(preload).href, controller, command, '--repository', 'example/sessions',
      ...(command === 'janitor' ? [] : ['--pr', String(scenario.pr ?? PR)]), ...args,
    ], {
      encoding: 'utf8', timeout: native ? 120_000 : 10_000,
      env: { ...process.env, CLOUDFLARE_PPE_ACCOUNT_ID: scenario.accountId ?? PREVIEW_ACCOUNT_ID,
        CLOUDFLARE_PPE_API_TOKEN: 'synthetic-cloudflare-token', PREVIEW_BEARER_SEED: SEED,
        GITHUB_TOKEN: 'synthetic-github-token' },
    });
    const output = `${result.stdout}\n${result.stderr}`;
    for (const secret of [SEED, 'synthetic-cloudflare-token', 'synthetic-github-token',
      'atomicity-private-provider-text', 'index_batch_atomicity_intentional_invalid_json',
      'ATOMICITY_CLEANUP_PRIVATE_CANARY',
      D1_BATCH_PROBE_TEXT, JSON.stringify(D1_BATCH_PROBE_TEXT).slice(1, -1)]) {
      assert.ok(!output.includes(secret), 'CLI evidence must not expose credentials, provider text or probe values');
    }
    if (result.error) {
      throw new Error(
        `Failed to spawn ${command} controller (status=${result.status}, signal=${result.signal})\nstdout:\n${result.stdout ?? ''}\nstderr:\n${result.stderr ?? ''}`,
        { cause: result.error },
      );
    }
    let events;
    let report;
    try {
      events = (await readFile(eventPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      report = JSON.parse(await readFile(reportPath, 'utf8'));
    } catch (cause) {
      throw new Error(
        `Failed to read or parse ${command} controller artifacts (status=${result.status}, signal=${result.signal})\nstdout:\n${result.stdout ?? ''}\nstderr:\n${result.stderr ?? ''}`,
        { cause },
      );
    }
    const migrationConfigsRemoved = await Promise.all(events.filter((event) => event.kind === 'migrate')
      .map(async (event) => {
        try { await access(event.options.config); return false; }
        catch (error) { if (error.code === 'ENOENT') return true; throw error; }
      }));
    return { ...result, ...report, events, output, hub, manifests, migrationConfigsRemoved };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function databaseDeletes(result) {
  return result.events.filter((event) => event.kind === 'request' && event.method === 'DELETE'
    && /\/d1\/database\/[^/]+$/.test(new URL(event.url).pathname));
}

function mutations(result) {
  return result.events.filter((event) => event.kind === 'request' && event.method !== 'GET'
    && !(event.body?.sql && /^SELECT\b/i.test(event.body.sql.trim())));
}

test('SQLite REST fixture decodes stored UTF-8 generically without coercing BLOB, null or numeric values', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`CREATE TABLE transport_values (
      id INTEGER PRIMARY KEY, text_value TEXT NOT NULL, blob_value BLOB, null_value, integer_value INTEGER, real_value REAL
    )`);
    const blob = new Uint8Array([0, 255, 1, 128]);
    const otherText = 'other\u0000stored-会話-😀';
    const insert = database.prepare('INSERT INTO transport_values VALUES (?, ?, ?, ?, ?, ?)');
    insert.run(1, D1_BATCH_PROBE_TEXT, blob, null, Number.MAX_SAFE_INTEGER, 0.125);
    insert.run(2, otherText, blob, null, 7, 1.5);
    for (const [id, text, integer, real] of [
      [1, D1_BATCH_PROBE_TEXT, Number.MAX_SAFE_INTEGER, 0.125],
      [2, otherText, 7, 1.5],
    ]) {
      const rows = plainRows(database, `SELECT text_value AS "quoted ""text""", blob_value,
        null_value, integer_value, real_value, length(CAST(text_value AS BLOB)) AS value_bytes
        FROM transport_values WHERE id = ?;`, [id]);
      assert.equal(rows.length, 1);
      const [row] = rows;
      assert.ok(row['quoted "text"'] === text, 'readback must match every stored UTF-8 character without logging it');
      assert.deepEqual(textEvidence(row['quoted "text"']), textEvidence(text));
      assert.equal(row.value_bytes, Buffer.byteLength(text, 'utf8'));
      assert.deepEqual(row.blob_value, blob);
      assert.equal(row.null_value, null);
      assert.equal(row.integer_value, integer);
      assert.equal(row.real_value, real);
      const stored = database.prepare('SELECT CAST(text_value AS BLOB) AS bytes FROM transport_values WHERE id = ?').get(id);
      assert.ok(Buffer.from(stored.bytes).equals(Buffer.from(text, 'utf8')), 'readback must match actual SQLite bytes');
      const [encoded] = plainRows(database, 'SELECT json_quote(text_value) AS encoded FROM transport_values WHERE id = ?', [id]);
      assert.ok(JSON.parse(encoded.encoded) === text, 'independent JSON1 evidence must retain the entire stored value');
    }
  } finally {
    database.close();
  }
});

test('provision creates main plus two named shards, remotely migrates each, then seeds main prices and deploys', async () => {
  const result = await runController('provision', { foreignCount: 7 });
  assert.equal(result.status, 0, result.output);
  const creates = result.events.filter((event) => event.kind === 'request' && event.method === 'POST'
    && new URL(event.url).pathname.endsWith('/d1/database'));
  assert.deepEqual(creates.map((event) => event.body.name), LAYOUT.databases.map((database) => database.name));
  assert.equal(result.databases.length, 10);
  const migrations = result.events.filter((event) => event.kind === 'migrate');
  assert.deepEqual(migrations.map((event) => event.options.database), ['DB', 'IDX00', 'IDX01']);
  assert.equal(new Set(migrations.map((event) => event.options.journal)).size, 3);
  assert.equal(new Set(migrations.map((event) => event.options['database-id'])).size, 3);
  for (const [index, migration] of migrations.entries()) {
    const directory = path.join(result.hub, index === 0 ? 'migrations' : 'migrations-index');
    assert.equal(migration.command, 'apply');
    assert.equal(migration.options.target, 'preview');
    assert.equal(migration.options['migrations-dir'], directory);
    assert.equal(migration.options.manifest, path.join(directory, 'manifest.json'));
    assert.equal(migration.options['base-manifest'], path.join(directory, 'source-baseline.json'));
    assert.equal(migration.options.history, index === 0 ? path.join(directory, 'historical-baseline.json') : undefined);
    const configured = migration.config.d1_databases.find((database) => database.binding === migration.options.database);
    assert.equal(configured.database_id, migration.options['database-id']);
    assert.equal(configured.migrations_dir, directory);
  }
  const ledgerWrites = result.events.filter((event) => event.kind === 'request'
    && event.body?.params?.[0] === 'preview_migration_files');
  assert.equal(ledgerWrites.length, 3);
  for (const [index, ledger] of ledgerWrites.entries()) {
    assert.ok(ledger.url.includes(`/d1/database/${migrations[index].options['database-id']}/query`));
    assert.match(ledger.body.sql, index === 0 ? /^INSERT INTO meta / : /^INSERT INTO index_migration_state /);
    const manifest = result.manifests[index === 0 ? 'migrations' : 'migrations-index'];
    assert.deepEqual(JSON.parse(ledger.body.params[1]),
      Object.fromEntries(manifest.migrations.map((entry) => [entry.filename, entry.sha256])));
  }
  const shardInitializations = result.events.filter((event) => event.kind === 'request'
    && event.body?.sql?.startsWith('INSERT INTO shard_meta'));
  assert.equal(shardInitializations.length, 2);
  for (const [index, initialization] of shardInitializations.entries()) {
    assert.deepEqual(initialization.body.params, [index, 2, 'fnv1a32-utf8-mod256', (index + 1) * 2 ** 40]);
  }
  const recordedLayout = result.events.find((event) => event.kind === 'request'
    && event.body?.params?.[0] === 'preview_index_layout');
  assert.deepEqual(JSON.parse(recordedLayout.body.params[1]), LAYOUT);
  const deploy = result.events.find((event) => event.kind === 'deploy');
  assert.ok(deploy);
  assert.deepEqual(deploy.config.d1_databases.map((database) => [database.binding, database.database_name]),
    LAYOUT.databases.map((database) => [database.binding, database.name]));
  assert.equal(deploy.config.vars.INDEX_SHARD_COUNT, '2');
  assert.equal(deploy.config.vars.INDEX_MODE, 'active');
  assert.equal(deploy.config.vars.DEPLOYMENT_REVISION, SHA);
  const prices = result.events.filter((event) => event.kind === 'request' && event.body?.sql?.includes('INSERT OR REPLACE INTO model_prices'));
  assert.equal(prices.length, 1, 'prices must be installed in main only');
  const mainId = deploy.config.d1_databases[0].database_id;
  assert.ok(prices[0].url.includes(`/d1/database/${mainId}/query`));
  assert.ok(result.events.indexOf(prices[0]) > result.events.indexOf(migrations[2]));
  assert.ok(result.events.indexOf(prices[0]) < result.events.indexOf(deploy));
  assert.equal(databaseDeletes(result).length, 0);
  const summary = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(summary.d1Reset, false);
  assert.deepEqual(summary.schemaDigests, SCHEMA_DIGESTS);
  const indexId = deploy.config.d1_databases[1].database_id;
  assert.deepEqual(summary.indexBatchAtomicity, {
    state: 'verified', probe: 'd1-rest-batch-atomicity', databaseId: indexId,
    textTransport: 'verified', textBytes: PROBE_TEXT_BYTES,
  });
  const batchRequests = result.events.filter((event) => event.kind === 'request' && event.body?.batch);
  assert.equal(batchRequests.length, 2);
  assert.ok(batchRequests.every((event) => event.url.includes(`/d1/database/${indexId}/query`)));
  assert.ok(result.events.indexOf(batchRequests[0]) > result.events.indexOf(migrations[2]));
  assert.ok(result.events.indexOf(batchRequests[1]) < result.events.indexOf(prices[0]));
  const probeSql = result.events.filter((event) => event.kind === 'probe-sql');
  const reads = probeSql.filter((event) => event.sql.startsWith('SELECT id, value'));
  assert.equal(reads.length, 2, 'successful native batch and independent readback both execute');
  assert.deepEqual(reads.map((event) => event.rows), Array.from({ length: 2 }, () =>
    [{ id: 1, value: textEvidence(D1_BATCH_PROBE_TEXT), value_bytes: PROBE_TEXT_BYTES }]),
  'actual SQLite readbacks must expose the complete UTF-8 digest and stored byte length, never the probe text');
  const createSql = probeSql.filter((event) => event.sql.startsWith('CREATE TABLE'));
  assert.equal(createSql.length, 2, 'the failure positive control executes CREATE before its rejection');
  assert.equal(probeSql.filter((event) => event.sql.startsWith('INSERT INTO')).length, 2);
  const finalExistence = probeSql.filter((event) => event.sql.includes('FROM sqlite_master')).at(-1);
  assert.deepEqual(finalExistence.rows, [], 'the deliberately failing batch rolls back its table');
  assert.deepEqual(result.probeEvidence,
    [{ databaseId: indexId, tables: ['unrelated_user_table'], unrelatedValues: ['untouched'] }]);
  assert.ok(!result.output.includes('index_batch_atomicity_intentional_invalid_json'));
  assert.equal(summary.schemaDigest, sha256Bytes(stableJson(SCHEMA_DIGESTS)));
  assert.equal(deploy.config.vars.SCHEMA_DIGEST, summary.schemaDigest);
  const expectedMigrationDigest = sha256Bytes(stableJson(LAYOUT.databases.map(({ binding }, index) => ({
    binding, digest: migrationDigest(result.manifests[index === 0 ? 'migrations' : 'migrations-index']),
  }))));
  assert.equal(deploy.config.vars.MIGRATION_DIGEST, expectedMigrationDigest);
});

test('provision reuses all three exact-name databases at the Free-account quota limit', async () => {
  const result = await runController('provision', { existing: true, foreignCount: 7 });
  assert.equal(result.status, 0, result.output);
  assert.equal(databaseDeletes(result).length, 0);
  assert.ok(!result.events.some((event) => event.kind === 'request' && event.method === 'POST'
    && new URL(event.url).pathname.endsWith('/d1/database')));
  assert.deepEqual(result.events.filter((event) => event.kind === 'migrate').map((event) => event.options['database-id']),
    ['existing-0', 'existing-1', 'existing-2']);
});

test('quota refusal creates and deletes nothing, leaving every other PR database alone', async () => {
  const result = await runController('provision', { foreignCount: 8 });
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /preview D1 quota: 8\/10.*3 required/);
  assert.match(result.output, /no other PR resources were deleted/);
  assert.equal(mutations(result).length, 0);
  assert.ok(!result.events.some((event) => event.kind === 'build' || event.kind === 'migrate' || event.kind === 'deploy'));
  assert.equal(result.databases.length, 8);
});

for (const [name, scenario, error] of [
  ['deployed count', { sourceCount: 16 }, /deployed preview index count is immutable/],
  ['deployed binding ID', { foreignBinding: 'IDX01', foreignCount: 1 }, /IDX01 does not bind the trusted database/],
  ['recorded count', { recordedLayout: { ...LAYOUT, count: 16 } }, /count\/name layout is immutable/],
  ['recorded database name', { recordedLayout: { ...LAYOUT, databases: LAYOUT.databases.map((database, index) =>
    index === 2 ? { ...database, name: 'pr-151-sessions-index-idx01' } : database) } }, /count\/name layout is immutable/],
  ['shard count', { shardCount: 16 }, /different immutable count\/hash layout/],
  ['shard hash', { shardHash: 'different-hash-layout' }, /different immutable count\/hash layout/],
  ['shard index', { shardIndex: 7 }, /different immutable count\/hash layout/],
  ['removed deployed shard layout', { sourceLegacy: true }, /lost its immutable index layout/],
]) {
  test(`provision refuses a changed ${name} before any resource mutation`, async () => {
    const result = await runController('provision', { existing: true, ...scenario });
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, error);
    assert.equal(mutations(result).length, 0);
    assert.ok(!result.events.some((event) => event.kind === 'migrate' || event.kind === 'deploy'));
  });
}

for (const scenario of [{ edited: 'IDX01' }, { removed: 'IDX00' }, { unproven: 'DB' }, { legacy: true },
  { partial: true }, { partial: true, missingWorker: true }]) {
  test(`divergence ${JSON.stringify(scenario)} quiesces and resets all three databases coherently`, async () => {
    const result = await runController('provision', { existing: true, foreignCount: 1, ...scenario });
    assert.equal(result.status, 0, result.output);
    const deletes = databaseDeletes(result);
    const expectedDeletedIds = scenario.legacy ? ['existing-0']
      : scenario.partial ? ['existing-0', 'existing-1'] : ['existing-0', 'existing-1', 'existing-2'];
    assert.deepEqual(deletes.map((event) => new URL(event.url).pathname.split('/').at(-1)), expectedDeletedIds);
    const stopWorker = result.events.find((event) => event.kind === 'request' && event.method === 'DELETE'
      && new URL(event.url).pathname.endsWith('/workers/scripts/pr-150-app'));
    assert.ok(stopWorker, 'the deployed source must be quiesced before its databases are reset');
    assert.ok(result.events.indexOf(stopWorker) < result.events.indexOf(deletes[0]));
    const emptyObject = result.events.find((event) => event.kind === 'request' && event.method === 'DELETE'
      && event.url.includes('/objects/'));
    const creates = result.events.filter((event) => event.kind === 'request' && event.method === 'POST'
      && new URL(event.url).pathname.endsWith('/d1/database'));
    assert.equal(creates.length, 3);
    const detachments = result.events.filter((event) => event.kind === 'request' && event.method === 'DELETE'
      && /\/consumers\/[^/]+$/.test(new URL(event.url).pathname));
    assert.equal(detachments.length, 3);
    assert.ok(detachments.every((event) => result.events.indexOf(event) < result.events.indexOf(stopWorker)));
    assert.ok(result.events.indexOf(emptyObject) < result.events.indexOf(creates[0]));
    assert.ok(result.events.indexOf(emptyObject) < result.events.indexOf(deletes[0]),
      'R2 must be empty before an interrupted reset could leave no database evidence');
    assert.ok(result.databases.some((database) => database.uuid === 'foreign-0'));
    const summary = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(summary.d1Reset, true);
    const migrations = result.events.filter((event) => event.kind === 'migrate');
    assert.deepEqual(migrations.map((event) => [event.options.database, event.options['database-id']]),
      [['DB', 'created-1'], ['IDX00', 'created-2'], ['IDX01', 'created-3']]);
    assert.ok(result.events.indexOf(deletes.at(-1)) < result.events.indexOf(creates[0]));
    assert.ok(result.events.indexOf(creates.at(-1)) < result.events.indexOf(migrations[0]));
    const batchRequests = result.events.filter((event) => event.kind === 'request' && event.body?.batch);
    assert.equal(batchRequests.length, 2);
    assert.ok(result.events.indexOf(migrations.at(-1)) < result.events.indexOf(batchRequests[0]));
    assert.equal(summary.indexBatchAtomicity.state, 'verified');
    assert.equal(summary.indexBatchAtomicity.databaseId, 'created-2');
    const prices = result.events.find((event) => event.kind === 'request'
      && event.body?.sql?.includes('INSERT OR REPLACE INTO model_prices'));
    const deploy = result.events.find((event) => event.kind === 'deploy');
    assert.ok(prices);
    assert.ok(deploy);
    assert.ok(result.events.indexOf(batchRequests.at(-1)) < result.events.indexOf(prices));
    assert.ok(result.events.indexOf(prices) < result.events.indexOf(deploy));
    assert.deepEqual(deploy.config.d1_databases.map((database) => database.database_id),
      ['created-1', 'created-2', 'created-3']);
  });
}

for (const [name, consumer] of [
  ['missing canonical owner', { consumer_id: 'consumer', type: 'worker' }],
  ['owned alias without a canonical owner', { consumer_id: 'consumer', type: 'worker', script_name: NAMES.app }],
  ['null owner', { consumer_id: 'consumer', type: 'worker', script: null, script_name: NAMES.app }],
  ['non-string owner', { consumer_id: 'consumer', type: 'worker', script: 42, script_name: NAMES.app }],
  ['unknown owner', { consumer_id: 'consumer', type: 'worker', script: 'pr-150-unrecognized', script_name: NAMES.app }],
  ['foreign canonical owner despite an owned alias', {
    consumer_id: 'consumer', type: 'worker', script: 'pr-151-app', script_name: NAMES.app,
  }],
  ['non-worker type', { consumer_id: 'consumer', type: 'http_pull', script: NAMES.app, script_name: NAMES.app }],
  ['missing worker type', { consumer_id: 'consumer', script: NAMES.app, script_name: NAMES.app }],
  ['null worker type', { consumer_id: 'consumer', type: null, script: NAMES.app, script_name: NAMES.app }],
  ['non-string consumer ID', { consumer_id: 42, type: 'worker', script: NAMES.app, script_name: NAMES.app }],
  ['null record', null],
  ['array record', []],
  ['primitive record', 'private primitive consumer record'],
]) {
  test(`native queue preflight rejects ${name} on the last queue before any DELETE`, async () => {
    const result = await runController('provision', {
      existing: true, partial: true, foreignCount: 1,
      queueConsumers: { 'queue-2': [
        { consumer_id: 'valid-first', type: 'worker', script: NAMES.app },
        consumer,
      ] },
    });
    assert.notEqual(result.status, 0, result.output);
    assert.equal(mutations(result).length, 0, 'no consumer, Worker, object or database may be deleted before full identity preflight');
    assert.deepEqual(result.databases.map((database) => database.uuid), ['foreign-0', 'existing-0', 'existing-1']);
    assert.ok(!result.events.some((event) => event.kind === 'migrate' || event.kind === 'deploy'));
  });
}

test('native queue rejection diagnostics redact settings, auth, consumer IDs and malformed identity strings', async () => {
  const privateValues = {
    consumerId: 'private-consumer-id-value',
    settings: 'private-unrelated-settings-value',
    auth: 'private-auth-token-value',
    owner: 'private invalid owner/value',
    type: 'private malformed type/value',
    alias: 'private invalid alias/value',
    propertyKey: 'PRIVATE PROPERTY KEY preview rejection canary',
  };
  for (const identity of [
    { type: 'worker', script: privateValues.owner },
    { type: privateValues.type, script: NAMES.app },
  ]) {
    const result = await runController('provision', {
      existing: true, partial: true, missingWorker: true, foreignCount: 1,
      queueConsumers: { 'queue-2': [{
        consumer_id: privateValues.consumerId, ...identity, script_name: privateValues.alias,
        settings: { retry: privateValues.settings }, auth: { bearer: privateValues.auth },
        [privateValues.propertyKey]: privateValues.auth,
      }] },
    });
    assert.notEqual(result.status, 0, result.output);
    for (const value of Object.values(privateValues)) {
      assert.ok(!result.output.includes(value), 'rejection diagnostics must not contain private response values');
    }
    assert.equal(mutations(result).length, 0);
    assert.ok(!result.events.some((event) => event.kind === 'migrate' || event.kind === 'deploy'));
  }
});

test('successful provision receipts redact private property names and values without refusing owned consumers', async () => {
  const privateValues = {
    propertyKey: 'PRIVATE PROPERTY KEY preview receipt canary',
    settings: 'private-receipt-settings-value',
    auth: 'private-receipt-auth-value',
    consumerId: 'private-receipt-consumer-id',
    unknownValue: 'private-receipt-unknown-value',
  };
  const result = await runController('provision', {
    queueConsumers: { 'queue-0': [{
      consumer_id: privateValues.consumerId, type: 'worker', script: NAMES.app,
      settings: { retry: privateValues.settings }, auth: { bearer: privateValues.auth },
      [privateValues.propertyKey]: privateValues.unknownValue,
    }] },
  });
  assert.equal(result.status, 0, result.output);
  const receipt = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
    .find((line) => line.queueConsumerIdentityReceipt)?.queueConsumerIdentityReceipt;
  assert.ok(receipt, 'successful provision must publish its native consumer receipt');
  assert.equal(receipt.expectedWorker, NAMES.app);
  for (const value of Object.values(privateValues)) {
    assert.ok(!result.output.includes(value), 'provision output must not disclose private response keys or values');
  }
});

const deployedBindings = [
  { name: 'INDEX_SHARD_COUNT', type: 'plain_text', text: String(LAYOUT.count) },
  ...LAYOUT.databases.map(({ binding }, index) => ({ name: binding, type: 'd1', id: `existing-${index}` })),
];

for (const [name, scenario] of [
  ['missing shard bound to a foreign database', { foreignBinding: 'IDX01' }],
  ['missing shard bound to another trusted database', { sourceBindings: deployedBindings.map((binding) =>
    binding.name === 'IDX01' ? { ...binding, id: 'existing-1' } : binding) }],
  ['wrong surviving database ID', { foreignBinding: 'IDX00' }],
  ['unrelated D1 binding', { sourceBindings: [...deployedBindings,
    { name: 'OTHER_DB', type: 'd1', id: 'foreign-0' }] }],
  ['renamed shard binding', { sourceBindings: deployedBindings.map((binding) =>
    binding.name === 'IDX01' ? { ...binding, name: 'IDX02' } : binding) }],
  ['duplicate shard binding', { sourceBindings: [...deployedBindings,
    { name: 'IDX01', type: 'd1', id: 'existing-2' }] }],
  ['wrong shard binding type', { sourceBindings: deployedBindings.map((binding) =>
    binding.name === 'IDX01' ? { ...binding, type: 'plain_text' } : binding) }],
  ['empty missing database ID', { sourceBindings: deployedBindings.map((binding) =>
    binding.name === 'IDX01' ? { ...binding, id: '' } : binding) }],
  ['non-string missing database ID', { sourceBindings: deployedBindings.map((binding) =>
    binding.name === 'IDX01' ? { ...binding, id: 42 } : binding) }],
  ['unrecorded topology with missing shard', { recordedLayout: null }],
  ['wrong deployed count', { sourceCount: 16 }],
  ['wrong recorded count', { recordedLayout: { ...LAYOUT, count: 16 } }],
  ['unapproved account', { accountId: 'f'.repeat(32) }],
  ['wrong recorded names', { recordedLayout: { ...LAYOUT, databases: LAYOUT.databases.map((database, index) =>
    index === 2 ? { ...database, name: 'pr-151-sessions-index-idx01' } : database) } }],
  ['foreign owner on the last queue', { foreignOwnerQueue: 'queue-2' }],
  ['foreign owner on the last queue without a Worker', { foreignOwnerQueue: 'queue-2', missingWorker: true }],
  ['database listing permission failure', { databaseListError: true }],
  ['Worker settings permission failure', { settingsError: true }],
  ['recorded layout query permission failure', { queryError: 'DB' }],
  ['surviving shard query permission failure', { queryError: 'IDX00' }],
]) {
  test(`an incomplete deployed topology refuses ${name} before any mutation`, async () => {
    const result = await runController('provision', { existing: true, partial: true, foreignCount: 1, ...scenario });
    assert.notEqual(result.status, 0, result.output);
    assert.equal(mutations(result).length, 0);
    assert.deepEqual(result.databases.map((database) => database.uuid), ['foreign-0', 'existing-0', 'existing-1']);
    assert.ok(!result.events.some((event) => event.kind === 'migrate' || event.kind === 'deploy'));
  });
}

test('a shard query permission failure propagates instead of being mistaken for fresh schema', async () => {
  const result = await runController('provision', { existing: true, queryError: 'IDX00' });
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /permission denied/);
  assert.equal(mutations(result).length, 0);
  assert.ok(!result.events.some((event) => event.kind === 'migrate' || event.kind === 'deploy'));
});

for (const scenario of [{ pending: 'IDX01' }, { wrongDigest: 'IDX00' }]) {
  test(`unverified shard migration ${JSON.stringify(scenario)} prevents prices and deployment`, async () => {
    const result = await runController('provision', scenario);
    assert.notEqual(result.status, 0, result.output);
    assert.ok(!result.events.some((event) => event.kind === 'deploy'));
    assert.ok(!result.events.some((event) => event.kind === 'request' && event.body?.sql?.includes('INSERT OR REPLACE INTO model_prices')));
  });
}

const readbackFailures = ['batch', 'independent'].flatMap((phase) => [
  'missing-result', 'extra-result', 'malformed-rows', 'missing-rows', 'missing-row', 'duplicate-row',
  'malformed-text', 'missing-text', 'nul-truncated-text', 'bom-stripped-text', 'normalized-text',
  'truncated-text-and-bytes', 'missing-byte-count', 'malformed-byte-count', 'incorrect-byte-count',
].map((corruption) => [
  `${phase} ${corruption}`, { atomicityReadback: { phase, corruption } },
]));

for (const [name, scenario] of [
  ['non-atomic native batch', { atomicityPartialCommit: true }],
  ['successful-batch transport echo', { atomicityNoExecution: true }],
  ['non-SQL failure', { atomicityWrongReason: true }],
  ...readbackFailures,
]) {
  test(`preview atomicity preflight rejects ${name} before prices or deployment`, async () => {
    const result = await runController('provision', scenario);
    assert.notEqual(result.status, 0, result.output);
    const diagnostic = result.stderr.split('\n').filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line)).find((line) => line.operation === 'preview-atomicity');
    const expectedPhase = scenario.atomicityReadback
      ? `${scenario.atomicityReadback.phase === 'batch' ? 'batch' : 'independent'}-positive`
      : scenario.atomicityNoExecution ? 'batch-positive' : 'rollback-negative';
    assert.deepEqual(diagnostic, {
      operation: 'preview-atomicity', phase: expectedPhase,
      failure: scenario.atomicityReadback?.phase === 'independent'
        && ['missing-result', 'extra-result', 'malformed-rows', 'missing-rows'].includes(scenario.atomicityReadback.corruption)
        ? 'shape' : scenario.atomicityWrongReason ? 'http' : 'assertion',
    }, 'only the reached atomicity control may supply the rejection identity');
    assert.equal(result.events.filter((event) => event.kind === 'migrate').length, 3,
      'runtime proof must follow every database migration');
    assert.ok(!result.events.some((event) => event.kind === 'deploy'));
    assert.ok(!result.events.some((event) => event.kind === 'request'
      && event.body?.sql?.includes('INSERT OR REPLACE INTO model_prices')));
    const indexMigration = result.events.find((event) => event.kind === 'migrate' && event.options.database === 'IDX00');
    assert.deepEqual(result.probeEvidence, [{
      databaseId: indexMigration.options['database-id'],
      tables: ['unrelated_user_table'],
      unrelatedValues: ['untouched'],
    }], 'failed proofs remove only their owned probe, preserving unrelated data');
    assert.equal(databaseDeletes(result).length, 0, 'a failed capability proof must not reset any database');
    const drops = result.events.filter((event) => event.kind === 'probe-sql' && event.sql.startsWith('DROP TABLE'));
    assert.ok(drops.every((event) => /^DROP TABLE "__index_batch_probe_[0-9a-f]+"$/.test(event.sql)),
      'cleanup may drop only the probe table owned by this invocation');
    if (scenario.atomicityReadback) {
      const { phase, corruption } = scenario.atomicityReadback;
      const faults = result.events.filter((event) => event.kind === 'probe-readback-fault');
      assert.deepEqual(faults.map((event) => ({ phase: event.phase, corruption: event.corruption })), [{ phase, corruption }],
        'the fault must alter an executed SQLite SELECT at the requested transport boundary');
      const reads = result.events.filter((event) => event.kind === 'probe-sql' && event.sql.startsWith('SELECT id, value'));
      assert.equal(reads.length, phase === 'batch' ? 1 : 2);
      assert.ok(reads.every((event) => event.databaseId === indexMigration.options['database-id']));
      assert.deepEqual(reads.map((event) => event.rows), reads.map(() =>
        [{ id: 1, value: textEvidence(D1_BATCH_PROBE_TEXT), value_bytes: PROBE_TEXT_BYTES }]),
      'corruption must target actual full-fidelity database readback, not fabricated success evidence');
      assert.equal(drops.length, 1, 'the committed probe must be cleaned exactly once after rejection');
      assert.equal(result.events.filter((event) => event.kind === 'probe-sql' && event.sql.startsWith('CREATE TABLE')).length, 1,
        'text/byte rejection must precede the deliberately failing atomicity batch');
    }
    assert.ok(!result.output.includes('atomicity-private-provider-text'));
    assert.ok(!result.output.includes('index_batch_atomicity_intentional_invalid_json'));
    assert.ok(!result.output.includes('synthetic-cloudflare-token'));
  });
}

test('preview atomicity reports secondary cleanup failure after a real partial commit while preserving all foreign resources', async () => {
  const foreign = [
    { name: 'sessions-index', uuid: 'production-looking-name' },
    { name: 'pr-151-sessions-index', uuid: 'other-pr-main' },
    { name: 'pr-150-copy-0123456789abcdef01234567-source', uuid: 'other-owned-proof' },
  ];
  const result = await runController('provision', {
    atomicityPartialCommit: true, atomicityCleanupFailure: true, extraDatabases: foreign,
  });
  assert.notEqual(result.status, 0, result.output);
  const diagnostic = result.stderr.split('\n').filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line)).find((line) => line.operation === 'preview-atomicity');
  assert.deepEqual(diagnostic, {
    operation: 'preview-atomicity', phase: 'rollback-negative', failure: 'assertion',
    cleanup: 'failed', cleanupFailure: 'http',
  }, 'secondary HTTP cleanup cannot replace the primary non-atomicity assertion');
  const indexMigration = result.events.find((event) => event.kind === 'migrate' && event.options.database === 'IDX00');
  const sql = result.events.filter((event) => event.kind === 'probe-sql');
  const creates = sql.filter((event) => event.sql.startsWith('CREATE TABLE'));
  assert.equal(creates.length, 2, 'successful and negative controls must both execute real SQLite CREATE');
  assert.equal(sql.filter((event) => event.sql.startsWith('INSERT INTO')).length, 2,
    'the failed native batch must actually commit its INSERT before the invalid JSON rejection');
  const ownedName = /^CREATE TABLE "(__index_batch_probe_[0-9a-f]+)"/.exec(creates[1].sql)[1];
  assert.deepEqual(result.probeEvidence, [{
    databaseId: indexMigration.options['database-id'],
    tables: [ownedName, 'unrelated_user_table'], unrelatedValues: ['untouched'],
  }], 'the failed final DROP leaves the real owned probe, not unrelated SQLite state');
  assert.deepEqual(result.events.filter((event) => event.kind === 'probe-cleanup-fault'), [{
    kind: 'probe-cleanup-fault', databaseId: indexMigration.options['database-id'], sql: `DROP TABLE "${ownedName}"`,
  }], 'final owned cleanup is attempted exactly once without replay');
  assert.equal(sql.filter((event) => event.sql.startsWith('DROP TABLE')).length, 1,
    'only the positive control DROP succeeds');
  assert.deepEqual(result.databases.filter((database) => !database.uuid.startsWith('created-')), foreign);
  assert.equal(databaseDeletes(result).length, 0);
  assert.equal(result.events.filter((event) => event.kind === 'migrate').length, 3);
  assert.ok(!result.events.some((event) => event.kind === 'deploy'
    || event.kind === 'request' && event.body?.sql?.includes('INSERT OR REPLACE INTO model_prices')));
  assert.ok(!result.output.includes('ATOMICITY_CLEANUP_PRIVATE_CANARY'));
});

for (const command of ['close', 'janitor']) {
  test(`${command} deletes main and both shards, preserving open or untrusted resources`, async () => {
    const result = await runController(command, { existing: true, foreignCount: 1, untrustedNames: true });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(databaseDeletes(result).map((event) => new URL(event.url).pathname.split('/').at(-1)),
      ['existing-0', 'existing-1', 'existing-2']);
    assert.deepEqual(new Set(result.databases.map((database) => database.uuid)),
      new Set(['foreign-0', 'production-looking-name', 'unexpected-shard', 'wrong-kind']));
    const summary = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.deepEqual(summary.deleted.filter((resource) => resource.kind === 'd1').map((resource) => resource.name),
      LAYOUT.databases.map((database) => database.name));
  });
}

for (const scenario of [
  { accountId: PRODUCTION_ACCOUNT_ID }, { accountId: 'f'.repeat(32) }, { pr: 0 },
  { headSha: 'not-a-head' }, { artifactDigest: 'not-a-digest' },
]) {
  test(`native-copy-proof refuses invalid identity before requests ${JSON.stringify(scenario)}`, async () => {
    const result = await runController('native-copy-proof', scenario);
    assert.notEqual(result.status, 0, result.output);
    assert.deepEqual(result.events, [], 'account, PR, head and artifact checks precede even inventory reads');
    assert.deepEqual(result.databases, []);
  });
}

test('native-copy-proof runs the real helper through CLI schema bindings and cleans only its scratch', async () => {
  const result = await runController('native-copy-proof', { existing: true, foreignCount: 1 });
  assert.equal(result.status, 0, result.output);
  const summary = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(summary.state, 'verified');
  assert.equal(summary.probe, 'd1-native-full-copy');
  assert.equal(summary.rows, 1463);
  assert.equal(summary.denseRows, 1461);
  assert.equal(summary.columns, 18);
  assert.equal(summary.shards, 2);
  assert.equal(summary.legacyProbeMatches, 0);
  assert.equal(summary.nativeProbeMatches, 1);
  assert.equal(summary.freezeTriggers, 3);
  assert.equal(summary.ordinaryPages, 2);
  assert.equal(summary.fallbackPages, 1);
  assert.equal(summary.longTextBytes, 1_100_061);
  assert.match(summary.sha256, /^[0-9a-f]{64}$/);
  const sql = result.events.filter((event) => event.kind === 'probe-sql');
  const denseIds = Array.from({ length: summary.denseRows }, (_, index) => index + 1);
  const suffixIds = denseIds.filter((id) => ![15, 16].includes(id));
  const suffixEvidence = textEvidence('nativedensesuffix');
  const denseMatches = sql.filter((event) => /\bMATCH\b/.test(event.sql)
    && event.params.length === 1 && event.params[0]?.sha256 === suffixEvidence.sha256);
  for (const [databaseId, expected] of [['created-2', []], ['created-3', suffixIds]]) {
    const matches = denseMatches.filter((event) => event.databaseId === databaseId);
    assert.ok(matches.length > 0, 'both shards require independent native after-NUL suffix evidence');
    for (const { rows } of matches) assert.deepEqual(rows, expected.map((rowid) => ({ rowid })));
  }
  const points = sql.filter((event) => /\bMATCH\b/.test(event.sql) && event.params.length === 2);
  const assertPoint = (databaseId, term, id, expected) => {
    const evidence = textEvidence(term);
    const matches = points.filter((event) => event.databaseId === databaseId
      && event.params[0]?.sha256 === evidence.sha256 && event.params[1] === id);
    assert.ok(matches.length > 0, 'the CLI must execute actual independent native point checks');
    for (const { rows } of matches) assert.deepEqual(rows, expected);
    return matches;
  };
  const oldSource = assertPoint('created-1', '"alpha"', 7, []);
  const nativeSource = assertPoint('created-1', '"🫠alpha"', 7, [{ rowid: 7 }]);
  const firstCopyWrite = sql.findIndex((event) => event.databaseId !== 'created-1'
    && /^INSERT INTO blocks \(/.test(event.sql));
  assert.ok(firstCopyWrite >= 0);
  assert.ok([...oldSource, ...nativeSource].every((event) => sql.indexOf(event) < firstCopyWrite),
    'native old-alpha-negative and whole-term-positive controls must run before the copier writes');
  const nativePoints = [
    ...['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].map((word, index) =>
      [index + 1, [`nativevaried${word}`]]),
    [7, ['🫠alpha']], [8, ['🫠', 'alpha']], [9, ['🧮alpha']], [10, ['🧠alpha']],
    [11, ['🛠alpha']], [12, ['al🫠pha']], [13, ['₿alpha']], [14, ['\u{1CF00}alpha']], [15, ['🫠']],
  ];
  for (const [id, terms] of nativePoints) {
    for (const term of terms) assertPoint('created-3', `"${term}"`, id, [{ rowid: id }]);
  }
  for (const [id, terms] of [
    [7, ['alpha']], [9, ['alpha']], [10, ['alpha']], [11, ['alpha']], [12, ['al']],
    [13, ['alpha']], [14, ['alpha']], [16, ['index-migration-tokenless-probe', '🫠', 'alpha']],
  ]) {
    for (const term of terms) assertPoint('created-3', `"${term}"`, id, []);
  }
  const independent = [...points.filter((event) => event.databaseId !== 'created-1'), ...denseMatches];
  assert.equal(summary.ftsMatches, independent.reduce((count, { rows }) => count + rows.length, 0),
    'summary FTS matches must be derived from observed independent point and suffix hits');
  const sourceBulk = sql.filter((event) => event.databaseId === 'created-1'
    && /^INSERT INTO blocks \(/.test(event.sql) && /FROM json_each\(\?\)/.test(event.sql));
  assert.equal(sourceBulk.length, 1, 'all dense source rows are seeded by one real JSON1 statement');
  assert.equal(sourceBulk[0].params.length, 1);
  assert.ok(sourceBulk[0].params[0].utf8Bytes < 1_048_576);
  const sourceSeed = result.events.find((event) => event.kind === 'request' && event.body?.batch
    && new URL(event.url).pathname.endsWith('/created-1/query')
    && event.body.batch.some(({ sql }) => /^INSERT INTO blocks \(/.test(sql)));
  assert.ok(sourceSeed);
  assert.equal(sourceSeed.body.batch.length, 4, 'source content and native postings must seed in one bounded request');
  assert.equal(sourceSeed.body.batch.filter(({ sql }) => /^INSERT INTO blocks_fts\b/.test(sql)).length, 1);
  const sourceFtsWrites = sql.filter((event) => event.databaseId === 'created-1'
    && /\bblocks_fts\b/.test(event.sql) && /^(?:INSERT|UPDATE|DELETE)\b/.test(event.sql));
  assert.equal(sourceFtsWrites.length, 1, 'source retirement must not issue legacy FTS mutations after seeding');
  assert.equal(sourceFtsWrites[0].sql, sourceSeed.body.batch.find(({ sql }) => /^INSERT INTO blocks_fts\b/.test(sql)).sql);
  const finalSourceCount = sql.filter((event) => event.databaseId === 'created-1'
    && event.sql === 'SELECT COUNT(*) AS rows FROM blocks').at(-1);
  assert.deepEqual(finalSourceCount.rows, [{ rows: 0 }]);
  const queries = result.events.filter((event) => event.kind === 'request'
    && new URL(event.url).pathname.endsWith('/query'));
  assert.ok(queries.length <= 200, `complete native CLI proof must use bounded RPCs, observed ${queries.length}`);
  const migrations = result.events.filter((event) => event.kind === 'migrate');
  assert.equal(migrations.length, 3);
  const creations = result.events.filter((event) => event.kind === 'request' && event.method === 'POST'
    && new URL(event.url).pathname.endsWith('/d1/database'));
  assert.equal(creations.length, 3);
  for (const { body } of creations) assert.match(body.name, /^pr-150-copy-[0-9a-f]{24}-(?:source|idx00|idx01)$/);
  assert.deepEqual(result.migrationConfigsRemoved, [true, true, true]);
  assert.deepEqual(databaseDeletes(result).map((event) => new URL(event.url).pathname.split('/').at(-1)),
    ['created-1', 'created-2', 'created-3']);
  assert.deepEqual(result.databases.map((database) => database.uuid),
    ['foreign-0', 'existing-0', 'existing-1', 'existing-2']);
  assert.ok(!result.events.some((event) => event.kind === 'build' || event.kind === 'deploy'));
});

test('native-copy-proof refuses unverified migration and removes all owned scratch', async () => {
  const result = await runController('native-copy-proof', { existing: true, pending: 'IDX00' });
  assert.notEqual(result.status, 0, result.output);
  assert.ok(result.output.includes('NativeCopyControlError'));
  assert.ok(result.output.includes('phase=schema'));
  assert.deepEqual(result.events.filter((event) => event.kind === 'migrate').map((event) => event.options.database),
    ['DB', 'IDX00']);
  assert.equal(result.probeEvidence.length, 0, 'schema rejection precedes native copy writes');
  assert.deepEqual(databaseDeletes(result).map((event) => new URL(event.url).pathname.split('/').at(-1)),
    ['created-1', 'created-2', 'created-3']);
  assert.deepEqual(result.databases.map((database) => database.uuid), ['existing-0', 'existing-1', 'existing-2']);
  assert.deepEqual(result.migrationConfigsRemoved, [true, true]);
});

for (const command of ['close', 'janitor']) {
  test(`${command} recovers closed PR copy probes without touching open PR or near-match names`, async () => {
    const nonce = '0123456789abcdef01234567';
    const owned = ['source', 'idx00', 'idx01'].map((role, index) => ({
      name: `pr-${PR}-copy-${nonce}-${role}`, uuid: `closed-copy-${index}`,
    }));
    const preserved = [
      { name: `pr-151-copy-${nonce}-source`, uuid: 'open-copy' },
      { name: `pr-${PR}-copy-${nonce}-idx02`, uuid: 'wrong-role' },
      { name: `pr-${PR}-copy-${nonce}-source-extra`, uuid: 'suffix' },
      { name: `pr-${PR}-copy-short-source`, uuid: 'short-nonce' },
      { name: 'sessions-index', uuid: 'production-looking' },
    ];
    const result = await runController(command, { extraDatabases: [...owned, ...preserved] });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(databaseDeletes(result).map((event) => new URL(event.url).pathname.split('/').at(-1)),
      owned.map((database) => database.uuid));
    assert.deepEqual(result.databases, preserved);
    const summary = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.deepEqual(summary.deleted.filter((resource) => resource.kind === 'd1').map((resource) => resource.name),
      owned.map((database) => database.name));
  });
}
