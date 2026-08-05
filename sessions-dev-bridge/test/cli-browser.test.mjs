import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { openSystemBrowser } from '../src/browser-authorization.mjs';
import { runCli } from '../src/cli.mjs';
import { parseArguments } from '../src/cli-arguments.mjs';

const authorizationUrl = 'https://sessions.vza.net/debug/authorize';
const digest = (character) => character.repeat(64);

function successfulLauncher(calls) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.unref = () => { calls.unref += 1; };
    calls.invocations.push({ command, args, options });
    setImmediate(() => child.emit('spawn'));
    return child;
  };
}

test('system browser launchers use platform commands without a shell', async (t) => {
  const cases = [
    { platform: 'linux', command: '/usr/bin/xdg-open', args: [authorizationUrl] },
    { platform: 'darwin', command: '/usr/bin/open', args: [authorizationUrl] },
    { platform: 'win32', command: 'C:\\Windows\\System32\\rundll32.exe', args: ['url.dll,FileProtocolHandler', authorizationUrl] },
  ];
  for (const expected of cases) {
    await t.test(expected.platform, async () => {
      const calls = { invocations: [], unref: 0 };
      await openSystemBrowser(authorizationUrl, {
        platform: expected.platform,
        windowsDirectory: 'C:\\Windows',
        launcher: successfulLauncher(calls),
        launchProbeMs: 0,
      });
      assert.deepEqual(calls.invocations, [{
        command: expected.command,
        args: expected.args,
        options: { detached: true, windowsHide: true, stdio: 'ignore', shell: false },
      }]);
      assert.equal(calls.unref, 1);
    });
  }
});

test('Windows browser launch rejects UNC system directories', async () => {
  await assert.rejects(
    openSystemBrowser(authorizationUrl, {
      platform: 'win32',
      windowsDirectory: '//server/share',
      launcher: () => assert.fail('UNC launcher must not run'),
    }),
    /absolute local path/,
  );
});

test('system browser launch rejects launcher spawn errors', async () => {
  let unrefCalled = false;
  const missingLauncher = () => {
    const child = new EventEmitter();
    child.unref = () => { unrefCalled = true; };
    setImmediate(() => {
      const error = Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' });
      child.emit('error', error);
    });
    return child;
  };
  await assert.rejects(
    openSystemBrowser(authorizationUrl, { platform: 'linux', launcher: missingLauncher }),
    (error) => error.code === 'ENOENT',
  );
  assert.equal(unrefCalled, false);
});

test('system browser launch rejects an immediate nonzero launcher exit', async () => {
  const failingLauncher = () => {
    const child = new EventEmitter();
    child.unref = () => {};
    setImmediate(() => {
      child.emit('spawn');
      child.emit('exit', 3, null);
    });
    return child;
  };
  await assert.rejects(
    openSystemBrowser(authorizationUrl, {
      platform: 'linux',
      launcher: failingLauncher,
      launchProbeMs: 100,
    }),
    /code 3/,
  );
});

test('system browser launch resolves on an immediate zero exit', async () => {
  const quickLauncher = () => {
    const child = new EventEmitter();
    child.unref = () => {};
    setImmediate(() => {
      child.emit('spawn');
      child.emit('exit', 0, null);
    });
    return child;
  };
  await openSystemBrowser(authorizationUrl, {
    platform: 'linux',
    launcher: quickLauncher,
    launchProbeMs: 60_000,
  });
});

test('remote CLI verifies provenance and never loads local dependencies', async () => {
  const events = [];
  const output = [];
  const manifest = Object.freeze({ marker: 'verified manifest' });
  const destination = Object.freeze({
    pr: 84,
    target: 'pr-84',
    attestation: Object.freeze({ payload: 'initial' }),
  });
  const extendedAttestation = Object.freeze({ payload: 'extended' });
  const remoteDestinations = {
    async create(request) {
      events.push(['create', request]);
      return destination;
    },
    async extend(receivedDestination, inventoryDigest) {
      assert.equal(receivedDestination, destination);
      assert.equal(inventoryDigest, digest('b'));
      events.push(['extend']);
      return extendedAttestation;
    },
    async transfer(request) {
      assert.equal(request.destination, destination);
      assert.equal(request.attestation, extendedAttestation);
      assert.equal(request.manifest, manifest);
      events.push(['transfer']);
    },
  };
  await runCli(['pull', '--session', 'session-1', '--target', 'pr-84'], {
    async verifyRelease() {
      events.push(['verify-release']);
      return Object.freeze({ digest: digest('a') });
    },
    parseArguments(argv) {
      events.push(['parse']);
      return parseArguments(argv);
    },
    async loadProductionManifestKeys() {
      events.push(['load-keys']);
      return Object.freeze({ keys: [Object.freeze({ kty: 'EC' })] });
    },
    async loadRemoteDestinations() {
      events.push(['load-remote']);
      return remoteDestinations;
    },
    loadLocalDependencies: async () => assert.fail('remote CLI loaded local dependencies'),
    authorization: {
      async prepare(request) {
        assert.equal(request.destinationAttestation, destination.attestation);
        events.push(['prepare']);
        return { jobCapability: 'am9i', codeVerifier: 'dmVyaWZpZXI' };
      },
      async finalize(request) {
        assert.equal(request.destinationAttestation, extendedAttestation);
        events.push(['finalize']);
        return { authorizationCode: 'Y29kZQ' };
      },
      async abort() { assert.fail('successful remote routing must not abort'); },
    },
    production: {
      async getPrepareJob() {
        events.push(['poll']);
        return {
          status: 'awaiting_consent',
          inventoryDigest: digest('b'),
          totalSize: 0,
          objectCount: 0,
          approvalUrl: 'https://sessions.vza.net/debug/approve',
        };
      },
      async exchangeAuthorization(code, verifier) {
        assert.equal(code, 'Y29kZQ');
        assert.equal(verifier, 'dmVyaWZpZXI');
        events.push(['exchange']);
        return { manifest, exchangeCapability: 'ZXhjaGFuZ2U' };
      },
    },
    snapshotVerifier: {
      verifyManifest(receivedManifest, expected) {
        assert.equal(receivedManifest, manifest);
        assert.deepEqual(expected, {
          sessionId: 'session-1',
          inventoryDigest: digest('b'),
          totalSize: 0,
          objectCount: 0,
        });
        events.push(['verify-snapshot']);
      },
    },
    stdout: { write(value) { output.push(value); } },
    stderr: { write() {} },
  });

  assert.deepEqual(output, ['Session session-1 imported into pr-84.\n']);
  assert.deepEqual(events.map(([event]) => event), [
    'verify-release',
    'parse',
    'load-keys',
    'load-remote',
    'create',
    'prepare',
    'poll',
    'extend',
    'finalize',
    'exchange',
    'verify-snapshot',
    'transfer',
  ]);
});
