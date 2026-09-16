import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { priceUsage } from '../src/pricing-pass';
import { refreshSessionCostStatements } from '../src/session-cost';
import { VIEWER } from './hosts';

/** The session detail page's money: the header's subagent-inclusive figure, the per-model
 * breakdown, and the cost chips on the subagent list.
 *
 * Driven over HTTP against real D1 rather than by unit-testing the renderers, because what is
 * actually at stake is presentational: whether an unpriced model reads as free, whether a lower
 * bound reads as a total, and whether two models with IDENTICAL token counters get the same
 * cached share. The last of those is the reason `usage.cache_basis` exists — 100k input with 90k
 * cache reads is a 90% hit when the transcript counted the reads INSIDE input (Codex) and a 47%
 * hit when it counted them alongside (OMP, Claude Code) — so the conventions are separate
 * assertions on separate fixtures, not one parameterised row. The convention is a property of the
 * transcript source, which is why it is seeded on the usage row and not on the price catalog.
 *
 * Fixtures INSERT into `usage` and run the real pricing pass, for the same reason stats.test.ts
 * does: a fixture that priced rows its own way could agree with itself while disagreeing with
 * production.
 */

const testEnv = env as unknown as Env;

/** Pinned so no assertion depends on the wall clock; inside every price epoch seeded below. */
const TS = '2026-07-20T10:00:00.000Z';

const BREAKDOWN = 'cost-breakdown-session';
const HIT_RATE = 'cost-hit-rate-session';
const PARENT = 'cost-parent-session';
const CHILD = 'cost-child-session';
const UNPRICED = 'cost-unpriced-session';
const NO_USAGE = 'cost-no-usage-session';

/** One rate card for every model, easy to check by hand: 1/M input, 10/M output, 0.1/M cache read,
 * 2/M and 4/M cache writes. Nothing about cache accounting lives here any more — the catalog
 * described the provider API, and the numbers in `usage` are whatever the transcript source
 * wrote. */
async function seedPrice(model: string, effectiveFrom: string): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO model_prices
       (model, effective_from, litellm_key, provider, input_cost, output_cost, cache_read_cost,
        cache_write_5m_cost, cache_write_1h_cost, input_cost_batch, output_cost_batch,
        source, fetched_at)
     VALUES (?1, ?2, ?1, 'test', 1, 10, 0.1, 2, 4, NULL, NULL, 'test', '2026-07-01T00:00:00Z')`,
  )
    .bind(model, effectiveFrom)
    .run();
}

async function seedSession(sessionId: string, parent?: string): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO sessions (session_id, harness, machine_id, title, started_at, index_state, parent_session_id)
     VALUES (?1, 'claude-code', 'box', ?2, '2026-07-20T00:00:00Z', 'ready', ?3)`,
  )
    .bind(sessionId, `title-${sessionId}`, parent ?? null)
    .run();
}

async function seedUsage(
  sessionId: string,
  turnIndex: number,
  model: string,
  basis: 'disjoint' | 'subset' | null,
  tokens: Partial<{ input: number; output: number; reasoning: number; cacheRead: number; w5: number; w1h: number }>,
): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO usage (session_id, turn_index, ts, model, input_tokens, output_tokens, reasoning_tokens,
                        cache_read_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens, cache_basis)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  )
    .bind(
      sessionId,
      turnIndex,
      TS,
      model,
      tokens.input ?? 0,
      tokens.output ?? 0,
      tokens.reasoning ?? 0,
      tokens.cacheRead ?? 0,
      tokens.w5 ?? 0,
      tokens.w1h ?? 0,
      basis,
    )
    .run();
}

/** The `<details>` panel only, so an assertion cannot pass on a match somewhere else on the page
 * (the header carries dollars too, and the transcript carries arbitrary text). */
function panelOf(html: string): string {
  const start = html.indexOf('<details class="session-cost">');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = html.indexOf('</details>', start);
  return html.slice(start, end);
}

