import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
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
test('PID reuse with a different start identity does not pin a stale environment', async (t) => {
  const stateDir = await temporaryState(t);
  const firstOwner = await acquireOwnership(stateDir, 'old-generation', {
    inspectProcess: (pid) => pid === process.pid ? 'old-owner-start' : null,
  });
  await recordRuntime(stateDir, firstOwner, 424243, () => 'old-child-start');

  const replacement = await acquireOwnership(stateDir, 'new-generation', {
    inspectProcess: (pid) => pid === process.pid ? 'new-owner-start' : pid === 424243 ? 'reused-pid-start' : null,
  });
  assert.equal(replacement.nonce, 'new-generation');
  assert.equal(replacement.processStartIdentity, 'new-owner-start');
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

test('artifact and migration changes independently change journal and deployment identities', () => {
  const artifact = 'a'.repeat(64);
  const migration = 'b'.repeat(64);
  const original = migrationDeploymentIdentity({ target: 'local', stateName: 'default', artifactDigest: artifact, migrationDigest: migration });
  const migrationOnly = migrationDeploymentIdentity({ target: 'local', stateName: 'default', artifactDigest: artifact, migrationDigest: 'c'.repeat(64) });
  const artifactOnly = migrationDeploymentIdentity({ target: 'local', stateName: 'default', artifactDigest: 'd'.repeat(64), migrationDigest: migration });

  assert.notEqual(original.journalName, migrationOnly.journalName);
  assert.notEqual(original.deploymentId, migrationOnly.deploymentId);
  assert.notEqual(original.journalName, artifactOnly.journalName);
  assert.notEqual(original.deploymentId, artifactOnly.deploymentId);
  assert.match(original.journalName, new RegExp(`^${artifact}-${migration}\\.json$`));
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
