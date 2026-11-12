#!/usr/bin/env node
// Owner-run P0: empty the main D1 `heartbeats` table in bounded chunks.
//
// The hub used to INSERT every collector heartbeat, with its full events JSON, into `heartbeats`;
// nothing ever read it and it filled the production main D1 to its 10 GB cap. Deploy the hub that
// no longer writes the table FIRST, then run this at the keyboard with your own wrangler login:
//
//   node infra/cf/prune-heartbeats.mjs --dry-run          # SELECT COUNT(*) only, deletes nothing
//   node infra/cf/prune-heartbeats.mjs                    # delete 500 rows per chunk until empty
//   node infra/cf/prune-heartbeats.mjs --chunk 200 --max-chunks 50
//   node infra/cf/prune-heartbeats.mjs --persist-to hub/.dev/local/default   # local dev D1, not remote
//
// Every chunk is one independent `DELETE ... WHERE id IN (SELECT id ... ORDER BY id LIMIT n)
// RETURNING id` statement (D1 has no DELETE ... LIMIT), so the run is resumable by construction:
// stop it at any point and re-run. It stops when a chunk deletes 0 rows. A failed chunk is retried
// with backoff a bounded number of times; exhausting them exits non-zero with the table partly
// pruned, which is safe — just re-run. Freed pages go to SQLite's freelist and are reused by later
// writes, so no VACUUM is needed for the database to accept writes again.
//
// Remote runs use the wrangler OAuth profile only (default `production`, or WRANGLER_PROFILE /
// --profile): CLOUDFLARE_API_TOKEN and friends take precedence over a profile in wrangler, so they
// are dropped from the child environment rather than silently selecting another credential.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const run = promisify(execFile);
const HUB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../hub');
const CONFIG = path.join(HUB_DIR, 'wrangler.jsonc');
const IGNORED_CF_ENV = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL'];

function positiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`);
  return n;
}

const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    chunk: { type: 'string', default: '500' },
    'max-chunks': { type: 'string' },
    retries: { type: 'string', default: '5' },
    profile: { type: 'string', default: process.env.WRANGLER_PROFILE ?? 'production' },
    'persist-to': { type: 'string' },
  },
  strict: true,
  allowPositionals: false,
});
const chunk = positiveInt(args.chunk, 'chunk');
const maxChunks = args['max-chunks'] === undefined ? Infinity : positiveInt(args['max-chunks'], 'max-chunks');
const retries = positiveInt(args.retries, 'retries');

// The main DB is the `DB` binding's database_name in hub/wrangler.jsonc — read, never restated.
// Strip comments without touching `//` inside string values (same rule as reset-passkey.sh).
const config = JSON.parse(
  readFileSync(CONFIG, 'utf8').replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (_, str) => str ?? ''),
);
const database = config.d1_databases?.find((db) => db.binding === 'DB')?.database_name;
if (typeof database !== 'string' || database.length === 0) throw new Error(`no DB binding database_name in ${CONFIG}`);

const target = args['persist-to'] === undefined
  ? ['--remote', '--profile', args.profile]
  : ['--local', '--persist-to', path.resolve(args['persist-to'])];
const childEnv = { ...process.env };
for (const name of IGNORED_CF_ENV) delete childEnv[name];

/** One wrangler d1 execute; returns the single statement's `{ results, meta }`. Throws on a
 * nonzero exit or any output that is not exactly one successful statement result. */
async function execute(sql) {
  const { stdout } = await run('npx', [
    '--no-install', 'wrangler', 'd1', 'execute', database, '--config', CONFIG, ...target, '--json', '--command', sql,
  ], { cwd: HUB_DIR, env: childEnv, maxBuffer: 16 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1 || parsed[0]?.success !== true) {
    throw new Error(`unexpected wrangler output: ${stdout.slice(0, 2000)}`);
  }
  return parsed[0];
}

async function withRetries(label, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const detail = [error.message, error.stdout, error.stderr].filter(Boolean).join('\n').slice(0, 2000);
      if (attempt >= retries) throw new Error(`${label} failed after ${attempt + 1} attempts: ${detail}`);
      const delayMs = Math.min(60_000, 2_000 * 2 ** attempt);
      console.error(JSON.stringify({ event: 'prune_heartbeats.retry', label, attempt: attempt + 1, delayMs, error: detail }));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

const where = args['persist-to'] === undefined ? `remote:${database}` : `local:${database}`;

if (args['dry-run']) {
  const { results } = await withRetries('count', () => execute('SELECT COUNT(*) AS n FROM heartbeats'));
  console.log(JSON.stringify({ event: 'prune_heartbeats.dry_run', database: where, rows: results[0].n }));
  process.exit(0);
}

const DELETE_SQL = `DELETE FROM heartbeats WHERE id IN (SELECT id FROM heartbeats ORDER BY id LIMIT ${chunk}) RETURNING id`;
let total = 0;
for (let n = 1; n <= maxChunks; n++) {
  const started = Date.now();
  const { results, meta } = await withRetries(`chunk ${n}`, () => execute(DELETE_SQL));
  // Rows deleted = rows RETURNED. Remote D1 also reports meta.changes; local `wrangler d1 execute
  // --local --json` reports only meta.duration, so RETURNING is the count both targets share. When
  // meta.changes is present it must agree.
  const deleted = results.length;
  if (meta?.changes !== undefined && meta.changes !== deleted) {
    throw new Error(`chunk ${n}: meta.changes=${meta.changes} but ${deleted} ids returned`);
  }
  total += deleted;
  console.log(JSON.stringify({ event: 'prune_heartbeats.chunk', database: where, chunk: n, deleted, total, ms: Date.now() - started }));
  if (deleted === 0) {
    console.log(JSON.stringify({ event: 'prune_heartbeats.done', database: where, state: 'empty', total }));
    process.exit(0);
  }
}
console.log(JSON.stringify({ event: 'prune_heartbeats.done', database: where, state: 'max_chunks_reached', total }));
