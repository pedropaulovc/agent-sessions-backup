import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserLauncher,
  assertSupportedNode,
  derivePreviewBearer,
  main,
  parsePreviewOpenArguments,
  previewSeedPath,
  previewUrl,
  readPreviewSeed,
  wslPreviewSeeds,
} from '../scripts/preview-open.mjs';
import { previewBearerToken } from '../../infra/cf/preview-trust.mjs';

const SEED = 's'.repeat(48);

test('constructs the shared PPE passkey URL for a valid PR', () => {
  assert.deepEqual(parsePreviewOpenArguments(['--pr', '42']), { pr: 42, printOnly: false });
  assert.equal(previewUrl(42), 'https://sessions.ppe.vza.net/pr?id=42');
});

test('the locally derived bearer matches the provisioning derivation exactly', () => {
  assert.equal(derivePreviewBearer(SEED, 42), previewBearerToken(SEED, 42));
  assert.notEqual(derivePreviewBearer(SEED, 42), derivePreviewBearer(SEED, 43));
  assert.throws(() => derivePreviewBearer('short', 42), /at least 32 characters/);
});

test('derivation rejects an unsafe or non-positive PR number outright', () => {
  // Number('9007199254740993') silently rounds — a caller that skipped its own
  // validation must not derive a bearer (and a host) for a DIFFERENT PR.
  for (const pr of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number('9007199254740993'), NaN, '42']) {
    assert.throws(() => derivePreviewBearer(SEED, pr), /safe positive integer/, String(pr));
  }
});

test('seed resolution prefers the environment and falls back to the seed file', () => {
  assert.equal(readPreviewSeed({ PREVIEW_BEARER_SEED: ` ${SEED} ` }), SEED);
  assert.equal(
    readPreviewSeed({}, (path) => {
      assert.equal(path, previewSeedPath());
      return `${SEED}\n`;
    }),
    SEED,
  );
  assert.equal(readPreviewSeed({}, () => { throw new Error('ENOENT'); }), null);
});

test('under WSL the seed is found on the Windows side, where it actually lives', () => {
  const wsl = { WSL_DISTRO_NAME: 'Ubuntu' };
  const missingHome = (path) => { if (path === previewSeedPath()) throw new Error('ENOENT'); return `${SEED}\n`; };
  const ownProfile = () => ['/mnt/c/Users/pedro/.config/agent-sessions/preview-seed'];

  assert.equal(readPreviewSeed(wsl, missingHome, ownProfile, 'pedro'), SEED);
  // The same profile mounted on two drives is not ambiguous.
  assert.equal(
    readPreviewSeed(wsl, missingHome, () => [
      '/mnt/c/Users/pedro/.config/agent-sessions/preview-seed',
      '/mnt/d/Users/pedro/.config/agent-sessions/preview-seed',
    ], 'pedro'),
    SEED,
  );
  // Without WSL the mounts are not consulted at all.
  assert.equal(readPreviewSeed({}, missingHome, ownProfile, 'pedro'), null);
  // Too short to derive a bearer, so it is not a seed.
  const shortOnMounts = (path) => {
    if (path === previewSeedPath()) throw new Error('ENOENT');
    return 'short';
  };
  assert.equal(readPreviewSeed(wsl, shortOnMounts, ownProfile, 'pedro'), null);
});

test('never reads a seed out of another Windows profile', () => {
  // A box can carry several readable profiles (a second user, sandbox accounts). Deriving a
  // bearer from their seed would be borrowing their credential, not finding ours.
  const wsl = { WSL_DISTRO_NAME: 'Ubuntu' };
  const missingHome = (path) => { if (path === previewSeedPath()) throw new Error('ENOENT'); return `${SEED}\n`; };
  const foreign = () => [
    '/mnt/c/Users/CodexSandboxOffline/.config/agent-sessions/preview-seed',
    '/mnt/c/Users/WsiAccount/.config/agent-sessions/preview-seed',
  ];

  assert.deepEqual(wslPreviewSeeds(wsl, missingHome, foreign, 'pedro'), []);
  assert.equal(readPreviewSeed(wsl, missingHome, foreign, 'pedro'), null);
});

