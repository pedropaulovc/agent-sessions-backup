import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalBytes, sha256, assertExactKeys, assertHex } from './canonical.mjs';

const REPOSITORY = 'pedropaulovc/agent-sessions-backup';
const WORKFLOW = '.github/workflows/release-sessions-dev-bridge.yml';
const REF = 'refs/heads/main';
const ISSUER = 'https://token.actions.githubusercontent.com';
const IDENTITY = `https://github.com/${REPOSITORY}/${WORKFLOW}@${REF}`;

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function verifyInstalledRelease(options = {}) {
  const root = resolve(options.packageRoot ?? packageRoot);
  const provenancePath = join(root, 'release-provenance.json');
  const raw = JSON.parse(await readFile(provenancePath, 'utf8'));
  assertExactKeys(raw, ['manifest', 'sigstoreBundle']);
  validateManifest(raw.manifest);

  const packageMetadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (packageMetadata.name !== 'sessions-dev-bridge' || packageMetadata.version !== raw.manifest.version) {
    throw new Error('release provenance does not match installed package identity');
  }

  const listed = new Map(raw.manifest.files.map((item) => [item.path, item.sha256]));
  const actualRuntimeFiles = ['package.json', ...(await listRuntimeFiles(join(root, 'src'), root))].sort();
  if (actualRuntimeFiles.length !== listed.size || actualRuntimeFiles.some((path) => !listed.has(path))) {
    throw new Error('installed executable files do not match the signed release manifest');
  }
  for (const [path, digest] of listed) {
    const absolute = resolve(root, ...path.split('/'));
    if (!inside(root, absolute)) throw new Error(`release manifest path escapes package: ${path}`);
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`release manifest path is not a regular file: ${path}`);
    if (!inside(root, await realpath(absolute))) throw new Error(`release manifest path resolves outside package: ${path}`);
    if (sha256(await readFile(absolute)) !== digest) throw new Error(`installed release file digest mismatch: ${path}`);
  }

  const payload = canonicalBytes(raw.manifest);
  const verifyBundle = options.verifyBundle ?? verifySigstoreBundle;
  await verifyBundle(raw.sigstoreBundle, payload);
  return Object.freeze({
    digest: sha256(payload),
    repository: raw.manifest.repository,
    commit: raw.manifest.commit,
    workflow: raw.manifest.workflow,
    runId: raw.manifest.runId,
    version: raw.manifest.version,
  });
}

async function verifySigstoreBundle(bundle, payload) {
  const { verify } = await import('sigstore');
  await verify(bundle, payload, {
    certificateIssuer: ISSUER,
    certificateIdentityURI: `^${escapeRegex(IDENTITY)}$`,
    ctLogThreshold: 1,
    tlogThreshold: 1,
  });
}

function validateManifest(manifest) {
  assertExactKeys(manifest, ['format', 'name', 'version', 'repository', 'commit', 'ref', 'workflow', 'runId', 'files']);
  if (manifest.format !== 1 || manifest.name !== 'sessions-dev-bridge') throw new Error('unsupported release provenance');
  if (manifest.repository !== REPOSITORY || manifest.ref !== REF || manifest.workflow !== WORKFLOW) {
    throw new Error('release provenance is not from the protected default-branch workflow');
  }
  assertHex(manifest.commit, 40, 'release commit');
  if (!/^[1-9][0-9]*$/.test(String(manifest.runId))) throw new Error('invalid release workflow run id');
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('empty release file manifest');
  let previous = '';
  for (const item of manifest.files) {
    assertExactKeys(item, ['path', 'sha256']);
    if (!/^(?:package\.json|src\/[A-Za-z0-9._/-]+)$/.test(item.path) || item.path.includes('..')) {
      throw new Error(`invalid release file path: ${item.path}`);
    }
    if (item.path <= previous) throw new Error('release file manifest is not strictly sorted');
    previous = item.path;
    assertHex(item.sha256, 64, `digest for ${item.path}`);
  }
}

async function listRuntimeFiles(directory, root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symlink in installed runtime: ${relative(root, absolute)}`);
    if (entry.isDirectory()) files.push(...(await listRuntimeFiles(absolute, root)));
    else if (entry.isFile() && (entry.name.endsWith('.mjs') || entry.name.endsWith('.json'))) files.push(relative(root, absolute).split(sep).join('/'));
    else throw new Error(`unexpected installed runtime entry: ${relative(root, absolute)}`);
  }
  return files;
}

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
