import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { EmbeddedBuildDriver } from '../src/local-build.mjs';

const execute = promisify(execFile);

async function git(cwd, args) {
  await execute('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
    },
  });
}

async function fixture(t, { checkoutDirectory = '', sourceNames = [] } = {}) {
  const repository = await mkdtemp(join(tmpdir(), 'bridge-local-build-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const checkout = checkoutDirectory ? join(repository, checkoutDirectory) : repository;
  const source = join(checkout, 'hub', 'src');
  await mkdir(source, { recursive: true });
  await mkdir(join(checkout, 'hub', 'migrations'), { recursive: true });
  await writeFile(join(checkout, '.gitignore'), 'hub/src/ignored/\n');
  await writeFile(join(checkout, 'hub', 'package.json'), '{"name":"local-build-fixture","private":true}\n');
  await writeFile(join(checkout, 'hub', 'package-lock.json'), '{"lockfileVersion":3}\n');
  await writeFile(join(checkout, 'hub', 'migrations', '0001_init.sql'), 'CREATE TABLE fixture (id INTEGER PRIMARY KEY);\n');
  for (const name of sourceNames) await writeFile(join(source, name), 'export const value = 1;\n');
  await writeFile(join(source, 'index.ts'), entrySource(sourceNames));
  await git(repository, ['init', '--quiet']);
  await git(repository, ['add', '.']);
  await git(repository, [
    '-c', 'user.name=Local Build Fixture',
    '-c', 'user.email=fixture@example.test',
    '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', 'fixture',
  ]);
  return { repository, checkout, source };
}

function entrySource(sourceNames) {
  const imports = sourceNames.map((name) => `import ${JSON.stringify(`./${name}`)};`).join('\n');
  return `${imports}${imports ? '\n' : ''}export default { fetch() { return new Response('ok'); } };\n`;
}

test('requires the checkout itself to be the repository root', async (t) => {
  const { checkout } = await fixture(t, { checkoutDirectory: 'nested' });
  const driver = new EmbeddedBuildDriver({ consent: async () => true });
  await assert.rejects(driver.build(checkout), /checkout must be the repository root/);
});

test('detects dirty consumed filenames without interpreting NUL-delimited path bytes', async (t) => {
  const sourceNames = ['white space.ts'];
  if (process.platform !== 'win32') sourceNames.push('line\nbreak.ts', 'back\\slash.ts');
  const { checkout, source } = await fixture(t, { sourceNames });
  for (const name of sourceNames) await writeFile(join(source, name), 'export const value = 200; // dirty\n');

  const consentCalls = [];
  const driver = new EmbeddedBuildDriver({ consent: async (paths) => { consentCalls.push([...paths]); return true; } });
  const build = await driver.build(checkout);
  const expected = sourceNames.map((name) => `hub/src/${name}`).sort();

  assert.deepEqual(consentCalls, [expected]);
  assert.deepEqual(build.dirtyPaths, expected);
  for (const path of expected) assert.ok(build.inputManifest.inputs.some((input) => input.path === path));
});

test('enumerates consumed files inside ignored directories individually', async (t) => {
  const { checkout, source } = await fixture(t);
  await mkdir(join(source, 'ignored'));
  await writeFile(join(source, 'ignored', 'consumed.ts'), 'export const consumed = true;\n');
  await writeFile(join(source, 'ignored', 'not-consumed.ts'), 'export const decoy = true;\n');
  await writeFile(join(source, 'index.ts'), entrySource(['ignored/consumed.ts']));

  const consentCalls = [];
  const driver = new EmbeddedBuildDriver({ consent: async (paths) => { consentCalls.push([...paths]); return true; } });
  const build = await driver.build(checkout);

  assert.deepEqual(consentCalls, [[
    'hub/src/ignored/consumed.ts',
    'hub/src/index.ts',
  ]]);
  assert.ok(build.inputManifest.inputs.some((input) => input.path === 'hub/src/ignored/consumed.ts'));
  assert.equal(build.inputManifest.inputs.some((input) => input.path === 'hub/src/ignored/not-consumed.ts'), false);
});
