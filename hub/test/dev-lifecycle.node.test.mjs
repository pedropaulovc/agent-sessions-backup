import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspect } from 'node:util';
import {
  acquireOwnership,
  recordRuntime,
  removeOwnedState,
} from '../scripts/lib/dev-ownership.mjs';
import {
  createProcessTracker,
  retryPortSelection,
  runCaptured,
} from '../scripts/lib/dev-process.mjs';
import { migrationDeploymentIdentity } from '../scripts/lib/migration-runner.mjs';
import { assertReusableLocalTopology, generatedLocalConfig } from '../scripts/lib/local-config.mjs';
import { fetchEnvironmentText, waitForReadiness } from '../scripts/lib/environment.mjs';
import { SYNTHETIC_EXPECTATIONS, seedSynthetic, syntheticSeedManifest } from '../scripts/lib/dev-seed.mjs';

async function temporaryState(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hub-dev-lifecycle-'));
  const stateDir = path.join(root, 'state');
  await mkdir(stateDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  return stateDir;
}

test('a dead orchestrator lock cannot be stolen while its exact Wrangler child is live', async (t) => {
  const stateDir = await temporaryState(t);
  const ownerIdentity = 'owner-start-1';
  const childIdentity = 'wrangler-start-1';
  const owner = await acquireOwnership(stateDir, 'first', {
    inspectProcess: (pid) => pid === process.pid ? ownerIdentity : null,
  });
  await recordRuntime(stateDir, owner, 424242, (pid) => pid === 424242 ? childIdentity : null);

  await assert.rejects(
    acquireOwnership(stateDir, 'takeover', {
      inspectProcess: (pid) => pid === 424242 ? childIdentity : null,
    }),
    /live Wrangler process 424242/,
  );
  const persisted = JSON.parse(await readFile(path.join(stateDir, '.owner.lock', 'owner.json'), 'utf8'));
  assert.equal(persisted.nonce, 'first');
});
test('stale runtime cleanup allows three successive owner generations', async (t) => {
  const stateDir = await temporaryState(t);
  const runtimePath = path.join(stateDir, 'runtime.json');
  const firstOwner = await acquireOwnership(stateDir, 'old-generation', {
    inspectProcess: (pid) => pid === process.pid ? 'old-owner-start' : null,
  });
  await recordRuntime(stateDir, firstOwner, 424243, () => 'old-child-start');

  const replacement = await acquireOwnership(stateDir, 'new-generation', {
    inspectProcess: (pid) => pid === process.pid ? 'new-owner-start' : pid === 424243 ? 'reused-pid-start' : null,
  });
  assert.equal(replacement.nonce, 'new-generation');
  assert.equal(replacement.processStartIdentity, 'new-owner-start');
  await assert.rejects(readFile(runtimePath), { code: 'ENOENT' });

  const thirdOwner = await acquireOwnership(stateDir, 'third-generation', {
    inspectProcess: (pid) => pid === process.pid ? 'third-owner-start' : null,
  });
  assert.equal(thirdOwner.nonce, 'third-generation');
  assert.equal(thirdOwner.processStartIdentity, 'third-owner-start');
});

test('lock removal during the ownerless recency check retries acquisition', async (t) => {
  const stateDir = await temporaryState(t);
  const lockDir = path.join(stateDir, '.owner.lock');
  const runtimePath = path.join(stateDir, 'runtime.json');
  const firstOwner = await acquireOwnership(stateDir, 'old-generation', {
    inspectProcess: (pid) => pid === process.pid ? 'old-owner-start' : null,
  });
  await recordRuntime(stateDir, firstOwner, 424244, () => 'old-child-start');
  await rm(lockDir, { recursive: true, force: false });
  await mkdir(lockDir);

  let removedDuringInspection = false;
  const replacement = await acquireOwnership(stateDir, 'replacement', {
    inspectProcess: (pid) => {
      if (pid === 424244) {
        if (!removedDuringInspection) {
          rmSync(lockDir, { recursive: true, force: false });
          removedDuringInspection = true;
        }
        return null;
      }
      return pid === process.pid ? 'replacement-owner-start' : null;
    },
  });

  assert.equal(removedDuringInspection, true);
  assert.equal(replacement.nonce, 'replacement');
  const persisted = JSON.parse(await readFile(path.join(lockDir, 'owner.json'), 'utf8'));
  assert.equal(persisted.nonce, 'replacement');
  await assert.rejects(readFile(runtimePath), { code: 'ENOENT' });
});


test('reset holds the same exclusive owner lock until the old state is atomically removed', async (t) => {
  const stateDir = await temporaryState(t);
  const identity = 'reset-start-identity';
  const resetOwner = await acquireOwnership(stateDir, 'reset-owner', {
    inspectProcess: (pid) => pid === process.pid ? identity : null,
  });

  await assert.rejects(
    acquireOwnership(stateDir, 'racing-start', {
      inspectProcess: (pid) => pid === process.pid ? identity : null,
    }),
    /owned by live process/,
  );
  await removeOwnedState(stateDir, resetOwner, { inspectProcess: () => null });
  await assert.rejects(readFile(path.join(stateDir, '.owner.lock', 'owner.json')), { code: 'ENOENT' });
});

test('artifact, migration, database, and storage changes independently change migration identities', () => {
  const identity = {
    target: 'local', stateName: 'default', artifactDigest: 'a'.repeat(64), migrationDigest: 'b'.repeat(64),
    databaseBinding: 'IDX00', databaseId: 'index-00', persistTo: path.resolve('/tmp/hub-local-state'),
  };
  const original = migrationDeploymentIdentity(identity);
  for (const change of [
    { migrationDigest: 'c'.repeat(64) },
    { artifactDigest: 'd'.repeat(64) },
    { databaseBinding: 'IDX01' },
    { databaseId: 'replacement-index-00' },
    { persistTo: path.resolve('/tmp/other-hub-state') },
    { stateName: 'other' },
  ]) {
    const changed = migrationDeploymentIdentity({ ...identity, ...change });
    assert.notEqual(original.journalName, changed.journalName);
    assert.notEqual(original.deploymentId, changed.deploymentId);
  }
  assert.deepEqual(migrationDeploymentIdentity(identity), original, 'same DB state resumes the same journal');
  assert.match(original.journalName, /^IDX00-[0-9a-f]{64}-[0-9a-f]{64}-[0-9a-f]{64}\.json$/);
  assert.throws(() => migrationDeploymentIdentity({ ...identity, databaseId: undefined }), /database binding, database ID/);
});

test('local config replaces production topology with exactly two active, stable index shards', () => {
  const hubRoot = path.resolve('/tmp/hub-config-test');
  const baseConfig = {
    name: 'sessions-hub', main: 'src/index.ts', compatibility_date: '2026-07-01',
    account_id: 'production', routes: [{ pattern: 'production.example' }], env: { preview: {} },
    vars: { ENVIRONMENT: 'production', INDEX_MODE: 'maintenance', INDEX_SHARD_COUNT: '16', DEPLOYMENT_REVISION: 'old' },
    d1_databases: [
      { binding: 'DB', database_name: 'sessions-index', database_id: 'existing-main-state', remote: true },
      ...Array.from({ length: 16 }, (_, shard) => ({
        binding: `IDX${String(shard).padStart(2, '0')}`, database_id: `production-${shard}`,
      })),
    ],
    queues: { producers: [{ binding: 'PARSE_QUEUE', queue: 'parse' }] },
  };
  const config = generatedLocalConfig({ baseConfig, hubRoot, revision: 'local:artifact' });
  assert.deepEqual(config.d1_databases.map(({ binding }) => binding), ['DB', 'IDX00', 'IDX01']);
  assert.equal(config.d1_databases[0].database_id, 'existing-main-state');
  assert.equal(new Set(config.d1_databases.map(({ database_id }) => database_id)).size, 3);
  for (const database of config.d1_databases) {
    assert.equal(database.remote, undefined);
    assert.equal(database.migrations_dir, path.join(hubRoot, database.binding === 'DB' ? 'migrations' : 'migrations-index'));
  }
  assert.equal(config.main, path.join(hubRoot, 'src/index.ts'));
  assert.deepEqual(config.vars, {
    ENVIRONMENT: 'development', INDEX_MODE: 'active', INDEX_SHARD_COUNT: '2', DEPLOYMENT_REVISION: 'local:artifact',
  });
  assert.equal(config.account_id, undefined);
  assert.equal(config.env, undefined);
  assert.deepEqual(config.routes, []);
  assert.deepEqual(config.queues, baseConfig.queues);
  const restarted = generatedLocalConfig({ baseConfig, hubRoot, revision: 'e2e:new-artifact' });
  assert.deepEqual(restarted.d1_databases, config.d1_databases);
  assert.equal(baseConfig.vars.INDEX_SHARD_COUNT, '16', 'generating local config must not mutate production config');
});

test('local cutover refuses old or unidentified populated state without deleting it', async (t) => {
  const stateDir = await temporaryState(t);
  const databases = ['DB', 'IDX00', 'IDX01'].map((binding) => ({ binding, database_id: `id-${binding}` }));
  let inspections = 0;
  const options = {
    stateDir, databases,
    hasLegacyBlocks: async () => { inspections += 1; return false; },
  };
  await assertReusableLocalTopology(options);
  assert.equal(inspections, 1, 'fresh state is inspected without migration DML');
  await assert.rejects(assertReusableLocalTopology({
    ...options, hasLegacyBlocks: async () => true,
  }), /legacy blocks.*dev:reset/);
  const diagnosticsPath = path.join(stateDir, 'schema-diagnostics.json');
  const legacy = JSON.stringify({ migrationDigest: 'old-main-only' });
  await writeFile(diagnosticsPath, legacy);
  await assert.rejects(assertReusableLocalTopology(options), /pre-sharding.*dev:reset/);
  assert.equal(await readFile(diagnosticsPath, 'utf8'), legacy, 'refusal leaves existing state untouched');
  assert.equal(inspections, 1, 'known old topology is refused without opening databases');
  const diagnostics = {
    databases: databases.map(({ binding, database_id }) => ({
      databaseBinding: binding, databaseId: database_id, persistTo: stateDir,
    })),
  };
  await writeFile(diagnosticsPath, JSON.stringify(diagnostics));
  await assertReusableLocalTopology(options);
  assert.equal(inspections, 1, 'verified topology reuses its independent journals');
  diagnostics.databases[1].databaseId = 'another-index-database';
  await writeFile(diagnosticsPath, JSON.stringify(diagnostics));
  await assert.rejects(assertReusableLocalTopology(options), /mismatched database layout/);
  await writeFile(diagnosticsPath, '{');
  await assert.rejects(assertReusableLocalTopology(options), /diagnostics are unreadable.*dev:reset/);
});

test('process tracker coalesces shutdown and terminates every tracked bootstrap child', async () => {
  const terminated = [];
  const tracker = createProcessTracker(async (child, signal) => {
    terminated.push([child.pid, signal]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    child.exitCode = 0;
    child.emit('exit', 0, null);
  });
  const first = Object.assign(new EventEmitter(), { pid: 101, exitCode: null, signalCode: null });
  const second = Object.assign(new EventEmitter(), { pid: 102, exitCode: null, signalCode: null });
  tracker.track(first);
  tracker.track(second);

  await Promise.all([tracker.terminateAll('SIGTERM'), tracker.terminateAll('SIGTERM')]);
  assert.deepEqual(terminated.sort((a, b) => a[0] - b[0]), [[101, 'SIGTERM'], [102, 'SIGTERM']]);
  assert.equal(tracker.size, 0);
});

test('captured bootstrap subprocess is tracked and abortable', async () => {
  const tracker = createProcessTracker();
  const running = runCaptured(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    label: 'bootstrap fixture',
    tracker,
  });
  for (let attempt = 0; attempt < 50 && tracker.size !== 1; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(tracker.size, 1);
  await tracker.terminateAll();
  await assert.rejects(running, /bootstrap fixture exited/);
  assert.equal(tracker.size, 0);
});

test('ephemeral bind collision selects a new port while a fixed port fails closed', async () => {
  const reserved = [41001, 41002];
  const launches = [];
  const retries = [];
  const result = await retryPortSelection(0, async (port) => {
    launches.push(port);
    if (port === 41001) {
      const error = new Error('Wrangler failed to bind');
      error.processOutput = 'listen EADDRINUSE: address already in use 127.0.0.1:41001';
      throw error;
    }
    return port;
  }, {
    reserve: async () => reserved.shift(),
    onRetry: async (_error, port) => retries.push(port),
  });
  assert.equal(result, 41002);
  assert.deepEqual(launches, [41001, 41002]);
  assert.deepEqual(retries, [41001]);

  let fixedAttempts = 0;
  await assert.rejects(retryPortSelection(8787, async () => {
    fixedAttempts += 1;
    const error = new Error('collision');
    error.processOutput = 'EADDRINUSE';
    throw error;
  }, { reserve: async () => 8787 }), /collision/);
  assert.equal(fixedAttempts, 1);
});

const READINESS_IDENTITY = Object.freeze({
  environmentId: 'local-fixture',
  deploymentRevision: 'local:artifact',
  indexMode: 'active',
  indexShardCount: 2,
  environmentNonce: 'fixture-generation-nonce',
  buildInputDigest: 'fixture-input-digest',
  artifactDigest: 'fixture-artifact-digest',
  migrationDigest: 'fixture-three-database-migration-digest',
  schemaDigest: 'fixture-three-database-schema-digest',
  pendingMigrations: 0,
  seedDigest: 'fixture-seed-digest',
});

test('local request failures retain the exact method, URL and nested transport cause without replay', async (t) => {
  const transport = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9857'), {
    code: 'ECONNREFUSED', syscall: 'connect', address: '127.0.0.1', port: 9857,
  });
  const failedFetch = new TypeError('fetch failed', { cause: transport });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests += 1;
    throw failedFetch;
  });
  const url = 'http://127.0.0.1:9857/api/v1/files/fixture/omp/session.jsonl';
  await assert.rejects(fetchEnvironmentText(url, {
    method: 'PUT', body: Buffer.from('private-request-body'),
    headers: { authorization: 'private-test-token', 'x-private-metadata': 'private-test-metadata' },
  }), (error) => {
    assert.equal(error.message, `PUT ${url} failed before receiving an HTTP response`);
    assert.equal(error.cause, failedFetch);
    assert.equal(error.cause.cause, transport);
    assert.equal(error.cause.cause.code, 'ECONNREFUSED');
    const diagnostics = inspect(error);
    assert.ok(!diagnostics.includes('private-test-token'));
    assert.ok(!diagnostics.includes('private-test-metadata'));
    assert.ok(!diagnostics.includes('private-request-body'));
    return true;
  });
  assert.equal(requests, 1, 'a failed local upload is not retried or replaced with a fallback');
});

