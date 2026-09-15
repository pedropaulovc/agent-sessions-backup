import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { priceUsage } from '../src/pricing-pass';
import { refreshSessionCosts } from '../src/session-cost';
import { VIEWER } from './hosts';

/** The session detail page's money: the header's subagent-inclusive figure, the per-model
 * breakdown, and the cost chips on the subagent list.
 *
 * Driven over HTTP against real D1 rather than by unit-testing the renderers, because what is
 * actually at stake is presentational: whether an unpriced model reads as free, whether a lower
 * bound reads as a total, and whether two models with IDENTICAL token counters get the same
 * cached share. The last of those is the reason `cache_accounting` exists at all — 100k input
 * with 90k cache reads is a 90% hit under OpenAI's subset accounting and a 47% hit under
 * Anthropic's disjoint accounting — so the two conventions are separate assertions on separate
 * fixtures, not one parameterised row.
 *
 * Fixtures INSERT into `usage` and run the real pricing pass, for the same reason stats.test.ts
 * does: a fixture that priced rows its own way could agree with itself while disagreeing with
 * production.
 */

const testEnv = env as unknown as Env;

/** Pinned so no assertion depends on the wall clock; inside every price epoch seeded below. */
const TS = '2026-07-20T10:00:00.000Z';

const BREAKDOWN = 'cost-breakdown-session';
const PARENT = 'cost-parent-session';
const CHILD = 'cost-child-session';
const UNPRICED = 'cost-unpriced-session';
const NO_USAGE = 'cost-no-usage-session';

/** One rate card, easy to check by hand: 1/M input, 10/M output, 0.1/M cache read, 2/M and 4/M
 * cache writes. Only `cache_accounting` varies between the models below. */
async function seedPrice(model: string, accounting: 'subset' | 'disjoint', effectiveFrom: string): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO model_prices
       (model, effective_from, litellm_key, provider, input_cost, output_cost, cache_read_cost,
        cache_write_5m_cost, cache_write_1h_cost, input_cost_batch, output_cost_batch,
        cache_accounting, source, fetched_at)
     VALUES (?1, ?2, ?1, ?3, 1, 10, 0.1, 2, 4, NULL, NULL, ?4, 'test', '2026-07-01T00:00:00Z')`,
  )
    .bind(model, effectiveFrom, accounting === 'subset' ? 'openai' : 'anthropic', accounting)
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
  tokens: Partial<{ input: number; output: number; reasoning: number; cacheRead: number; w5: number; w1h: number }>,
): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO usage (session_id, turn_index, ts, model, input_tokens, output_tokens, reasoning_tokens,
                        cache_read_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
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
  await seedPrice('subset-model', 'subset', '2026-01-01');
  await seedPrice('disjoint-model', 'disjoint', '2026-01-01');
  await seedPrice('partial-model', 'subset', '2026-01-01');
  // One model, two snapshots, two conventions — the sync stores a new row when `provider` changes.
  // Priceable per turn, but with no single answer for a session-wide cached share.
  await seedPrice('split-basis-model', 'subset', '2026-01-01');
  await seedPrice('split-basis-model', 'disjoint', '2026-06-01');

  await seedSession(BREAKDOWN);
  // Identical counters under the two conventions, side by side in one table.
  await seedUsage(BREAKDOWN, 0, 'subset-model', { input: 100_000, output: 10_000, cacheRead: 90_000, w5: 5_000, w1h: 1_000 });
  await seedUsage(BREAKDOWN, 1, 'disjoint-model', { input: 100_000, output: 10_000, cacheRead: 90_000 });
  await seedUsage(BREAKDOWN, 2, 'split-basis-model', { input: 100_000, cacheRead: 90_000 });
  // No price row at all: unpriceable today, and the pass leaves `usd` NULL.
  await seedUsage(BREAKDOWN, 3, 'no-price-model', { input: 1_000, output: 100 });
  await seedUsage(BREAKDOWN, 4, 'partial-model', { input: 1_000_000 });
  await seedUsage(BREAKDOWN, 5, 'partial-model', { input: 1_000_000, reasoning: 2_000 });

  await seedSession(PARENT);
  await seedSession(CHILD, PARENT);
  await seedUsage(PARENT, 0, 'subset-model', { input: 1_000_000 });
  await seedUsage(CHILD, 0, 'subset-model', { input: 500_000 });

  await seedSession(UNPRICED);
  await seedUsage(UNPRICED, 0, 'no-price-model', { input: 1_000 });

  await seedSession(NO_USAGE);

  await priceUsage(testEnv.DB, { maxRows: 1_000, now: new Date('2026-07-21T00:00:00.000Z') });
  // Mid-backfill mixture, forced rather than waited for: one priced row of `partial-model` rolled
  // back to unpriced, so its group is a lower bound and has to say so.
  await testEnv.DB.prepare('UPDATE usage SET usd = NULL WHERE session_id = ?1 AND turn_index = 5').bind(BREAKDOWN).run();
  await refreshSessionCosts(testEnv.DB, [BREAKDOWN, PARENT, CHILD, UNPRICED, NO_USAGE]);
});

describe('session cost breakdown', () => {
  it('measures a subset-accounting cached share against input alone', async () => {
    // OpenAI reports the cached tokens INSIDE input_tokens: 90k of the 100k prompt was cached.
    const row = rowOf(await get(BREAKDOWN), 'subset-model');
    expect(row).toContain('90.0%</td>');
    expect(row).toContain('cached tokens are reported as PART OF input_tokens');
  });

  it('measures a disjoint-accounting cached share against input plus cache read', async () => {
    // Anthropic reports them ALONGSIDE input_tokens, so the same two counters describe a 190k
    // prompt: 90000 / 190000 = 47.4%, not 90%. Identical fixture numbers, different answer.
    const row = rowOf(await get(BREAKDOWN), 'disjoint-model');
    expect(row).toContain('47.4%</td>');
    expect(row).toContain('cached tokens are reported IN ADDITION TO input_tokens');
  });

  it('withholds a cached share when the price snapshots disagree about cache accounting', async () => {
    const row = rowOf(await get(BREAKDOWN), 'split-basis-model');
    expect(row).toContain('—</td>');
    expect(row).not.toMatch(/\d%<\/td>/);
    expect(row).toContain('No single published cache-accounting convention');
  });

  it('withholds a cached share for a model with no price row', async () => {
    const row = rowOf(await get(BREAKDOWN), 'no-price-model');
    expect(row).not.toMatch(/\d%<\/td>/);
    expect(row).toContain('No single published cache-accounting convention');
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
    // Summing them would double-count for every subset-accounting model in the table, so the
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

  it("totals the session's own spend in the footer, excluding subagents", async () => {
    const panel = panelOf(await get(BREAKDOWN));
    const footer = panel.slice(panel.indexOf('<tfoot>'));
    expect(footer).toContain('This session only');
    expect(footer).toContain('excludes subagents');
    // 4 of 6 usage rows priced, so the stored subtotal is a lower bound and says so.
    expect(footer).toContain('4 / 6 priced');
    expect(footer).toMatch(/\$[\d.]+ subtotal/);
    // Token columns ARE column sums: 100k + 100k + 100k + 1k + 1M + 1M input.
    expect(footer).toContain('title="2,301,000">2.3M</td>');
    expect(footer).toContain('title="270,000">270.0k</td>');
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
    // The panel below is the session's own spend only.
    expect(panelOf(html)).toContain('<td class="num">$1.00</td>');
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
