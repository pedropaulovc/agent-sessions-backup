import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runModelPriceSync } from '../src/cron/model-prices';

/** The unattended refresh path. Without these, "prices stay current" rests on a cron trigger
 * nobody ever exercised — and a silently stale price table produces confident, wrong dollars.
 *
 * The cron wiring itself (`30 4 * * *` -> runModelPriceSync) lives in src/worker.ts and is
 * asserted in worker-cron.test.ts; this file covers what the sync actually writes. */

const testEnv = env as unknown as Env;

/** A minimal LiteLLM entry. Upstream costs are PER TOKEN; the sync scales them to per-million. */
function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    litellm_provider: 'anthropic',
    input_cost_per_token: 5e-6,
    output_cost_per_token: 25e-6,
    cache_read_input_token_cost: 0.5e-6,
    cache_creation_input_token_cost: 6.25e-6,
    cache_creation_input_token_cost_above_1hr: 10e-6,
    ...over,
  };
}

/** The sync refuses a payload too small to be the real catalog (see MIN_CATALOG_ENTRIES), which
 * is a production guard, not something each test wants to restate. Pad every mocked payload with
 * inert filler entries so tests can keep declaring only the models they care about. Tests that
 * exercise the guard itself call mockUpstreamRaw and skip this. */
function pad(payload: Record<string, unknown>): Record<string, unknown> {
  const out = { ...payload };
  for (let i = Object.keys(out).length; i < 200; i++) {
    out[`filler-model-${i}`] = { litellm_provider: 'filler', input_cost_per_token: 1e-9, output_cost_per_token: 1e-9 };
  }
  return out;
}

function mockUpstream(payload: Record<string, unknown> | { fail: number }): void {
  if (typeof (payload as { fail?: number }).fail !== 'number') {
    return mockUpstreamRaw(pad(payload as Record<string, unknown>));
  }
  return mockUpstreamRaw(payload);
}

function mockUpstreamRaw(payload: Record<string, unknown> | { fail: number }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const fail = (payload as { fail?: number }).fail;
      if (typeof fail === 'number') return new Response('nope', { status: fail });
      return new Response(JSON.stringify(payload), { status: 200 });
    }),
  );
}

async function pricesFor(model: string) {
  return (
    await testEnv.DB.prepare(
      `SELECT effective_from, provider, input_cost, cache_write_5m_cost, cache_write_1h_cost, cache_accounting
         FROM model_prices WHERE model = ?1 ORDER BY effective_from DESC`,
    )
      .bind(model)
      .all<Record<string, unknown>>()
  ).results;
}

beforeEach(async () => {
  await testEnv.DB.prepare('DELETE FROM model_prices').run();
  await testEnv.DB.prepare('DELETE FROM model_prices_sync').run();
  await testEnv.DB.prepare('DELETE FROM usage').run();
  await testEnv.DB.prepare(
    `INSERT OR IGNORE INTO sessions (session_id, harness, index_state) VALUES ('sync-sess', 'claude-code', 'ready')`,
  ).run();
  await testEnv.DB.prepare(
    `INSERT INTO usage (session_id, turn_index, ts, model) VALUES ('sync-sess', 1, '2026-07-01T00:00:00Z', 'claude-opus-5')`,
  ).run();
});

afterEach(() => vi.unstubAllGlobals());

