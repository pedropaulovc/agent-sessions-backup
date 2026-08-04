import { createPublicKey } from 'node:crypto';
import { lstat, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sign } from 'sigstore';
import { canonicalBytes, sha256 } from '../src/canonical.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expected = {
  repository: 'pedropaulovc/agent-sessions-backup',
  ref: 'refs/heads/main',
  workflow: '.github/workflows/release-sessions-dev-bridge.yml',
};
for (const [field, value] of [['GITHUB_REPOSITORY', expected.repository], ['GITHUB_REF', expected.ref]]) {
  if (process.env[field] !== value) throw new Error(`${field} must be ${value}`);
}
if (process.env.GITHUB_WORKFLOW_REF !== `${expected.repository}/${expected.workflow}@${expected.ref}`) throw new Error('provenance may only be created by the protected bridge release workflow');
if (!/^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? '') || !/^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ID ?? '')) throw new Error('invalid GitHub release identity');
const manifestJwk = JSON.parse(process.env.DEBUG_EXPORT_MANIFEST_VERIFY_PUBLIC_JWK ?? 'null');
if (!manifestJwk || manifestJwk.kty !== 'EC' || manifestJwk.crv !== 'P-256' || manifestJwk.d !== undefined) throw new Error('DEBUG_EXPORT_MANIFEST_VERIFY_PUBLIC_JWK must be a public P-256 JWK');
createPublicKey({ key: manifestJwk, format: 'jwk' });
await writeFile(join(root, 'src', 'production-manifest-key.json'), `${JSON.stringify({ keys: [manifestJwk] })}\n`, { mode: 0o644 });

const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const paths = ['package.json', ...(await runtimeFiles(join(root, 'src')))].sort();
const files = [];
for (const path of paths) {
  const stat = await lstat(join(root, ...path.split('/')));
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`release input is not a regular file: ${path}`);
  files.push({ path, sha256: sha256(await readFile(join(root, ...path.split('/')))) });
}
const manifest = {
  format: 1,
  name: 'sessions-dev-bridge',
  version: metadata.version,
  repository: expected.repository,
  commit: process.env.GITHUB_SHA,
  ref: expected.ref,
  workflow: expected.workflow,
  runId: process.env.GITHUB_RUN_ID,
  files,
};
const sigstoreBundle = await sign(canonicalBytes(manifest));
const destination = join(root, 'release-provenance.json');
const temporary = `${destination}.${process.pid}.tmp`;
try {
  await writeFile(temporary, `${JSON.stringify({ manifest, sigstoreBundle })}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, destination);
} finally { await rm(temporary, { force: true }); }

async function runtimeFiles(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await runtimeFiles(absolute)));
    else if (entry.isFile() && (entry.name.endsWith('.mjs') || entry.name.endsWith('.json'))) paths.push(relative(root, absolute).split(sep).join('/'));
    else throw new Error(`unexpected runtime file: ${relative(root, absolute)}`);
  }
  return paths;
}