test('refuses to guess when the caller\'s own profiles hold different seeds', () => {
  // Guessing here publishes a bearer nobody else derives: every open preview URL breaks at once.
  const seeds = {
    '/mnt/c/Users/pedro/.config/agent-sessions/preview-seed': 'a'.repeat(48),
    '/mnt/d/Users/pedro/.config/agent-sessions/preview-seed': 'b'.repeat(48),
  };
  assert.throws(
    () => readPreviewSeed(
      { WSL_DISTRO_NAME: 'Ubuntu' },
      (path) => seeds[path] ?? (() => { throw new Error('ENOENT'); })(),
      () => Object.keys(seeds),
      'pedro',
    ),
    /2 different preview seeds/,
  );
});

test('enforces Node 22.13 or newer', () => {
  assert.doesNotThrow(() => assertSupportedNode('22.13.0'));
  assert.doesNotThrow(() => assertSupportedNode('24.0.0'));
  assert.throws(() => assertSupportedNode('22.12.9'), /Node >=22\.13\.0 is required/);
  assert.throws(() => assertSupportedNode('20.20.0'), /Node >=22\.13\.0 is required/);
});

test('rejects missing, repeated, unknown, and invalid PR arguments', () => {
  assert.throws(() => parsePreviewOpenArguments([]), /missing required option: --pr/);
  assert.throws(() => parsePreviewOpenArguments(['--pr']), /missing value for --pr/);
  assert.throws(() => parsePreviewOpenArguments(['--pr', '--print-only']), /missing value for --pr/);
  assert.throws(() => parsePreviewOpenArguments(['--pr', '1', '--pr', '2']), /duplicate option: --pr/);
  assert.throws(() => parsePreviewOpenArguments(['--pr', '1', '--print-only', '--print-only']), /duplicate option: --print-only/);
  assert.throws(() => parsePreviewOpenArguments(['--number', '1']), /unknown option: --number/);
  for (const value of ['0', '-1', '1.5', '01', '1x', String(Number.MAX_SAFE_INTEGER + 1)]) {
    assert.throws(() => parsePreviewOpenArguments(['--pr', value]), /--pr must be/);
  }
});

test('print-only prints the passkey URL and never launches a browser', async () => {
  const output = [];
  let launches = 0;
  const url = await main(['--pr', '7', '--print-only'], {
    seed: SEED,
    log: (line) => output.push(line),
    spawnProcess: () => {
      launches += 1;
      throw new Error('browser launch must not run');
    },
  });

  assert.equal(url, previewUrl(7));
  assert.deepEqual(output, [url]);
  assert.equal(launches, 0);
});

test('the shared PPE URL does not depend on a local bearer seed', async () => {
  const output = [];
  const url = await main(['--pr', '7', '--print-only'], {
    seed: null,
    log: (line) => output.push(line),
  });
  assert.equal(url, 'https://sessions.ppe.vza.net/pr?id=7');
  assert.deepEqual(output, [url]);
});

test('uses direct argument-array launchers on Windows, macOS, and Linux', () => {
  const url = 'https://sessions.ppe.vza.net/pr?id=9';
  assert.deepEqual(browserLauncher(url, 'win32'), { command: 'explorer.exe', args: [url] });
  assert.deepEqual(browserLauncher(url, 'darwin'), { command: 'open', args: [url] });
  assert.deepEqual(browserLauncher(url, 'linux'), { command: 'xdg-open', args: [url] });
  assert.throws(() => browserLauncher(url, 'freebsd'), /unsupported platform: freebsd/);
});

test('default command prints and opens the exact URL without a shell', async () => {
  const output = [];
  const launched = [];
  const url = await main(['--pr', '11'], {
    seed: SEED,
    log: (line) => output.push(line),
    platform: 'linux',
    spawnProcess: (command, args, options) => {
      launched.push({ command, args, options });
      const child = {
        once(event, handler) {
          if (event === 'spawn') queueMicrotask(handler);
          return child;
        },
        unref() {},
      };
      return child;
    },
  });

  assert.deepEqual(output, [url]);
  assert.equal(launched.length, 1);
  assert.equal(launched[0].command, 'xdg-open');
  assert.deepEqual(launched[0].args, [url]);
  assert.equal(launched[0].options.shell, false);
});
