import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker';

/** The scheduled-handler routing. Pricing "stays current automatically" only if the daily cron
 * actually reaches runModelPriceSync — a mis-typed cron string here fails silently forever:
 * nothing errors, the table simply stops updating and every dollar figure quietly goes stale.
 *
 * This drives the REAL handler and asserts on what the sync leaves behind (a `model_prices_sync`
 * audit row), rather than mocking the module out — mocking would have re-verified the test's own
 * wiring instead of the worker's. */

const testEnv = env as unknown as Env;

async function auditCount(): Promise<number> {
  const r = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM model_prices_sync').first<{ n: number }>();
  return r?.n ?? 0;
}

/** Collects waitUntil promises so assertions run after the handler's async work completes. */
function ctx(): ExecutionContext & { settled: () => Promise<unknown[]> } {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => pending.push(p.catch(() => {})),
    passThroughOnException: () => {},
    props: {},
    settled: () => Promise.all(pending),
  } as unknown as ExecutionContext & { settled: () => Promise<unknown[]> };
}

async function fire(cron: string): Promise<void> {
  const c = ctx();
  await worker.scheduled!({ cron, scheduledTime: 0, noRetry: () => {} } as ScheduledController, testEnv, c);
  await c.settled();
}

beforeEach(async () => {
  await testEnv.DB.prepare('DELETE FROM model_prices_sync').run();
  await testEnv.DB.prepare('DELETE FROM model_prices').run();
  // The sync only prices models it can SEE in `usage`, so without a usage row the daily cron
  // succeeds having written nothing — which is indistinguishable from a broken cron.
  await testEnv.DB.prepare('DELETE FROM usage').run();
  await testEnv.DB.prepare(
    `INSERT OR IGNORE INTO sessions (session_id, harness, index_state) VALUES ('cron-sess', 'claude-code', 'ready')`,
  ).run();
  // The session is a claude-code one, so its rows carry Anthropic's disjoint counters. Without a
  // recorded basis the pricing pass leaves the row unpriced by design, and the assertion below
  // that the cron priced it would fail for a reason that has nothing to do with the cron.
  await testEnv.DB.prepare(
    `INSERT INTO usage (session_id, turn_index, ts, model, cache_basis)
     VALUES ('cron-sess', 1, '2026-07-01T00:00:00Z', 'claude-opus-5', 'disjoint')`,
  ).run();
  // A REAL catalog, not `{}`. An empty object is rejected by assertLooksLikeCatalog, so the sync
  // wrote an ok=0 audit row and rethrew into ctx()'s swallowed promise — and a bare "one audit row
  // exists" assertion passed anyway. That made this test green for a cron that never refreshed a
  // single price, which is precisely the regression it exists to catch.
  const catalog: Record<string, unknown> = {
    'claude-opus-5': {
      litellm_provider: 'anthropic',
      input_cost_per_token: 5e-6,
      output_cost_per_token: 25e-6,
    },
  };
  for (let i = 0; i < 200; i++) {
    catalog[`filler-model-${i}`] = { litellm_provider: 'openai', input_cost_per_token: 1e-9, output_cost_per_token: 1e-9 };
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(catalog), { status: 200 })),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('scheduled handler', () => {
  it('refreshes model prices on the daily cron', async () => {
    await fire('37 4 * * *');
    expect(await auditCount(), 'the daily cron never reached runModelPriceSync').toBe(1);
    // Reaching the sync is not the same as the sync WORKING. Assert the run succeeded and that a
    // price actually landed, or a change that makes every cron sync fail stays green here.
    const sync = (
      await testEnv.DB.prepare('SELECT ok, error FROM model_prices_sync ORDER BY id DESC LIMIT 1').all<{
        ok: number;
        error: string | null;
      }>()
    ).results[0]!;
    expect(sync.ok, `the daily sync failed: ${sync.error}`).toBe(1);
    const prices = (
      await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM model_prices').all<{ n: number }>()
    ).results[0]!;
    expect(prices.n, 'the cron ran but wrote no prices').toBeGreaterThan(0);
  });

  it('prices unpriced usage rows AFTER the sync, using the rates it just wrote', async () => {
    // The ordering is the assertion. The pricing pass runs after runModelPriceSync in the daily
    // sequence, because a model whose rate upstream published TODAY would otherwise be examined
    // before that rate landed, be recorded as unpriceable, and stay that way for another full day.
    // The seeded row's model exists ONLY in the catalog this cron fetches -- `model_prices` is
    // emptied in beforeEach -- so a pass that ran first cannot price it.
    await testEnv.DB.prepare('UPDATE usage SET input_tokens = 1000000 WHERE session_id = ?1').bind('cron-sess').run();

    await fire('37 4 * * *');

    const row = await testEnv.DB.prepare('SELECT usd, price_epoch FROM usage WHERE session_id = ?1')
      .bind('cron-sess')
      .first<{ usd: number | null; price_epoch: string | null }>();
    // 1M input tokens at the catalog's 5e-6/token = $5/M.
    expect(row?.usd, 'the daily cron never reached the pricing pass, or ran it before the sync').toBeCloseTo(5, 6);
    expect(row?.price_epoch, 'priced without recording which snapshot was used').not.toBeNull();
  });

  it('still prices when the upstream sync fails', async () => {
    // runModelPriceSync RETHROWS after writing its audit row, so a sequence that stops on the first
    // failure would skip the pricing pass on any upstream hiccup.
    // A stale catalog is not a reason to stop pricing: the rows that need it mostly need rates
    // that already exist, and a backfill in progress must not be held hostage to a 500 from
    // GitHub raw. Failing the fetch is the whole fixture.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream is down', { status: 500 })),
    );
    await testEnv.DB.prepare(
      `INSERT INTO model_prices (model, effective_from, litellm_key, provider, input_cost, output_cost,
                                 cache_read_cost, cache_write_5m_cost, cache_write_1h_cost,
                                 source, fetched_at)
       VALUES ('claude-opus-5', '2026-01-01', 'claude-opus-5', 'anthropic', 1, 1, 0.1, 2, 4,
               'test', '2026-06-01T00:00:00Z')`,
    ).run();
    await testEnv.DB.prepare('UPDATE usage SET input_tokens = 1000000 WHERE session_id = ?1').bind('cron-sess').run();

    await fire('37 4 * * *');

    // Assert the FAILURE actually happened before asserting what survived it. The pricing
    // assertion alone would also pass if the handler stopped calling runModelPriceSync alogether,
    // at which point this test would quietly stop covering the path it is named for.
    expect(fetch, 'the sync never ran, so nothing failed and this proves nothing').toHaveBeenCalled();
    const sync = await testEnv.DB.prepare('SELECT ok, error FROM model_prices_sync ORDER BY id DESC LIMIT 1')
      .first<{ ok: number; error: string | null }>();
    expect(sync?.ok, 'the sync succeeded, so the pass was never chained off a rejection').toBe(0);
    expect(sync?.error, 'a failed sync recorded no reason').toBeTruthy();

    const row = await testEnv.DB.prepare('SELECT usd FROM usage WHERE session_id = ?1')
      .bind('cron-sess')
      .first<{ usd: number | null }>();
    expect(row?.usd, 'a failed price sync took the pricing pass down with it').toBeCloseTo(1, 6);
  });

  it('runs every later daily step when an earlier one throws, and logs the failed step', async () => {
    // The first step (staging prune) lists R2. Failing it must not take the rest of the daily
    // sequence down: the sync and the pricing pass after it still have to land.
    let listCalls = 0;
    const list = vi.spyOn(testEnv.RAW, 'list').mockImplementation(async () => {
      listCalls++;
      throw new Error('r2 list unavailable');
    });
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(String(args[0])); });
    await testEnv.DB.prepare('UPDATE usage SET input_tokens = 1000000 WHERE session_id = ?1').bind('cron-sess').run();

    try {
      await fire('37 4 * * *');
    } finally {
      list.mockRestore();
      errorSpy.mockRestore();
    }

    // Positive control: the prune really failed, so the later steps ran PAST a failure. Counted by
    // hand because mockRestore() above also clears the spy's recorded calls.
    expect(listCalls).toBeGreaterThan(0);
    const failed = errors.map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((o) => o.event === 'hub.cron.daily_step_failed');
    expect(failed).toEqual([{ event: 'hub.cron.daily_step_failed', step: 'prune', error: 'r2 list unavailable' }]);
    expect(await auditCount(), 'a failed prune skipped the price sync').toBe(1);
    const row = await testEnv.DB.prepare('SELECT usd FROM usage WHERE session_id = ?1')
      .bind('cron-sess')
      .first<{ usd: number | null }>();
    expect(row?.usd, 'a failed prune skipped the pricing pass').toBeCloseTo(5, 6);
  });

  it('does not refresh prices on the 15-minute watchdog tick', async () => {
    // 96 needless upstream fetches a day, and 96 audit rows, if these ever get crossed.
    await fire('*/15 * * * *');
    // Assert the fetch, not just the audit row: a sync that fetches and then FAILS writes an
    // audit row too, so the count alone cannot tell "never ran" from "ran and errored".
    expect(fetch, 'the watchdog tick hit the upstream catalog').not.toHaveBeenCalled();
    expect(await auditCount()).toBe(0);
  });

  it('ignores a cron string it does not recognise', async () => {
    await fire('0 0 1 1 *');
    expect(await auditCount()).toBe(0);
  });
});
