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

  it('falls a missing cache-read rate back to the STANDARD input rate, not the batch one', () => {
    // Otherwise a cache read is charged at the batch discount while rateSet reports it as
    // standard — the two halves of the same rule disagreeing.
    const noCacheRate: ModelPrice = { ...LUNA, cache_read_cost: null };
    // LUNA is a `subset` model, so the cache-read charge is clamped to input — give it input, or
    // the row is contradictory (cached tokens with no input to be a subset of) and prices at 0,
    // testing the clamp instead of the rate fallback this is about.
    const u = { model: 'gpt-5.6-luna', input_tokens: 1_000_000, cache_read_tokens: 1_000_000 };
    // Standard input is 0.2/M; batch input is 0.1/M. Must be the former.
    expect(costOfUsage(u, noCacheRate, { batch: true }).usd).toBeCloseTo(0.2, 10);
  });

  it('does not report a zero-token call as unpriced even with no matching price', () => {
    // Such a call contributes no unknown cost whatever the rate turns out to be. Counting it
    // inflated unpriced_calls, added its model to unpriced_models, and told clients the total was
    // a floor — degrading the coverage signal that is supposed to mean "dollars are missing".
    const c = costOfUsage({ model: 'brand-new-model', input_tokens: 0, output_tokens: 0 }, null);
    expect(c.unpriced).toBe(false);
    expect(c.usd).toBe(0);
    expect(c.rateSet).toBe('none');
    // A row with tokens and no price is still unpriced — the signal has to keep working.
    expect(costOfUsage({ model: 'brand-new-model', input_tokens: 1 }, null).unpriced).toBe(true);
  });

  it('claims no rate set at all when every billable class is zero', () => {
    // Such a row produced no dollars from any rate set. Reporting 'standard' put it into
    // rateSetsUsed and flipped a fully batch-priced response's cost_basis to _partial on the
    // strength of a row that cost nothing.
    const empty = { model: 'gpt-5.6-luna', input_tokens: 0, output_tokens: 0 };
    const c = costOfUsage(empty, LUNA, { batch: true });
    expect(c.usd).toBe(0);
    expect(c.unpriced).toBe(false);
    expect(c.rateSet).toBe('none');
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

  it('tries EVERY exact form, prefixed included, before any undated one', () => {
    // An undated match is a DIFFERENT model's rate. With `anthropic/claude-x-20260101` published
    // and a bare `claude-x` family entry present but no bare dated key, ordering the undated
    // candidate first prices the call at the family rate and reports it as confidently priced.
    const c = priceKeyCandidates('claude-x-20260101');
    const lastExact = Math.max(...c.map((k, i) => (k.endsWith('-20260101') ? i : -1)));
    const firstUndated = c.findIndex((k) => !k.endsWith('-20260101'));
    expect(c).toContain('anthropic/claude-x-20260101');
    expect(firstUndated, 'an undated candidate is tried before an exact prefixed one').toBeGreaterThan(lastExact);
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

describe('unknown cache accounting', () => {
  const UNKNOWN: ModelPrice = { ...LUNA, provider: null, cache_accounting: 'unknown' };

  it('refuses to price a row that has cache reads', () => {
    // Disjoint bills cache reads ON TOP of input, subset bills them INSIDE it. Guessing either
    // way is a silent ~2x error on every cached turn, with the row still reported as priced.
    const c = costOfUsage({ model: 'gpt-5.6-luna', input_tokens: 1_000_000, cache_read_tokens: 500_000 }, UNKNOWN);
    expect(c.unpriced).toBe(true);
    expect(c.usd).toBe(0);
  });

  it('still prices a row with no cache reads', () => {
    // The convention cannot change the cost of a row that has no cache reads, so an unrecognised
    // provider must not cost pricing where it does not matter.
    const c = costOfUsage({ model: 'gpt-5.6-luna', input_tokens: 1_000_000, output_tokens: 1_000_000 }, UNKNOWN);
    expect(c.unpriced).toBe(false);
    expect(c.usd).toBeCloseTo(0.2 + 1.2, 10);
  });
});

describe('subset cache-read clamp', () => {
  it('never bills more cached tokens than the row reports as input', () => {
    // Under subset accounting cached tokens are BY DEFINITION part of input_tokens. The
    // fresh-input clamp only protected the subtraction: input=500 / cache_read=9000 correctly
    // yields 0 fresh input, but the cache term still billed all 9000 — 18x the tokens the row
    // says it used.
    const c = costOfUsage({ model: 'gpt-5.6-luna', input_tokens: 500, cache_read_tokens: 9000 }, LUNA);
    // 500 cached tokens at 0.02/M, and no fresh input.
    expect(c.usd).toBeCloseTo((500 * 0.02) / 1_000_000, 12);
    expect(c.billableInputTokens).toBe(0);
  });

  it('leaves disjoint models alone', () => {
    // Anthropic reports cache reads SEPARATELY from input, so exceeding input is normal there and
    // clamping would under-report real spend.
    const c = costOfUsage({ model: 'claude-opus-5', input_tokens: 500, cache_read_tokens: 9000 }, OPUS);
    expect(c.usd).toBeCloseTo((500 * 5 + 9000 * 0.5) / 1_000_000, 12);
  });

  it('uses the per-row sum when the caller pre-aggregated', () => {
    // MIN is nonlinear, so a group's totals cannot reproduce it — the SQL carries the per-row sum.
    const c = costOfUsage(
      { model: 'gpt-5.6-luna', input_tokens: 1000, cache_read_tokens: 18000, billable_cache_read_tokens: 1000 },
      LUNA,
    );
    expect(c.usd).toBeCloseTo((1000 * 0.02) / 1_000_000, 12);
  });
});
