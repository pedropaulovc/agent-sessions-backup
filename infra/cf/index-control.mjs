import { createRequire } from 'node:module';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PREVIEW_ACCOUNT_ID, PRODUCTION_ACCOUNT_ID, paginatedList, parseArgs,
} from './preview-trust.mjs';
import {
  COPY_CHECKPOINT, SEED_CHECKPOINT, READY_CHECKPOINT, ACTIVATION_CHECKPOINT,
  DRAIN_MILLISECONDS, assertMaintenanceHealth, assertReadyProof, assertActivationProof,
  buildReadyProof, buildActivationProof, SOURCE_FREEZE_TABLE, classifyIndexMigration,
  copyFrozenIndex, initializeShardLayouts, readCheckpoint, reconcileIndexCatalog,
  seedFrozenCatalog, sourceCopyForecast, verifyIndexRecords, writeCheckpoint,
} from '../../hub/scripts/lib/index-migration.mjs';
import { indexShardBindingName } from '../../hub/src/index-layout.mjs';
import { D1_BATCH_PROBE_TEXT, D1_FAILURE_KINDS, D1_SQL_FAILURE_REASONS, d1SqlFailureReason, verifyD1BatchAtomicity } from './d1-batch-atomicity.mjs';
import { sharedCloudflareApiPermit } from '../../hub/scripts/lib/cloudflare-api-budget.mjs';

const MAIN_ID = '5ff65cf3-89c8-4fe6-a3c2-a370293ecea6';
const FREEZE_CHECKPOINT = 'index-maintenance-freeze-v1';
const ATOMICITY_CHECKPOINT = 'index-rest-batch-atomicity-v1';
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const decimalIdentifier = (value) => typeof value === 'string' && value.length > 0 && !/[^0-9]/.test(value);
const providerCodes = (errors) => (Array.isArray(errors) ? errors : [])
  .map((error) => error?.code).filter((code) => Number.isSafeInteger(code) && code >= 0);
const publicDatabaseId = (id) => typeof id === 'string'
  && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) ? id : 'unknown';

export class CopyPassBudgetExhausted extends Error {
  constructor() {
    super('copy pass request budget exhausted');
    this.name = 'CopyPassBudgetExhausted';
  }
}

/** Soft boundary only: never cancel an in-flight request or native transaction. */
export function createCopyPassRequestGate(budgetMs, { now = Date.now } = {}) {
  if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0) {
    throw new Error('--pass-budget-ms must be a positive safe integer number of milliseconds');
  }
  const startedAt = now();
  return (delayMs = 0) => {
    const remaining = budgetMs - (now() - startedAt);
    if (remaining <= 0 || delayMs >= remaining) throw new CopyPassBudgetExhausted();
  };
}

/** Only the explicit boundary exception is a resumable partial pass. */
export async function runCopyPass({ source, shards, gate }) {
  try {
    const copied = await copyFrozenIndex({ source, shards, gate });
    return { copiedRows: copied.rows, state: copied.state, sha256: copied.sha256 };
  } catch (error) {
    if (!(error instanceof CopyPassBudgetExhausted)) throw error;
    return { status: 'partial', reason: 'pass-budget-exhausted' };
  }
}

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
    const error = new Error('Cloudflare HTTP 429 lacks a valid retry-after delay; checkpoint retained');
    error.providerStatus = response.status;
    error.d1FailureKind = 'http';
    throw error;
  }
  return seconds * 1000;
}

