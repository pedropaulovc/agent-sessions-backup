import { createRequire } from 'node:module';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PREVIEW_ACCOUNT_ID, PRODUCTION_ACCOUNT_ID, paginatedList, parseArgs,
} from './preview-trust.mjs';
import {
  COPY_CHECKPOINT, SEED_CHECKPOINT, DRAIN_MILLISECONDS, assertMaintenanceHealth,
  SOURCE_FREEZE_TABLE, classifyIndexMigration, copyFrozenIndex, initializeShardLayouts, readCheckpoint,
  reconcileIndexCatalog, seedFrozenCatalog, sourceCopyForecast, verifyIndexRecords, writeCheckpoint,
} from '../../hub/scripts/lib/index-migration.mjs';
import { indexShardBindingName } from '../../hub/src/index-layout.mjs';
import { d1SqlFailureReason, verifyD1BatchAtomicity } from './d1-batch-atomicity.mjs';

const MAIN_ID = '5ff65cf3-89c8-4fe6-a3c2-a370293ecea6';
const FREEZE_CHECKPOINT = 'index-maintenance-freeze-v1';
const ATOMICITY_CHECKPOINT = 'index-rest-batch-atomicity-v1';
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const decimalIdentifier = (value) => typeof value === 'string' && value.length > 0 && !/[^0-9]/.test(value);

export function requireProtectedProduction(env = process.env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'push'
    || env.GITHUB_REPOSITORY !== 'pedropaulovc/agent-sessions-backup'
    || env.GITHUB_REF !== 'refs/heads/main' || env.PROTECTED_PRODUCTION_MIGRATION !== '1'
    || env.GITHUB_SHA?.length !== 40 || !/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '')
    || !decimalIdentifier(env.GITHUB_RUN_ID) || !decimalIdentifier(env.GITHUB_RUN_ATTEMPT)) {
    throw new Error('production index control requires the protected main-push GitHub Actions job');
  }
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_ACCOUNT_ID !== PRODUCTION_ACCOUNT_ID) {
    throw new Error('production account identity mismatch');
  }
}

export function cloudflareRetryDelay(response) {
  if (response.status !== 429) return null;
  const seconds = Number(response.headers.get('retry-after'));
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600) {
    throw new Error('Cloudflare HTTP 429 lacks a valid retry-after delay; checkpoint retained');
  }
  return seconds * 1000;
}

