import { describe, expect, it } from 'vitest';
import { costOfUsage, isBillableModel, priceAt, priceKeyCandidates, type ModelPrice } from '../src/pricing';

/** Real rates as published by LiteLLM on 2026-07-31, per million tokens. */
const OPUS: ModelPrice = {
  model: 'claude-opus-5',
  effective_from: '2026-07-31',
  provider: 'anthropic',
  input_cost: 5,
  output_cost: 25,
  cache_read_cost: 0.5,
  cache_write_5m_cost: 6.25,
  cache_write_1h_cost: 10,
  input_cost_batch: null,
  output_cost_batch: null,
  cache_accounting: 'disjoint',
};

const LUNA: ModelPrice = {
  model: 'gpt-5.6-luna',
  effective_from: '2026-07-31',
  provider: 'openai',
  input_cost: 0.2,
  output_cost: 1.2,
  cache_read_cost: 0.02,
  cache_write_5m_cost: 0.25,
  cache_write_1h_cost: 0.25,
  input_cost_batch: 0.1,
  output_cost_batch: 0.6,
  cache_accounting: 'subset',
};

describe('cache accounting', () => {
  // The whole point of the cache_accounting column. Same token numbers, two conventions.
  const tokens = { input_tokens: 100_000, output_tokens: 10_000, cache_read_tokens: 90_000 };

  it('charges anthropic cache reads ON TOP of input (disjoint)', () => {
    const c = costOfUsage({ model: 'claude-opus-5', ...tokens }, OPUS);
    expect(c.billableInputTokens).toBe(100_000);
    // 100k*5 + 10k*25 + 90k*0.5 all per-million
    expect(c.usd).toBeCloseTo((100_000 * 5 + 10_000 * 25 + 90_000 * 0.5) / 1e6, 10);
  });

  it('subtracts openai cache reads FROM input (subset)', () => {
    const c = costOfUsage({ model: 'gpt-5.6-luna', ...tokens }, LUNA);
    // Only 10k of the 100k input was fresh; charging all 100k would double-bill the cached 90k.
    expect(c.billableInputTokens).toBe(10_000);
    expect(c.usd).toBeCloseTo((10_000 * 0.2 + 10_000 * 1.2 + 90_000 * 0.02) / 1e6, 10);
  });

  it('never bills negative fresh input when cache_read exceeds input', () => {
    // A truncated or reordered transcript can report this; it must clamp, not go negative.
    const c = costOfUsage(
      { model: 'gpt-5.6-luna', input_tokens: 500, output_tokens: 0, cache_read_tokens: 9_000 },
      LUNA,
    );
    expect(c.billableInputTokens).toBe(0);
    expect(c.usd).toBeGreaterThanOrEqual(0);
  });

  it('takes the per-row clamp sum for a group rather than clamping the group totals', () => {
    // The clamp is nonlinear, so it cannot be applied after summing. These two calls --
    // (500 in, 9000 cached) and (10000 in, 0 cached) -- are 0 + 10000 = 10000 fresh tokens.
    // Clamping the SUMs instead gives max(0, 10500 - 9000) = 1500: the truncated row's excess
    // cache reads eat fresh input belonging to a perfectly valid neighbour.
    const group = {
      model: 'gpt-5.6-luna',
      input_tokens: 10_500,
      output_tokens: 0,
      cache_read_tokens: 9_000,
      fresh_input_tokens: 10_000,
    };
    expect(costOfUsage(group, LUNA).billableInputTokens).toBe(10_000);
  });

  it('ignores fresh_input_tokens for disjoint models, where input is already fresh', () => {
    const c = costOfUsage(
      { model: 'claude-opus-5', input_tokens: 10_500, cache_read_tokens: 9_000, fresh_input_tokens: 10_000 },
      OPUS,
    );
    expect(c.billableInputTokens).toBe(10_500);
  });
});

describe('batch tier', () => {
  it('halves input and output when the provider publishes a batch rate', () => {
    const u = { model: 'gpt-5.6-luna', input_tokens: 1_000_000, output_tokens: 1_000_000 };
    const std = costOfUsage(u, LUNA);
    const batch = costOfUsage(u, LUNA, { batch: true });
    expect(std.usd).toBeCloseTo(0.2 + 1.2, 10);
    expect(batch.usd).toBeCloseTo(0.1 + 0.6, 10);
  });

  it('falls back to standard rates when the provider has no batch tier', () => {
    // Anthropic publishes no batch fields in LiteLLM, so asking for batch must not silently
    // discount -- it should return the standard price rather than a number we invented.
    const u = { model: 'claude-opus-5', input_tokens: 1_000_000, output_tokens: 0 };
    expect(costOfUsage(u, OPUS, { batch: true }).usd).toBeCloseTo(costOfUsage(u, OPUS).usd, 10);
  });
});

