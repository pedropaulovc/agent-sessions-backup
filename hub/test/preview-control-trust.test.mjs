import { describe, expect, it } from 'vitest';
import {
  PREVIEW_ACCOUNT_ID,
  acknowledgedResources,
  assertInventoryItem,
  assertPreviewAccount,
  resourceNames,
} from '../../infra/cf/preview-trust.mjs';

const SHA = 'a'.repeat(40);
const GENERATION = 'g123-aaaaaaaaaaaa';

describe('trusted preview resource ownership', () => {
  it('pins every generated resource to the approved account and PR prefix', () => {
    expect(() => assertPreviewAccount(PREVIEW_ACCOUNT_ID)).not.toThrow();
    expect(() => assertPreviewAccount('18ef3246e9f36d1560485ef53889c0ab')).toThrow(/production/);
    expect(() => assertPreviewAccount('f'.repeat(32))).toThrow(/unapproved/);
    const names = resourceNames(42, 123, SHA);
    expect(names.generation).toBe(GENERATION);
    for (const name of [names.worker, names.d1, names.r2, names.kv, names.queue, names.dlq]) {
      expect(name.startsWith('pr-42-')).toBe(true);
    }
  });

  it('accepts generation-owned stable Workers and fail-closed planned null IDs only explicitly', () => {
    const planned = { kind: 'worker', id: null, name: 'pr-42-sessions-hub', generation: GENERATION };
    expect(() => assertInventoryItem(planned, 42, GENERATION)).toThrow(/id is required/);
    expect(assertInventoryItem(planned, 42, GENERATION, { allowMissingId: true })).toBe(planned);
    expect(() => assertInventoryItem({ ...planned, name: 'sessions-hub' }, 42, GENERATION, {
      allowMissingId: true,
    })).toThrow(/foreign inventory/);
    expect(() => assertInventoryItem({ ...planned, generation: 'g124-bbbbbbbbbbbb' }, 42, GENERATION, {
      allowMissingId: true,
    })).toThrow(/generation mismatch/);
  });

  it('acknowledges the original trusted identity rather than a resolved discovery ID', () => {
    expect(acknowledgedResources([{
      kind: 'd1', id: null, name: 'pr-42-g123-aaaaaaaaaaaa-sessions-index',
      generation: GENERATION, deleted: true, resolvedId: 'foreign-or-discovered-id',
    }])).toEqual([{
      kind: 'd1', id: null, name: 'pr-42-g123-aaaaaaaaaaaa-sessions-index', generation: GENERATION,
    }]);
  });
});