describe('model price autorefresh', () => {
  it('writes a snapshot for every model seen in usage', async () => {
    mockUpstream({ 'claude-opus-5': entry() });
    await runModelPriceSync(testEnv);

    const rows = await pricesFor('claude-opus-5');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.input_cost).toBe(5);
    expect(rows[0]!.cache_write_1h_cost).toBe(10);
    expect(rows[0]!.cache_accounting).toBe('disjoint');
  });

  it('does not grow the table when nothing upstream changed', async () => {
    mockUpstream({ 'claude-opus-5': entry() });
    await runModelPriceSync(testEnv);
    await runModelPriceSync(testEnv);
    // Re-running daily must be a no-op, or the table grows a row per day forever and
    // priceAt()'s history walk gets slower and noisier for no information.
    expect(await pricesFor('claude-opus-5')).toHaveLength(1);
  });

  it('stores NULL when upstream omits the 1h cache-write rate', async () => {
    // NOT the 5m rate standing in for it: a 1h write is 2x input where a 5m write is 1.25x, and
    // a substituted value is indistinguishable from a published one, so costOfUsage's
    // missing-rate guard could never fire and every 1h write was underpriced by ~40%.
    mockUpstream({
      'claude-opus-5': entry({ cache_creation_input_token_cost_above_1hr: undefined }),
    });
    await runModelPriceSync(testEnv);

    const rows = await pricesFor('claude-opus-5');
    expect(rows[0]!.cache_write_5m_cost).toBe(6.25);
    expect(rows[0]!.cache_write_1h_cost).toBeNull();
  });

  it('snapshots a cache-accounting flip even when every rate is identical', async () => {
    // Upstream correcting a null provider to `anthropic` flips cache_accounting NULL ->
    // disjoint, which changes whether cache reads are charged ON TOP of input or subtracted
    // from it. A rates-only change predicate skipped this, leaving the wrong convention active
    // until some unrelated number happened to move.
    //
    // The unknown-provider value here used to be 'subset'. That was a confident guess that
    // underpriced every cached Claude Code call, and it is now 'unknown' — costOfUsage refuses
    // to price cache reads it has no convention for. This test's subject is the FLIP being
    // snapshotted, which it still exercises; only the starting value changed.
    mockUpstream({ 'claude-opus-5': entry({ litellm_provider: null }) });
    await runModelPriceSync(testEnv);
    const first = await pricesFor('claude-opus-5');
    expect(first).toHaveLength(1);
    expect(first[0]!.cache_accounting).toBe('unknown');

    mockUpstream({ 'claude-opus-5': entry({ litellm_provider: 'anthropic' }) });
    await runModelPriceSync(testEnv);
    const after = await pricesFor('claude-opus-5');
    // Same-day reruns collapse onto one (model, effective_from) PK via INSERT OR REPLACE, so
    // the signal is the stored VALUE, not the row count: a predicate that skipped the write
    // would leave `subset` here. (A flip on a later day appends a second snapshot instead.)
    expect(after).toHaveLength(1);
    expect(after[0]!.cache_accounting, 'the accounting flip was not snapshotted').toBe('disjoint');
    expect(after[0]!.provider).toBe('anthropic');
  });

  it('records a failed run in the audit table instead of failing silently', async () => {
    mockUpstream({ fail: 503 });
    await expect(runModelPriceSync(testEnv)).rejects.toThrow();

    const audit = (
      await testEnv.DB.prepare('SELECT ok, error FROM model_prices_sync ORDER BY id DESC LIMIT 1').all<{
        ok: number;
        error: string;
      }>()
    ).results;
    expect(audit[0]!.ok).toBe(0);
    expect(audit[0]!.error).toContain('503');
  });

  it('records unresolved models rather than dropping them quietly', async () => {
    await testEnv.DB.prepare(
      `INSERT INTO usage (session_id, turn_index, ts, model) VALUES ('sync-sess', 2, '2026-07-01T00:00:00Z', 'not-a-real-model')`,
    ).run();
    mockUpstream({ 'claude-opus-5': entry() });
    await runModelPriceSync(testEnv);

    const audit = (
      await testEnv.DB.prepare('SELECT ok, unresolved FROM model_prices_sync ORDER BY id DESC LIMIT 1').all<{
        ok: number;
        unresolved: string;
      }>()
    ).results;
    expect(audit[0]!.ok).toBe(1);
    expect(JSON.parse(audit[0]!.unresolved)).toContain('not-a-real-model');
  });

  it('never tries to price the <synthetic> sentinel', async () => {
    await testEnv.DB.prepare(
      `INSERT INTO usage (session_id, turn_index, ts, model) VALUES ('sync-sess', 3, '2026-07-01T00:00:00Z', '<synthetic>')`,
    ).run();
    mockUpstream({ 'claude-opus-5': entry() });
    await runModelPriceSync(testEnv);

    const audit = (
      await testEnv.DB.prepare('SELECT unresolved FROM model_prices_sync ORDER BY id DESC LIMIT 1').all<{
        unresolved: string;
      }>()
    ).results;
    expect(JSON.parse(audit[0]!.unresolved ?? '[]')).not.toContain('<synthetic>');
  });

  it('coerces non-integer max_*_tokens rather than failing the whole batch', async () => {
    // These land in STRICT INTEGER columns, and every model's snapshot goes out in ONE batch(),
    // so a single malformed upstream entry used to abort the sync and leave EVERY price stale.
    // The float and the numeric string here are exactly the shapes a community JSON blob produces.
    await testEnv.DB.prepare(
      `INSERT INTO usage (session_id, turn_index, ts, model) VALUES ('sync-sess', 2, '2026-07-01T00:00:00Z', 'claude-sonnet-5')`,
    ).run();
    mockUpstream({
      'claude-opus-5': entry({ max_input_tokens: 200000.5, max_output_tokens: '32768' }),
      'claude-sonnet-5': entry({ max_input_tokens: 200000 }),
    });
    await runModelPriceSync(testEnv);

    const limits = (
      await testEnv.DB.prepare(
        `SELECT model, max_input_tokens, max_output_tokens FROM model_prices ORDER BY model`,
      ).all<Record<string, unknown>>()
    ).results;
    expect(limits.find((r) => r.model === 'claude-opus-5')).toMatchObject({
      // A finite float is a real limit expressed sloppily -- truncate it rather than discarding
      // the value. Only a non-number (the string) has nothing recoverable in it.
      max_input_tokens: 200000,
      max_output_tokens: null,
    });
    // The actual point: the well-formed model still got written despite the bad neighbour.
    expect(limits.find((r) => r.model === 'claude-sonnet-5')!.max_input_tokens).toBe(200000);
  });

  it('refuses a 200 that is not the price catalog, rather than recording a successful no-op', () => {
    // The dangerous shape: valid JSON, HTTP 200, every model unresolved, audit row ok=1 — prices
    // silently stop tracking upstream while the sync reports success.
    return (async () => {
      mockUpstreamRaw({});
      // Rethrown after the audit row is written, same as any other sync failure — the cron sees a
      // failed invocation rather than a successful one that did nothing.
      await expect(runModelPriceSync(testEnv)).rejects.toThrow('does not look like a price catalog');
      const sync = (
        await testEnv.DB.prepare('SELECT ok, error FROM model_prices_sync ORDER BY id DESC LIMIT 1').all<{
          ok: number;
          error: string | null;
        }>()
      ).results[0]!;
      expect(sync.ok).toBe(0);
      expect(sync.error).toContain('does not look like a price catalog');
    })();
  });

  it('rejects a negative rate instead of storing a cost that cancels real spend', async () => {
    mockUpstream({ 'claude-opus-5': entry({ input_cost_per_token: -5e-6 }) });
    await runModelPriceSync(testEnv);
    const rows = await pricesFor('claude-opus-5');
    // Dropped to NULL, which makes the row UNPRICED and therefore visible in unpriced_calls —
    // rather than fully priced and quietly negative.
    expect(rows[0]!.input_cost).toBe(null);
  });

  it('does not treat any eight trailing digits as a release date', async () => {
    // `gpt-5-99999999` is not a dated `gpt-5`. Stripping the suffix made it resolve to the real
    // gpt-5 catalog entry and receive a confident price, instead of surfacing in unpriced_models.
    await testEnv.DB.prepare(
      `INSERT INTO usage (session_id, turn_index, ts, model) VALUES ('sync-sess', 3, '2026-07-01T00:00:00Z', 'gpt-5-99999999')`,
    ).run();
    await testEnv.DB.prepare(
      `INSERT INTO usage (session_id, turn_index, ts, model) VALUES ('sync-sess', 4, '2026-07-01T00:00:00Z', 'gpt-5-20260214')`,
    ).run();
    mockUpstream({ 'claude-opus-5': entry(), 'gpt-5': entry({ litellm_provider: 'openai' }) });
    await runModelPriceSync(testEnv);

    const sync = (
      await testEnv.DB.prepare('SELECT unresolved FROM model_prices_sync ORDER BY id DESC LIMIT 1').all<{
        unresolved: string | null;
      }>()
    ).results[0]!;
    expect(sync.unresolved ?? '', 'an impossible date suffix resolved to the undated model').toContain('gpt-5-99999999');
    // A REAL dated suffix must still resolve, or the fix has over-reached.
    expect(sync.unresolved ?? '').not.toContain('gpt-5-20260214');
  });

  it('drops a token limit outside SQLite\'s integer range', async () => {
    // Number.isFinite accepts 1e100 and Math.trunc leaves it there, still far outside what a
    // STRICT INTEGER column stores — so it failed the INSERT and, since the snapshots go out in
    // one batch(), took every model's price down with it.
    mockUpstream({ 'claude-opus-5': entry({ max_input_tokens: 1e100, max_output_tokens: 2 ** 53 }) });
    await runModelPriceSync(testEnv);
    const row = (
      await testEnv.DB.prepare(
        'SELECT max_input_tokens, max_output_tokens FROM model_prices WHERE model = ?1',
      )
        .bind('claude-opus-5')
        .all<Record<string, unknown>>()
    ).results[0]!;
    expect(row.max_input_tokens).toBe(null);
    expect(row.max_output_tokens).toBe(null);
  });
});