export function indexControlClient(accountId, token, { permit = sharedCloudflareApiPermit, wait = sleep, requestGate } = {}) {
  if (accountId === PRODUCTION_ACCOUNT_ID) requireProtectedProduction();
  else if (accountId !== PREVIEW_ACCOUNT_ID) throw new Error('index control account must be production or preview');
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required');
  const responseStatuses = new WeakMap();
  const cf = async (pathname, init = {}) => {
    const { responseFormat = 'result', ...request } = init;
    if (responseFormat !== 'result' && responseFormat !== 'envelope') {
      throw new Error('Cloudflare response format must be result or envelope');
    }
    for (;;) {
      if (requestGate) requestGate();
      await permit();
      if (requestGate) requestGate();
      let response;
      try {
        response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/${pathname}`, {
          ...request, redirect: 'error', signal: AbortSignal.timeout(60000),
          headers: { authorization: `Bearer ${token}`, accept: 'application/json',
            ...(request.body ? { 'content-type': 'application/json' } : {}) },
        });
      } catch (error) {
        error.d1FailureKind = 'transport';
        error.providerStatus = undefined; // No actual Response was received.
        throw error;
      }
      const delay = cloudflareRetryDelay(response);
      if (delay !== null) {
        // A 429 rejected the operation before execution. Replay only that unambiguous
        // rejection; network errors and 5xx leave recovery to durable checkpoints.
        await response.body?.cancel();
        if (requestGate) requestGate(delay);
        await wait(delay);
        continue;
      }
      let text;
      try { text = await response.text(); }
      catch {
        const error = new Error(`Cloudflare response body read failed: HTTP ${response.status}`);
        error.providerStatus = response.status;
        error.d1FailureKind = 'transport';
        throw error;
      }
      let envelope;
      try { envelope = JSON.parse(text); }
      catch {
        const error = new Error(`Cloudflare returned non-JSON HTTP ${response.status}`);
        error.providerStatus = response.status;
        error.d1FailureKind = response.ok ? 'shape' : 'http';
        throw error;
      }
      if (!response.ok || envelope?.success !== true) {
        // Never emit SQL, response bodies, transcript data, or credentials into CI logs.
        const codes = providerCodes(envelope?.errors);
        const isD1 = /^d1\/database\/[^/]+\/query$/.test(pathname);
        const error = new Error(`Cloudflare ${isD1 ? 'D1 query' : pathname.split('?')[0]} failed: HTTP ${response.status}, codes=${codes.join(',')}`);
        error.providerStatus = response.status;
        error.providerCodes = codes;
        error.d1FailureKind = !response.ok ? 'http' : envelope?.success === false ? 'statement' : 'shape';
        if (isD1) error.d1SqlReason = d1SqlFailureReason(envelope?.errors);
        throw error;
      }
      if (responseFormat === 'envelope') responseStatuses.set(envelope, response.status);
      return responseFormat === 'envelope' ? envelope : envelope.result;
    }
  };
  return {
    cf,
    db(id) {
      const execute = async (body, kind) => {
        let encodedBody;
        let failureKind = 'transport';
        try {
          const envelope = await cf(`d1/database/${encodeURIComponent(id)}/query`, {
            method: 'POST', body: encodedBody = JSON.stringify(body), responseFormat: 'envelope',
          });
          const results = envelope.result;
          if (!Array.isArray(results) || results.some((result) => result?.success !== true)) {
            failureKind = Array.isArray(results) && results.some((result) => result?.success === false)
              ? 'statement' : 'shape';
            const failures = Array.isArray(results)
              ? results.flatMap((result) => [result?.error,
                ...(Array.isArray(result?.errors) ? result.errors : [])]) : [];
            const error = new Error('D1 statement rejection');
            error.d1SqlReason = d1SqlFailureReason(failures);
            error.providerCodes = providerCodes([...failures, ...(Array.isArray(envelope.errors) ? envelope.errors : [])]);
            error.providerStatus = responseStatuses.get(envelope);
            throw error;
          }
          if (kind === 'query' && (results.length !== 1 || !Array.isArray(results[0]?.results))) {
            failureKind = 'shape';
            const error = new Error('D1 query returned an unexpected result shape');
            error.providerStatus = responseStatuses.get(envelope);
            throw error;
          }
          return results;
        } catch (error) {
          if (error instanceof CopyPassBudgetExhausted) throw error;
          // Replace transport/provider messages too: they may contain URLs, SQL or data.
          const reason = D1_SQL_FAILURE_REASONS.includes(error?.d1SqlReason) ? error.d1SqlReason : 'other';
          const failure = D1_FAILURE_KINDS.includes(error?.d1FailureKind) ? error.d1FailureKind : failureKind;
          const codes = Array.isArray(error?.providerCodes) ? providerCodes(error.providerCodes.map((code) => ({ code }))) : [];
          // Count already-encoded request bytes only on failure. Parameter JSON byte
          // counts include array framing/escaping and never disclose the values.
          const statements = kind === 'batch' && Array.isArray(body.batch) ? body.batch : [body];
          const parameters = statements.reduce((count, statement) =>
            count + (Array.isArray(statement?.params) ? statement.params.length : 0), 0);
          const parameterJsonBytes = typeof encodedBody === 'string' ? statements.reduce((bytes, statement) =>
            bytes + Buffer.byteLength(JSON.stringify(statement?.params ?? []), 'utf8'), 0) : 0;
          const safe = new Error(`D1 database=${publicDatabaseId(id)} kind=${kind}`
            + ` HTTP=${Number.isInteger(error?.providerStatus) && error.providerStatus >= 100 && error.providerStatus <= 599 ? error.providerStatus : 'unknown'}`
            + ` codes=${codes.join(',')}`
            + ` failure=${failure}`
            + ` native=${reason} statements=${statements.length} parameters=${parameters}`
            + ` bodyBytes=${typeof encodedBody === 'string' ? Buffer.byteLength(encodedBody, 'utf8') : 0}`
            + ` parameterJsonBytes=${parameterJsonBytes}`);
          safe.d1SqlReason = reason;
          safe.d1FailureKind = failure;
          safe.d1Diagnostic = true;
          throw safe;
        }
      };
      return {
        id,
        async query(sql, params = []) {
          const result = await execute({ sql, params }, 'query');
          return result[0].results;
        },
        async batch(batch) { return await execute({ batch }, 'batch'); },
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

function healthFailure(command, mode, failure, attempts, status) {
  const safeCommand = ['health', 'reconcile-catalog', 'verify-active', 'drain', 'copy', 'seed-catalog', 'ready']
    .includes(command) ? command : 'unknown';
  return new Error(`health operation=revision-gate command=${safeCommand} mode=${mode === 'active' ? 'active' : 'maintenance'}`
    + ` failure=${failure} HTTP=${Number.isInteger(status) && status >= 100 && status <= 599 ? status : 'unknown'}`
    + ` attempts=${attempts}`);
}

async function health(config, mode, { command, requestGate } = {}) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (requestGate) requestGate();
    let response;
    let text;
    try {
      response = await fetch(`https://${config.vars.VIEWER_HOST}/healthz`, {
        redirect: 'error', signal: AbortSignal.timeout(30000), headers: { 'cache-control': 'no-cache' },
      });
      if (response.ok) text = await response.text();
    } catch (error) {
      if (error instanceof CopyPassBudgetExhausted) throw error;
      if (attempt === 3) throw healthFailure(command, mode, 'transport', attempt, response?.status);
      // Only this read-only GET is safe to replay after an ambiguous transport
      // interruption. The same copy boundary gates starts and retry waits.
      if (requestGate) requestGate(1000);
      await sleep(1000);
      continue;
    }
    if (!response.ok) throw healthFailure(command, mode, 'http', attempt, response.status);
    let value;
    try { value = JSON.parse(text); }
    catch { throw healthFailure(command, mode, 'json', attempt, response.status); }
    try {
      if (mode === 'maintenance') assertMaintenanceHealth(value, config.vars.DEPLOYMENT_REVISION, 16);
      else if (value?.ok !== true || value.environment !== 'production' || value.indexMode !== 'active'
        || value.deploymentRevision !== config.vars.DEPLOYMENT_REVISION || value.indexShardCount !== 16) {
        throw new Error('live active revision/layout mismatch');
      }
    } catch { throw healthFailure(command, mode, 'mismatch', attempt, response.status); }
    return value;
  }
}

