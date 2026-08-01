#!/usr/bin/env node
/**
 * Sync `model_prices` from LiteLLM's model_prices_and_context_window.json -- the same file
 * ccusage reads to price Claude Code sessions.
 *
 *   node scripts/sync-model-prices.mjs [--remote] [--dry-run] [--all]
 *
 * By default it prices only the models that actually appear in `usage.model` (~20 rows)
 * rather than all ~3000 upstream entries. `--all` overrides that.
 *
 * Writes a new row only when a rate CHANGES, so the table accumulates real price history
 * from repeated runs. Upstream publishes only the current price, so this snapshotting is the
 * only way a July session keeps pricing at July's rate after an August cut.
 *
 * Requires CLOUDFLARE_ACCOUNT_ID (wrangler cannot pick between two accounts non-interactively).
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// Coercion + validation shared verbatim with hub/src/cron/model-prices.ts. These two drifted
// three times in one review; the rules now live in one file.
import {
  assertLooksLikeCatalog,
  cacheAccountingFor,
  intOrNull,
  perM,
  priceKeyCandidates,
  providerOf,
} from '../hub/src/upstream-catalog.mjs';

const UPSTREAM =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const DB = 'sessions-index';
const ARGS = new Set(process.argv.slice(2));
const REMOTE = ARGS.has('--remote');
const DRY = ARGS.has('--dry-run');
const ALL = ARGS.has('--all');

const PER_MILLION = 1_000_000;
/** Upstream stores dollars per token; the table stores dollars per million tokens. */
// Round after scaling: 2e-8 * 1e6 lands on 0.019999999999999998 in binary float, which is
// numerically irrelevant but makes the stored table look untrustworthy.

const sqlStr = (v) => (v == null ? 'NULL' : `'${String(v).replaceAll("'", "''")}'`);

// Unlike the cron (hub/src/cron/model-prices.ts), which binds parameters, this script builds a
// SQL FILE and hands it to `wrangler d1 execute --remote` against the PRODUCTION database. A
// numeric literal is therefore interpolated unquoted, so anything that is not provably a finite
// number must never reach the statement: the values come from a third-party payload (LiteLLM's
// JSON), where a string like "1); DROP TABLE usage; --" would otherwise be spliced in verbatim.
// Throwing beats coercing to NULL — a malformed upstream field is a reason to stop and look, not
// to write a silently wrong price row.
const sqlNum = (v) => {
  if (v == null) return 'NULL';
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`refusing to inline non-numeric value into SQL: ${JSON.stringify(v)}`);
  }
  return String(v);
};

/** Upstream token limits are unvalidated JSON; coerce to a finite integer or drop them. */

function run(args) {
  return execFileSync('npx', ['wrangler', 'd1', 'execute', DB, REMOTE ? '--remote' : '--local', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    cwd: new URL('../hub/', import.meta.url).pathname,
    env: process.env,
  });
}

/** Multi-statement write. Goes through --file, which wrangler runs as a batch and answers
 * with summary stats rather than rows -- fine here, since nothing is read back. */
function d1Exec(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'mp-'));
  const file = join(dir, 'q.sql');
  writeFileSync(file, sql);
  return run(['--file', file]);
}

/** Single read query. MUST use --command: the --file path returns batch statistics
 * ("Total queries executed", "Rows read") instead of the SELECT's rows, which silently
 * yields an empty result set. */
