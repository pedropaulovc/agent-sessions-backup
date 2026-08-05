import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalBytes, sha256 } from '../src/canonical.mjs';
import { verifyInstalledRelease } from '../src/provenance.mjs';

async function fixture(change = (value) => value) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-provenance-'));
  await mkdir(join(root, 'src'));
  const packageBytes = Buffer.from('{"name":"sessions-dev-bridge","version":"1.0.0"}\n');
  const sourceBytes = Buffer.from('export const trusted = true;\n');
  await writeFile(join(root, 'package.json'), packageBytes);
  await writeFile(join(root, 'src', 'main.mjs'), sourceBytes);
  let manifest = {
    format: 2,
    name: 'sessions-dev-bridge',
    version: '1.0.0',
    repository: 'pedropaulovc/agent-sessions-backup',
    commit: 'a'.repeat(40),
    ref: 'refs/heads/main',
    workflow: '.github/workflows/release-sessions-dev-bridge.yml',
    runId: '123',
    runAttempt: '1',
    files: [
      { path: 'package.json', sha256: sha256(packageBytes) },
      { path: 'src/main.mjs', sha256: sha256(sourceBytes) },
    ],
  };
  manifest = change(manifest);
  await writeFile(join(root, 'release-provenance.json'), JSON.stringify({ manifest, sigstoreBundle: { fake: true } }));
  return { root, manifest };
}

test('accepts only a signed exact installed payload from the protected main workflow', async () => {
  const { root, manifest } = await fixture();
  let verified = false;
  try {
    const release = await verifyInstalledRelease({ packageRoot: root, verifyBundle: async (bundle, payload) => {
      assert.deepEqual(bundle, { fake: true });
      assert.deepEqual(payload, canonicalBytes(manifest));
      verified = true;
    }});
    assert.equal(verified, true);
    assert.equal(release.commit, 'a'.repeat(40));
    assert.equal(release.runAttempt, '1');
    assert.equal(release.digest, sha256(canonicalBytes(manifest)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects wrong release provenance and modified installed bytes before trust', async () => {
  const wrong = await fixture((manifest) => ({ ...manifest, ref: 'refs/heads/feature' }));
  try { await assert.rejects(verifyInstalledRelease({ packageRoot: wrong.root, verifyBundle: async () => {} }), /protected default-branch/); }
  finally { await rm(wrong.root, { recursive: true, force: true }); }

  const invalidAttempt = await fixture((manifest) => ({ ...manifest, runAttempt: '0' }));
  try { await assert.rejects(verifyInstalledRelease({ packageRoot: invalidAttempt.root, verifyBundle: async () => {} }), /run attempt/); }
  finally { await rm(invalidAttempt.root, { recursive: true, force: true }); }

  const changed = await fixture();
  try {
    await writeFile(join(changed.root, 'src', 'main.mjs'), 'export const trusted = false;\n');
    await assert.rejects(verifyInstalledRelease({ packageRoot: changed.root, verifyBundle: async () => {} }), /digest mismatch/);
  } finally { await rm(changed.root, { recursive: true, force: true }); }
});
