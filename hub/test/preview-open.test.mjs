import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  browserLauncher,
  assertSupportedNode,
  main,
  parsePreviewOpenArguments,
  previewUrl,
} from '../scripts/preview-open.mjs';

test('constructs the stable HTTPS front-door URL for a valid PR', () => {
  assert.deepEqual(parsePreviewOpenArguments(['--pr', '42']), { pr: 42, printOnly: false });
  assert.equal(previewUrl(42), 'https://pr-42-preview.sessions.vza.net');
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

test('print-only prints the URL and never launches a browser', async () => {
  const output = [];
  let launches = 0;
  const url = await main(['--pr', '7', '--print-only'], {
    log: (line) => output.push(line),
    spawnProcess: () => {
      launches += 1;
      throw new Error('browser launch must not run');
    },
  });

  assert.equal(url, 'https://pr-7-preview.sessions.vza.net');
  assert.deepEqual(output, [url]);
  assert.equal(launches, 0);
});

test('uses direct argument-array launchers on Windows, macOS, and Linux', () => {
  const url = 'https://pr-9-preview.sessions.vza.net';
  assert.deepEqual(browserLauncher(url, 'win32'), { command: 'explorer.exe', args: [url] });
  assert.deepEqual(browserLauncher(url, 'darwin'), { command: 'open', args: [url] });
  assert.deepEqual(browserLauncher(url, 'linux'), { command: 'xdg-open', args: [url] });
  assert.throws(() => browserLauncher(url, 'freebsd'), /unsupported platform: freebsd/);
});

test('default command prints and opens the exact URL without a shell', async () => {
  const calls = [];
  const output = [];
  const child = new EventEmitter();
  let unrefCalled = false;
  child.unref = () => { unrefCalled = true; };
  const opening = main(['--pr', '11'], {
    log: (line) => output.push(line),
    platform: 'linux',
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });

  await opening;
  assert.deepEqual(output, ['https://pr-11-preview.sessions.vza.net']);
  assert.deepEqual(calls, [{
    command: 'xdg-open',
    args: ['https://pr-11-preview.sessions.vza.net'],
    options: { detached: true, shell: false, stdio: 'ignore', windowsHide: true },
  }]);
  assert.equal(unrefCalled, true);
});