describe('missing prices', () => {
  it('flags unpriced instead of charging zero', () => {
    const c = costOfUsage({ model: 'brand-new-model', input_tokens: 1e6, output_tokens: 1e6 }, null);
    expect(c.unpriced).toBe(true);
    expect(c.usd).toBe(0);
  });

  it('treats a missing cache READ rate as the input rate, not as free', () => {
    // Safe in this direction only: a cache read is never dearer than fresh input, so the
    // substitution can over-report but never quietly under-report.
    const noReadRate: ModelPrice = { ...OPUS, cache_read_cost: null };
    const c = costOfUsage({ model: 'claude-opus-5', cache_read_tokens: 1_000_000 }, noReadRate);
    expect(c.usd).toBeCloseTo(5, 10);
  });

  // Cache WRITES get no such fallback: OPUS above charges 6.25 for a 5m write and 10 for a 1h
  // write against an input rate of 5, so substituting the input rate (or the 5m rate for a
  // missing 1h rate) invents a discount and reports it as a priced number.
  it('flags a row as unpriced when its 5m cache-write rate is unpublished', () => {
    const noW5: ModelPrice = { ...OPUS, cache_write_5m_cost: null };
    const c = costOfUsage({ model: 'claude-opus-5', cache_creation_5m_tokens: 1_000_000 }, noW5);
    expect(c.unpriced).toBe(true);
    expect(c.usd).toBe(0);
  });

  it('flags a row as unpriced when its 1h cache-write rate is unpublished', () => {
    // The 1h rate is 2x input while the 5m rate is 1.25x, so the old w1h -> w5 fallback was
    // the biggest under-charge of the three.
    const noW1h: ModelPrice = { ...OPUS, cache_write_1h_cost: null };
    const c = costOfUsage({ model: 'claude-opus-5', cache_creation_1h_tokens: 1_000_000 }, noW1h);
    expect(c.unpriced).toBe(true);
    expect(c.usd).toBe(0);
  });

  it('still prices a row whose missing write rate is never multiplied by anything', () => {
    // No cache-creation tokens means the absent rate is irrelevant; refusing to price here
    // would throw away real cost data over a column that does not apply.
    const noWrites: ModelPrice = { ...OPUS, cache_write_5m_cost: null, cache_write_1h_cost: null };
    const c = costOfUsage({ model: 'claude-opus-5', input_tokens: 1_000_000 }, noWrites);
    expect(c.unpriced).toBe(false);
    expect(c.usd).toBeCloseTo(5, 10);
  });

  it('does not price synthetic entries', () => {
    expect(isBillableModel('<synthetic>')).toBe(false);
    expect(isBillableModel(null)).toBe(false);
    expect(isBillableModel('claude-opus-5')).toBe(true);
  });
});

describe('model id resolution', () => {
  it('tries the dated id before the undated family', () => {
    const c = priceKeyCandidates('claude-haiku-4-5-20251001');
    expect(c[0]).toBe('claude-haiku-4-5-20251001');
    expect(c).toContain('claude-haiku-4-5');
    expect(c).toContain('anthropic/claude-haiku-4-5');
  });
});

describe('historical pricing', () => {
  const history: ModelPrice[] = [
    { ...LUNA, effective_from: '2026-07-30', input_cost: 0.2 },
    { ...LUNA, effective_from: '2026-06-01', input_cost: 0.4 },
  ];

  it('prices a turn at the rate in effect when it ran', () => {
    // A June session must keep June's rate after the July 30 cut, or every historical cost
    // on the stats page silently rewrites itself whenever upstream changes.
    expect(priceAt(history, '2026-06-15')!.input_cost).toBe(0.4);
    expect(priceAt(history, '2026-07-31')!.input_cost).toBe(0.2);
  });

  it('falls back to the earliest snapshot for turns older than any record', () => {
    expect(priceAt(history, '2025-01-01')!.input_cost).toBe(0.4);
  });
});
