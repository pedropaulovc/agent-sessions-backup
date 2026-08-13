/**
 * Deterministic JSON serialization for values that get HASHED and later re-derived:
 * undefined-valued keys dropped, keys sorted, no whitespace. Used by the read-grant
 * binding hash — the exact server-side state a fresh passkey assertion approves.
 * (Relocated from the retired debug-exchange module, which originated it.)
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('undefined is not canonical JSON');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).filter((key) => object[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}