/** Safe native GET schema facts only; this projection never authorizes deletion. */
export function queueConsumerIdentityFacts(consumer) {
  const workerName = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,63}$/.test(value)
    ? value : null;
  const recognizedKeys = new Set([
    'script', 'dead_letter_queue', 'settings', 'type', 'queue_name', 'queue_id', 'consumer_id', 'created_on',
  ]);
  const propertyKeys = consumer !== null && typeof consumer === 'object' ? Object.keys(consumer) : [];
  return {
    recordKind: consumer === null ? 'null' : Array.isArray(consumer) ? 'array' : typeof consumer,
    consumer_id: { type: typeof consumer?.consumer_id },
    type: {
      type: typeof consumer?.type,
      ...(typeof consumer?.type === 'string'
        ? { value: consumer.type === 'worker' || consumer.type === 'http_pull' ? consumer.type : null } : {}),
    },
    recognizedPropertyKeys: propertyKeys.filter((key) => recognizedKeys.has(key)),
    unknownPropertyKeyCount: propertyKeys.filter((key) => !recognizedKeys.has(key)).length,
    script: { type: typeof consumer?.script, workerName: workerName(consumer?.script) },
  };
}

export async function pauseConsumers(api, config) {
  const queues = await paginatedList(api.cf, 'queues', { pagination: 'page', rowsOf: (envelope) => envelope.result });
  const queueNames = [...new Set(config.queues?.consumers?.map((queue) => queue.queue) ?? [])];
  const validatedConsumers = [];
  for (const name of queueNames) {
    const queue = queues.find((item) => item.queue_name === name);
    if (!queue) throw new Error(`production queue ${name} is missing`);
    const consumers = await api.cf(`queues/${queue.queue_id}/consumers`);
    for (const consumer of consumers) {
      if ((consumer?.type != null && consumer.type !== 'worker') || consumer?.script !== config.name
        || typeof consumer?.consumer_id !== 'string') {
        throw new Error(`unexpected consumer on production queue ${name}; refusing to pause another owner; `
          + JSON.stringify({ expectedWorker: config.name, consumer: queueConsumerIdentityFacts(consumer) }));
      }
      validatedConsumers.push({ queueId: queue.queue_id, consumerId: consumer.consumer_id });
    }
  }
  for (const { queueId, consumerId } of validatedConsumers) {
    await api.cf(`queues/${queueId}/consumers/${consumerId}`, { method: 'DELETE' });
  }
  return { pausedConsumers: validatedConsumers.length };
}

