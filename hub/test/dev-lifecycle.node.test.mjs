import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
