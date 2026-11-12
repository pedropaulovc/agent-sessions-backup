#!/usr/bin/env node
// Owner-run P0: empty the main D1 `heartbeats` table in bounded chunks.
//
// The hub used to INSERT every collector heartbeat, with its full events JSON, into `heartbeats`;
// nothing ever read it and it filled the production main D1 to its 10 GB cap. Run this at the
// keyboard with your own wrangler login IMMEDIATELY — do not wait for the hub change that stops the
// inserts to deploy. The database is unwritable until this frees space, and the old Worker's one
// row per heartbeat request refills a negligible fraction of what it frees (infra/cf/deploy.md,
// "Recovering a full production main D1"):
//
//   node infra/cf/prune-heartbeats.mjs --dry-run          # SELECT COUNT(*) only, deletes nothing
//   node infra/cf/prune-heartbeats.mjs                    # delete 500 rows per chunk until empty
//   node infra/cf/prune-heartbeats.mjs --chunk 200 --max-chunks 50
//   node infra/cf/prune-heartbeats.mjs --persist-to hub/.dev/local/default   # local dev D1, not remote
//
// Every chunk is one independent `DELETE ... WHERE id IN (SELECT id ... ORDER BY id LIMIT n)
// RETURNING id` statement (D1 has no DELETE ... LIMIT), so the run is resumable by construction:
// stop it at any point and re-run. It stops when a chunk deletes 0 rows. A chunk that fails with a
// recognisably transient error (network, D1 overloaded/internal error, timeout) is retried with
// backoff up to --retries times; any other failure (auth/profile, SQL, unparseable output) stops at
// once, since retrying cannot change it. Either way the table is left partly pruned, which is safe —
// re-run. Freed pages go to SQLite's freelist and are reused by later writes, so no VACUUM is needed
// for the database to accept writes again.
//
// Remote runs use the wrangler OAuth profile only (default `production`, or WRANGLER_PROFILE /
// --profile): CLOUDFLARE_API_TOKEN and friends take precedence over a profile in wrangler, so they
// are dropped from the child environment rather than silently selecting another credential.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HUB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../hub');
const CONFIG = path.join(HUB_DIR, 'wrangler.jsonc');
// Run wrangler's JS entry under this Node, as hub/scripts/lib/migration-runner.mjs does: no npx or
// shell shim, so it behaves the same on Windows.
const WRANGLER_BIN = path.join(HUB_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const IGNORED_CF_ENV = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL'];

// Retried only when the error text says the failure was in transit or in D1's own availability.
// Anything unrecognised is treated as deterministic: a retry loop around an auth or SQL error
// only delays the operator seeing it.
const DETERMINISTIC_ERROR = /no such table|no such column|syntax error|SQLITE_(?:ERROR|CONSTRAINT|AUTH)|authenticat|unauthori[sz]ed|forbidden|not logged in|wrangler login|(?:unknown|no such|invalid|missing) profile|profile \S+ (?:does not exist|not found)|couldn't find|could not find|\b(?:400|401|403|404)\b/i;
const TRANSIENT_ERROR = /overloaded|internal error|timed? ?out|timeout|network connection lost|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|object to be reset|too many requests|\b(?:429|500|502|503|504)\b/i;

function nonNegativeInt(value, name, min) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be an integer >= ${min}`);
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
const chunk = nonNegativeInt(args.chunk, 'chunk', 1);
const maxChunks = args['max-chunks'] === undefined ? Infinity : nonNegativeInt(args['max-chunks'], 'max-chunks', 1);
const retries = nonNegativeInt(args.retries, 'retries', 0);

// `DB` is the binding name; wrangler resolves the database from hub/wrangler.jsonc, as
// hub/scripts/environment.mjs does for the local fixture prices.
const target = args['persist-to'] === undefined
  ? ['--remote', '--profile', args.profile]
  : ['--local', '--persist-to', path.resolve(args['persist-to'])];
const where = args['persist-to'] === undefined ? `remote:DB(profile ${args.profile})` : `local:DB(${path.resolve(args['persist-to'])})`;
const childEnv = { ...process.env };
for (const name of IGNORED_CF_ENV) delete childEnv[name];

class ExecuteError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind; // 'transient' | 'deterministic'
  }
}

function classify(text) {
  if (DETERMINISTIC_ERROR.test(text)) return 'deterministic';
  if (TRANSIENT_ERROR.test(text)) return 'transient';
  return 'deterministic';
}

function wrangler(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRANGLER_BIN, ...argv], {
      cwd: HUB_DIR,
      env: childEnv,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (data) => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', (data) => { stderr += data; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

/** One wrangler d1 execute; returns the single statement's `{ results, meta }`. Throws an
 * ExecuteError classed transient or deterministic on a nonzero exit, and deterministic on any
 * output that is not exactly one successful statement result. */
async function execute(sql) {
  const { code, signal, stdout, stderr } = await wrangler([
    'd1', 'execute', 'DB', '--config', CONFIG, ...target, '--json', '--command', sql,
  ]);
  if (code !== 0) {
    const detail = `wrangler exited ${code ?? signal}: ${`${stdout}\n${stderr}`.trim().slice(0, 2000)}`;
    throw new ExecuteError(detail, classify(`${stdout}\n${stderr}`));
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ExecuteError(`unparseable wrangler output: ${stdout.slice(0, 2000)}`, 'deterministic');
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || parsed[0]?.success !== true || !Array.isArray(parsed[0].results)) {
    throw new ExecuteError(`unexpected wrangler output: ${stdout.slice(0, 2000)}`, 'deterministic');
  }
  return parsed[0];
}

async function withRetries(label, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof ExecuteError)) throw error;
      if (error.kind === 'deterministic') throw new Error(`${label} failed (not retried, deterministic): ${error.message}`);
      if (attempt >= retries) throw new Error(`${label} failed after ${attempt + 1} attempt(s): ${error.message}`);
      const delayMs = Math.min(60_000, 2_000 * 2 ** attempt);
      console.error(JSON.stringify({ event: 'prune_heartbeats.retry', label, attempt: attempt + 1, delayMs, error: error.message }));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

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
