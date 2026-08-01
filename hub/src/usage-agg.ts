/** Shared SQL fragments and pricing fold for aggregating `usage` rows into dollars.
 *
 * Two callers now price the same table: /api/v1/usage (api/ops.ts) and the statistics page
 * (viewer/stats.ts). Every piece of this file is here because getting it slightly different in
 * the second caller produces plausible, wrong money — and this repo has already paid for that
 * lesson three times over in the price-sync path, where the cron and the manual script
 * implemented the same rules twice and drifted apart in review. One copy.
 *
 * The invariant the fragments encode: a group handed to `costOfUsage` must be one that could
 * have been a single call. Same model, same rate epoch, same set of PRESENT token classes, and
 * the two nonlinear per-row clamps already applied. Break any of those and the aggregate is
 * priced at a rate that applies to only part of it.
 */
import { costOfUsage, priceAt, type ModelPrice, type UsageTokens } from './pricing';

/** Sorts before every real `effective_from`, so `priceAt` takes its documented
 * older-than-any-snapshot branch instead of the falsy-ts one (which returns the NEWEST rate). */
export const EPOCH_BEFORE_ANY_PRICE = '0000-00-00';

/** `usage.ts` is nullable, and a row with no timestamp is NOT evidence that the call predates
 * every snapshot — it is evidence that we do not know when it ran. Keeping it distinct from
 * EPOCH_BEFORE_ANY_PRICE lets the fold refuse to price it (unless the model only ever had one
 * rate, in which case there is nothing to be ambiguous about) instead of silently charging it at
 * the earliest rate and reporting that as a real number. */
export const EPOCH_UNKNOWN_TIME = 'unknown';

/** Stands in for a NULL `usage.model`. Deliberately bracketed so it cannot collide with a real id. */
export const UNKNOWN_MODEL_LABEL = '(unknown)';

export const TOKEN_COLS = [
  'input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'cache_read_tokens',
  'cache_creation_5m_tokens',
  'cache_creation_1h_tokens',
] as const;

export type TokenCol = (typeof TOKEN_COLS)[number];

export interface UsageAggRow extends UsageTokens {
  epoch: string | null;
  calls: number;
  [k: string]: unknown;
}

/** Booleans splitting a group by which token classes are PRESENT.
 *
 * Every class can independently require a nullable rate, and `costOfUsage` marks a row unpriced
 * when a rate it needs is missing — so mixing shapes lets one unpriceable call drag perfectly
 * priceable neighbours to $0. Concretely, with a partial upstream entry carrying an input rate
 * but no output rate, an input-only call grouped with an output-bearing one loses its own valid
 * cost. Booleans keep the fan-out bounded, and in practice tiny: a model's calls nearly all
 * share one shape.
 */
export const USAGE_SHAPE_SELECT = `
  (COALESCE(u.input_tokens,0) > 0) AS has_input,
  -- Under subset accounting the input rate applies to MAX(0, input - cache_read), not to raw
  -- input, so THAT is the rate-dependent class. A fully-cached call (input == cache_read) needs
  -- no input rate and stays priceable from the cache-read rate alone; grouping it with a
  -- partly-fresh call would put positive fresh input in the aggregate and discard its valid cost.
  (MAX(0, MAX(0, COALESCE(u.input_tokens,0)) - MAX(0, COALESCE(u.cache_read_tokens,0))) > 0)
    AS has_fresh_input,
  (COALESCE(u.output_tokens,0) > 0) AS has_output,
  (COALESCE(u.cache_read_tokens,0) > 0) AS has_cache_read,
  (COALESCE(u.cache_creation_5m_tokens,0) > 0) AS has_w5,
  (COALESCE(u.cache_creation_1h_tokens,0) > 0) AS has_w1h`;

/** The shape columns as a GROUP BY list. Must stay in lockstep with USAGE_SHAPE_SELECT — a
 * class selected but not grouped silently re-mixes the shapes the split exists to separate. */
export const USAGE_SHAPE_GROUP_BY = 'has_input, has_fresh_input, has_output, has_cache_read, has_w5, has_w1h';

