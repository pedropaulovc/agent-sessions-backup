import { describe, expect, it } from 'vitest';
import wranglerSource from '../wrangler.jsonc?raw';
import * as previewEntrypoint from '../src/preview';
import * as productionEntrypoint from '../src/index';

interface WranglerConfig {
  exports?: Record<string, unknown>;
  env?: Record<string, WranglerConfig & { main?: string }>;
}

const wrangler = JSON.parse(wranglerSource.replace(/^\s*\/\/.*$/gm, '')) as WranglerConfig;

describe('preview entrypoint', () => {
  it('exports only the default Worker handler while production keeps the Durable Object handler', () => {
    expect(Object.keys(previewEntrypoint)).toEqual(['default']);
    expect(previewEntrypoint.default).toBe(productionEntrypoint.default);
    expect(productionEntrypoint.CloudflareOAuthBroker).toBeTypeOf('function');
  });

  it('resolves preview upload exports to empty instead of inheriting the production Durable Object export', () => {
    const preview = wrangler.env?.preview;
    const effectiveExports = preview && Object.hasOwn(preview, 'exports') ? preview.exports : wrangler.exports;

    expect(wrangler.exports).toHaveProperty('CloudflareOAuthBroker');
    expect(preview?.main).toBe('src/preview.ts');
    expect(effectiveExports).toEqual({});
  });
});
