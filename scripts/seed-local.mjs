#!/usr/bin/env node
/**
 * Seed a local hub (wrangler dev) with the real on-disk corpus.
 * Reference implementation of the collector upload path: scan stores,
 * hash, idempotent PUT, per-file result accounting.
 *
 * Usage: node seed-local.mjs [--hub http://localhost:8787] [--machine amet-wsl]
 *        [--store claude-projects=~/.claude/projects] [--store codex-sessions=~/.codex/sessions]
 *        [--limit N] [--concurrency 6]
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const HUB = opt('hub', 'http://localhost:8787');
const MACHINE = opt('machine', 'amet-wsl');
const LIMIT = Number(opt('limit', 'Infinity'));
const CONCURRENCY = Number(opt('concurrency', '6'));

const stores = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--store') {
    const [name, dir] = args[i + 1].split('=');
    stores.push({ name, dir: dir.replace(/^~/, homedir()) });
  }
}
if (stores.length === 0) {
  stores.push(
    { name: 'claude-projects', dir: join(homedir(), '.claude', 'projects') },
    { name: 'codex-sessions', dir: join(homedir(), '.codex', 'sessions') },
  );
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

const results = { uploaded: 0, unchanged: 0, failed: 0, bytes: 0, errors: [] };
let inFlight = 0;
const queue = [];

async function uploadOne(store, root, path) {
  const st = await stat(path);
  const body = await readFile(path); // capped in practice at ~35MB per file
  const sha256 = createHash('sha256').update(body).digest('hex');
  const relpath = relative(root, path).split(sep).join('/');
  const url = `${HUB}/api/v1/files/${MACHINE}/${store}/${encodeURIComponent(relpath)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'x-dev-machine': MACHINE,
      'x-content-hash': `sha256:${sha256}`,
      'x-file-mtime': st.mtime.toISOString(),
      'content-length': String(body.length),
    },
    body,
  });
  if (res.status === 201) {
    results.uploaded++;
    results.bytes += body.length;
  } else if (res.status === 200) {
    results.unchanged++;
  } else {
    results.failed++;
    results.errors.push({ relpath, status: res.status, body: (await res.text()).slice(0, 200) });
  }
}

async function run() {
  const files = [];
  for (const s of stores) {
    for await (const f of walk(s.dir)) {
      files.push({ store: s.name, root: s.dir, path: f });
      if (files.length >= LIMIT) break;
    }
    if (files.length >= LIMIT) break;
  }
  console.log(`seeding ${files.length} files from ${stores.map((s) => s.name).join('+')} as ${MACHINE} → ${HUB}`);

  let done = 0;
  const started = Date.now();
  await new Promise((resolve, reject) => {
    const next = () => {
      if (files.length === 0 && inFlight === 0) return resolve();
      while (inFlight < CONCURRENCY && files.length > 0) {
        const f = files.shift();
        inFlight++;
        uploadOne(f.store, f.root, f.path)
          .catch((e) => {
            results.failed++;
            results.errors.push({ relpath: f.path, status: 'exception', body: String(e).slice(0, 200) });
          })
          .finally(() => {
            inFlight--;
            if (++done % 100 === 0) {
              const mb = (results.bytes / 1e6).toFixed(0);
              console.log(`  ${done} done (${mb} MB uploaded, ${results.failed} failed, ${((Date.now() - started) / 1000).toFixed(0)}s)`);
            }
            next();
          });
      }
    };
    next();
  });

  console.log(JSON.stringify({ ...results, errors: results.errors.slice(0, 20) }, null, 2));
  if (results.failed > 0) process.exitCode = 1;
}

await run();
