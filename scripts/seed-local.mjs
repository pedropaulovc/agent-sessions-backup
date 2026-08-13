#!/usr/bin/env node
/** Explicit private-data uploader for a loopback development hub. */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';

const HELP = `Usage: node scripts/seed-local.mjs --acknowledge-private-data [options]

Uploads local Claude/Codex transcript files to an already-running loopback hub.
This command is never run by dev:up or test:e2e.

Options:
  --acknowledge-private-data  Required confirmation that local transcripts will be uploaded
  --hub <url>                 Loopback hub URL (default: http://127.0.0.1:8787)
  --machine <id>              Development machine ID (default: local-corpus)
  --store <name=directory>    Repeatable corpus store override
  --limit <count>             Maximum files to upload (default: unlimited)
  --concurrency <count>       Concurrent requests, 1-32 (default: 6)
  -h, --help                  Show this help

Non-loopback destinations are intentionally rejected. For a consented production-session
copy into a preview, use the viewer's "Export zip" button plus
hub/scripts/preview-upload-session.mjs; never put production authorization in this checkout.
`;

function parseArguments(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const options = {
    acknowledged: false,
    hub: 'http://127.0.0.1:8787',
    machine: 'local-corpus',
    limit: Infinity,
    concurrency: 6,
    stores: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--acknowledge-private-data') {
      options.acknowledged = true;
      continue;
    }
    if (!['--hub', '--machine', '--store', '--limit', '--concurrency'].includes(flag)) throw new Error(`unknown option: ${flag}`);
    const value = argv[++index];
    if (value == null || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    if (flag === '--hub') options.hub = value;
    if (flag === '--machine') options.machine = value;
    if (flag === '--limit') options.limit = Number(value);
    if (flag === '--concurrency') options.concurrency = Number(value);
    if (flag === '--store') {
      const equals = value.indexOf('=');
      if (equals < 1 || equals === value.length - 1) throw new Error('--store must be name=directory');
      options.stores.push({ name: value.slice(0, equals), dir: value.slice(equals + 1).replace(/^~(?=[\\/]|$)/, homedir()) });
    }
  }
  if (!options.acknowledged) throw new Error('refusing private transcript upload without --acknowledge-private-data');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.machine)) throw new Error('invalid --machine value');
  if (!Number.isSafeInteger(options.limit) && options.limit !== Infinity) throw new Error('--limit must be a positive integer');
  if (options.limit <= 0) throw new Error('--limit must be a positive integer');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 32) throw new Error('--concurrency must be from 1 through 32');
  if (options.stores.length === 0) {
    options.stores = [
      { name: 'claude-projects', dir: join(homedir(), '.claude', 'projects') },
      { name: 'codex-sessions', dir: join(homedir(), '.codex', 'sessions') },
    ];
  }
  for (const store of options.stores) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(store.name)) throw new Error(`invalid store name: ${store.name}`);
  }
  const url = new URL(options.hub);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('private corpus uploads are restricted to a loopback HTTP hub');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('--hub must be a credential-free loopback origin without a path, query, or fragment');
  }
  options.hub = url.origin;
  return options;
}

async function assertSchemaReady(options) {
  const health = await fetch(`${options.hub}/healthz`, { signal: AbortSignal.timeout(3000) });
  if (!health.ok) throw new Error(`hub health probe failed (${health.status}): ${(await health.text()).slice(0, 300)}`);
  const healthBody = await health.json();
  if (healthBody.environment !== 'development' || healthBody.pendingMigrations !== 0 || !healthBody.schemaDigest) {
    throw new Error('hub is not a migrated development environment; start it with npm --prefix hub run dev:up');
  }
  const status = await fetch(`${options.hub}/api/v1/status`, {
    headers: { 'x-dev-machine': options.machine },
    signal: AbortSignal.timeout(3000),
  });
  if (!status.ok) throw new Error(`schema-readiness query failed (${status.status}): ${(await status.text()).slice(0, 300)}`);
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

async function uploadOne(options, file, results) {
  const fileStat = await stat(file.path);
  const body = await readFile(file.path);
  const digest = createHash('sha256').update(body).digest('hex');
  const relpath = relative(file.root, file.path).split(sep).join('/');
  const response = await fetch(`${options.hub}/api/v1/files/${options.machine}/${file.store}/${encodeURIComponent(relpath)}`, {
    method: 'PUT',
    headers: {
      'x-dev-machine': options.machine,
      'x-content-hash': `sha256:${digest}`,
      'x-file-mtime': fileStat.mtime.toISOString(),
      'content-length': String(body.length),
    },
    body,
  });
  if (response.status === 201) {
    results.uploaded += 1;
    results.bytes += body.length;
  } else if (response.status === 200) {
    results.unchanged += 1;
  } else {
    results.failed += 1;
    results.errors.push({ relpath, status: response.status, body: (await response.text()).slice(0, 200) });
  }
}

async function run(options) {
  console.error('WARNING: this explicitly uploads private local transcript content to the loopback hub.');
  await assertSchemaReady(options);
  const files = [];
  for (const store of options.stores) {
    for await (const path of walk(store.dir)) {
      files.push({ store: store.name, root: store.dir, path });
      if (files.length >= options.limit) break;
    }
    if (files.length >= options.limit) break;
  }
  const results = { uploaded: 0, unchanged: 0, failed: 0, bytes: 0, errors: [] };
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const file = files[next++];
      try {
        await uploadOne(options, file, results);
      } catch (error) {
        results.failed += 1;
        results.errors.push({ relpath: file.path, status: 'exception', body: String(error).slice(0, 200) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, files.length) }, () => worker()));
  console.log(JSON.stringify({ files: files.length, ...results, errors: results.errors.slice(0, 20) }, null, 2));
  if (results.failed) process.exitCode = 1;
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) process.stdout.write(HELP);
  else await run(options);
} catch (error) {
  console.error(`session:seed-corpus: ${error.message}`);
  process.exitCode = 1;
}