test('a local response-body failure retains the received status, content type and original cause', async (t) => {
  const socketError = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
  const bodyError = new TypeError('terminated', { cause: socketError });
  const response = new Response('incomplete body', {
    status: 201, headers: { 'content-type': 'application/json' },
  });
  t.mock.method(response, 'text', async () => { throw bodyError; });
  t.mock.method(globalThis, 'fetch', async () => response);
  const url = 'http://127.0.0.1:9857/api/v1/files/fixture/omp/session.jsonl';
  await assert.rejects(fetchEnvironmentText(url, { method: 'PUT' }), (error) => {
    assert.equal(error.message, `PUT ${url} failed reading HTTP 201 response body (content-type: application/json)`);
    assert.equal(error.cause, bodyError);
    assert.equal(error.cause.cause, socketError);
    return true;
  });
});

test('local readiness rejects every stale identity field before accepting the full current identity', async (t) => {
  const child = { exitCode: null, signalCode: null };
  const current = { ok: true, environment: 'development', ...READINESS_IDENTITY };
  const requests = [];
  let staleField;
  let attempts;
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(url);
    attempts += 1;
    if (attempts === 1) {
      const value = current[staleField];
      return Response.json({ ...current, [staleField]: typeof value === 'number' ? value + 1 : `stale-${value}` });
    }
    return Response.json(current);
  });
  for (const field of Object.keys(READINESS_IDENTITY)) {
    staleField = field;
    attempts = 0;
    assert.deepEqual(await waitForReadiness('http://127.0.0.1:9857', READINESS_IDENTITY, child, 2000), current);
    assert.equal(attempts, 2, `${field} must match before readiness can succeed`);
  }
  assert.ok(requests.every((url) => url === 'http://127.0.0.1:9857/healthz'),
    'readiness probes only health; fixture uploads and DB checks stay in their existing phases');
});

