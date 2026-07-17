/**
 * Shared, RangeError-proof epoch → ISO-8601 conversion for the web/prompt-log parsers.
 *
 * `new Date(ms).toISOString()` THROWS a RangeError when `ms` is finite but outside the
 * representable Date range (±8.64e15 ms — e.g. a bogus `1e20` create_time). A single such value
 * anywhere in a conversation would otherwise abort the WHOLE file/archive parse and drop every
 * valid turn. Route every remote-sourced timestamp through here instead: an out-of-range (or
 * non-finite / non-numeric) value simply yields `undefined`, so the row still indexes via its text
 * and just doesn't contribute to the started/ended bounds. Callers count the drop as parse drift.
 */

/** ISO-8601 for an epoch-MILLISECONDS value, or undefined if it's non-numeric, non-finite, or
 *  outside the representable Date range. */
export function isoFromEpochMs(ms: unknown): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** ISO-8601 for an epoch-SECONDS value (e.g. ChatGPT create_time/update_time float seconds). */
export function isoFromEpochSeconds(s: unknown): string | undefined {
  if (typeof s !== 'number' || !Number.isFinite(s)) return undefined;
  return isoFromEpochMs(s * 1000);
}
