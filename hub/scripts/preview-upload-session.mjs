#!/usr/bin/env node
/**
 * Push a hand-carried session export (the viewer's "Export zip") into a per-PR preview
 * environment — the agent-driven half of the prod→preview session-copy flow. The owner
 * exports the zip behind their production passkey session; this script re-uploads its
 * entries through the preview's standard collector API, authenticated by the derived
 * per-PR bearer. Zero new ingest code: every entry is a normal
 * `PUT /api/v1/files/{machine}/{store}/{relpath}`.
 *
 *   node hub/scripts/preview-upload-session.mjs --pr 128 --zip session-<id>.zip
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { unzipSync } from 'fflate';
import { derivePreviewBearer, readPreviewSeed } from './preview-open.mjs';

// Cloudflare caps a single request body at 100MB; leave headroom. Multipart is not wired
// here yet — an oversized entry fails loudly rather than half-uploading.
const MAX_PUT_BYTES = 95 * 1024 * 1024;

export function parseUploadArguments(argv) {
  const values = { pr: undefined, zip: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== '--pr' && flag !== '--zip') throw new Error(`unknown option: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    if (flag === '--pr') {
      if (!/^[1-9]\d*$/.test(value)) throw new Error('--pr must be a positive integer');
      values.pr = Number(value);
      if (!Number.isSafeInteger(values.pr)) throw new Error('--pr must be a safe positive integer');
    } else {
      values.zip = value;
    }
    index += 1;
  }
  if (values.pr === undefined) throw new Error('missing required option: --pr');
  if (values.zip === undefined) throw new Error('missing required option: --zip');
  return values;
}

export function readExportZip(bytes) {
  const files = unzipSync(bytes);
  const manifestBytes = files['manifest.json'];
  if (!manifestBytes) throw new Error('zip has no manifest.json — is this a viewer session export?');
  const manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8'));
  if (manifest.format !== 'agent-sessions-export/v1') {
    throw new Error(`unsupported export format: ${manifest.format}`);
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw new Error('export manifest lists no entries');
  }
  const entries = manifest.entries.map((entry) => {
    for (const field of ['machine', 'store', 'relpath']) {
      if (typeof entry[field] !== 'string' || entry[field].length === 0) {
        throw new Error(`export manifest entry missing ${field}`);
      }
    }
    // fetch() normalizes `.`/`..` in the URL path BEFORE the hub routes it, so a crafted
    // manifest entry could otherwise redirect an upload to a different machine or store.
    // machine and store are single path segments; relpath is validated segment by segment.
    if (entry.machine.includes('/') || entry.store.includes('/')) {
      throw new Error(`export manifest entry has a multi-segment machine or store: ${entry.machine}/${entry.store}`);
    }
    const segments = [entry.machine, entry.store, ...entry.relpath.split('/')];
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new Error(`export manifest entry path is not normalized: ${entry.machine}/${entry.store}/${entry.relpath}`);
    }
    const name = `${entry.machine}/${entry.store}/${entry.relpath}`;
    const body = files[name];
    if (!body) throw new Error(`zip is missing the entry its manifest lists: ${name}`);
    return { ...entry, name, body };
  });
  return { manifest, entries };
}

export function uploadTarget(origin, entry) {
  const encodedRelpath = entry.relpath.split('/').map(encodeURIComponent).join('/');
  return `${origin}/api/v1/files/${encodeURIComponent(entry.machine)}/${encodeURIComponent(entry.store)}/${encodedRelpath}`;
}

async function putEntry(origin, token, entry, log) {
  if (entry.body.length > MAX_PUT_BYTES) {
    throw new Error(`${entry.name} is ${entry.body.length} bytes — over the ${MAX_PUT_BYTES} single-PUT limit (multipart is not wired into this script yet)`);
  }
  const sha256 = createHash('sha256').update(entry.body).digest('hex');
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/octet-stream',
    'content-length': String(entry.body.length),
    'x-content-hash': `sha256:${sha256}`,
    'cache-control': 'no-store',
  };
  if (typeof entry.mtime === 'string' && entry.mtime) headers['x-file-mtime'] = entry.mtime;
  const response = await fetch(uploadTarget(origin, entry), {
    method: 'PUT',
    redirect: 'error',
    headers,
    body: entry.body,
    // A 95MB PUT over a slow uplink is legitimate; a hung socket forever is not.
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`upload of ${entry.name} failed with ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  log(`uploaded ${entry.name} (${entry.body.length} bytes, ${response.status})`);
}

async function waitForSession(origin, token, sessionId, log, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
      redirect: 'error',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'cache-control': 'no-store' },
      // Each poll is bounded by the overall deadline so a hung request can't outlive it.
      signal: AbortSignal.timeout(Math.min(15_000, Math.max(1, deadline - Date.now()))),
    });
    last = await response.text();
    if (response.ok) {
      const body = JSON.parse(last);
      if (body.meta?.index_state === 'ready') return;
      log(`session ${sessionId}: index_state=${body.meta?.index_state ?? 'unknown'} — waiting`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  throw new Error(`session ${sessionId} was not indexed within ${timeoutMs / 1000}s: ${last.slice(0, 500)}`);
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const { pr, zip } = parseUploadArguments(argv);
  const log = options.log ?? console.log;
  const seed = options.seed !== undefined ? options.seed : readPreviewSeed();
  if (seed === null) {
    throw new Error('no preview seed found (~/.config/agent-sessions/preview-seed or PREVIEW_BEARER_SEED)');
  }
  const token = derivePreviewBearer(seed, pr);
  const origin = `https://pr-${pr}.sessions-ppe.workers.dev`;
  const { manifest, entries } = readExportZip(new Uint8Array(readFileSync(zip)));
  log(`uploading session ${manifest.session_id} (${entries.length} entries) to ${origin}`);
  for (const entry of entries) await putEntry(origin, token, entry, log);
  await waitForSession(origin, token, manifest.session_id, log);
  log(`indexed — open the PPE preview page with: npm --prefix hub run preview:open -- --pr ${pr}`);
  return { sessionId: manifest.session_id, origin, entries: entries.length };
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isEntrypoint) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
