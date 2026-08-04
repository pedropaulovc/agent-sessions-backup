import { describe, expect, it } from 'vitest';
import {
  createPreviewStorageState,
  previewStorageStatePath,
  requiredCloudflareAccessHeaders,
} from '../e2e/storage-state';

const RUN_A = '11111111-1111-4111-8111-111111111111';
const RUN_B = '22222222-2222-4222-8222-222222222222';
const EMPTY_STATE = { cookies: [], origins: [] };

describe('Playwright preview storage state', () => {
  it('publishes one run path that config reloads reuse in workers', () => {
    const mainEnvironment: Record<string, string | undefined> = {};
    let generated = 0;
    const setupPath = previewStorageStatePath('bootstrap.json', mainEnvironment, 'test-temp', () => {
      generated += 1;
      return RUN_A;
    });

    const workerPath = previewStorageStatePath(
      'bootstrap.json',
      { ...mainEnvironment },
      'test-temp',
      () => {
        throw new Error('a worker must reuse the published run id');
      },
    );

    expect(workerPath).toBe(setupPath);
    expect(setupPath).toContain(RUN_A);
    expect(generated).toBe(1);
  });

  it('gives a new run a different path instead of reusing crashed-run state', () => {
    const crashedRunPath = previewStorageStatePath('bootstrap.json', {}, 'test-temp', () => RUN_A);
    const nextRunPath = previewStorageStatePath('bootstrap.json', {}, 'test-temp', () => RUN_B);

    expect(nextRunPath).not.toBe(crashedRunPath);
  });

  it('does not remove a pre-existing file when exclusive creation loses a race', async () => {
    let existingContents = 'unrelated run state';
    const fileSystem = {
      async create() {
        throw Object.assign(new Error('already exists'), { code: 'EEXIST' });
      },
      async remove() {
        existingContents = 'removed';
      },
    };

    await expect(createPreviewStorageState('state.json', EMPTY_STATE, fileSystem)).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(existingContents).toBe('unrelated run state');
  });

  it('returns cleanup ownership only after exclusive creation succeeds', async () => {
    let storedContents: string | undefined;
    let removed = false;
    const cleanup = await createPreviewStorageState('state.json', EMPTY_STATE, {
      async create(_path, contents) {
        storedContents = contents;
      },
      async remove() {
        removed = true;
      },
    });

    expect(storedContents).toBe('{"cookies":[],"origins":[]}\n');
    expect(removed).toBe(false);
    await cleanup();
    expect(removed).toBe(true);
  });
});

describe('Playwright Cloudflare Access headers', () => {
  it('requires both service credentials without forwarding unrelated environment values', () => {
    expect(requiredCloudflareAccessHeaders({
      CF_ACCESS_CLIENT_ID: ' client-id ',
      CF_ACCESS_CLIENT_SECRET: ' client-secret ',
      UNRELATED_SECRET: 'must-not-leak',
    })).toEqual({
      'cf-access-client-id': 'client-id',
      'cf-access-client-secret': 'client-secret',
    });
    expect(() => requiredCloudflareAccessHeaders({})).toThrow(/service credentials are required/);
    expect(() => requiredCloudflareAccessHeaders({
      CF_ACCESS_CLIENT_SECRET: 'client-secret',
    })).toThrow(/service credentials are required/);
  });
});