/** Token sums for a group, with both nonlinear per-row clamps pre-applied.
 *
 * MAX(0, ...) on every class: `usage` has no nonnegative constraint and both parsers store
 * whatever counter a transcript reports, so a negative would produce a negative cost reported as
 * fully priced — and, summed, cancel real cost from valid calls sharing the group.
 */
export const USAGE_TOKEN_SUMS = `
  COUNT(*) AS calls,
  SUM(MAX(0, COALESCE(u.input_tokens,0))) AS input_tokens,
  SUM(MAX(0, COALESCE(u.output_tokens,0))) AS output_tokens,
  SUM(MAX(0, COALESCE(u.reasoning_tokens,0))) AS reasoning_tokens,
  SUM(MAX(0, COALESCE(u.cache_read_tokens,0))) AS cache_read_tokens,
  SUM(MAX(0, COALESCE(u.cache_creation_5m_tokens,0))) AS cache_creation_5m_tokens,
  SUM(MAX(0, COALESCE(u.cache_creation_1h_tokens,0))) AS cache_creation_1h_tokens,
  -- Subset-accounting models bill only input beyond the cached prefix, and the clamp at 0 is
  -- nonlinear, so it has to happen per row: one truncated call with cache_read > input would
  -- otherwise cancel fresh input from valid calls in the same group. costOfUsage() consumes this
  -- instead of clamping the SUMs.
  --
  -- BOTH operands are clamped before the subtraction, not just the result. A negative cache_read
  -- would otherwise ADD to fresh input: (5) - (-100) = 105 billable tokens on a row whose own
  -- reported columns say input=5, cache_read=0.
  SUM(MAX(0, MAX(0, COALESCE(u.input_tokens,0)) - MAX(0, COALESCE(u.cache_read_tokens,0))))
    AS fresh_input_tokens,
  -- The other half of the same clamp, nonlinear for the same reason. Under subset accounting
  -- cached tokens are part of input, so the cache-read CHARGE cannot exceed input either:
  -- input=500 with cache_read=9000 is 0 fresh input AND at most 500 billable cached tokens.
  SUM(MIN(MAX(0, COALESCE(u.cache_read_tokens,0)), MAX(0, COALESCE(u.input_tokens,0))))
    AS billable_cache_read_tokens`;

/** A SQL expression mapping `u.ts` to the price snapshot in effect at that time.
 *
 * The boundaries are pooled across all models on purpose: a shared partition means one CASE for
 * the whole query, and a model with fewer boundaries than the pool just resolves adjacent epochs
 * to the same rate — `priceAt` is what actually picks the model's rate, this only has to
 * guarantee no group straddles a change.
 */