export function indexControlClient(accountId, token) {
  if (accountId === PRODUCTION_ACCOUNT_ID) requireProtectedProduction();
  else if (accountId !== PREVIEW_ACCOUNT_ID) throw new Error('index control account must be production or preview');
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required');
  const cf = async (pathname, init = {}) => {
    const { returnEnvelope = false, ...request } = init;
    for (;;) {
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/${pathname}`, {
        ...request, redirect: 'error', signal: AbortSignal.timeout(60000),
        headers: { authorization: `Bearer ${token}`, accept: 'application/json',
          ...(request.body ? { 'content-type': 'application/json' } : {}) },
      });
      const delay = cloudflareRetryDelay(response);
      if (delay !== null) {
        // A 429 rejected the operation before execution. Replay only that unambiguous
        // rejection; network errors and 5xx leave recovery to durable checkpoints.
        await response.body?.cancel();
        await sleep(delay);
        continue;
      }
      let envelope;
      try { envelope = await response.json(); }
      catch { throw new Error(`Cloudflare returned non-JSON HTTP ${response.status}`); }
      if (!response.ok || envelope.success !== true) {
        // Never emit SQL, response bodies, transcript data, or credentials into CI logs.
        const codes = (envelope.errors ?? []).map((error) => error.code).join(',');
        const error = new Error(`Cloudflare ${pathname.split('?')[0]} failed: HTTP ${response.status}, codes=${codes}`);
        if (/^d1\/database\/[^/]+\/query$/.test(pathname)) {
          error.d1SqlReason = d1SqlFailureReason(envelope.errors ?? []);
        }
        throw error;
      }
      return returnEnvelope ? envelope : envelope.result;
    }
  };
  return {
    cf,
    db(id) {
      const execute = async (body) => {
        const results = await cf(`d1/database/${encodeURIComponent(id)}/query`, {
          method: 'POST', body: JSON.stringify(body),
        });
        if (!Array.isArray(results) || results.some((result) => result.success !== true)) {
          const error = new Error(`D1 statement batch failed on database ${id}`);
          error.d1SqlReason = d1SqlFailureReason(Array.isArray(results)
            ? results.flatMap((result) => [result.error, ...(result.errors ?? [])]) : []);
          throw error;
        }
        return results;
      };
      return {
        id,
        async query(sql, params = []) {
          const result = await execute({ sql, params });
          if (result.length !== 1 || !Array.isArray(result[0].results)) {
            throw new Error('D1 query returned an unexpected result shape');
          }
          return result[0].results;
        },
        async batch(batch) { return await execute({ batch }); },
      };
    },
  };
}

async function template(configPath, target) {
  const require = createRequire(path.resolve(path.dirname(configPath), 'package.json'));
  const { experimental_readRawConfig } = require('wrangler');
  const { rawConfig } = experimental_readRawConfig({ config: configPath });
  const config = target === 'preview'
    ? { ...rawConfig, ...rawConfig.env?.preview }
    : { ...rawConfig };
  delete config.env;
  delete config.$schema;
  if (target === 'preview' && !rawConfig.env?.preview) throw new Error('standing preview environment missing');
  const expectedAccount = target === 'production' ? PRODUCTION_ACCOUNT_ID : PREVIEW_ACCOUNT_ID;
  if (config.account_id !== expectedAccount) throw new Error('configuration account identity mismatch');
  const count = target === 'production' ? 16 : 2;
  if (config.vars?.INDEX_SHARD_COUNT !== String(count)) throw new Error('configuration shard count mismatch');
  const bindings = config.d1_databases ?? [];
  const expected = ['DB', ...Array.from({ length: count }, (_, index) => indexShardBindingName(index))];
  if (bindings.length !== expected.length || expected.some((binding, index) => bindings[index]?.binding !== binding)) {
    throw new Error('configuration must bind main and every configured index shard, in layout order');
  }
  if (target === 'production' && bindings[0].database_id !== MAIN_ID) throw new Error('main database identity mismatch');
  config.main = path.resolve(path.dirname(configPath), config.main);
  config.d1_databases = bindings.map((db) => ({
    ...db, migrations_dir: path.resolve(path.dirname(configPath), db.migrations_dir),
  }));
  return config;
}

async function provision(api, args, target) {
  const configPath = path.resolve(args.config ?? 'hub/wrangler.jsonc');
  const config = await template(configPath, target);
  if (!args.output) throw new Error('provision requires --output generated config path');
  const databases = await paginatedList(api.cf, 'd1/database', {
    pagination: 'page', rowsOf: (envelope) => envelope.result,
  });
  const missing = config.d1_databases.filter((binding) =>
    !databases.some((database) => database.name === binding.database_name)).length;
  if (target === 'preview' && databases.length + missing > 10) {
    throw new Error('standing preview requires main+2 databases; Free account limit10 would be exceeded (close unused PR previews)');
  }
  const seen = new Set();
  for (const binding of config.d1_databases) {
    const existing = databases.filter((database) => database.name === binding.database_name);
    if (existing.length > 1) throw new Error(`ambiguous D1 name ${binding.database_name}`);
    let db = existing[0];
    if (binding.binding === 'DB') {
      if (target === 'preview' && !db && !binding.database_id
        && binding.database_name === 'sessions-metadata-preview') {
        db = await api.cf('d1/database', { method: 'POST', body: JSON.stringify({ name: binding.database_name }) });
        databases.push(db);
      }
      if (!db || (binding.database_id && db.uuid !== binding.database_id)) {
        throw new Error('authoritative main database is missing or mismatched');
      }
      binding.database_id = db.uuid;
    } else {
      const expectedName = `${config.d1_databases[0].database_name}-${binding.binding.toLowerCase()}`;
      if (binding.database_name !== expectedName) throw new Error('immutable shard database name mismatch');
      if (!db) {
        if (target === 'preview' && databases.length >= 10) throw new Error('preview D1 quota changed during provisioning');
        db = await api.cf('d1/database', { method: 'POST', body: JSON.stringify({ name: expectedName }) });
        databases.push(db);
      }
      if (binding.database_id && binding.database_id !== db.uuid) throw new Error('immutable shard database ID mismatch');
      binding.database_id = db.uuid;
    }
    if (typeof binding.database_id !== 'string' || seen.has(binding.database_id)) throw new Error('duplicate or missing D1 identity');
    seen.add(binding.database_id);
  }
  config.vars = { ...config.vars, INDEX_MODE: target === 'production' ? 'maintenance' : 'active',
    DEPLOYMENT_REVISION: target === 'production' ? process.env.GITHUB_SHA : args.revision ?? 'standing-preview' };
  await writeFile(path.resolve(args.output), `${JSON.stringify(config, null, 2)}\n`);
  if (args['active-output']) {
    await writeFile(path.resolve(args['active-output']), `${JSON.stringify({ ...config,
      vars: { ...config.vars, INDEX_MODE: 'active' } }, null, 2)}\n`);
  }
  // Deployment without configured consumers must not resume queues during the copy.
  if (target === 'production') {
    config.queues = { ...config.queues, consumers: [] };
    await writeFile(path.resolve(args.output), `${JSON.stringify(config, null, 2)}\n`);
  }
  console.log(JSON.stringify({ target, databaseCount: config.d1_databases.length, config: path.resolve(args.output) }));
}

async function generatedConfig(args) {
  if (!args.config) throw new Error('--config generated config is required');
  const config = JSON.parse(await readFile(path.resolve(args.config), 'utf8'));
  if (config.account_id !== PRODUCTION_ACCOUNT_ID || config.name !== 'sessions-hub'
    || config.vars?.INDEX_SHARD_COUNT !== '16' || config.vars?.DEPLOYMENT_REVISION !== process.env.GITHUB_SHA
    || config.d1_databases?.[0]?.database_id !== MAIN_ID || config.d1_databases.length !== 17) {
    throw new Error('generated production config/revision/database identities do not match');
  }
  const ids = new Set();
  for (let index = 0; index < config.d1_databases.length; index += 1) {
    const db = config.d1_databases[index];
    const binding = index === 0 ? 'DB' : indexShardBindingName(index - 1);
    const name = index === 0 ? 'sessions-index' : `sessions-index-${binding.toLowerCase()}`;
    if (db.binding !== binding || db.database_name !== name || typeof db.database_id !== 'string'
      || ids.has(db.database_id)) throw new Error('generated shard binding identity mismatch');
    ids.add(db.database_id);
  }
  return config;
}

async function health(config, mode) {
  const response = await fetch(`https://${config.vars.VIEWER_HOST}/healthz`, {
    redirect: 'error', signal: AbortSignal.timeout(30000), headers: { 'cache-control': 'no-cache' },
  });
  if (!response.ok) throw new Error(`health revision gate HTTP ${response.status}`);
  const value = await response.json();
  if (mode === 'maintenance') assertMaintenanceHealth(value, config.vars.DEPLOYMENT_REVISION, 16);
  else if (value.ok !== true || value.environment !== 'production' || value.indexMode !== 'active'
    || value.deploymentRevision !== config.vars.DEPLOYMENT_REVISION || value.indexShardCount !== 16) {
    throw new Error('live active revision/layout mismatch');
  }
  return value;
}

