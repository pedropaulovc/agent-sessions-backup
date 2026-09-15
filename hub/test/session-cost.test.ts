import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  refreshSessionCostStatement,
  refreshSessionCosts,
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
  } = {},
): Promise<void> {
  const usd = row.usd ?? null;
  // The five-way split is stored alongside `usd` by the pricing pass. `breakdown: false` models a
  // row priced before that column existed — still priced, but with no split to sum.
  const split = usd !== null && row.breakdown !== false ? usd / 5 : null;
  await testEnv.DB.prepare(
    `INSERT INTO usage (session_id, turn_index, ts, model, input_tokens, output_tokens, reasoning_tokens,
                        cache_read_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens,
                        usd, usd_input, usd_output, usd_cache_read, usd_cache_write_5m, usd_cache_write_1h)
     VALUES (?1, ?2, '2026-07-20T00:00:00Z', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?11, ?11, ?11)`,
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
      usd,
      split,
    )
    .run();
}

async function seedPrice(model: string, accounting: 'disjoint' | 'subset', effectiveFrom = '2026-01-01'): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO model_prices
       (model, effective_from, litellm_key, provider, input_cost, output_cost, cache_read_cost,
        cache_write_5m_cost, cache_write_1h_cost, input_cost_batch, output_cost_batch,
        cache_accounting, source, fetched_at)
     VALUES (?1, ?2, ?1, 'test', 1, 10, 0.1, 2, 4, NULL, NULL, ?3, 'test', '2026-07-31T00:00:00Z')`,
  )
    .bind(model, effectiveFrom, accounting)
    .run();
}

beforeEach(async () => {
  await testEnv.DB.prepare('DELETE FROM usage').run();
  await testEnv.DB.prepare('DELETE FROM sessions').run();
  await testEnv.DB.prepare('DELETE FROM model_prices').run();
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

    await refreshSessionCosts(testEnv.DB, ids);

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

  it('measures the cached share against the convention the model is billed under', async () => {
    // Identical reported counters, two answers. Anthropic reports cache reads ALONGSIDE input, so
    // the prompt is input + cache_read; the OpenAI family reports them INSIDE input, so the prompt
    // is input alone. Using one convention for both is wrong by roughly the cache ratio itself —
    // the number most worth trusting on the page.
    await seedPrice('disjoint-model', 'disjoint');
    await seedPrice('subset-model', 'subset');
    await seedSession('hit-rate');
    await seedUsage('hit-rate', { model: 'disjoint-model', usd: 1, input: 100_000, cacheRead: 90_000 });
    await seedUsage('hit-rate', { model: 'subset-model', usd: 1, input: 100_000, cacheRead: 90_000 });

    const byModel = new Map((await sessionModelCosts(testEnv.DB, 'hit-rate')).map((r) => [r.model, r]));
    expect(byModel.get('disjoint-model')!.basis).toBe('disjoint');
    expect(byModel.get('disjoint-model')!.cacheHitRate).toBeCloseTo(90_000 / 190_000, 10);
    expect(byModel.get('subset-model')!.basis).toBe('subset');
    expect(byModel.get('subset-model')!.cacheHitRate).toBeCloseTo(0.9, 10);
  });

  it('cannot exceed 100% when a provider reports more cache reads than input', async () => {
    // Real rows do this: a subset-accounting provider can report a cached count that its own input
    // count does not cover. Dividing raw counters would print a 900% hit rate. The clamped sum from
    // usage-agg (MIN(cache_read, input) per row) is why this is capped at the prompt.
    await seedPrice('subset-model', 'subset');
    await seedSession('over-report');
    await seedUsage('over-report', { model: 'subset-model', usd: 1, input: 10_000, cacheRead: 90_000 });

    const [row] = await sessionModelCosts(testEnv.DB, 'over-report');
    expect(row!.cacheHitRate).toBe(1);
  });

  it('declines to compute a share when the model has no single accounting convention', async () => {
    // A model with no price row, and a model whose snapshots disagree (the sync writes a new
    // snapshot when the provider changes). Picking the newest would restate older turns under a
    // convention they were not billed by, so the page shows `—` instead.
    await seedPrice('switched-model', 'disjoint', '2026-01-01');
    await seedPrice('switched-model', 'subset', '2026-06-01');
    await seedSession('no-basis');
    await seedUsage('no-basis', { model: 'switched-model', usd: 1, input: 100, cacheRead: 50 });
    await seedUsage('no-basis', { model: 'uncatalogued-model', usd: null, input: 100, cacheRead: 50 });

    const byModel = new Map((await sessionModelCosts(testEnv.DB, 'no-basis')).map((r) => [r.model, r]));
    expect(byModel.get('switched-model')).toMatchObject({ basis: 'unknown', cacheHitRate: null });
    expect(byModel.get('uncatalogued-model')).toMatchObject({ basis: 'unknown', cacheHitRate: null });
  });

  it('has no rows for a session with no usage', async () => {
    await seedSession('quiet');
    expect(await sessionModelCosts(testEnv.DB, 'quiet')).toEqual([]);
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
