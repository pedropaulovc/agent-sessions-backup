import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HUB_ROOT } from './dev-paths.mjs';
import { seedManifest, sha256 } from './dev-manifests.mjs';

const FIXTURE_DIR = join(HUB_ROOT, 'test', 'fixtures', 'local');
const PRIMARY = join(FIXTURE_DIR, 'e2e-synthetic-session.jsonl');
const PAGER = join(FIXTURE_DIR, 'e2e-pager-session.jsonl');
const EXTERNAL_BASE64 = join(FIXTURE_DIR, 'fixture-external.png.base64');
const MACHINE = 'e2e-machine';
const STORE = 'claude-projects';
const PRIMARY_SESSION_ID = '00000000-0000-4000-8000-000000000001';
const PAGER_SESSION_ID = '00000000-0000-4000-8000-000000000002';
const PRIMARY_RELPATH = `-workspace-e2e-fixtures/${PRIMARY_SESSION_ID}.jsonl`;
const PAGER_RELPATH = `-workspace-e2e-fixtures/${PAGER_SESSION_ID}.jsonl`;
const EXTERNAL_DIGEST = '431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460';
const EXTERNAL_RELPATH = `${PRIMARY_RELPATH}.assets/${EXTERNAL_DIGEST}/fixture-external.png`;

export const SYNTHETIC_EXPECTATIONS = Object.freeze({
  machine: MACHINE,
  store: STORE,
  primarySessionId: PRIMARY_SESSION_ID,
  primaryTitle: 'Find the deterministic saffron telescope browser fixture.',
  pagerSessionId: PAGER_SESSION_ID,
  pagerTitle: 'This second deterministic session verifies machine-filtered pagination.',
  searchPhrase: 'saffron telescope',
  externalDigest: EXTERNAL_DIGEST,
  externalFileName: 'fixture-external.png',
});

export async function syntheticSeedManifest() {
  return seedManifest([PRIMARY, PAGER, EXTERNAL_BASE64]);
}

async function upload(baseUrl, relpath, bytes) {
  const contentHash = sha256(bytes);
  const response = await fetch(`${baseUrl}/api/v1/files/${MACHINE}/${STORE}/${encodeURIComponent(relpath)}`, {
    method: 'PUT',
    headers: {
      'x-dev-machine': MACHINE,
      'x-content-hash': `sha256:${contentHash}`,
      'x-file-mtime': '2026-07-01T00:00:00.000Z',
      'content-length': String(bytes.length),
    },
    body: bytes,
  });
  const text = await response.text();
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`synthetic upload ${relpath} failed (${response.status}): ${text.slice(0, 500)}`);
  }
}

async function waitForIndexed(baseUrl, sessionId, marker, deadline) {
  let last = 'not probed';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/search?q=${encodeURIComponent(marker)}&machine=${MACHINE}&limit=20`, {
        headers: { 'x-dev-machine': MACHINE },
      });
      last = `${response.status} ${await response.text()}`;
      if (response.ok) {
        const body = JSON.parse(last.slice(last.indexOf(' ') + 1));
        if (Array.isArray(body.hits) && body.hits.some((hit) => hit.session_id === sessionId)) return;
      }
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`synthetic session ${sessionId} was not indexed before timeout; last probe: ${last.slice(0, 500)}`);
}

export async function seedSynthetic(baseUrl, timeoutMs = 30_000, expectedDigest) {
  const liveManifest = await syntheticSeedManifest();
  if (expectedDigest && liveManifest.digest !== expectedDigest) {
    throw new Error('synthetic fixtures changed after the environment manifest was recorded');
  }
  const [primary, pager, assetText] = await Promise.all([
    readFile(PRIMARY),
    readFile(PAGER),
    readFile(EXTERNAL_BASE64, 'utf8'),
  ]);
  const asset = Buffer.from(assetText.trim(), 'base64');
  if (sha256(asset) !== EXTERNAL_DIGEST) throw new Error('synthetic external asset digest does not match its fixture contract');

  await upload(baseUrl, EXTERNAL_RELPATH, asset);
  await upload(baseUrl, PRIMARY_RELPATH, primary);
  await upload(baseUrl, PAGER_RELPATH, pager);
  const deadline = Date.now() + timeoutMs;
  await waitForIndexed(baseUrl, PRIMARY_SESSION_ID, 'saffron telescope', deadline);
  await waitForIndexed(baseUrl, PAGER_SESSION_ID, 'stable second page', deadline);
  return SYNTHETIC_EXPECTATIONS;
}