/** Persist readiness only after the actual frozen data and final outbox checks pass. */
export async function verifyReadyIndex({ source, shards, revision, cycle, gate }) {
  await gate();
  const copied = await readCheckpoint(shards[0], COPY_CHECKPOINT);
  const seeded = await readCheckpoint(shards[0], SEED_CHECKPOINT);
  const existingReady = await readCheckpoint(shards[0], READY_CHECKPOINT);
  const activation = await readCheckpoint(shards[0], ACTIVATION_CHECKPOINT);
  if (activation !== null) {
    assertActivationProof({ source, shards, copy: copied, seed: seeded, ready: existingReady, activation });
    throw new Error('initial activation is already proven; refusing to replace its readiness checkpoint');
  }
  if (existingReady !== null) {
    assertReadyProof({ source, shards, copy: copied, seed: seeded, ready: existingReady });
  }
  if (copied?.state !== 'complete' || seeded?.state !== 'complete'
    || (await source.query('SELECT seq FROM session_catalog_outbox LIMIT 1')).length) {
    throw new Error('verified copy/catalog prerequisites incomplete; active deployment forbidden');
  }
  await initializeShardLayouts(shards);
  const legacy = await source.query(`SELECT name FROM sqlite_master WHERE type = 'table'
    AND name IN ('blocks', 'blocks_fts', '${SOURCE_FREEZE_TABLE}')`);
  if (legacy.length) throw new Error('main legacy index/freeze objects remain; migrations must complete before activation');
  const evidence = await verifyIndexRecords({ source, shards, catalogConsistency: 'required' });
  await gate();
  if ((await source.query('SELECT seq FROM session_catalog_outbox LIMIT 1')).length) {
    throw new Error('catalog changed during strict readiness verification; active deployment forbidden');
  }
  const ready = buildReadyProof({ source, shards, copy: copied, seed: seeded,
    revision, cycle, verifiedAt: Date.now(), evidence });
  await writeCheckpoint(shards[0], READY_CHECKPOINT, ready);
  return { state: 'ready', ...evidence };
}

