import { describe, expect, it } from 'vitest';
import * as previewEntrypoint from '../src/preview';
import * as productionEntrypoint from '../src/index';

describe('preview entrypoint', () => {
  it('exports only the default Worker handler while production keeps the Durable Object handler', () => {
    expect(Object.keys(previewEntrypoint)).toEqual(['default']);
    expect(previewEntrypoint.default).toBe(productionEntrypoint.default);
    expect(productionEntrypoint.CloudflareOAuthBroker).toBeTypeOf('function');
  });
});