test('local readiness timeout keeps the last failed request cause instead of only fetch failed', async (t) => {
  const transport = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
  const failedFetch = new TypeError('fetch failed', { cause: transport });
  let now = 0;
  let requests = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => {
    requests += 1;
    now = 1000;
    throw failedFetch;
  });
  await assert.rejects(waitForReadiness(
    'http://127.0.0.1:9857', READINESS_IDENTITY, { exitCode: null, signalCode: null }, 1000,
  ), (error) => {
    assert.match(error.message, /Wrangler readiness timed out after 1000ms/);
    assert.match(error.message, /GET http:\/\/127\.0\.0\.1:9857\/healthz failed before receiving an HTTP response/);
    assert.equal(error.cause.cause, failedFetch);
    assert.equal(error.cause.cause.cause, transport);
    return true;
  });
  assert.equal(requests, 1);
});

const LOCAL_SEED_ORIGIN = 'http://127.0.0.1:9857';
const LOCAL_ASSET_URL = `${LOCAL_SEED_ORIGIN}/api/v1/files/${SYNTHETIC_EXPECTATIONS.machine}/${SYNTHETIC_EXPECTATIONS.store}/${encodeURIComponent(SYNTHETIC_EXPECTATIONS.externalRelpath)}`;

test('local seed reports the failed fixture PUT and its nested cause without another upload or search', async (t) => {
  const transport = Object.assign(new Error('invalid content-length header'), {
    code: 'UND_ERR_INVALID_ARG',
  });
  const failedFetch = new TypeError('fetch failed', { cause: transport });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, ...options });
    throw failedFetch;
  });
  const seed = await syntheticSeedManifest();
  await assert.rejects(seedSynthetic(LOCAL_SEED_ORIGIN, 1000, seed.digest), (error) => {
    assert.equal(error.message, `PUT ${LOCAL_ASSET_URL} failed before receiving an HTTP response`);
    assert.equal(error.cause, failedFetch);
    assert.equal(error.cause.cause, transport);
    return true;
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'PUT');
  assert.equal(requests[0].url, LOCAL_ASSET_URL);
  const headers = new Headers(requests[0].headers);
  assert.equal(headers.get('x-dev-machine'), SYNTHETIC_EXPECTATIONS.machine);
  assert.equal(headers.get('x-content-hash'), `sha256:${SYNTHETIC_EXPECTATIONS.externalDigest}`);
  assert.equal(headers.get('content-length'), null, 'the fetch transport owns the computed wire byte count');
  const assetSource = Buffer.from((await readFile(
    new URL('./fixtures/local/fixture-external.png.base64', import.meta.url), 'utf8',
  )).trim(), 'base64');
  assert.deepEqual(requests[0].body, assetSource, 'the first request sends every original PNG byte');
  assert.equal(headers.get('authorization'), null);
});

