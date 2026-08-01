export declare const MIN_CATALOG_ENTRIES: number;
export declare function perM(v: unknown): number | null;
export declare function intOrNull(v: unknown): number | null;
export declare function assertLooksLikeCatalog(payload: unknown): number;
export declare function undatedModel(model: string): string;
export declare function priceKeyCandidates(model: string): string[];
export declare function providerOf(entry: unknown): string | null;
export declare function cacheAccountingFor(provider: string | null): 'disjoint' | 'subset' | 'unknown';
