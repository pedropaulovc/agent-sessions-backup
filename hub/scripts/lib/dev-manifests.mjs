import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { HUB_ROOT } from './dev-paths.mjs';
import { runChecked } from './dev-process.mjs';

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function portablePath(path) {
  return path.split(sep).join('/');
}

function inside(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function forbiddenInput(path) {
  const portable = `/${portablePath(path).toLowerCase()}/`;
  const name = basename(path).toLowerCase();
  return portable.includes('/node_modules/') || portable.includes('/.dev/') || portable.includes('/.wrangler/') ||
    portable.includes('/coverage/') || portable.includes('/dist/') || portable.includes('/cache/') ||
    name.startsWith('.env') || /credential|secret|private[-_.]?corpus/.test(name);
}

async function canonicalFileEntry(path) {
  const absolute = resolve(path);
  const info = await lstat(absolute);
  if (!info.isFile()) throw new Error(`manifest input is not a regular file: ${absolute}`);
  const actual = await realpath(absolute);
  const repoActual = await realpath(resolve(HUB_ROOT, '..'));
  if (!inside(repoActual, actual)) throw new Error(`manifest input escapes the repository: ${absolute} -> ${actual}`);
  const bytes = await readFile(actual);
  return { path: portablePath(relative(HUB_ROOT, absolute)), sha256: sha256(bytes), size: bytes.length };
}


export async function seedManifest(fixturePaths) {
  const files = await Promise.all([...fixturePaths].sort().map(canonicalFileEntry));
  const digest = sha256(`${canonicalJson(files)}\n`);
  return { version: 1, digest, files };
}

async function artifactManifest(outdir, metaPath) {
  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  if (!meta?.outputs || typeof meta.outputs !== 'object') {
    throw new Error(`Wrangler metafile has no outputs: ${metaPath}`);
  }
  const files = [];
  const outputPaths = Object.keys(meta.outputs)
    .filter((name) => !name.endsWith('.map'))
    .map((name) => resolve(HUB_ROOT, name))
    .sort();
  for (const path of outputPaths) {
    if (!inside(outdir, path)) throw new Error(`Wrangler output escapes build directory: ${path}`);
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`Wrangler output is not a regular file: ${path}`);
    const bytes = await readFile(path);
    files.push({ path: portablePath(relative(outdir, path)), sha256: sha256(bytes), size: bytes.length });
  }
  if (files.length === 0) throw new Error('Wrangler dry-run produced no deployable bundle');
  return { files, digest: sha256(`${canonicalJson(files)}\n`) };
}

async function declaredInputs(metaPath) {
  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  if (!meta?.inputs || typeof meta.inputs !== 'object') throw new Error(`Wrangler metafile has no inputs: ${metaPath}`);
  const paths = new Set([
    join(HUB_ROOT, 'package.json'),
    join(HUB_ROOT, 'package-lock.json'),
    join(HUB_ROOT, 'wrangler.jsonc'),
    join(HUB_ROOT, 'tsconfig.json'),
  ]);
  for (const input of Object.keys(meta.inputs)) {
    const absolute = resolve(HUB_ROOT, input);
    const portable = `/${portablePath(absolute).toLowerCase()}/`;
    if (portable.includes('/node_modules/')) continue;
    if (forbiddenInput(absolute)) throw new Error(`bundler consumed a forbidden local input: ${absolute}`);
    paths.add(absolute);
  }
  const files = await Promise.all([...paths].sort().map(canonicalFileEntry));
  return { files, digest: sha256(`${canonicalJson(files)}\n`) };
}

export async function buildReproducibly({ stateDir, wranglerPath, childEnv }) {
  const buildRoot = join(stateDir, 'build');
  await rm(buildRoot, { recursive: true, force: true });
  await mkdir(buildRoot, { recursive: true });
  const builds = [];
  for (const name of ['first', 'second']) {
    const outdir = join(buildRoot, name);
    const metaPath = join(outdir, 'bundle-meta.json');
    await mkdir(outdir, { recursive: true });
    runChecked(process.execPath, [
      wranglerPath,
      'deploy',
      '--dry-run',
      '--outdir', outdir,
      '--metafile', metaPath,
      '--var', 'ENVIRONMENT:development',
    ], { cwd: HUB_ROOT, env: childEnv, label: `Wrangler reproducibility build (${name})` });
    builds.push({
      artifact: await artifactManifest(outdir, metaPath),
      inputs: await declaredInputs(metaPath),
    });
  }
  if (builds[0].inputs.digest !== builds[1].inputs.digest) throw new Error('build input manifest changed between reproducibility builds');
  if (builds[0].artifact.digest !== builds[1].artifact.digest) throw new Error('identical declared inputs produced different Worker bundles');
  const result = {
    version: 1,
    buildInputDigest: builds[0].inputs.digest,
    artifactDigest: builds[0].artifact.digest,
    inputs: builds[0].inputs.files,
    artifacts: builds[0].artifact.files,
  };
  await writeFile(join(stateDir, 'build-manifest.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}
