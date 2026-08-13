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
} from '../scripts/preview-open.mjs';
import { previewBearerToken } from '../../infra/cf/preview-trust.mjs';

const SEED = 's'.repeat(48);

test('constructs the stable tokenized workers.dev URL for a valid PR', () => {
  assert.deepEqual(parsePreviewOpenArguments(['--pr', '42']), { pr: 42, printOnly: false });
  assert.equal(previewUrl(42), 'https://pr-42-app.agent-sessions-nonproduction.workers.dev');
  assert.equal(
    previewUrl(42, SEED),
    `https://pr-42-app.agent-sessions-nonproduction.workers.dev/?token=${derivePreviewBearer(SEED, 42)}`,
  );
});

test('the locally derived bearer matches the provisioning derivation exactly', () => {
  assert.equal(derivePreviewBearer(SEED, 42), previewBearerToken(SEED, 42));
  assert.notEqual(derivePreviewBearer(SEED, 42), derivePreviewBearer(SEED, 43));
  assert.throws(() => derivePreviewBearer('short', 42), /at least 32 characters/);
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

test('print-only prints the tokenized URL and never launches a browser', async () => {
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

  assert.equal(url, previewUrl(7, SEED));
  assert.deepEqual(output, [url]);
  assert.equal(launches, 0);
});

test('a missing seed warns and prints the bare URL', async () => {
  const output = [];
  const warnings = [];
  const url = await main(['--pr', '7', '--print-only'], {
    seed: null,
    log: (line) => output.push(line),
    warn: (line) => warnings.push(line),
  });
  assert.equal(url, 'https://pr-7-app.agent-sessions-nonproduction.workers.dev');
  assert.deepEqual(output, [url]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no preview seed found/);
});

test('uses direct argument-array launchers on Windows, macOS, and Linux', () => {
  const url = 'https://pr-9-app.agent-sessions-nonproduction.workers.dev';
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