function d1(sql) {
  const out = run(['--json', '--command', sql]);
  // wrangler interleaves ANSI-coloured banners with the payload, and those escapes contain
  // '[' -- so scan for a line that *starts* a JSON array rather than the first bracket.
  const clean = out.replace(/\[[0-9;]*m/g, '');
  const lines = clean.split('\n');
  const start = lines.findIndex((l) => l.trimEnd() === '[');
  if (start < 0) throw new Error(`no JSON array in wrangler output:\n${clean}`);
  return JSON.parse(lines.slice(start).join('\n'));
}

const isBillable = (m) => !!m && !m.startsWith('<');

/** Anthropic reports cache reads disjoint from input_tokens; OpenAI-family reports them as a
 * subset. Getting this backwards double-bills (or under-bills) every cached turn. */

function extract(entry, key, model, today) {
  const provider = providerOf(entry);
  return {
    model,
    effective_from: today,
    litellm_key: key,
    provider,
    input_cost: perM(entry.input_cost_per_token),
    output_cost: perM(entry.output_cost_per_token),
    cache_read_cost: perM(entry.cache_read_input_token_cost ?? entry.input_cost_per_token_cache_hit),
    cache_write_5m_cost: perM(entry.cache_creation_input_token_cost),
    // NULL when upstream omits the 1h rate -- never the 5m rate standing in for it. The 1h
    // write is 2x input where the 5m write is 1.25x, and storing the substitute made it
    // indistinguishable from a published rate, so the hub's missing-rate guard never fired.
    cache_write_1h_cost: perM(entry.cache_creation_input_token_cost_above_1hr),
    input_cost_batch: perM(entry.input_cost_per_token_batches),
    output_cost_batch: perM(entry.output_cost_per_token_batches),
    max_input_tokens: intOrNull(entry.max_input_tokens),
    max_output_tokens: intOrNull(entry.max_output_tokens),
    cache_accounting: cacheAccountingFor(provider),
  };
}

const RATE_COLS = [
  'input_cost',
  'output_cost',
  'cache_read_cost',
  'cache_write_5m_cost',
  'cache_write_1h_cost',
  'input_cost_batch',
  'output_cost_batch',
];

// Not rates, but they change what a row costs: cache_accounting is derived from provider, and
// flipping subset<->disjoint changes whether cache reads are charged on top of input or
// subtracted from it. Kept in lockstep with hub/src/cron/model-prices.ts.
const ACCOUNTING_COLS = ['provider', 'cache_accounting'];

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  process.stderr.write(`fetching ${UPSTREAM}\n`);
  const res = await fetch(UPSTREAM);
  if (!res.ok) throw new Error(`upstream fetch failed: ${res.status} ${res.statusText}`);
  const upstream = await res.json();
  // Same guard as the cron, from the same module: a 200 carrying `{}` or an error envelope would
  // otherwise resolve no models, write no rows, and exit 0 — a backfill that reports success
  // having done nothing, while prices stay stale.
  const entryCount = assertLooksLikeCatalog(upstream);
  process.stderr.write(`upstream entries: ${entryCount}\n`);

  let models;
  if (ALL) {
    models = Object.keys(upstream);
  } else {
    const r = d1('SELECT DISTINCT model FROM usage WHERE model IS NOT NULL');
    models = (r[0]?.results ?? []).map((x) => x.model).filter(isBillable);
  }
  process.stderr.write(`models to price: ${models.length}\n`);

  const existing = d1(
    `SELECT model, effective_from, ${RATE_COLS.join(', ')}, ${ACCOUNTING_COLS.join(', ')}
       FROM model_prices ORDER BY model, effective_from DESC`,
  )[0]?.results ?? [];
  const latest = new Map();
  for (const row of existing) if (!latest.has(row.model)) latest.set(row.model, row);

  const inserts = [];
  const unresolved = [];
  for (const model of models) {
    const key = priceKeyCandidates(model).find((c) => upstream[c]);
    if (!key) {
      unresolved.push(model);
      continue;
    }
    const next = extract(upstream[key], key, model, today);
    const prev = latest.get(model);
    // Only snapshot when a rate -- or the accounting convention -- actually moved. Re-running
    // daily must not grow the table.
    const changed =
      !prev ||
      RATE_COLS.some((c) => (prev[c] ?? null) !== (next[c] ?? null)) ||
      ACCOUNTING_COLS.some((c) => (prev[c] ?? null) !== (next[c] ?? null));
    if (changed) inserts.push(next);
  }

  process.stderr.write(
    `resolved ${models.length - unresolved.length}/${models.length}; ` +
      `${inserts.length} price change(s)${unresolved.length ? `; unresolved: ${unresolved.join(', ')}` : ''}\n`,
  );

  if (DRY) {
    console.log(JSON.stringify({ today, inserts, unresolved }, null, 2));
    return;
  }

  const stmts = inserts.map(
    (p) =>
      `INSERT OR REPLACE INTO model_prices (model, effective_from, litellm_key, provider,
        input_cost, output_cost, cache_read_cost, cache_write_5m_cost, cache_write_1h_cost,
        input_cost_batch, output_cost_batch, max_input_tokens, max_output_tokens,
        cache_accounting, source, fetched_at)
       VALUES (${sqlStr(p.model)}, ${sqlStr(p.effective_from)}, ${sqlStr(p.litellm_key)},
        ${sqlStr(p.provider)}, ${sqlNum(p.input_cost)}, ${sqlNum(p.output_cost)},
        ${sqlNum(p.cache_read_cost)}, ${sqlNum(p.cache_write_5m_cost)},
        ${sqlNum(p.cache_write_1h_cost)}, ${sqlNum(p.input_cost_batch)},
        ${sqlNum(p.output_cost_batch)}, ${sqlNum(p.max_input_tokens)},
        ${sqlNum(p.max_output_tokens)}, ${sqlStr(p.cache_accounting)}, 'litellm',
        ${sqlStr(new Date().toISOString())});`,
  );
  stmts.push(
    `INSERT INTO model_prices_sync (upstream_entries, models_seen, rows_inserted, unresolved, ok)
     VALUES (${entryCount}, ${models.length}, ${inserts.length}, ${sqlStr(JSON.stringify(unresolved))}, 1);`,
  );

  d1Exec(stmts.join("\n"));
  process.stderr.write(`wrote ${inserts.length} price row(s)\n`);
}

// Only when run directly. This script writes to a real database, and an `import()` of it -- to
// check that its module graph resolves, say -- otherwise executes the whole sync as a side effect.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    process.stderr.write(`sync-model-prices failed: ${e.message}\n`);
    process.exit(1);
  });
}
