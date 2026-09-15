/** Number and money formatting shared by every page that shows cost.
 *
 * These moved out of viewer/stats.ts when the session list and the session detail page started
 * showing dollars too. The two coverage helpers are the reason this is a module rather than three
 * copies of `toLocaleString`: they encode the convention that an unpriced figure reads as unknown
 * and a partial one says it is partial, which is the difference between "this session was free"
 * and "we could not price this session".
 */

/** A dollar figure, or `—` when nothing in scope carries a stored price.
 *
 * Appends `subtotal` whenever some records in the group are unpriced, so a lower bound is never
 * displayed as if it were the total. */
export function knownCost(usd: number | null, pricedCalls: number, calls: number, dp = 2): string {
  if (pricedCalls === 0 || usd === null) return '—';
  return `${fmtUsd(usd, dp)}${pricedCalls < calls ? ' subtotal' : ''}`;
}

/** How much of a group is priced, in words, for the line under a cost figure. */
export function costCoverage(pricedCalls: number, calls: number): string {
  if (calls === 0) return 'No usage records';
  if (pricedCalls === 0) return 'Unpriced';
  return `${fmtInt(pricedCalls)} / ${fmtInt(calls)} priced`;
}

export function fmtUsd(v: number, dp = 2): string {
  if (!Number.isFinite(v)) return '—';
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

export function fmtInt(v: number): string {
  return Math.round(v).toLocaleString('en-US');
}

/** Compact token counts: exact figures belong in a `title` attribute, not in a table cell. */
export function fmtTokens(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}
