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
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('scheduled handler', () => {
  it('refreshes model prices on the daily cron', async () => {
    await fire('30 4 * * *');
    expect(await auditCount(), 'the daily cron never reached runModelPriceSync').toBe(1);
  });

  it('does not refresh prices on the 15-minute watchdog tick', async () => {
    // 96 needless upstream fetches a day, and 96 audit rows, if these ever get crossed.
    await fire('*/15 * * * *');
    expect(await auditCount()).toBe(0);
  });

  it('ignores a cron string it does not recognise', async () => {
    await fire('0 0 1 1 *');
    expect(await auditCount()).toBe(0);
  });
});
