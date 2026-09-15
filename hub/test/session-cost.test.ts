import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  refreshSessionCostStatement,
  refreshSessionCostStatements,
  sessionModelCosts,
  sessionSubtreeCosts,
} from '../src/session-cost';

/** The per-session cost layer the session list and detail page read.
 *
 * Migration 0028's backfill is covered in test/migrations.acceptance.mjs against the real
 * migration bytes; this file covers what happens afterwards — the rollup across subagents, the
 * refresh that keeps the stored subtotal honest, and the per-model breakdown.
 *
 * Fixtures write `usage.usd` and the `sessions.cost_*` columns directly. That is deliberate: the
 * pricing pass and the ingest write path are what maintain them in production and are tested where
 * they live, and pinning these assertions to the pricing catalog would make them fail whenever a
 * rate changed, for reasons that have nothing to do with rolling costs up a session tree.
 */

const testEnv = env as unknown as Env;

async function seedSession(
  sessionId: string,
  cost: { usd?: number | null; calls?: number; priced?: number; parent?: string } = {},
): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO sessions (session_id, harness, index_state, parent_session_id,
                           cost_usd, cost_calls, cost_priced_calls)
     VALUES (?1, 'claude-code', 'ready', ?2, ?3, ?4, ?5)`,
  )
    .bind(sessionId, cost.parent ?? null, cost.usd ?? null, cost.calls ?? 0, cost.priced ?? 0)
    .run();
}

let turn = 0;
async function seedUsage(
  sessionId: string,
  row: {
    model?: string | null;
    usd?: number | null;
    input?: number;
    output?: number;
    reasoning?: number;
    cacheRead?: number;
    w5?: number;
    w1h?: number;
    breakdown?: boolean;
    /** What the transcript source counted cache reads against; NULL for an unrecognised one. */
    basis?: 'disjoint' | 'subset' | null;
  } = {},
): Promise<void> {
  const usd = row.usd ?? null;
  // The five-way split is stored alongside `usd` by the pricing pass. `breakdown: false` models a
  // row priced before that column existed — still priced, but with no split to sum.
  const split = usd !== null && row.breakdown !== false ? usd / 5 : null;
  // `basis` defaults to the convention ingest records for the harness these fixtures seed
  // (claude-code, i.e. Anthropic-raw counters), so a row only names it when that is the point.
  const basis = row.basis === undefined ? 'disjoint' : row.basis;
  await testEnv.DB.prepare(
    `INSERT INTO usage (session_id, turn_index, ts, model, input_tokens, output_tokens, reasoning_tokens,
                        cache_read_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens, cache_basis,
                        usd, usd_input, usd_output, usd_cache_read, usd_cache_write_5m, usd_cache_write_1h)
     VALUES (?1, ?2, '2026-07-20T00:00:00Z', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?12, ?12, ?12)`,
  )
    .bind(
      sessionId,
      turn++,
      row.model === undefined ? 'm1' : row.model,
      row.input ?? 0,
      row.output ?? 0,
      row.reasoning ?? 0,
      row.cacheRead ?? 0,
      row.w5 ?? 0,
      row.w1h ?? 0,
      basis,
      usd,
      split,
    )
    .run();
}

beforeEach(async () => {
  // No `model_prices` cleanup, because nothing here seeds it: the cached-share convention is read
  // from the usage row that recorded it, so the price catalog has no say in these assertions.
  await testEnv.DB.prepare('DELETE FROM usage').run();
  await testEnv.DB.prepare('DELETE FROM sessions').run();
  turn = 0;
});

describe('subagent rollup', () => {
  it('folds descendants at every depth into the root figure', async () => {
    // A three-level tree, because a single JOIN on parent_session_id would pass a two-level test
    // and silently drop the grandchild's spend — which for an agent harness is where most of the
    // money is.
    await seedSession('root', { usd: 1, calls: 2, priced: 2 });
    await seedSession('child', { usd: 2, calls: 3, priced: 3, parent: 'root' });
    await seedSession('grandchild', { usd: 4, calls: 1, priced: 1, parent: 'child' });

    const costs = await sessionSubtreeCosts(testEnv.DB, ['root', 'child', 'grandchild']);
    expect(costs.get('root')).toEqual({ usd: 7, calls: 6, pricedCalls: 6, subagentSessions: 2 });
    expect(costs.get('child')).toEqual({ usd: 6, calls: 4, pricedCalls: 4, subagentSessions: 1 });
    expect(costs.get('grandchild')).toEqual({ usd: 4, calls: 1, pricedCalls: 1, subagentSessions: 0 });
  });

  it('keeps an unpriced descendant visible as unpriced instead of as free', async () => {
    // The failure this prevents: a parent whose subagents did all the work, rendered as a
    // confident total that silently excludes them. `pricedCalls < calls` is what makes the viewer
    // label the figure a subtotal, so the rollup has to carry both counts, not just the dollars.
    await seedSession('partial-root', { usd: 1.5, calls: 1, priced: 1 });
    await seedSession('partial-child', { usd: null, calls: 4, priced: 0, parent: 'partial-root' });

    expect((await sessionSubtreeCosts(testEnv.DB, ['partial-root'])).get('partial-root')).toEqual({
      usd: 1.5,
      calls: 5,
      pricedCalls: 1,
      subagentSessions: 1,
    });

    // Nothing priced anywhere in the subtree: no known subtotal at all, which is not $0.00.
    await seedSession('dark-root', { usd: null, calls: 2, priced: 0 });
    await seedSession('dark-child', { usd: null, calls: 2, priced: 0, parent: 'dark-root' });
    expect((await sessionSubtreeCosts(testEnv.DB, ['dark-root'])).get('dark-root')).toEqual({
      usd: null,
      calls: 4,
      pricedCalls: 0,
      subagentSessions: 1,
    });
  });

  it('terminates and counts each session once when parent links form a cycle', async () => {
    // `parent_session_id` has no foreign key and no acyclicity guarantee: a parser can link a
    // session to itself, and a session re-ingested under a changed parent can close a loop. With
    // UNION ALL this query recurses until D1 kills the request — a page that never renders.
    await seedSession('loop-a', { usd: 1, calls: 1, priced: 1, parent: 'loop-b' });
    await seedSession('loop-b', { usd: 2, calls: 1, priced: 1, parent: 'loop-a' });
    await seedSession('self', { usd: 8, calls: 1, priced: 1, parent: 'self' });

    const costs = await sessionSubtreeCosts(testEnv.DB, ['loop-a', 'self']);
    expect(costs.get('loop-a')).toEqual({ usd: 3, calls: 2, pricedCalls: 2, subagentSessions: 1 });
    expect(costs.get('self')).toEqual({ usd: 8, calls: 1, pricedCalls: 1, subagentSessions: 0 });
  });

  it('omits ids that name no session rather than reporting them as zero', async () => {
    const costs = await sessionSubtreeCosts(testEnv.DB, ['ghost']);
    expect(costs.has('ghost')).toBe(false);
  });
});

describe('stored subtotal refresh', () => {
  it('recomputes dollars and both counts from the session usage rows', async () => {
    await seedSession('refresh-me');
    await seedUsage('refresh-me', { usd: 0.25 });
    await seedUsage('refresh-me', { usd: 0.75 });
    await seedUsage('refresh-me', { model: 'brand-new-model', usd: null });

    await refreshSessionCostStatement(testEnv.DB, ['refresh-me']).run();

    expect(await storedCost('refresh-me')).toEqual({ cost_usd: 1, cost_calls: 3, cost_priced_calls: 2 });
  });

  it('zeroes a session whose usage rows are gone', async () => {
    // The reason the refresh uses correlated subqueries instead of joining a grouped aggregate: a
    // re-parse that shrinks a session, or the index-clearing path, leaves it with NO usage rows and
    // therefore no aggregate row to join to. The join form would preserve the old subtotal forever
    // — a session showing dollars it no longer has any records for.
    await seedSession('emptied', { usd: 9.5, calls: 4, priced: 4 });
    await seedUsage('emptied', { usd: 9.5 });
    await testEnv.DB.prepare('DELETE FROM usage WHERE session_id = ?1').bind('emptied').run();

    await refreshSessionCostStatement(testEnv.DB, ['emptied']).run();

    expect(await storedCost('emptied')).toEqual({ cost_usd: null, cost_calls: 0, cost_priced_calls: 0 });
  });

  it('refreshes more sessions than fit in one statement', async () => {
    // D1 caps a statement at 100 bound parameters. The pricing pass hands this function every
    // session a 500-row read touched, so an unchunked IN list would throw — and a chunk loop with
    // an off-by-one would silently leave the tail of the archive stale.
    const ids = Array.from({ length: 95 }, (_, i) => `bulk-${String(i).padStart(3, '0')}`);
    for (const id of ids) {
      await seedSession(id);
      await seedUsage(id, { usd: 0.5 });
    }

    await testEnv.DB.batch(refreshSessionCostStatements(testEnv.DB, ids));

    const stale = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM sessions WHERE session_id LIKE 'bulk-%' AND (cost_usd IS NOT 0.5 OR cost_calls != 1)`,
    ).first<{ n: number }>();
    expect(stale?.n).toBe(0);
  });
});

