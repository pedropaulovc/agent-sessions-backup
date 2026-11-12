import 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    /** hub/wrangler.jsonc top-level `triggers.crons`, or null when absent (vitest.config.ts). */
    wranglerCrons: string[] | null;
  }
}
