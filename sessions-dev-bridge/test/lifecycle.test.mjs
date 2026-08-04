import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runProcess } from '../src/secure.mjs';
import { BrowserAuthorization } from '../src/browser-authorization.mjs';
import { SessionsDevBridge } from '../src/bridge.mjs';
import { StateStore } from '../src/state.mjs';
import { parseArguments } from '../src/cli-arguments.mjs';
import { validateProductionManifestKeys } from '../src/production-keys.mjs';
import { SnapshotVerifier } from '../src/snapshot.mjs';

const digest = (character) => character.repeat(64);
const release = Object.freeze({ digest: digest('a') });

test('bounds subprocess runtime and reports stdin pipe failures', async () => {
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { timeoutMs: 30 }),
    /timed out after 30ms/,
  );
  await assert.rejects(
    runProcess('sessions-dev-bridge-command-that-does-not-exist', [], { timeoutMs: 2_000 }),
    /ENOENT/,
  );
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'process.exit(0)'], { stdin: Buffer.alloc(8 * 1024 * 1024), timeoutMs: 2_000 }),
    /stdin failed/,
  );
});

test('aborting a pending browser authorization closes an idle loopback socket', async () => {
  let callbackUrl;
  const authorization = new BrowserAuthorization({ openBrowser: async () => {}, timeoutMs: 2_000 });
  const prepared = await authorization.prepare({
    sessionId: 'session-1',
    destinationAttestation: { payload: 'attestation' },
    production: {
      browserBase: 'https://sessions.vza.net',
      prepareBrowserUrl(request) {
        callbackUrl = request.callback;
        setImmediate(() => void fetch(`${callbackUrl}?code=Y29kZQ&state=c3RhdGU`));
        return 'https://sessions.vza.net/debug/prepare';
      },
      async exchangePrepare(code, verifier) {
        assert.equal(code, 'Y29kZQ');
        assert.match(verifier, /^[A-Za-z0-9_-]+$/);
        return { jobCapability: 'am9i' };
      },
    },
  });
  const callback = new URL(callbackUrl);
  const socket = createConnection({ host: callback.hostname, port: Number(callback.port) });
  await once(socket, 'connect');
  const socketClosed = once(socket, 'close');
  await authorization.abort(prepared.jobCapability);
  await socketClosed;
  await authorization.abort(prepared.jobCapability);
});

test('local and remote pull failures abort prepared browser authorizations', async () => {
  const localEvents = [];
  const local = new SessionsDevBridge({
    release,
    state: {
      async loadEnrollment() { return { keyProvider: 'windows-cng-tpm' }; },
      async reserveCounter() { return { deviceId: 'device-1', keyRef: 'key-1', keyProvider: 'windows-cng-tpm', counter: 1 }; },
    },
    keyProvider: {
      async available() { return true; },
      async sign() { return Buffer.alloc(64); },
    },
    buildDriver: {
      async build() { return { bundleDigest: digest('b'), inputDigest: digest('c') }; },
    },
    localEnvironmentFactory: {
      async start() {
        return {
          assertAttested() {},
          async dispose() { localEvents.push('disposed'); },
        };
      },
    },
    authorization: {
      async prepare() { return { jobCapability: 'am9i', codeVerifier: 'dmVyaWZpZXI' }; },
      async abort(capability) { localEvents.push(`aborted:${capability}`); },
    },
    production: {
      async getPrepareJob() { throw new Error('prepare polling failed'); },
    },
    clock: () => Date.parse('2026-08-03T12:00:00.000Z'),
  });
  await assert.rejects(local.pull({ sessionId: 'session-1', target: 'local', checkout: '.' }), /prepare polling failed/);
  assert.deepEqual(localEvents, ['aborted:am9i', 'disposed']);

  const remoteEvents = [];
  const remote = new SessionsDevBridge({
    release,
    remoteDestinations: {
      async create() { return { pr: 84, target: 'pr-84', attestation: { payload: 'remote' } }; },
    },
    authorization: {
      async prepare() { return { jobCapability: 'cmVtb3Rl', codeVerifier: 'dmVyaWZpZXI' }; },
      async abort(capability) { remoteEvents.push(capability); },
    },
    production: {
      async getPrepareJob() { throw new Error('remote polling failed'); },
    },
  });
  await assert.rejects(remote.pull({ sessionId: 'session-1', target: 'pr-84' }), /remote polling failed/);
  assert.deepEqual(remoteEvents, ['cmVtb3Rl']);
});

test('state locks recover dead owners and identify a verifiably live lock path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-state-lock-'));
  const lockPath = join(directory, '.lock');
  const enrollment = {
    format: 1,
    deviceId: 'device-1',
    deviceLabel: 'Developer device',
    keyProvider: 'windows-cng-tpm',
    keyRef: 'sessions-dev-bridge-key',
    publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'eA', y: 'eQ' },
    scope: 'local-destination-attest',
    releaseDigest: digest('a'),
    counter: 0,
    expiresAt: Date.now() + 60_000,
  };
  try {
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(join(lockPath, 'owner.json'), `${JSON.stringify({ format: 1, pid: 12345, acquiredAt: Date.now(), token: 'a'.repeat(32) })}\n`);
    const recovering = new StateStore(directory, { processIsAlive: () => false });
    await recovering.saveEnrollment(enrollment);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'enrollment.json'), 'utf8')), enrollment);
    await assert.rejects(lstat(lockPath), { code: 'ENOENT' });

    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(join(lockPath, 'owner.json'), `${JSON.stringify({ format: 1, pid: process.pid, acquiredAt: Date.now(), token: 'b'.repeat(32) })}\n`);
    const contending = new StateStore(directory, { lockTimeoutMs: 0, processIsAlive: () => true });
    await assert.rejects(contending.saveEnrollment(enrollment), (error) => {
      assert.match(error.message, /another bridge process owns/);
      assert.equal(error.message.includes(lockPath), true);
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI flags are single-use even when checkout resolves to the default', () => {
  assert.throws(() => parseArguments(['enroll', '--device-label', 'one', '--device-label', 'two']), /usage:/);
  assert.throws(() => parseArguments(['pull', '--session', 's', '--target', 'local', '--checkout', '.', '--checkout', 'other']), /usage:/);
  assert.throws(() => parseArguments(['pull', '--session', 's', '--session', 'other', '--target', 'local']), /usage:/);
  assert.throws(() => parseArguments(['pull', '--session', 's', '--target', 'local', '--target', 'pr-84']), /usage:/);
});

test('empty production verifier key sets fail closed', () => {
  assert.throws(() => validateProductionManifestKeys({ keys: [] }), /no protected production manifest verification keys/);
  assert.throws(() => new SnapshotVerifier([]), /no protected production manifest verification keys/);
});
