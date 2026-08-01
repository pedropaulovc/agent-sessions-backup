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
  await testEnv.DB.prepare(
    `INSERT INTO usage (session_id, turn_index, ts, model) VALUES ('cron-sess', 1, '2026-07-01T00:00:00Z', 'claude-opus-5')`,
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
    await fire('30 4 * * *');
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