describe('per-model breakdown', () => {
  it('splits a session by model and keeps unpriced models unpriced', async () => {
    await seedSession('by-model');
    await seedUsage('by-model', { model: 'm1', usd: 1, input: 1000, output: 200, reasoning: 50 });
    await seedUsage('by-model', { model: 'm1', usd: 2, input: 3000, output: 400, w5: 120, w1h: 80 });
    await seedUsage('by-model', { model: 'm2', usd: null, input: 700 });
    await seedUsage('by-model', { model: null, usd: null, input: 5 });

    const rows = await sessionModelCosts(testEnv.DB, 'by-model');
    // Ranked by known cost, so the model that actually spent money leads. Groups with no known
    // cost tie on dollars and then on calls, and fall back to the label for a stable order.
    expect(rows.map((r) => r.model)).toEqual(['m1', '(unknown)', 'm2']);

    const m1 = rows[0];
    const m2 = rows[2];
    expect(m1).toMatchObject({ calls: 2, pricedCalls: 2, usd: 3, staleBreakdownCalls: 0 });
    expect(m1!.tokens).toEqual({ input: 4000, output: 600, reasoning: 50, cacheRead: 0, cacheWrite5m: 120, cacheWrite1h: 80 });
    // Unpriced stays null all the way to the renderer, which turns it into `—`. A 0 here would be
    // indistinguishable from a sentinel model that genuinely cost nothing.
    expect(m2).toMatchObject({ calls: 1, pricedCalls: 0, usd: null, byClass: null });
  });

  it('reports a priced row with no stored split as priced but unsplit', async () => {
    // `staleBreakdownCalls` exists so a per-class view cannot quietly under-report: the row has a
    // total, and its five-way split is NULL because it was priced before that column existed.
    await seedSession('stale-split');
    await seedUsage('stale-split', { model: 'm1', usd: 4, input: 10, breakdown: false });

    const [row] = await sessionModelCosts(testEnv.DB, 'stale-split');
    expect(row).toMatchObject({ usd: 4, pricedCalls: 1, staleBreakdownCalls: 1, byClass: null });
  });

  it('counts cache writes in the disjoint denominator', async () => {
    // A written token is a prompt token that MISSED, so it belongs in the denominator with the
    // reads. Leaving the two write terms out divides 90000 by 91000 and reports 98.9% for a
    // session that spent nine tenths of its prompt rebuilding cache — the exact shape of the
    // "this session never missed" number that was wrong on the page.
    await seedSession('disjoint-share');
    await seedUsage('disjoint-share', {
      model: 'omp-model',
      usd: 1,
      basis: 'disjoint',
      input: 1_000,
      cacheRead: 90_000,
      w5: 6_000,
      w1h: 3_000,
    });

    const [row] = await sessionModelCosts(testEnv.DB, 'disjoint-share');
    expect(row).toMatchObject({ basis: 'disjoint' });
    // 90000 / (1000 + 90000 + 6000 + 3000), exactly — not 90000 / 91000.
    expect(row!.cacheHitRate).toBe(0.9);
  });

  it('divides a subset row by the input its cached tokens are part of', async () => {
    // Codex writes the cached count INSIDE input_tokens, so the 100k prompt already contains the
    // 90k that hit and adding them again would describe a prompt that was never sent. The same two
    // counters written by an OMP sidecar mean a 190k prompt and a 47% hit — which is why the
    // convention is recorded per row rather than per model.
    await seedSession('subset-share');
    await seedUsage('subset-share', { model: 'codex-model', usd: 1, basis: 'subset', input: 100_000, cacheRead: 90_000 });
    await seedUsage('subset-share', { model: 'omp-model', usd: 1, basis: 'disjoint', input: 100_000, cacheRead: 90_000 });

    const byModel = new Map((await sessionModelCosts(testEnv.DB, 'subset-share')).map((r) => [r.model, r]));
    expect(byModel.get('codex-model')).toMatchObject({ basis: 'subset' });
    expect(byModel.get('codex-model')!.cacheHitRate).toBeCloseTo(0.9, 10);
    expect(byModel.get('omp-model')).toMatchObject({ basis: 'disjoint' });
    expect(byModel.get('omp-model')!.cacheHitRate).toBeCloseTo(90_000 / 190_000, 10);
  });

  it('cannot exceed 100% when a source reports more cache reads than input', async () => {
    // Real rows do this: a subset-accounting source can report a cached count that its own input
    // count does not cover. Dividing raw counters would print a 900% hit rate. The clamped sum from
    // usage-agg (MIN(cache_read, input) per row) is why this is capped at the prompt.
    await seedSession('over-report');
    await seedUsage('over-report', { model: 'codex-model', usd: 1, basis: 'subset', input: 10_000, cacheRead: 90_000 });

    const [row] = await sessionModelCosts(testEnv.DB, 'over-report');
    expect(row!.cacheHitRate).toBe(1);
  });

  it('accumulates each convention separately for a model recorded under both', async () => {
    // One model, two sources — an OMP sidecar and a Codex session, both archived here — which is
    // the case a per-MODEL convention could not express at all. Each group is divided by its own
    // denominator and the halves summed: 140000 / 300000. Applying either convention to both rows
    // instead gives 40.0% (all disjoint) or 25.4% (all subset), and the clamps in
    // USAGE_TOKEN_SUMS are per row, so only the SQL grouping can keep them apart.
    await seedSession('mixed-basis');
    await seedUsage('mixed-basis', {
      model: 'shared-model',
      usd: 1,
      basis: 'disjoint',
      input: 1_000,
      cacheRead: 90_000,
      w5: 6_000,
      w1h: 3_000,
    });
    await seedUsage('mixed-basis', { model: 'shared-model', usd: 2, basis: 'subset', input: 200_000, cacheRead: 50_000 });

    const [row] = await sessionModelCosts(testEnv.DB, 'mixed-basis');
    expect(row).toMatchObject({ basis: 'mixed', calls: 2, usd: 3 });
    expect(row!.cacheHitRate).toBeCloseTo(140_000 / 300_000, 10);
    // The convention is now part of the group key, and one session can hold rows of both, so the
    // distinct-session count has to come from outside that grouping or this reads as 2 sessions.
    expect(row!.sessions).toBe(1);
  });

  it('excludes a row with no recorded convention from the share rather than calling it 0%', async () => {
    // An unrecognised transcript source has no defensible convention, and the two answers differ by
    // roughly the cache ratio itself, so NULL stays distinct from zero all the way to the renderer:
    // a 0% hit rate on an almost entirely cached session is worse than no answer. A model with SOME
    // unclassified rows is `mixed` for the same reason — its share covers only the rows that could
    // be measured, so claiming it is disjoint would overstate what was checked.
    await seedSession('null-basis');
    await seedUsage('null-basis', { model: 'unclassified-model', usd: null, basis: null, input: 100, cacheRead: 50 });
    await seedUsage('null-basis', { model: 'partly-classified-model', usd: null, basis: null, input: 100, cacheRead: 50 });
    await seedUsage('null-basis', { model: 'partly-classified-model', usd: 1, basis: 'disjoint', input: 1_000, cacheRead: 9_000 });

    const byModel = new Map((await sessionModelCosts(testEnv.DB, 'null-basis')).map((r) => [r.model, r]));
    expect(byModel.get('unclassified-model')).toMatchObject({ basis: 'unknown', cacheHitRate: null });
    expect(byModel.get('partly-classified-model')).toMatchObject({ basis: 'mixed' });
    expect(byModel.get('partly-classified-model')!.cacheHitRate).toBeCloseTo(0.9, 10);
  });

  it('measures the cached share of a model that has no price row at all', async () => {
    // The original defect in miniature: the convention was read from the price catalog, so a model
    // nobody had published rates for had no measurable cache share either — two unrelated unknowns
    // wired together. Both the counters and the convention are on the usage row now, so an
    // unpriced model still reports how much of its prompt was cached.
    await seedSession('unpriced-share');
    await seedUsage('unpriced-share', { model: 'brand-new-model', usd: null, basis: 'disjoint', input: 10_000, cacheRead: 90_000 });

    const [row] = await sessionModelCosts(testEnv.DB, 'unpriced-share');
    expect(row).toMatchObject({ usd: null, basis: 'disjoint' });
    expect(row!.cacheHitRate).toBeCloseTo(0.9, 10);
  });

  it('has no rows for a session with no usage', async () => {
    await seedSession('quiet');
    expect(await sessionModelCosts(testEnv.DB, 'quiet')).toEqual([]);
  });

  it('includes subagent models at every depth and marks the ones this session never ran', async () => {
    // The bug this covers: a fan-out to a different model counted in the header's rolled-up
    // dollars and appeared nowhere in the only table that names models, so the model read as
    // absent rather than as out of scope. Three levels, because a single JOIN on
    // parent_session_id would pass a two-level test and drop the grandchild.
    await seedSession('fan-parent');
    await seedSession('fan-child', { parent: 'fan-parent' });
    await seedSession('fan-grandchild', { parent: 'fan-child' });
    await seedSession('fan-elsewhere');
    await seedUsage('fan-parent', { model: 'opus', usd: 1, input: 100 });
    await seedUsage('fan-child', { model: 'opus', usd: 8, input: 800 });
    await seedUsage('fan-child', { model: 'luna', usd: 2, input: 200 });
    await seedUsage('fan-grandchild', { model: 'luna', usd: 4, input: 400 });
    await seedUsage('fan-elsewhere', { model: 'sol', usd: 16, input: 1600 });

    const rows = await sessionModelCosts(testEnv.DB, 'fan-parent');
    // A session outside the subtree contributes nothing, at any rank.
    expect(rows.map((r) => r.model)).toEqual(['opus', 'luna']);
    const byModel = new Map(rows.map((r) => [r.model, r]));
    expect(byModel.get('luna')).toMatchObject({ usd: 6, calls: 2, sessions: 2, own: null });
    expect(byModel.get('luna')!.tokens.input).toBe(600);
    // The parent's own share stays separable under a row that now includes its subagents'.
    expect(byModel.get('opus')).toMatchObject({ usd: 9, calls: 2, sessions: 2 });
    expect(byModel.get('opus')!.own).toEqual({
      calls: 1,
      tokens: { input: 100, output: 0, reasoning: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    });
  });

  it('merges an unpriced subagent scope without making a model look free or cheaper', async () => {
    // Two scopes per model are folded in JS, where null has to keep meaning "no stored cost in
    // this scope": SUM would have turned the unpriced half into $0 and the fully unpriced model
    // into a free one.
    await seedSession('merge-parent');
    await seedSession('merge-child', { parent: 'merge-parent' });
    await seedUsage('merge-parent', { model: 'm1', usd: 3, input: 10 });
    await seedUsage('merge-child', { model: 'm1', usd: null, input: 10 });
    await seedUsage('merge-child', { model: 'm2', usd: null, input: 10 });

    const byModel = new Map((await sessionModelCosts(testEnv.DB, 'merge-parent')).map((r) => [r.model, r]));
    expect(byModel.get('m1')).toMatchObject({ usd: 3, calls: 2, pricedCalls: 1 });
    expect(byModel.get('m2')).toMatchObject({ usd: null, pricedCalls: 0, own: null });
  });
});

async function storedCost(sessionId: string): Promise<unknown> {
  return {
    ...(await testEnv.DB.prepare(
      'SELECT cost_usd, cost_calls, cost_priced_calls FROM sessions WHERE session_id = ?1',
    )
      .bind(sessionId)
      .first()),
  };
}