test('local seed retains a failed upload response-body status and cannot continue seeding', async (t) => {
  const transport = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
  const bodyError = new TypeError('terminated', { cause: transport });
  const response = new Response('incomplete created response', {
    status: 201, headers: { 'content-type': 'application/json' },
  });
  t.mock.method(response, 'text', async () => { throw bodyError; });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests += 1;
    return response;
  });
  await assert.rejects(seedSynthetic(LOCAL_SEED_ORIGIN), (error) => {
    assert.equal(error.message, `PUT ${LOCAL_ASSET_URL} failed reading HTTP 201 response body (content-type: application/json)`);
    assert.equal(error.cause, bodyError);
    assert.equal(error.cause.cause, transport);
    return true;
  });
  assert.equal(requests, 1, 'a status 201 with an unreadable body is not a successfully seeded fixture');
});

test('current health followed by successful local seed still uploads exact fixtures and reads every indexed session', async (t) => {
  const seed = await syntheticSeedManifest();
  const expected = { ...READINESS_IDENTITY, seedDigest: seed.digest };
  const current = { ok: true, environment: 'development', ...expected };
  const indexed = new Map([
    [SYNTHETIC_EXPECTATIONS.searchPhrase, { sessionId: SYNTHETIC_EXPECTATIONS.primarySessionId, kind: 'main' }],
    ['stable second page', { sessionId: SYNTHETIC_EXPECTATIONS.pagerSessionId, kind: 'main' }],
    ...SYNTHETIC_EXPECTATIONS.costFixtures.map((fixture) => [fixture.marker, fixture]),
  ]);
  const requests = [];
  const responses = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    requests.push({ url, ...options });
    const target = new URL(url);
    assert.equal(target.origin, LOCAL_SEED_ORIGIN, 'neither local readiness nor seed may contact production');
    let response;
    if (target.pathname === '/healthz') {
      response = Response.json(current);
    } else if (options.method === 'PUT') {
      assert.ok(target.pathname.startsWith('/api/v1/files/'));
      const headers = new Headers(options.headers);
      assert.equal(headers.get('x-dev-machine'), SYNTHETIC_EXPECTATIONS.machine);
      assert.equal(headers.get('authorization'), null);
      assert.equal(headers.get('content-length'), null, 'finite Buffer uploads delegate Content-Length to fetch');
      assert.ok(Buffer.isBuffer(options.body));
      assert.equal(headers.get('x-content-hash'), `sha256:${createHash('sha256').update(options.body).digest('hex')}`);
      response = new Response('created', { status: 201 });
    } else {
      assert.equal(target.pathname, '/api/v1/search');
      assert.equal(target.searchParams.get('machine'), SYNTHETIC_EXPECTATIONS.machine);
      const fixture = indexed.get(target.searchParams.get('q'));
      assert.ok(fixture, `unexpected indexed fixture probe ${url}`);
      assert.equal(target.searchParams.get('subagent'), fixture.kind === 'subagent' ? 'yes' : null);
      response = Response.json({ hits: [{ session_id: fixture.sessionId }] });
    }
    responses.push(response);
    return response;
  });
  assert.deepEqual(await waitForReadiness(
    LOCAL_SEED_ORIGIN, expected, { exitCode: null, signalCode: null }, 1000,
  ), current);
  assert.equal(await seedSynthetic(LOCAL_SEED_ORIGIN, 1000, seed.digest), SYNTHETIC_EXPECTATIONS);
  assert.equal(requests[0].url, `${LOCAL_SEED_ORIGIN}/healthz`);
  const uploads = requests.filter((request) => request.method === 'PUT');
  assert.equal(uploads.length, 4 + SYNTHETIC_EXPECTATIONS.costFixtures.length);
  assert.equal(uploads[0].url, LOCAL_ASSET_URL);
  assert.deepEqual(uploads.map((request) => decodeURIComponent(new URL(request.url).pathname)), [
    `/api/v1/files/${SYNTHETIC_EXPECTATIONS.machine}/${SYNTHETIC_EXPECTATIONS.store}/${SYNTHETIC_EXPECTATIONS.externalRelpath}`,
    `/api/v1/files/${SYNTHETIC_EXPECTATIONS.machine}/${SYNTHETIC_EXPECTATIONS.store}/${SYNTHETIC_EXPECTATIONS.primaryRelpath}`,
    `/api/v1/files/${SYNTHETIC_EXPECTATIONS.machine}/${SYNTHETIC_EXPECTATIONS.store}/${SYNTHETIC_EXPECTATIONS.pagerRelpath}`,
    `/api/v1/files/${SYNTHETIC_EXPECTATIONS.machine}/${SYNTHETIC_EXPECTATIONS.skillStore}/${SYNTHETIC_EXPECTATIONS.skillRelpath}`,
    ...SYNTHETIC_EXPECTATIONS.costFixtures.map((fixture) =>
      `/api/v1/files/${SYNTHETIC_EXPECTATIONS.machine}/${fixture.store}/${fixture.relpath}`),
  ]);
  assert.equal(requests.filter((request) => new URL(request.url).pathname === '/api/v1/search').length, indexed.size);
  assert.ok(responses.every((response) => response.bodyUsed), 'health, uploads and search responses are consumed');
});