async function pauseConsumers(api, config) {
  const queues = await paginatedList(api.cf, 'queues', { pagination: 'page', rowsOf: (envelope) => envelope.result });
  const queueNames = config.queues?.producers?.map((queue) => queue.queue) ?? [];
  let paused = 0;
  for (const name of queueNames) {
    const queue = queues.find((item) => item.queue_name === name);
    if (!queue) throw new Error(`production queue ${name} is missing`);
    const consumers = await api.cf(`queues/${queue.queue_id}/consumers`);
    for (const consumer of consumers) {
      if ((consumer.type != null && consumer.type !== 'worker') || consumer.script_name !== config.name
        || typeof consumer.consumer_id !== 'string') {
        throw new Error(`unexpected consumer on production queue ${name}; refusing to pause another owner`);
      }
      await api.cf(`queues/${queue.queue_id}/consumers/${consumer.consumer_id}`, { method: 'DELETE' });
      paused += 1;
    }
  }
  console.log(JSON.stringify({ pausedConsumers: paused }));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest, new Set(['target', 'config', 'output', 'active-output', 'revision', 'mode', 'github-output']));
  const target = args.target ?? 'production';
  if (!['production', 'preview'].includes(target)) throw new Error('target must be production or preview');
  if (target === 'production') requireProtectedProduction();
  else if (command !== 'provision') throw new Error('standing preview supports fresh provisioning only, never production copying');
  const account = target === 'production' ? PRODUCTION_ACCOUNT_ID : PREVIEW_ACCOUNT_ID;
  if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_ACCOUNT_ID !== account) throw new Error('Cloudflare account mismatch');
  const api = indexControlClient(account, process.env.CLOUDFLARE_API_TOKEN);
  if (command === 'provision') return await provision(api, args, target);
  const config = await generatedConfig(args);
  if (command === 'pause-consumers') return await pauseConsumers(api, config);
  if (command === 'health') {
    if (!['maintenance', 'active'].includes(args.mode)) throw new Error('health requires --mode maintenance|active');
    const deadline = Date.now() + 180000;
    for (;;) {
      try { console.log(JSON.stringify(await health(config, args.mode))); return; }
      catch (error) { if (Date.now() >= deadline) throw error; await sleep(2000); }
    }
  }
  const source = api.db(config.d1_databases[0].database_id);
  const shards = config.d1_databases.slice(1).map((db) => api.db(db.database_id));
  if (command === 'state') {
    const legacy = await source.query(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('blocks', 'blocks_fts', '${SOURCE_FREEZE_TABLE}')`);
    const layoutState = classifyIndexMigration({
      source, shards, legacyTables: legacy.map((row) => row.name),
      copy: await readCheckpoint(shards[0], COPY_CHECKPOINT),
      seed: await readCheckpoint(shards[0], SEED_CHECKPOINT),
    });
    if (args['github-output']) await appendFile(path.resolve(args['github-output']), `layout_state=${layoutState}\n`);
    const copyForecast = legacy.some((row) => row.name === 'blocks')
      ? await sourceCopyForecast({ source, shards }) : null;
    console.log(JSON.stringify({ layoutState, copyForecast }));
    return;
  }
  if (command === 'reconcile-catalog') {
    await health(config, 'active');
    const result = await reconcileIndexCatalog({ source, shards });
    await health(config, 'active');
    console.log(JSON.stringify(result));
    return;
  }
  if (command === 'initialize') {
    await initializeShardLayouts(shards);
    const atomicity = await verifyD1BatchAtomicity(shards[0]);
    await writeCheckpoint(shards[0], ATOMICITY_CHECKPOINT, {
      ...atomicity, revision: config.vars.DEPLOYMENT_REVISION,
      cycle: `${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT}`, verifiedAt: Date.now(),
    });
    console.log(JSON.stringify({ initializedShards: shards.length, atomicity }));
    return;
  }
  if (command === 'verify-active') {
    await health(config, 'active');
    const copied = await readCheckpoint(shards[0], COPY_CHECKPOINT);
    const seeded = await readCheckpoint(shards[0], SEED_CHECKPOINT);
    if (copied?.state !== 'complete' || seeded?.state !== 'complete' || copied.identity.source !== source.id
      || JSON.stringify(copied.identity.shards) !== JSON.stringify(shards.map((db) => db.id))) {
      throw new Error('active verification lacks completed copy/catalog identity evidence');
    }
    const evidence = await verifyIndexRecords({ source, shards, catalogConsistency: 'observe' });
    const login = await fetch(`https://${config.vars.VIEWER_HOST}/login`, {
      redirect: 'error', signal: AbortSignal.timeout(30000),
    });
    if (login.status !== 200 || !login.headers.get('content-type')?.includes('text/html')) {
      throw new Error('active viewer login smoke failed');
    }
    await login.body?.cancel();
    await health(config, 'active');
    console.log(JSON.stringify({ state: 'active', copiedRows: copied.rows, copySha256: copied.sha256, ...evidence }));
    return;
  }
  const gate = async () => await health(config, 'maintenance');
  await gate();
  const cycle = `${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT}`;
  if (command === 'drain') {
    let frozen = await readCheckpoint(shards[0], FREEZE_CHECKPOINT);
    if (!frozen || frozen.revision !== config.vars.DEPLOYMENT_REVISION || frozen.cycle !== cycle) {
      frozen = { revision: config.vars.DEPLOYMENT_REVISION, cycle, observedAt: Date.now(), source: source.id, shards: shards.map((db) => db.id) };
      await writeCheckpoint(shards[0], FREEZE_CHECKPOINT, frozen);
    }
    if (!Number.isSafeInteger(frozen.observedAt) || frozen.observedAt <= 0 || frozen.observedAt > Date.now()
      || frozen.source !== source.id || JSON.stringify(frozen.shards) !== JSON.stringify(shards.map((db) => db.id))) {
      throw new Error('freeze checkpoint database identities changed');
    }
    while (Date.now() - frozen.observedAt < DRAIN_MILLISECONDS) {
      await gate();
      await sleep(Math.min(30000, DRAIN_MILLISECONDS - (Date.now() - frozen.observedAt)));
    }
    await gate();
    console.log(JSON.stringify({ drainedRevision: frozen.revision, milliseconds: DRAIN_MILLISECONDS }));
    return;
  }
  const frozen = await readCheckpoint(shards[0], FREEZE_CHECKPOINT);
  if (frozen?.revision !== config.vars.DEPLOYMENT_REVISION || frozen.cycle !== cycle
    || !Number.isSafeInteger(frozen.observedAt) || frozen.observedAt <= 0 || frozen.observedAt > Date.now()
    || frozen.source !== source.id || JSON.stringify(frozen.shards) !== JSON.stringify(shards.map((db) => db.id))
    || Date.now() - frozen.observedAt < DRAIN_MILLISECONDS) {
    throw new Error('queue and scheduled work has not passed the durable maintenance drain gate');
  }
  if (command === 'copy') {
    const atomicity = await readCheckpoint(shards[0], ATOMICITY_CHECKPOINT);
    if (atomicity?.state !== 'verified' || atomicity.databaseId !== shards[0].id
      || atomicity.revision !== config.vars.DEPLOYMENT_REVISION || atomicity.cycle !== cycle
      || !Number.isSafeInteger(atomicity.verifiedAt) || atomicity.verifiedAt <= 0 || atomicity.verifiedAt > Date.now()) {
      throw new Error('this deployment has no verified native D1 REST batch atomicity control; source copy forbidden');
    }
    const copied = await copyFrozenIndex({ source, shards, gate });
    console.log(JSON.stringify({ copiedRows: copied.rows, state: copied.state, sha256: copied.sha256 }));
  } else if (command === 'seed-catalog') {
    const seeded = await seedFrozenCatalog({ source, shards, gate });
    console.log(JSON.stringify({ catalogRows: seeded.rows, state: seeded.state }));
  } else if (command === 'ready') {
    const copied = await readCheckpoint(shards[0], COPY_CHECKPOINT);
    const seeded = await readCheckpoint(shards[0], SEED_CHECKPOINT);
    if (copied?.state !== 'complete' || seeded?.state !== 'complete' || (await source.query('SELECT seq FROM session_catalog_outbox LIMIT 1')).length) {
      throw new Error('verified copy/catalog prerequisites incomplete; active deployment forbidden');
    }
    await initializeShardLayouts(shards);
    const legacy = await source.query(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('blocks', 'blocks_fts', '${SOURCE_FREEZE_TABLE}')`);
    if (legacy.length) throw new Error('main legacy index/freeze objects remain; migrations must complete before activation');
    const evidence = await verifyIndexRecords({ source, shards, catalogConsistency: 'required' });
    await gate();
    console.log(JSON.stringify({ state: 'ready', ...evidence }));
  } else throw new Error(`unknown index control command: ${command}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
