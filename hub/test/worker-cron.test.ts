import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { DAILY_STEP_RETRY } from '../src/cron/daily-step';
import { DAILY_CRON, WATCHDOG_CRON } from '../src/cron/schedule';
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

/** Every JSON log line `fire` emitted on `stream`, parsed. */
function captureLogs(stream: 'log' | 'error'): { lines: Array<Record<string, unknown>>; restore: () => void } {
  const lines: Array<Record<string, unknown>> = [];
  const spy = vi.spyOn(console, stream).mockImplementation((...args: unknown[]) => {
    try {
      lines.push(JSON.parse(String(args[0])));
    } catch {
      // Non-JSON output is not a structured event.
    }
  });
  return { lines, restore: () => spy.mockRestore() };
}

const D1_CHAIN = ['model_price_sync', 'pricing', 'catalog_reconcile', 'session_rollup', 'cert_prune', 'omp_qa_reports_prune'];

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
    await fire(DAILY_CRON);
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

    await fire(DAILY_CRON);

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

    const logs = captureLogs('log');
    const errors = captureLogs('error');
    try {
      await fire(DAILY_CRON);
    } finally {
      logs.restore();
      errors.restore();
    }

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

    // The failed first step is logged under the one generic event, and every later step of the
    // chain still ran, in order, after it.
    expect(errors.lines.filter((o) => o.event === 'hub.cron.daily_step_failed')).toEqual([
      { event: 'hub.cron.daily_step_failed', step: 'model_price_sync', ms: expect.any(Number), error: expect.any(String) },
    ]);
    const chain = logs.lines.filter((o) => o.event === 'hub.cron.daily_step' && o.step !== 'staging_prune');
    expect(chain.map((o) => [o.step, o.outcome])).toEqual(
      D1_CHAIN.map((step) => [step, step === 'model_price_sync' ? 'failed' : 'ok']),
    );
  });

  it('runs the R2 staging sweep beside the D1 chain, so its failure costs the chain nothing', async () => {
    let listCalls = 0;
    const list = vi.spyOn(testEnv.RAW, 'list').mockImplementation(async () => {
      listCalls++;
      throw new Error('r2 list unavailable');
    });
    const logs = captureLogs('log');
    const errors = captureLogs('error');
    await testEnv.DB.prepare('UPDATE usage SET input_tokens = 1000000 WHERE session_id = ?1').bind('cron-sess').run();

    try {
      await fire(DAILY_CRON);
    } finally {
      list.mockRestore();
      logs.restore();
      errors.restore();
    }

    // Positive control: the sweep really failed. Counted by hand because mockRestore() above also
    // clears the spy's recorded calls.
    expect(listCalls).toBeGreaterThan(0);
    expect(errors.lines.filter((o) => o.event === 'hub.cron.daily_step_failed')).toEqual([
      { event: 'hub.cron.daily_step_failed', step: 'staging_prune', ms: expect.any(Number), error: 'r2 list unavailable' },
    ]);
    const chain = logs.lines.filter((o) => o.event === 'hub.cron.daily_step' && o.step !== 'staging_prune');
    expect(chain.map((o) => [o.step, o.outcome])).toEqual(D1_CHAIN.map((step) => [step, 'ok']));
    // Every step announces itself before running, so a run cut off mid-chain names its last step.
    expect(logs.lines.filter((o) => o.event === 'hub.cron.daily_step_started').map((o) => o.step).sort())
      .toEqual(['staging_prune', ...D1_CHAIN].sort());
    const row = await testEnv.DB.prepare('SELECT usd FROM usage WHERE session_id = ?1')
      .bind('cron-sess')
      .first<{ usd: number | null }>();
    expect(row?.usd, 'a failed staging sweep skipped the pricing pass').toBeCloseTo(5, 6);
  });

  it('records pricing, catalog and rollup failures as failed steps and still runs the rest', async () => {
    // Each of these used to catch its own error, so the chain would have logged `ok` for a step
    // that did nothing. Fail one query in each and nothing else.
    const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
    const failing: Array<[step: string, marker: RegExp]> = [
      ['pricing', /usage_due_for_pricing/],
      ['catalog_reconcile', /FROM\s+session_catalog_outbox\s+ORDER\s+BY\s+seq/],
      ['session_rollup', /FROM\s+session_rollup_state\s+WHERE/],
    ];
    const prepare = vi.spyOn(testEnv.DB, 'prepare').mockImplementation((sql: string) => {
      const hit = failing.find(([, marker]) => marker.test(sql));
      if (hit) throw new Error(`injected ${hit[0]} failure`);
      return realPrepare(sql);
    });
    const logs = captureLogs('log');
    const errors = captureLogs('error');
    try {
      await fire(DAILY_CRON);
    } finally {
      prepare.mockRestore();
      logs.restore();
      errors.restore();
    }

    expect(errors.lines.filter((o) => o.event === 'hub.cron.daily_step_failed').map((o) => [o.step, o.error])).toEqual([
      ['pricing', 'injected pricing failure'],
      ['catalog_reconcile', 'injected catalog_reconcile failure'],
      ['session_rollup', 'injected session_rollup failure'],
    ]);
    const chain = logs.lines.filter((o) => o.event === 'hub.cron.daily_step' && o.step !== 'staging_prune');
    expect(chain.map((o) => [o.step, o.outcome])).toEqual(
      D1_CHAIN.map((step) => [step, failing.some(([failed]) => failed === step) ? 'failed' : 'ok']),
    );
    // The pricing pass still reports its own failure line before rethrowing.
    expect(logs.lines.some((o) => o.event === 'hub.pricing.daily' && o.ok === false)).toBe(true);
  });

  describe('D1 overload on a daily step', () => {
    // The production rejection, verbatim: once it hits one step, every step started inside the
    // same 10-second window fails with it too unless the chain waits the window out.
    const OVERLOAD = 'D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window.';

    /** Fires the daily cron with the first query matching `marker` (pricing's by default) throwing
     * `errorFor(hit)` on the hits it returns a message for, and the real query otherwise. */
    async function fireWithPricingErrors(errorFor: (hit: number) => string | undefined, marker = /usage_due_for_pricing/) {
      const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
      let hits = 0;
      const prepare = vi.spyOn(testEnv.DB, 'prepare').mockImplementation((sql: string) => {
        if (marker.test(sql)) {
          const message = errorFor(++hits);
          if (message) throw new Error(message);
        }
        return realPrepare(sql);
      });
      const sleeps: number[] = [];
      const sleep = vi.spyOn(DAILY_STEP_RETRY, 'sleep').mockImplementation(async (ms) => {
        sleeps.push(ms);
      });
      const logs = captureLogs('log');
      const errors = captureLogs('error');
      try {
        await fire(DAILY_CRON);
      } finally {
        prepare.mockRestore();
        sleep.mockRestore();
        logs.restore();
        errors.restore();
      }
      const pricing = logs.lines.filter((o) => o.event === 'hub.cron.daily_step' && o.step === 'pricing');
      return {
        hits,
        sleeps,
        retries: logs.lines.filter((o) => o.event === 'hub.cron.daily_step_retry'),
        pricing,
        failed: errors.lines.filter((o) => o.event === 'hub.cron.daily_step_failed'),
        chain: logs.lines.filter((o) => o.event === 'hub.cron.daily_step' && o.step !== 'staging_prune'),
      };
    }

    it('waits out the window and retries the step once, which then succeeds', async () => {
      await testEnv.DB.prepare('UPDATE usage SET input_tokens = 1000000 WHERE session_id = ?1').bind('cron-sess').run();
      const run = await fireWithPricingErrors((hit) => (hit === 1 ? OVERLOAD : undefined));

      expect(run.hits, 'the overloaded step was not run a second time').toBe(2);
      expect(run.retries).toEqual([
        { event: 'hub.cron.daily_step_retry', step: 'pricing', ms: expect.any(Number), error: OVERLOAD, backoff_ms: 11_000 },
      ]);
      expect(run.sleeps).toEqual([11_000]);
      expect(run.pricing.map((o) => o.outcome)).toEqual(['ok']);
      expect(run.failed).toEqual([]);
      expect(run.chain.map((o) => [o.step, o.outcome])).toEqual(D1_CHAIN.map((step) => [step, 'ok']));
      const row = await testEnv.DB.prepare('SELECT usd FROM usage WHERE session_id = ?1')
        .bind('cron-sess')
        .first<{ usd: number | null }>();
      expect(row?.usd, 'the retried pricing pass priced nothing').toBeCloseTo(5, 6);
    });

    it('fails the step when the retry is overloaded too, and runs the rest of the chain', async () => {
      const run = await fireWithPricingErrors(() => OVERLOAD);

      expect(run.hits, 'an overloaded step must be retried exactly once').toBe(2);
      expect(run.retries.map((o) => o.step)).toEqual(['pricing']);
      expect(run.sleeps).toEqual([11_000]);
      expect(run.pricing.map((o) => o.outcome)).toEqual(['failed']);
      expect(run.failed).toEqual([
        { event: 'hub.cron.daily_step_failed', step: 'pricing', ms: expect.any(Number), error: OVERLOAD },
      ]);
      expect(run.chain.map((o) => [o.step, o.outcome])).toEqual(
        D1_CHAIN.map((step) => [step, step === 'pricing' ? 'failed' : 'ok']),
      );
    });

    it('does not retry any other error', async () => {
      const other = 'D1_ERROR: no such table: usage_due_for_pricing';
      const run = await fireWithPricingErrors(() => other);

      expect(run.hits).toBe(1);
      expect(run.retries).toEqual([]);
      expect(run.sleeps).toEqual([]);
      expect(run.pricing.map((o) => o.outcome)).toEqual(['failed']);
      expect(run.failed.map((o) => [o.step, o.error])).toEqual([['pricing', other]]);
    });

    it('retries the session rollup step on an overload escaping the pass', async () => {
      // runScheduledSessionRollup must rethrow the pass error unprefixed, or the overload
      // classifier stops recognising it and rollup is never retried.
      const run = await fireWithPricingErrors((hit) => (hit === 1 ? OVERLOAD : undefined), /FROM\s+session_rollup_state\s+WHERE/);

      expect(run.retries.map((o) => [o.step, o.error])).toEqual([['session_rollup', OVERLOAD]]);
      expect(run.sleeps).toEqual([11_000]);
      expect(run.failed).toEqual([]);
      expect(run.chain.map((o) => [o.step, o.outcome])).toEqual(D1_CHAIN.map((step) => [step, 'ok']));
    });
  });

  it('handles exactly the crons wrangler.jsonc schedules', () => {
    // A schedule in wrangler.jsonc that scheduled() does not recognise is silently ignored, and one
    // scheduled() expects but wrangler never fires is silently dead. vitest.config.ts reads the
    // top-level triggers with wrangler's own config reader and provides them here.
    const crons = inject('wranglerCrons');
    expect(crons).toHaveLength(2);
    expect(new Set(crons)).toEqual(new Set([WATCHDOG_CRON, DAILY_CRON]));
  });

  it('does not refresh prices on the 15-minute watchdog tick', async () => {
    // 96 needless upstream fetches a day, and 96 audit rows, if these ever get crossed.
    await fire(WATCHDOG_CRON);
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