/** One model's row. Rows are ranked by cost, so nothing here may depend on row order. */
function rowOf(html: string, model: string): string {
  const rows = panelOf(html)
    .split('<tr>')
    .filter((row) => row.includes(`session-cost-model">${model}<`));
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function get(sessionId: string): Promise<string> {
  const res = await SELF.fetch(`${VIEWER}/s/${sessionId}`);
  expect(res.status).toBe(200);
  return res.text();
}

beforeAll(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM usage'),
    testEnv.DB.prepare('DELETE FROM sessions'),
    testEnv.DB.prepare('DELETE FROM model_prices'),
  ]);
  for (const model of [
    'subset-model',
    'disjoint-model',
    'partial-model',
    'mixed-model',
    'null-basis-model',
    'near-full-model',
    'full-model',
    'write-heavy-model',
  ]) {
    await seedPrice(model, '2026-01-01');
  }

  await seedSession(BREAKDOWN);
  // Identical counters under the two conventions, side by side in one table.
  await seedUsage(BREAKDOWN, 0, 'subset-model', 'subset', { input: 100_000, output: 10_000, cacheRead: 90_000, w5: 5_000, w1h: 1_000 });
  await seedUsage(BREAKDOWN, 1, 'disjoint-model', 'disjoint', { input: 100_000, output: 10_000, cacheRead: 90_000 });
  // One model, two transcript sources: an OMP sidecar counted its reads alongside input, a Codex
  // session counted them inside it. Both are archived here, so the model has no single convention.
  await seedUsage(BREAKDOWN, 2, 'mixed-model', 'disjoint', { input: 1_000, cacheRead: 90_000, w5: 6_000, w1h: 3_000 });
  await seedUsage(BREAKDOWN, 3, 'mixed-model', 'subset', { input: 200_000, cacheRead: 50_000 });
  // No price row at all: unpriceable today, and the pass leaves `usd` NULL. Its cached share is
  // still measurable, because the convention is on the row rather than in the catalog.
  await seedUsage(BREAKDOWN, 4, 'no-price-model', 'disjoint', { input: 1_000, output: 100, cacheRead: 9_000 });
  await seedUsage(BREAKDOWN, 5, 'partial-model', 'subset', { input: 1_000_000 });
  await seedUsage(BREAKDOWN, 6, 'partial-model', 'subset', { input: 1_000_000, reasoning: 2_000 });
  // Priced model, unrecognised transcript source: the convention is NULL, so the row is neither
  // priced nor counted in a cached share. Fail closed, visibly.
  await seedUsage(BREAKDOWN, 7, 'null-basis-model', null, { input: 50_000, cacheRead: 40_000 });

  await seedSession(HIT_RATE);
  await seedUsage(HIT_RATE, 0, 'near-full-model', 'disjoint', { input: 1_000, cacheRead: 1_999_000 });
  await seedUsage(HIT_RATE, 1, 'full-model', 'disjoint', { cacheRead: 100_000 });
  await seedUsage(HIT_RATE, 2, 'write-heavy-model', 'disjoint', { input: 1_000, cacheRead: 90_000, w5: 6_000, w1h: 3_000 });

  await seedSession(PARENT);
  await seedSession(CHILD, PARENT);
  await seedUsage(PARENT, 0, 'subset-model', 'subset', { input: 1_000_000 });
  // A DIFFERENT model in the subagent: the parent never called it, so it is the row the panel
  // used to drop while the header above already counted its dollars.
  await seedUsage(CHILD, 0, 'disjoint-model', 'disjoint', { input: 500_000 });

  await seedSession(UNPRICED);
  await seedUsage(UNPRICED, 0, 'no-price-model', 'disjoint', { input: 1_000 });

  await seedSession(NO_USAGE);

  await priceUsage(testEnv.DB, { maxRows: 1_000, now: new Date('2026-07-21T00:00:00.000Z') });
  // Mid-backfill mixture, forced rather than waited for: one priced row of `partial-model` rolled
  // back to unpriced, so its group is a lower bound and has to say so.
  await testEnv.DB.prepare('UPDATE usage SET usd = NULL WHERE session_id = ?1 AND turn_index = 6').bind(BREAKDOWN).run();
  await testEnv.DB.batch(refreshSessionCostStatements(testEnv.DB, [BREAKDOWN, HIT_RATE, PARENT, CHILD, UNPRICED, NO_USAGE]));
});