test('a local seed HTTP rejection reports its URL and status without logging the response body', async (t) => {
  const privateBody = 'fixture response body that must not be logged';
  const response = new Response(privateBody, { status: 503 });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests += 1;
    return response;
  });
  await assert.rejects(seedSynthetic(LOCAL_SEED_ORIGIN), (error) => {
    assert.equal(error.message, `synthetic upload PUT ${LOCAL_ASSET_URL} failed (HTTP 503)`);
    assert.ok(!error.message.includes(privateBody));
    return true;
  });
  assert.equal(requests, 1, 'an HTTP rejection does not gain a new upload retry');
  assert.equal(response.bodyUsed, true, 'the rejected response still has its body consumed');
});

test('local seed indexing timeout preserves the exact failed search and nested cause', async (t) => {
  const transport = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
  const failedFetch = new TypeError('fetch failed', { cause: transport });
  let now = 0;
  const requests = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    requests.push({ url, ...options });
    if (options.method === 'PUT') return new Response('created', { status: 200 });
    now = 1000;
    throw failedFetch;
  });
  await assert.rejects(seedSynthetic(LOCAL_SEED_ORIGIN, 1000), (error) => {
    assert.match(error.message, /synthetic session .* was not indexed before timeout/);
    assert.match(error.message, /GET http:\/\/127\.0\.0\.1:9857\/api\/v1\/search\?q=saffron\+telescope/);
    assert.equal(error.cause.cause, failedFetch);
    assert.equal(error.cause.cause.cause, transport);
    return true;
  });
  const searches = requests.filter((request) => request.method !== 'PUT');
  assert.equal(searches.length, 1);
  assert.equal(requests.filter((request) => request.method === 'PUT').length, 4 + SYNTHETIC_EXPECTATIONS.costFixtures.length);
  assert.equal(new URL(searches[0].url).searchParams.get('machine'), SYNTHETIC_EXPECTATIONS.machine);
});
