export type CacheBasis = 'disjoint' | 'subset';

/** Cache counters follow the transcript writer, not the provider API that originally emitted them.
 * OMP is disjoint for every provider: across 63k measured usage rows, including OpenAI models,
 * `total == input + cacheRead + cacheWrite + output` with zero delta. Claude Code preserves
 * Anthropic's disjoint counters. Codex is subset: across 23,270 measured rows `cached <= input`
 * always, while `total == input + output`.
 *
 * This evidence is why the mapping is keyed by harness. Keying it by provider misclassifies OMP's
 * OpenAI rows and silently drops most of their cache-read cost. */
export const CACHE_BASIS_BY_HARNESS: Readonly<Record<string, CacheBasis>> = {
  omp: 'disjoint',
  'claude-code': 'disjoint',
  codex: 'subset',
};

export function cacheBasisForHarness(harness: string | null | undefined): CacheBasis | null {
  if (!harness || !Object.prototype.hasOwnProperty.call(CACHE_BASIS_BY_HARNESS, harness)) return null;
  return CACHE_BASIS_BY_HARNESS[harness]!;
}
