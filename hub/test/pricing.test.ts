import { describe, expect, it } from 'vitest';
import { classifyModel, costOfUsage, isBillableModel, priceAt, priceKeyCandidates, type ModelPrice } from '../src/pricing';

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

  it('applies a published batch rate per class, not all-or-nothing', () => {
    // A provider that publishes an input batch rate but no output one is common enough (the
    // fields are independent upstream). The old check required BOTH before using EITHER, so an
    // input-only row silently paid full list price despite a published batch rate for exactly
    // the tokens it had.
    const halfBatch: ModelPrice = { ...LUNA, output_cost_batch: null };
    const inputOnly = { model: 'gpt-5.6-luna', input_tokens: 1_000_000, output_tokens: 0 };
    expect(costOfUsage(inputOnly, halfBatch, { batch: true }).usd).toBeCloseTo(0.1, 10);
    expect(costOfUsage(inputOnly, halfBatch, { batch: true }).rateSet).toBe('batch');

    // With BOTH classes present and only one batch rate published, the row is genuinely priced
    // off two different rate sets -- report that instead of picking a label that misstates half
    // the dollars in either direction.
    const both = { model: 'gpt-5.6-luna', input_tokens: 1_000_000, output_tokens: 1_000_000 };
    const c = costOfUsage(both, halfBatch, { batch: true });
    expect(c.usd).toBeCloseTo(0.1 + 1.2, 10);
    expect(c.rateSet).toBe('mixed');
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

  // A boolean collapsed two opposite cases: `<synthetic>` never hit an API (not coverage loss),
  // while a NULL model burned real tokens at a rate we can't determine (very much coverage loss).
  it('separates sentinel models from unknown ones', () => {
    expect(classifyModel('<synthetic>')).toBe('sentinel');
    expect(classifyModel('<any-future-sentinel>')).toBe('sentinel');
    expect(classifyModel(null)).toBe('unknown');
    expect(classifyModel(undefined)).toBe('unknown');
    expect(classifyModel('')).toBe('unknown');
    expect(classifyModel('claude-opus-5')).toBe('billable');
  });

  it('reports no billable input for a row it cannot price', () => {
    // billableInputTokens means "input actually billed at the input rate". Returning the raw
    // count for an unpriced row lets a caller sum billable input across rows whose dollars are
    // missing — and for an unmatched subset model it would wrongly include the cached prefix.
    const c = costOfUsage({ model: 'brand-new-model', input_tokens: 50_000, cache_read_tokens: 40_000 }, null);
    expect(c.unpriced).toBe(true);
    expect(c.billableInputTokens).toBe(0);
    expect(c.rateSet).toBe('none');
  });

  it('requires a rate only for token classes that are actually present', () => {
    // Upstream publishes partial entries. Discarding a known input cost because output_cost is
    // null throws away real, correctly-priceable usage on a row that produced no output.
    const noOutputRate: ModelPrice = { ...OPUS, output_cost: null };
    const inputOnly = costOfUsage({ model: 'claude-opus-5', input_tokens: 1_000_000, output_tokens: 0 }, noOutputRate);
    expect(inputOnly.unpriced).toBe(false);
    expect(inputOnly.usd).toBeCloseTo(5, 10);

    // ...but a row that DOES have output tokens still can't be priced without the rate.
    const withOutput = costOfUsage({ model: 'claude-opus-5', input_tokens: 1_000_000, output_tokens: 1 }, noOutputRate);
    expect(withOutput.unpriced).toBe(true);

    const noInputRate: ModelPrice = { ...OPUS, input_cost: null };
    const outputOnly = costOfUsage({ model: 'claude-opus-5', input_tokens: 0, output_tokens: 1_000_000 }, noInputRate);
    expect(outputOnly.unpriced).toBe(false);
    expect(outputOnly.usd).toBeCloseTo(25, 10);
  });
});

describe('corrupt token counters', () => {
  it('never produces a negative cost from a negative counter', () => {
    // `usage` has no nonnegative constraint and both parsers store whatever a transcript
    // reports. Unclamped, this row bills -1M * 5 = -$5 and reports itself as fully priced —
    // a credit invented from corrupt input, which then cancels real cost when summed.
    const c = costOfUsage({ model: 'claude-opus-5', input_tokens: -1_000_000, output_tokens: 40 }, OPUS);
    expect(c.usd).toBeGreaterThanOrEqual(0);
    expect(c.usd).toBeCloseTo((40 * 25) / 1e6, 10);
    expect(c.billableInputTokens).toBe(0);
  });

  it('clamps every token class, not just input', () => {
    const c = costOfUsage(
      {
        model: 'claude-opus-5',
        input_tokens: -5,
        output_tokens: -5,
        cache_read_tokens: -5,
        cache_creation_5m_tokens: -5,
        cache_creation_1h_tokens: -5,
      },
      OPUS,
    );
    expect(c.usd).toBe(0);
    expect(c.unpriced).toBe(false);
  });
});

describe('rate set reporting', () => {
  it('reports which rate set actually priced the row', () => {
    const u = { model: 'gpt-5.6-luna', input_tokens: 1_000_000, output_tokens: 0 };
    expect(costOfUsage(u, LUNA).rateSet).toBe('standard');
    expect(costOfUsage(u, LUNA, { batch: true }).rateSet).toBe('batch');
    // Anthropic publishes no batch tier, so batch=1 silently falls back to standard rates. The
    // caller has to be able to see that, or it will label standard dollars as batch-priced.
    expect(costOfUsage({ model: 'claude-opus-5', input_tokens: 1 }, OPUS, { batch: true }).rateSet).toBe('standard');
  });

  it('counts cache classes as standard — LiteLLM publishes no batch cache rates', () => {
    // A cached call under batch=1 pays batch rates on input/output and STANDARD rates on cache
    // read and cache write, because no batch cache columns exist upstream to pay instead. Calling
    // the row 'batch' would label those standard dollars as discounted.
    const cached = {
      model: 'gpt-5.6-luna',
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_tokens: 500_000,
    };
    expect(costOfUsage(cached, LUNA, { batch: true }).rateSet).toBe('mixed');
    // Cache-write alone counts too, not just cache reads.
    const written = { model: 'gpt-5.6-luna', input_tokens: 1_000_000, cache_creation_5m_tokens: 1_000 };
    expect(costOfUsage(written, LUNA, { batch: true }).rateSet).toBe('mixed');
    // And with no cache tokens at all it stays a clean 'batch'.
    const plain = { model: 'gpt-5.6-luna', input_tokens: 1_000_000, output_tokens: 1_000_000 };
    expect(costOfUsage(plain, LUNA, { batch: true }).rateSet).toBe('batch');
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
