import type { FullConfig } from '@playwright/test';

/**
 * Deployed-preview runs need no global setup: the `previewBearer` fixture injects the
 * derived per-PR bearer header on every request (see fixtures/environment.ts), and local
 * runs own their environment per worker. Kept as a hook point so playwright.config.ts
 * does not change shape when setup becomes necessary again.
 */
export default async function globalSetup(_config: FullConfig): Promise<void> {}