/** The initial activation marker is written only after real active/login checks. */
export async function verifyActiveIndex({ source, shards, revision, cycle, gate, login }) {
  const copied = await readCheckpoint(shards[0], COPY_CHECKPOINT);
  const seeded = await readCheckpoint(shards[0], SEED_CHECKPOINT);
  const ready = await readCheckpoint(shards[0], READY_CHECKPOINT);
  const activation = await readCheckpoint(shards[0], ACTIVATION_CHECKPOINT);
  const activationState = activation === null ? 'initial' : 'existing';
  const proofContext = { source, shards, copy: copied, seed: seeded, ready };
  if (activationState === 'existing') assertActivationProof({ ...proofContext, activation });
  else assertReadyProof({ ...proofContext, revision, cycle });
  await gate();
  const evidence = await verifyIndexRecords({ source, shards, catalogConsistency: 'observe' });
  await login();
  await gate();
  if (activationState === 'initial') {
    const proof = buildActivationProof({ ...proofContext, revision, cycle,
      verifiedAt: Date.now(), evidence });
    await writeCheckpoint(shards[0], ACTIVATION_CHECKPOINT, proof);
  }
  return { state: 'active', activationState,
    copiedRows: copied.rows, copySha256: copied.sha256, ...evidence };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest, new Set(['target', 'config', 'output', 'active-output', 'revision', 'mode', 'github-output', 'pass-budget-ms']));
  if (args['pass-budget-ms'] !== undefined && (command !== 'copy'
    || !/^[0-9]+$/.test(args['pass-budget-ms'])
    || !Number.isSafeInteger(Number(args['pass-budget-ms'])) || Number(args['pass-budget-ms']) <= 0)) {
    throw new Error('--pass-budget-ms requires copy and a positive safe integer number of milliseconds');
  }
  const target = args.target ?? 'production';
  if (!['production', 'preview'].includes(target)) throw new Error('target must be production or preview');
  if (target === 'production') requireProtectedProduction();
  else if (command !== 'provision') throw new Error('standing preview supports fresh provisioning only, never production copying');
  const account = target === 'production' ? PRODUCTION_ACCOUNT_ID : PREVIEW_ACCOUNT_ID;
  if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_ACCOUNT_ID !== account) throw new Error('Cloudflare account mismatch');
  const api = indexControlClient(account, process.env.CLOUDFLARE_API_TOKEN);
  if (command === 'provision') return await provision(api, args, target);
  const config = await generatedConfig(args);
  if (command === 'pause-consumers') {
    console.log(JSON.stringify(await pauseConsumers(api, config)));
    return;
  }
  if (command === 'health') {
    if (!['maintenance', 'active'].includes(args.mode)) throw new Error('health requires --mode maintenance|active');
    const deadline = Date.now() + 180000;
    for (;;) {
      try { console.log(JSON.stringify(await health(config, args.mode, { command }))); return; }
      catch (error) { if (Date.now() >= deadline) throw error; await sleep(2000); }
    }
  }
  const source = api.db(config.d1_databases[0].database_id);
  const shards = config.d1_databases.slice(1).map((db) => api.db(db.database_id));
  const cycle = `${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT}`;
  if (command === 'state') {
    const legacy = await source.query(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('blocks', 'blocks_fts', '${SOURCE_FREEZE_TABLE}')`);
    const layoutState = classifyIndexMigration({
      source, shards, legacyTables: legacy.map((row) => row.name),
      copy: await readCheckpoint(shards[0], COPY_CHECKPOINT),
      seed: await readCheckpoint(shards[0], SEED_CHECKPOINT),
      ready: await readCheckpoint(shards[0], READY_CHECKPOINT),
      activation: await readCheckpoint(shards[0], ACTIVATION_CHECKPOINT),
    });
    if (args['github-output']) await appendFile(path.resolve(args['github-output']), `layout_state=${layoutState}\n`);
    const copyForecast = legacy.some((row) => row.name === 'blocks')
      ? await sourceCopyForecast({ source, shards }) : null;
    console.log(JSON.stringify({ layoutState, copyForecast }));
    return;
  }
  if (command === 'reconcile-catalog') {
    await health(config, 'active', { command });
    const result = await reconcileIndexCatalog({ source, shards });
    await health(config, 'active', { command });
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
    const result = await verifyActiveIndex({
      source, shards, revision: config.vars.DEPLOYMENT_REVISION, cycle,
      gate: async () => await health(config, 'active', { command }),
      login: async () => {
        const response = await fetch(`https://${config.vars.VIEWER_HOST}/login`, {
          redirect: 'error', signal: AbortSignal.timeout(30000),
        });
        if (response.status !== 200 || !response.headers.get('content-type')?.includes('text/html')) {
          throw new Error('active viewer login smoke failed');
        }
        await response.body?.cancel();
      },
    });
    console.log(JSON.stringify(result));
    return;
  }
  const gate = async () => await health(config, 'maintenance', { command });
  await gate();
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
      || atomicity.textTransport !== 'verified' || atomicity.textBytes !== Buffer.byteLength(D1_BATCH_PROBE_TEXT, 'utf8')
      || atomicity.revision !== config.vars.DEPLOYMENT_REVISION || atomicity.cycle !== cycle
      || !Number.isSafeInteger(atomicity.verifiedAt) || atomicity.verifiedAt <= 0 || atomicity.verifiedAt > Date.now()) {
      throw new Error('this deployment has no verified native D1 REST batch atomicity/text transport control; source copy forbidden');
    }
    // Setup/drain/atomicity prerequisites stay unbudgeted. Copy data requests and
    // fresh health gates share this process's non-persisted pass boundary.
    const requestGate = args['pass-budget-ms'] === undefined ? undefined
      : createCopyPassRequestGate(Number(args['pass-budget-ms']));
    const copyApi = requestGate ? indexControlClient(account, process.env.CLOUDFLARE_API_TOKEN, { requestGate }) : api;
    const result = await runCopyPass({
      source: copyApi.db(config.d1_databases[0].database_id),
      shards: config.d1_databases.slice(1).map((db) => copyApi.db(db.database_id)),
      gate: async () => await health(config, 'maintenance', { command, requestGate }),
    });
    console.log(JSON.stringify(result));
    if (result.status === 'partial') process.exitCode = 78;
  } else if (command === 'seed-catalog') {
    const seeded = await seedFrozenCatalog({ source, shards, gate });
    console.log(JSON.stringify({ catalogRows: seeded.rows, state: seeded.state }));
  } else if (command === 'ready') {
    console.log(JSON.stringify(await verifyReadyIndex({
      source, shards, revision: config.vars.DEPLOYMENT_REVISION, cycle, gate,
    })));
  } else throw new Error(`unknown index control command: ${command}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    if (error.d1SourceComparison) console.error(JSON.stringify({ sourceRetirementComparison: error.d1SourceComparison }));
    console.error(error.message);
    process.exitCode = 1;
  });
}
