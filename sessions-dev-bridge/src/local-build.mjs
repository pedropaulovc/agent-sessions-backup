import { build as esbuild } from 'esbuild';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalBytes, sha256 } from './canonical.mjs';
import { packageRoot as bridgePackageRoot } from './provenance.mjs';
import { runProcess } from './secure.mjs';

const ENTRY = 'hub/src/index.ts';
const FIXED_BUILD_OPTIONS = Object.freeze({
  bundle: true,
  charset: 'utf8',
  conditions: ['workerd', 'worker', 'browser'],
  format: 'esm',
  legalComments: 'none',
  logLevel: 'silent',
  mainFields: ['module', 'main'],
  minify: false,
  platform: 'browser',
  sourcemap: false,
  target: 'es2022',
  treeShaking: true,
  write: false,
});
const REJECTED_PREFIXES = ['.env', '.dev/', '.git/', '.wrangler/', 'node_modules/', '.cache/', 'dist/', 'coverage/'];

export class EmbeddedBuildDriver {
  constructor(options = {}) {
    this.runProcess = options.runProcess ?? runProcess;
    this.consent = options.consent ?? (async () => { throw new Error('dirty consumed inputs require explicit consent'); });
  }

  async build(checkout) {
    const root = await realpath(resolve(checkout));
    if (inside(root, bridgePackageRoot)) throw new Error('sessions-dev-bridge must be installed outside the target checkout');
    await assertRepositoryRoot(root, this.runProcess);
    const entry = join(root, ...ENTRY.split('/'));
    await assertRepoFile(root, entry);
    const first = await this.#bundle(root, entry);
    const second = await this.#bundle(root, entry);
    if (first.bundleDigest !== second.bundleDigest || !first.bundle.equals(second.bundle)) {
      throw new Error('embedded build is not reproducible');
    }
    const consumed = await this.#manifest(root, first.loadedPaths);
    const dirtyPaths = await consumedDirtyPaths(root, consumed.map((item) => item.path), this.runProcess);
    if (dirtyPaths.length) {
      const accepted = await this.consent(Object.freeze([...dirtyPaths]));
      if (accepted !== true) throw new Error('user declined dirty or untracked consumed inputs');
    }
    const manifest = Object.freeze({ format: 1, driver: 'sessions-dev-bridge/esbuild-0.28.1', inputs: consumed });
    return Object.freeze({
      bundle: first.bundle,
      bundleDigest: first.bundleDigest,
      inputManifest: manifest,
      inputDigest: sha256(canonicalBytes(manifest)),
      migrations: await loadMigrations(root),
      dirtyPaths: Object.freeze(dirtyPaths),
    });
  }

  async #bundle(root, entry) {
    const loadedPaths = new Set();
    const result = await esbuild({
      ...FIXED_BUILD_OPTIONS,
      absWorkingDir: root,
      entryPoints: [entry],
      metafile: true,
      outfile: 'worker.mjs',
      tsconfigRaw: { compilerOptions: { useDefineForClassFields: true } },
      plugins: [embeddedDependencyResolver(), consumedInputRecorder(loadedPaths)],
    });
    if (result.outputFiles.length !== 1) throw new Error('embedded build produced an unexpected output set');
    const bundle = Buffer.from(result.outputFiles[0].contents);
    return { bundle, bundleDigest: sha256(bundle), loadedPaths };
  }

  async #manifest(root, loadedPaths) {
    const paths = new Set(['hub/package.json', 'hub/package-lock.json']);
    for (const input of loadedPaths) {
      const absolute = resolve(input);
      if (inside(bridgePackageRoot, absolute)) continue;
      const path = repoPath(root, absolute);
      if (!path.startsWith('hub/src/')) throw new Error(`build consumed checkout input outside hub/src: ${path}`);
      paths.add(path);
    }
    const migrationsDir = join(root, 'hub', 'migrations');
    for (const entry of await readdir(migrationsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^\d+_[A-Za-z0-9_-]+\.sql$/.test(entry.name)) throw new Error(`unexpected migration entry: ${entry.name}`);
      paths.add(`hub/migrations/${entry.name}`);
    }
    const items = [];
    for (const path of [...paths].sort()) {
      rejectPath(path);
      const absolute = resolve(root, ...path.split('/'));
      await assertRepoFile(root, absolute);
      const bytes = await readFile(absolute);
      items.push(Object.freeze({ path, size: bytes.length, sha256: sha256(bytes) }));
    }
    return Object.freeze(items);
  }
}

function embeddedDependencyResolver() {
  const packageJson = pathToFileURL(join(bridgePackageRoot, 'package.json')).href;
  return {
    name: 'embedded-pinned-dependency-resolver',
    setup(build) {
      build.onResolve({ filter: /^cloudflare:workers$/ }, (args) => ({ path: args.path, external: true }));
      build.onResolve({ filter: /^(?:@[^/]+\/|[A-Za-z0-9])[^:]*$/ }, (args) => {
        try { return { path: fileURLToPath(import.meta.resolve(args.path, packageJson)) }; }
        catch { return { errors: [{ text: `dependency is not in the embedded pinned toolchain: ${args.path}` }] }; }
      });
    },
  };
}