describe('session cost breakdown', () => {
  it('measures a subset-accounting cached share against input alone', async () => {
    // Codex records the cached tokens INSIDE input_tokens: 90k of the 100k prompt was cached.
    const row = rowOf(await get(BREAKDOWN), 'subset-model');
    expect(row).toContain('90.0%</td>');
    expect(row).toContain('cached tokens are reported as PART OF input_tokens');
  });

  it('measures a disjoint-accounting cached share against input plus cache read', async () => {
    // OMP and Claude Code record them ALONGSIDE input_tokens, so the same two counters describe a
    // 190k prompt: 90000 / 190000 is 47.36%, floored to 47.3% by the renderer, not 90%. Identical
    // fixture numbers, different answer.
    const row = rowOf(await get(BREAKDOWN), 'disjoint-model');
    expect(row).toContain('47.3%</td>');
    expect(row).toContain('cache reads are reported IN ADDITION TO input_tokens');
  });

  it('counts cache writes in a disjoint denominator', async () => {
    // A written token is a prompt token that MISSED. Without the two write terms this row divides
    // 90000 by 91000 and claims 98.9% for a session that spent most of its prompt rebuilding
    // cache; with them it is exactly 90000 / 100000.
    const row = rowOf(await get(HIT_RATE), 'write-heavy-model');
    expect(row).toContain('90.0%</td>');
    expect(row).not.toContain('98.9%');
    expect(row).toContain('cache write 5m + cache write 1h');
  });

  it('keeps a nearly-total cached share below 100%', async () => {
    // 1999000 / 2000000 is 99.95%, and rounding it to `100.0%` erases the one thing a reader
    // checks this column for: whether anything missed. Only an exact 1 may print 100.0%.
    expect(rowOf(await get(HIT_RATE), 'near-full-model')).toContain('99.9%</td>');
    expect(rowOf(await get(HIT_RATE), 'full-model')).toContain('100.0%</td>');
  });

  it('names a model recorded under both conventions as mixed instead of picking one', async () => {
    // Each source's calls are divided under their own convention and the halves summed:
    // (90000 + 50000) / (100000 + 200000) = 46.6%. Calling all four counters disjoint gives 40.0%
    // and calling them all subset gives 25.3%, so the row cannot borrow either wording.
    const row = rowOf(await get(BREAKDOWN), 'mixed-model');
    expect(row).toContain('46.6%</td>');
    expect(row).toContain('Mixed accounting');
  });

  it('measures a cached share for a model with no price row', async () => {
    // The original defect: the convention was read from the price catalog, so an uncatalogued
    // model had no measurable cached share either. 9000 / 10000 disjoint.
    const row = rowOf(await get(BREAKDOWN), 'no-price-model');
    expect(row).toContain('90.0%</td>');
  });

  it('withholds a cached share, and a price, for a call with no recorded convention', async () => {
    // The row has a rate card; what it lacks is any record of which counter its cache reads were
    // measured against, and the two answers differ by roughly the cache ratio itself. Both the
    // dollars and the share stay unknown rather than becoming 0.
    const row = rowOf(await get(BREAKDOWN), 'null-basis-model');
    expect(row).toContain('—</td>');
    expect(row).not.toMatch(/\d%<\/td>/);
    expect(row).not.toContain('$0.00');
    expect(row).toContain('No cache-accounting convention recorded');
    expect(row).toContain('Unpriced');
  });

  it('renders an unpriced model as unknown rather than as free', async () => {
    const row = rowOf(await get(BREAKDOWN), 'no-price-model');
    expect(row).toContain('<td class="num">—</td>');
    expect(row).not.toContain('$0.00');
    expect(row).toContain('Unpriced');
  });

  it('marks a partially priced model as a subtotal', async () => {
    const row = rowOf(await get(BREAKDOWN), 'partial-model');
    expect(row).toContain('$1.00 subtotal');
    expect(row).toContain('1 / 2 priced');
  });

  it('keeps input and cache read in separate columns and offers no combined total', async () => {
    // Summing them would double-count for every subset-accounting row in the table, so the
    // column set is part of the contract, not a layout detail.
    const headers = [...panelOf(await get(BREAKDOWN)).matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(headers).toEqual([
      'Model / coverage',
      'Calls',
      'Cost',
      'Input',
      'Output',
      'Reasoning',
      'Cache read',
      'Cache write',
      'Cache hit rate',
    ]);
  });

  it('puts the nine-column table in a focusable, labelled scroll region', async () => {
    // The table overflows horizontally on a narrow viewport, and an overflow box only scrolls by
    // keyboard if it is a focus stop; the label is what stops that stop being unexplained. Same
    // contract as the skills table, through the shared layout.tableScroll helper.
    expect(panelOf(await get(BREAKDOWN))).toContain(
      '<div class="stats-table-scroll" role="region" aria-label="Cost by model" tabindex="0"><table class="chart">',
    );
  });

  it('splits the 5m and 1h cache writes in the cell title', async () => {
    const row = rowOf(await get(BREAKDOWN), 'subset-model');
    expect(row).toContain('title="5,000 5m + 1,000 1h">6.0k</td>');
  });

  it("totals the session's own spend in the footer when it has no subagents", async () => {
    const panel = panelOf(await get(BREAKDOWN));
    const footer = panel.slice(panel.indexOf('<tfoot>'));
    expect(footer).toContain('This session only');
    expect(footer).toContain('excludes subagents');
    // 5 of 8 usage rows priced — no rate card, rolled back, and no recorded convention — so the
    // stored subtotal is a lower bound and says so.
    expect(footer).toContain('5 / 8 priced');
    expect(footer).toMatch(/\$[\d.]+ subtotal/);
    // Token columns ARE column sums, across every convention: they are counters, not ratios.
    expect(footer).toContain('title="2,452,000">2.5M</td>');
    expect(footer).toContain('title="369,000">369.0k</td>');
    // Nothing to roll up, so there is no second footer row to compare against.
    expect(footer).not.toContain('Including');
  });

  it("includes a subagent's own model and attributes the calls to the subagent", async () => {
    // The panel was scoped to the parent's own usage rows, so a fan-out to another model was
    // counted in the header's $1.50 and then absent from the only table that names models.
    const html = await get(PARENT);
    const row = rowOf(html, 'disjoint-model');
    expect(row).toContain('1 subagent only');
    expect(row).toContain('<td class="num">$0.50</td>');
    expect(row).toContain('title="500,000">500.0k</td>');
    expect(rowOf(html, 'subset-model')).toContain('this session only');
  });

  it('keeps this session and the rolled-up subtree as separate footer rows', async () => {
    const panel = panelOf(await get(PARENT));
    const footer = panel.slice(panel.indexOf('<tfoot>'));
    expect(footer).toContain('This session only');
    expect(footer).toContain('<td class="num">$1.00</td>');
    expect(footer).toContain('Including 1 subagent');
    expect(footer).toContain('<td class="num">$1.50</td>');
    // Own row excludes the subagent's 500k input; the rolled-up row includes it.
    expect(footer).toContain('title="1,000,000">1.0M</td>');
    expect(footer).toContain('title="1,500,000">1.5M</td>');
  });

  it('renders no panel for a session with no usage records', async () => {
    const html = await get(NO_USAGE);
    // The stylesheet is inline and unconditional, so this has to look for the markup.
    expect(html).not.toContain('<details class="session-cost">');
  });
});

describe('session cost header', () => {
  it('shows the subagent-inclusive cost and names the subagent count', async () => {
    // Parent's own 1M input is $1.00, the child's 500k is $0.50; the header is the subtree.
    const html = await get(PARENT);
    expect(html).toContain('cost: $1.50');
    expect(html).toContain('incl. 1 subagent');
    expect(html).toContain('title="2 / 2 priced · 1 subagent"');
    // The panel below covers the same subtree, so the subagent's model is one of its rows.
    expect(panelOf(html)).toContain('session-cost-model">disjoint-model<');
  });

  it("shows each subagent's own cost in the child list", async () => {
    const html = await get(PARENT);
    expect(html).toContain(`<a href="/s/${CHILD}">title-${CHILD}</a> <span class="chip" title="1 / 1 priced · 0 subagents">$0.50</span>`);
  });

  it('reports an entirely unpriced session as unknown', async () => {
    const html = await get(UNPRICED);
    expect(html).toContain('cost: unknown');
    expect(html).not.toContain('$0.00');
  });

  it('shows no cost line for a session with no usage records', async () => {
    const html = await get(NO_USAGE);
    expect(html).not.toContain('cost:');
  });
});