export function priceEpochExpr(prices: Map<string, ModelPrice[]>): string {
  const boundaries = [...new Set([...prices.values()].flatMap((h) => h.map((p) => p.effective_from)))]
    // Interpolated into SQL, so anything not literally a date shape is dropped rather than
    // escaped: `effective_from` is a TEXT column and a value like `2026-01-01'; DROP TABLE` has
    // no business becoming a CASE arm.
    .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e))
    .sort()
    .reverse();
  // The NULL-ts arm has to come first and be explicit: `NULL >= '2026-01-01'` is NULL, not
  // false, so without it a timestamp-less row falls through to the ELSE and is
  // indistinguishable from one that genuinely predates every snapshot.
  //
  // The same arm also catches any timestamp that is not canonical UTC. These comparisons are
  // LEXICOGRAPHIC, which is only equivalent to chronological for `YYYY-MM-DDTHH:MM:SS...Z`.
  // A valid but offset-bearing `2026-06-30T23:30:00-05:00` is 04:30 on July 1 UTC yet sorts
  // before '2026-07-01' and silently takes the pre-July rate; a malformed non-empty string sorts
  // wherever its first character lands. Neither is detectable downstream — the row looks
  // confidently priced.
  //
  // Canonical UTC AND a real calendar date. The GLOB alone only checks digit POSITIONS, so
  // `2026-99-99T00:00:00Z` passed it and then sorted after every boundary; and date() alone is
  // not enough either, since it silently ROLLS `2026-02-31` forward to `2026-03-03` and calls it
  // valid. Comparing the round-trip against the literal prefix catches the rollover.
  //
  // `IS NOT 1`, not `NOT (...)`: date() returns NULL for an unparseable value, and `NOT (NULL)`
  // is NULL, so a plain negation would fail to fire this arm and let the row fall through to the
  // date arms — the exact NULL-semantics trap that already produced one bug in this query.
  //
  // The hour bound is a third distinct hole. SQLite accepts `2026-03-15T24:00:00Z` -- verified
  // against D1: it rolls the day field and normalises only on overflow, so `date()` returns
  // '2026-03-15' unchanged for most dates (only month ends cascade) and the round-trip agrees.
  // But ISO 8601 24:00 IS midnight starting the next day, so a boundary on the 16th is skipped
  // and the row silently takes the 15th's rate. Checked with substr rather than by tightening the
  // GLOB: the time tail must stay `*` because every real row carries milliseconds
  // (`2025-12-21T21:23:08.952Z` — all 775k production rows).
  const canonical =
    `u.ts GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z' AND date(u.ts) = substr(u.ts, 1, 10)` +
    ` AND substr(u.ts, 12, 2) < '24'`;
  const unknownArm = `WHEN u.ts IS NULL OR (${canonical}) IS NOT 1 THEN '${EPOCH_UNKNOWN_TIME}'`;
  if (!boundaries.length) return `CASE ${unknownArm} ELSE '${EPOCH_BEFORE_ANY_PRICE}' END`;
  const arms = boundaries.map((e) => `WHEN u.ts >= '${e}' THEN '${e}'`).join(' ');
  return `CASE ${unknownArm} ${arms} ELSE '${EPOCH_BEFORE_ANY_PRICE}' END`;
}

/** The rate for a group, given the epoch it was bucketed into.
 *
 * A group with no timestamp can still be priced when every snapshot the model has would produce
 * the SAME cost — there is no ambiguity to resolve. Counting snapshots instead of comparing them
 * was too strict: the sync writes a new row for a metadata-only correction (a null `provider`
 * becoming `openai`, say), and that alone made every timestamp-less call for the model unpriced
 * even though all its snapshots compute identical dollars.
 *
 * The comparison asks `costOfUsage` what each snapshot would charge rather than diffing a
 * hand-maintained list of "cost-relevant columns". Two attempts at that list were both wrong in
 * the same direction — comparing rates the request does not select. The batch tier is the clearest
 * case: `batch=1` takes `*_cost_batch` and FALLS BACK to standard when a model publishes none, so
 * which columns matter depends on the request flag AND on whether the batch rate is null, and a
 * standard-priced request was going unpriced because only `input_cost_batch` had moved.
 *
 * It compares `rateSignature` — the selected PER-CLASS rates — and not the scalar `usd`. Comparing
 * the aggregate is not equivalent on a group: changes in separate classes cancel out. Old
 * input/output rates of 1/3 against new rates of 3/1 total the same dollars whenever the group's
 * summed input equals its summed output, so two genuinely different rate schedules would look
 * interchangeable, and the input-heavy and output-heavy calls folded into that group may well
 * belong to different epochs with substantially different true totals.
 *
 * When snapshots genuinely differ, any choice is a guess, so it stays unpriced rather than being
 * charged at some arbitrary rate and reported as a real figure. */
export function priceForGroup(
  history: ModelPrice[],
  epoch: string,
  row: UsageTokens,
  batch: boolean,
): ModelPrice | null {
  if (epoch !== EPOCH_UNKNOWN_TIME) return priceAt(history, epoch);
  if (!history.length) return null;
  const first = history[0]!;
  if (history.length === 1) return first;
  const baseline = costOfUsage(row, first, { batch }).rateSignature;
  return history.every((p) => costOfUsage(row, p, { batch }).rateSignature === baseline) ? first : null;
}