function consumedInputRecorder(paths) {
  return {
    name: 'consumed-input-recorder',
    setup(build) {
      build.onLoad({ filter: /.*/ }, (args) => {
        if (args.namespace === 'file') paths.add(args.path);
        return undefined;
      });
    },
  };
}

async function loadMigrations(root) {
  const directory = join(root, 'hub', 'migrations');
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^\d+_[A-Za-z0-9_-]+\.sql$/.test(entry.name))
    .map((entry) => entry.name).sort();
  return Object.freeze(await Promise.all(names.map(async (name) => Object.freeze({ name, sql: await readFile(join(directory, name), 'utf8') }))));
}

async function consumedDirtyPaths(root, consumedPaths, run) {
  const options = gitOptions(root);
  const status = await run('git', [
    '-c', 'core.fsmonitor=false',
    '-c', 'core.untrackedCache=false',
    'status', '--porcelain=v1', '-z', '--untracked-files=all',
  ], options);
  const ignored = await run('git', [
    '-c', 'core.fsmonitor=false',
    '-c', 'core.untrackedCache=false',
    '--literal-pathspecs',
    'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--',
    ...consumedPaths,
  ], options);
  const tracked = await run('git', [
    '--literal-pathspecs',
    'ls-files', '--cached', '-z', '--',
    ...consumedPaths,
  ], options);
  const consumed = new Map(consumedPaths.map((path) => [Buffer.from(path, 'utf8').toString('hex'), path]));
  const dirty = new Set();
  const represented = new Set();
  const matchConsumed = (pathBytes) => consumed.get(pathBytes.toString('hex'));
  const markDirty = (pathBytes) => {
    const path = matchConsumed(pathBytes);
    if (path !== undefined) {
      represented.add(path);
      dirty.add(path);
    }
  };
  const fields = splitNulFields(status.stdout);
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (field.length < 4 || field[2] !== 0x20) throw new Error('unexpected git status output');
    const statusCode = field.subarray(0, 2).toString('ascii');
    markDirty(field.subarray(3));
    if (statusCode.includes('R') || statusCode.includes('C')) {
      const priorPath = fields[++index];
      if (priorPath === undefined) throw new Error('unexpected git status output');
      markDirty(priorPath);
    }
  }
  for (const path of splitNulFields(ignored.stdout)) markDirty(path);
  for (const pathBytes of splitNulFields(tracked.stdout)) {
    const path = matchConsumed(pathBytes);
    if (path !== undefined) represented.add(path);
  }
  if (represented.size !== consumed.size) {
    const missing = consumedPaths.find((path) => !represented.has(path));
    throw new Error(`build input is not represented as a repository file: ${missing}`);
  }
  return [...dirty].sort();
}

async function assertRepositoryRoot(root, run) {
  const result = await run('git', ['rev-parse', '--show-prefix'], gitOptions(root));
  if (!result.stdout.equals(Buffer.from('\n'))) {
    throw new Error('checkout must be the repository root');
  }
}

function gitOptions(root) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.toUpperCase().startsWith('GIT_')) delete env[name];
  }
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
  });
  return { cwd: root, env };
}
function splitNulFields(output) {
  if (output.length === 0) return [];
  if (output[output.length - 1] !== 0) throw new Error('unexpected unterminated git output');
  const fields = [];
  let start = 0;
  for (let index = 0; index < output.length; index++) {
    if (output[index] !== 0) continue;
    if (index > start) fields.push(output.subarray(start, index));
    start = index + 1;
  }
  return fields;
}

async function assertRepoFile(root, absolute) {
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`consumed input is not a regular file: ${repoPath(root, absolute)}`);
  const resolved = await realpath(absolute);
  if (!inside(root, resolved)) throw new Error(`consumed input resolves outside checkout: ${repoPath(root, absolute)}`);
}

function repoPath(root, absolute) {
  const path = relative(root, absolute);
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('build input escapes checkout');
  return path.split(sep).join('/');
}

function rejectPath(path) {
  const normalized = path.toLowerCase();
  if (normalized.split('/').some((part) => part === '..') || REJECTED_PREFIXES.some((prefix) => normalized.startsWith(prefix) || normalized.includes(`/${prefix}`))) {
    throw new Error(`forbidden build input: ${path}`);
  }
  if (normalized.split('/').some((part) => part.startsWith('.env'))) throw new Error(`environment file cannot be consumed: ${path}`);
}

function inside(root, candidate) {
  const path = relative(resolve(root), resolve(candidate));
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
