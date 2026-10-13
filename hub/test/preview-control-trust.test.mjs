import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SYNTHETIC_EXPECTATIONS } from '../scripts/lib/dev-seed.mjs';
import { detect } from '../src/ingest/detect';
import {
  PREVIEW_ACCOUNT_ID,
  PRODUCTION_ACCOUNT_ID,
  assertPreviewAccount,
  assertPreviewIndexLayout,
  assertPreviewResourceNames,
  assertWorkerModulePayload,
  deleteInDependencyPasses,
  emptyR2Bucket,
  generatedBuildConfig,
  generatedPrivateAppConfig,
  migrationSqlNames,
  paginatedList,
  previewBearerToken,
  previewDatabasePlan,
  previewIndexLayout,
  previewResourceOwner,
  queueConsumerIdsForQueue,
  resolveBundlerInputPath,
  resourceNames,
  previewWranglerEnvironment,
  wranglerWorkerBundle,
} from '../../infra/cf/preview-trust.mjs';
import {
  deactivatePreviewDeployments,
  previewDeploymentEnvironment,
} from '../../infra/cf/preview-deployment.mjs';

const SHA = 'a'.repeat(40);
const SEED = 's'.repeat(48);
const ASSET_SECRET = 'S'.repeat(43);
const DIGEST = 'd'.repeat(64);

function appConfig(overrides = {}) {
  const names = overrides.names ?? resourceNames(42);
  return generatedPrivateAppConfig({
    accountId: PREVIEW_ACCOUNT_ID,
    main: '/tmp/payload/worker.mjs',
    migrationsDir: '/tmp/payload/migrations',
    indexMigrationsDir: '/tmp/payload/migrations-index',
    names,
    resources: {
      d1: 'd1-id',
      indexShards: ['idx00-id', 'idx01-id'],
      kv: 'kv-id',
      pr: 42,
      headSha: SHA,
      buildInputDigest: DIGEST,
      artifactDigest: DIGEST,
      migrationDigest: DIGEST,
      schemaDigest: DIGEST,
      ...overrides.resources,
    },
    application: {
      assetSigningSecret: ASSET_SECRET,
      previewBearer: previewBearerToken(SEED, 42),
      ...overrides.application,
    },
  });
}

describe('per-PR preview bearer derivation', () => {
  it('is deterministic per PR, distinct across PRs, and refuses weak seeds', () => {
    expect(previewBearerToken(SEED, 42)).toBe(previewBearerToken(SEED, 42));
    expect(previewBearerToken(SEED, 42)).not.toBe(previewBearerToken(SEED, 43));
    expect(previewBearerToken(SEED, 42)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(() => previewBearerToken('short-seed', 42)).toThrow(/at least 32 characters/);
    expect(() => previewBearerToken(SEED, 0)).toThrow(/positive integer/);
  });
});

describe('stable per-PR resource names', () => {
  it('derives the fixed name set and the workers.dev host from the PR number alone', () => {
    const names = resourceNames(42);
    expect(names).toMatchObject({
      app: 'pr-42-app',
      d1: 'pr-42-sessions-index',
      indexShards: ['pr-42-sessions-index-idx00', 'pr-42-sessions-index-idx01'],
      r2: 'pr-42-agent-sessions',
      kv: 'pr-42-sessions-hub-kv',
      queue: 'pr-42-parse',
      dlq: 'pr-42-parse-dlq',
      rollupQueue: 'pr-42-session-rollup',
      host: 'pr-42-app.sessions-ppe.workers.dev',
    });
    expect(() => resourceNames(0)).toThrow(/positive integer/);
  });

  it('classifies resource ownership for cleanup, including legacy generation debris', () => {
    expect(previewResourceOwner('pr-42-sessions-index')).toEqual({ pr: 42, legacy: false });
    for (const name of resourceNames(42).indexShards) {
      expect(previewResourceOwner(name, 'd1')).toEqual({ pr: 42, legacy: false });
      expect(previewResourceOwner(name, 'worker')).toBeNull();
    }
    expect(previewResourceOwner('pr-42-sessions-index-idx02')).toBeNull();
    expect(previewResourceOwner('pr-42-sessions-index-idx01-extra')).toBeNull();
    expect(previewResourceOwner('pr-42-app', 'd1')).toBeNull();
    expect(previewResourceOwner(`pr-17-g12345-${'a'.repeat(12)}-foreign`)).toBeNull();
    expect(previewResourceOwner('pr-42-app')).toEqual({ pr: 42, legacy: false });
    expect(previewResourceOwner(`pr-17-g12345-${'a'.repeat(12)}-app`)).toEqual({ pr: 17, legacy: true });
    expect(previewResourceOwner('sessions-index')).toBeNull();
    expect(previewResourceOwner('pr-42-something-else')).toBeNull();
    expect(previewResourceOwner('prefix-pr-42-app')).toBeNull();
  });

  it('owns per-PR rollup queues without claiming standing or production queues for cleanup', () => {
    expect(previewResourceOwner(resourceNames(42).rollupQueue)).toEqual({ pr: 42, legacy: false });
    for (const name of ['session-rollup', 'session-rollup-preview', 'pr-42-session-rollup-preview', 'pr-0-session-rollup']) {
      expect(previewResourceOwner(name)).toBeNull();
    }
  });
});

describe('preview immutable layout and Free database quota', () => {
  it('rejects changed PR names, shard counts, and reordered shard names', () => {
    const names = resourceNames(42);
    expect(() => assertPreviewResourceNames(names, 42)).not.toThrow();
    expect(() => assertPreviewResourceNames(names, 43)).toThrow(/immutable per-PR layout/);
    expect(() => assertPreviewIndexLayout(previewIndexLayout(names), names)).not.toThrow();
    expect(() => assertPreviewIndexLayout({ ...previewIndexLayout(names), count: 16 }, names)).toThrow(/immutable/);
    expect(() => assertPreviewIndexLayout({
      ...previewIndexLayout(names),
      databases: [...previewIndexLayout(names).databases].reverse(),
    }, names)).toThrow(/immutable/);
  });

  it('counts all account databases and only allocates missing trusted names', () => {
    const names = resourceNames(42);
    const others = Array.from({ length: 7 }, (_, index) => ({ name: `foreign-${index}`, uuid: `foreign-id-${index}` }));
    const plan = previewDatabasePlan([...others, { name: names.d1, uuid: 'main-id' }], names);
    expect([...plan.existing]).toEqual([['DB', 'main-id']]);
    expect(plan.missing).toEqual([
      { binding: 'IDX00', name: names.indexShards[0] },
      { binding: 'IDX01', name: names.indexShards[1] },
    ]);
    expect(() => previewDatabasePlan([...others, { name: 'foreign-extra', uuid: 'extra' }], names))
      .toThrow(/8\/10 databases exist, 3 required.*no other PR resources were deleted/);
  });

  it('reuses all three databases even when no quota remains and rejects duplicate trusted names', () => {
    const names = resourceNames(42);
    const trusted = previewIndexLayout(names).databases.map(({ name, binding }) => ({ name, uuid: binding }));
    const others = Array.from({ length: 7 }, (_, index) => ({ name: `foreign-${index}`, uuid: `foreign-id-${index}` }));
    expect(previewDatabasePlan([...trusted, ...others], names).missing).toEqual([]);
    expect(() => previewDatabasePlan([...trusted, trusted[0]], names)).toThrow(/multiple preview databases/);
  });
});

describe('preview account pinning', () => {
  it('accepts only the approved non-production account', () => {
    expect(() => assertPreviewAccount(PREVIEW_ACCOUNT_ID)).not.toThrow();
    expect(() => assertPreviewAccount(PRODUCTION_ACCOUNT_ID)).toThrow(/production Cloudflare account/);
    expect(() => assertPreviewAccount('f'.repeat(32))).toThrow(/unapproved Cloudflare account/);
  });
});

describe('preview R2 cleanup', () => {
  it('lists every page and deletes encoded object keys before bucket deletion', async () => {
    const requests = [];
    const request = async (pathname, init) => {
      requests.push([pathname, init]);
      if (pathname.endsWith('per_page=1000')) {
        return {
          result: [{ key: 'raw/space key/first?.jsonl' }],
          result_info: { is_truncated: true, cursor: 'next/page==' },
        };
      }
      if (pathname.includes('cursor=next%2Fpage%3D%3D')) {
        return {
          result: [{ key: 'staging/second#object' }],
          result_info: { is_truncated: false },
        };
      }
      return {};
    };

    await expect(emptyR2Bucket('preview-bucket', request)).resolves.toBe(2);
    expect(requests).toEqual([
      ['r2/buckets/preview-bucket/objects?per_page=1000', {
        allowNotFound: true,
        responseFormat: 'envelope',
      }],
      ['r2/buckets/preview-bucket/objects?per_page=1000&cursor=next%2Fpage%3D%3D', {
        allowNotFound: true,
        responseFormat: 'envelope',
      }],
      ['r2/buckets/preview-bucket/objects/raw/space%20key/first%3F.jsonl', {
        method: 'DELETE',
        allowNotFound: true,
      }],
      ['r2/buckets/preview-bucket/objects/staging/second%23object', {
        method: 'DELETE',
        allowNotFound: true,
      }],
    ]);
  });

  it('treats an already deleted bucket as empty', async () => {
    await expect(emptyR2Bucket('preview-bucket', async () => null)).resolves.toBe(0);
  });
});

describe('paginated account listings', () => {
  it('walks page-based endpoints to exhaustion instead of reading only the first page', async () => {
    const pages = {
      1: { result: Array.from({ length: 2 }, (_, i) => ({ name: `row-${i}` })), result_info: { total_count: 3, per_page: 2 } },
      2: { result: [{ name: 'row-2' }], result_info: { total_count: 3, per_page: 2 } },
    };
    const seen = [];
    const rows = await paginatedList(async (pathname) => {
      seen.push(pathname);
      return pages[Number(new URLSearchParams(pathname.split('?')[1]).get('page'))];
    }, 'd1/database', { pagination: 'page', rowsOf: (envelope) => envelope.result, perPage: 2 });
    expect(rows.map((row) => row.name)).toEqual(['row-0', 'row-1', 'row-2']);
    expect(seen).toEqual(['d1/database?per_page=2&page=1', 'd1/database?per_page=2&page=2']);
  });

  it('follows cursor-based endpoints until the cursor runs out', async () => {
    const rows = await paginatedList(async (pathname) => {
      if (!pathname.includes('cursor=')) {
        return { result: { buckets: [{ name: 'pr-1-agent-sessions' }] }, result_info: { cursor: 'c2' } };
      }
      return { result: { buckets: [{ name: 'pr-2-agent-sessions' }] }, result_info: {} };
    }, 'r2/buckets', { pagination: 'cursor', rowsOf: (envelope) => envelope.result?.buckets, perPage: 1 });
    expect(rows.map((row) => row.name)).toEqual(['pr-1-agent-sessions', 'pr-2-agent-sessions']);
  });

  it('appends pagination onto an existing query string and tolerates a missing endpoint', async () => {
    const seen = [];
    const rows = await paginatedList(async (pathname) => {
      seen.push(pathname);
      return null;
    }, 'd1/database?name=pr-1-sessions-index', { pagination: 'page', rowsOf: (envelope) => envelope.result });
    expect(rows).toEqual([]);
    expect(seen).toEqual(['d1/database?name=pr-1-sessions-index&per_page=100&page=1']);
  });

  it('refuses a cursor loop rather than spinning forever', async () => {
    await expect(paginatedList(
      async () => ({ result: { buckets: [{ name: 'x' }] }, result_info: { cursor: 'same' } }),
      'r2/buckets',
      { pagination: 'cursor', rowsOf: (envelope) => envelope.result?.buckets, perPage: 1 },
    )).rejects.toThrow(/repeated a cursor/);
  });
});

describe('preview synthetic corpus', () => {
  it('uses the same indexable Claude paths and identities as local e2e', () => {
    expect(detect(
      SYNTHETIC_EXPECTATIONS.store,
      SYNTHETIC_EXPECTATIONS.primaryRelpath,
      SYNTHETIC_EXPECTATIONS.machine,
    )).toMatchObject({
      kind: 'session',
      sessionId: SYNTHETIC_EXPECTATIONS.primarySessionId,
    });
    expect(detect(
      SYNTHETIC_EXPECTATIONS.store,
      SYNTHETIC_EXPECTATIONS.pagerRelpath,
      SYNTHETIC_EXPECTATIONS.machine,
    )).toMatchObject({
      kind: 'session',
      sessionId: SYNTHETIC_EXPECTATIONS.pagerSessionId,
    });
    expect(detect(
      SYNTHETIC_EXPECTATIONS.store,
      SYNTHETIC_EXPECTATIONS.externalRelpath,
      SYNTHETIC_EXPECTATIONS.machine,
    )).toMatchObject({ kind: 'other' });
  });
});

describe('preview migration packaging', () => {
  it('accepts canonical baseline metadata without copying it as a migration', () => {
    expect(migrationSqlNames([
      'source-baseline.json',
      '0002_next.sql',
      'manifest.json',
      'historical-baseline.json',
      '0001_init.sql',
    ])).toEqual(['0001_init.sql', '0002_next.sql']);
    expect(() => migrationSqlNames([
      'manifest.json',
      '0001_init.sql',
      'attacker.json',
    ])).toThrow(/unexpected migration entry/);
    expect(() => migrationSqlNames([
      'manifest.json',
      '0001_init.sql',
      'constructor',
    ])).toThrow(/unexpected migration entry/);
  });
});

describe('queue consumer detachment', () => {
  it('accepts native worker consumers owned by the same PR, including known legacy workers', () => {
    expect(queueConsumerIdsForQueue([
      { consumer_id: 'c1', type: 'worker', script: 'pr-42-app', queue_name: 'pr-42-parse' },
      { consumer_id: 'c2', type: 'worker', script: `pr-42-g99-${'b'.repeat(12)}-app` },
    ], 'pr-42-parse')).toEqual(['c1', 'c2']);
    expect(queueConsumerIdsForQueue([
      { consumer_id: 'canonical-owner', type: 'worker', script: 'pr-42-app', script_name: 'pr-43-app',
        ['PRIVATE PROPERTY KEY accepted preview consumer canary']: 'harmless extra metadata' },
    ], 'pr-42-parse')).toEqual(['canonical-owner']);
  });

  for (const [name, consumer] of [
    ['missing canonical owner', { consumer_id: 'c3', type: 'worker' }],
    ['owned alias without a canonical owner', { consumer_id: 'c3', type: 'worker', script_name: 'pr-42-app' }],
    ['null owner', { consumer_id: 'c3', type: 'worker', script: null, script_name: 'pr-42-app' }],
    ['non-string owner', { consumer_id: 'c3', type: 'worker', script: 42, script_name: 'pr-42-app' }],
    ['unknown owner', { consumer_id: 'c3', type: 'worker', script: 'pr-42-unrecognized', script_name: 'pr-42-app' }],
    ['standing foreign owner', { consumer_id: 'c4', type: 'worker', script: 'sessions-hub', script_name: 'pr-42-app' }],
    ['another PR owner', { consumer_id: 'other-pr', type: 'worker', script: 'pr-43-app', script_name: 'pr-42-app' }],
    ['null record', null],
    ['array record', []],
    ['primitive record', 'private primitive consumer record'],
  ]) {
    it(`rejects ${name} instead of returning a partial detachment list`, () => {
      expect(() => queueConsumerIdsForQueue([
        { consumer_id: 'valid-first', type: 'worker', script: 'pr-42-app' },
        consumer,
      ], 'pr-42-parse')).toThrow();
    });
  }

  for (const type of [undefined, null, 'http_pull', 42]) {
    it(`rejects non-worker type ${String(type)} even with a known same-PR owner`, () => {
      expect(() => queueConsumerIdsForQueue([
        { consumer_id: 'non-worker', type, script: 'pr-42-app', script_name: 'pr-42-app' },
      ], 'pr-42-parse')).toThrow();
    });
  }

  for (const consumerId of [undefined, null, 42, '']) {
    it(`rejects invalid consumer ID ${String(consumerId)} after checking the owner and type`, () => {
      expect(() => queueConsumerIdsForQueue([
        { consumer_id: consumerId, type: 'worker', script: 'pr-42-app' },
      ], 'pr-42-parse')).toThrow();
    });
  }

  it('redacts unrelated settings, auth, consumer IDs and malformed identity strings in rejection diagnostics', () => {
    const privateValues = {
      consumerId: 'private-consumer-id-value',
      settings: 'private-unrelated-settings-value',
      auth: 'private-auth-token-value',
      owner: 'private invalid owner/value',
      type: 'private malformed type/value',
      alias: 'private invalid alias/value',
      propertyKey: 'PRIVATE PROPERTY KEY preview rejection canary',
    };
    for (const identity of [
      { type: 'worker', script: privateValues.owner },
      { type: privateValues.type, script: 'pr-42-app' },
    ]) {
      let rejection;
      try {
        queueConsumerIdsForQueue([{
          consumer_id: privateValues.consumerId, ...identity, script_name: privateValues.alias,
          settings: { retry: privateValues.settings }, auth: { bearer: privateValues.auth },
          [privateValues.propertyKey]: privateValues.auth,
        }], 'pr-42-parse');
      } catch (error) {
        rejection = error;
      }
      if (!rejection) expect.unreachable('malformed queue consumer identity must be rejected');
      for (const value of Object.values(privateValues)) {
        expect(rejection.message).not.toContain(value);
      }
    }
  });

  it('refuses to detach a foreign standing consumer from a PR rollup queue', () => {
    const queue = resourceNames(42).rollupQueue;
    expect(queueConsumerIdsForQueue([
      { consumer_id: 'rollup-consumer', type: 'worker', script: 'pr-42-app' },
    ], queue)).toEqual(['rollup-consumer']);
    expect(() => queueConsumerIdsForQueue([
      { consumer_id: 'foreign-consumer', type: 'worker', script: 'sessions-hub-preview' },
    ], queue)).toThrow();
  });
});

describe('dependency-tolerant resource deletion', () => {
  it('retries a service-bound worker after the worker referencing it is gone', async () => {
    // Legacy generations deploy edge→app pairs: the edge binds the app, so deleting the
    // app first fails with Cloudflare 10142 until the edge is removed.
    const alive = new Set(['pr-127-edge', 'pr-127-app', 'pr-127-d1']);
    const attempts = [];
    const deleted = await deleteInDependencyPasses(
      [{ name: 'pr-127-app' }, { name: 'pr-127-d1' }, { name: 'pr-127-edge' }],
      async ({ name }) => {
        attempts.push(name);
        if (name === 'pr-127-app' && alive.has('pr-127-edge')) {
          throw new Error('10142: still referenced by service bindings');
        }
        alive.delete(name);
      },
    );
    expect(alive.size).toBe(0);
    expect(deleted.map((item) => item.name)).toEqual(['pr-127-d1', 'pr-127-edge', 'pr-127-app']);
    expect(attempts).toEqual(['pr-127-app', 'pr-127-d1', 'pr-127-edge', 'pr-127-app']);
  });

  it('fails loud with the first error once a full pass makes no progress', async () => {
    await expect(deleteInDependencyPasses(
      [{ name: 'stuck-a' }, { name: 'stuck-b' }],
      async ({ name }) => { throw new Error(`cannot delete ${name}`); },
    )).rejects.toThrow(/cannot delete stuck-a/);
  });

  it('deletes an unconstrained set in one pass and returns every item', async () => {
    const deleted = await deleteInDependencyPasses(
      [{ name: 'a' }, { name: 'b' }],
      async () => {},
    );
    expect(deleted.map((item) => item.name)).toEqual(['a', 'b']);
    expect(await deleteInDependencyPasses([], async () => { throw new Error('never'); })).toEqual([]);
  });
});

describe('private preview application config', () => {
  it('binds the bearer, the asset secret, and workers.dev exposure — nothing production-shaped', () => {
    const config = appConfig();
    expect(config.workers_dev).toBe(true);
    expect(config.preview_urls).toBe(false);
    expect(config.routes).toEqual([]);
    expect(config.vars.ENVIRONMENT).toBe('preview');
    expect(config.vars.PREVIEW_BEARER).toBe(previewBearerToken(SEED, 42));
    expect(config.vars.ASSET_SIGNING_SECRET).toBe(ASSET_SECRET);
    expect(config.vars.API_HOST).toBe('pr-42-app.sessions-ppe.workers.dev');
    expect(config.vars.VIEWER_HOST).toBe(config.vars.API_HOST);
    expect(config.vars.PREVIEW_PR_NUMBER).toBe('42');
    expect(config.vars.INDEX_SHARD_COUNT).toBe('2');
    expect(config.vars.INDEX_MODE).toBe('active');
    expect(config.vars.DEPLOYMENT_REVISION).toBe(SHA);
    // The assertion/JWKS machinery died with the front door — its vars must never come back.
    for (const retired of [
      'PREVIEW_ASSERTION_ISSUER',
      'PREVIEW_BROWSER_ASSERTION_JWKS',
      'PREVIEW_ACTION_ASSERTION_JWKS',
      'PREVIEW_ORIGIN_ASSERTION_JWKS',
      'PREVIEW_GENERATION',
      'ENVIRONMENT_NONCE',
      'DEBUG_IMPORT_ASSERTION_PUBLIC_JWK',
      'DEBUG_EXPORT_MANIFEST_VERIFY_PUBLIC_JWK',
      'PRODUCTION_SESSION_SIGNING_KEY',
      'SETUP_TOKEN',
    ]) {
      expect(config.vars).not.toHaveProperty(retired);
    }
    expect(config.d1_databases).toEqual([
      { binding: 'DB', database_name: 'pr-42-sessions-index', database_id: 'd1-id', migrations_dir: '/tmp/payload/migrations' },
      { binding: 'IDX00', database_name: 'pr-42-sessions-index-idx00', database_id: 'idx00-id', migrations_dir: '/tmp/payload/migrations-index' },
      { binding: 'IDX01', database_name: 'pr-42-sessions-index-idx01', database_id: 'idx01-id', migrations_dir: '/tmp/payload/migrations-index' },
    ]);
    expect(config.r2_buckets[0]).toMatchObject({ binding: 'RAW', bucket_name: 'pr-42-agent-sessions' });
    expect(config.ratelimits).toEqual([{
      name: 'OMP_QA_RATE_LIMITER',
      namespace_id: '100042',
      simple: { limit: 30, period: 60 },
    }]);
    expect(config.queues.consumers[0]).toMatchObject({ queue: 'pr-42-parse', dead_letter_queue: 'pr-42-parse-dlq' });
  });

  it('rejects malformed bearers, secrets, and digests', () => {
    expect(() => appConfig({ application: { previewBearer: 'not-a-token' } })).toThrow(/preview bearer/);
    expect(() => appConfig({ application: { assetSigningSecret: 'short' } })).toThrow(/asset signing secret/);
    expect(() => appConfig({ resources: { schemaDigest: 'xyz' } })).toThrow(/invalid schemaDigest/);
  });

  it('rejects missing, duplicate, or foreign-named database layouts rather than binding main as an index', () => {
    expect(() => appConfig({ resources: { indexShards: ['only-one'] } })).toThrow(/exactly two/);
    expect(() => appConfig({ resources: { indexShards: ['d1-id', 'idx01-id'] } })).toThrow(/must be distinct/);
    expect(() => appConfig({ names: { ...resourceNames(42), indexShards: ['pr-43-sessions-index-idx00', 'pr-42-sessions-index-idx01'] } }))
      .toThrow(/immutable per-PR layout/);
    expect(() => appConfig({ resources: { headSha: 'not-a-sha' } })).toThrow(/head SHA/);
  });

  it('keeps the build config private (no public URL surface)', () => {
    const config = generatedBuildConfig({ main: '/src/preview.ts', workerName: 'pr-42-app' });
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
  });
});

describe('bundler metafile input paths', () => {
  const posixConfigDirectory = '/tmp/sessions-preview-build-abc';
  const posixInput = '../../home/runner/work/agent-sessions-backup/agent-sessions-backup/source/hub/node_modules/pkg/index.js';

  it('resolves Wrangler inputs from the generated config directory', () => {
    expect(resolveBundlerInputPath(posixConfigDirectory, posixInput, path.posix))
      .toBe('/home/runner/work/agent-sessions-backup/agent-sessions-backup/source/hub/node_modules/pkg/index.js');
    expect(resolveBundlerInputPath(posixConfigDirectory, 'generated/module.js', path.posix))
      .toBe(`${posixConfigDirectory}/generated/module.js`);
  });

  it('normalizes Windows relative and absolute inputs', () => {
    const windowsConfigDirectory = 'C:\\temp\\sessions-preview-build-abc';
    const expected = 'C:\\work\\source\\hub\\node_modules\\pkg\\index.js';
    expect(resolveBundlerInputPath(windowsConfigDirectory, expected, path.win32)).toBe(expected);
    expect(resolveBundlerInputPath(windowsConfigDirectory, '..\\..\\work\\source\\hub\\node_modules\\pkg\\index.js', path.win32))
      .toBe(expected);
  });
});

describe('preview Wrangler process environment', () => {
  it('preserves machine-readable output without inheriting unrelated secrets', () => {
    expect(previewWranglerEnvironment({
      PATH: '/trusted/bin',
      HOME: '/trusted/home',
      WRANGLER_LOG: 'error',
      UNRELATED_SECRET: 'must-not-leak',
    }, 'preview-token', PREVIEW_ACCOUNT_ID)).toEqual({
      PATH: '/trusted/bin',
      HOME: '/trusted/home',
      CLOUDFLARE_API_TOKEN: 'preview-token',
      CLOUDFLARE_ACCOUNT_ID: PREVIEW_ACCOUNT_ID,
      WRANGLER_LOG: 'log',
      NO_COLOR: '1',
    });
  });
});

describe('Worker bundle payload', () => {
  it('rejects Wrangler multipart upload envelopes before deployment', () => {
    const multipart = new TextEncoder().encode('--boundary\\r\\nContent-Disposition: form-data');
    expect(() => assertWorkerModulePayload(multipart)).toThrow(/multipart upload envelope/);
  });

  it('accepts JavaScript module output', () => {
    const module = new TextEncoder().encode('export default { fetch() {} };');
    expect(assertWorkerModulePayload(module)).toBe(module);
  });

  it('selects one executable module from a Wrangler output directory', async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), 'wrangler-worker-output-'));
    try {
      await writeFile(path.join(output, 'README.md'), 'generated');
      await writeFile(path.join(output, 'preview.js.map'), '{}');
      const worker = path.join(output, 'preview.js');
      await writeFile(worker, 'export default { fetch() {} };');
      expect(await wranglerWorkerBundle(output)).toBe(worker);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });
});

describe('preview deployment card removal', () => {
  const repository = 'pedropaulovc/agent-sessions-backup';
  const pr = 42;
  const logUrl = `https://github.com/${repository}/actions/runs/456`;

  it('names the per-PR environment GitHub opens from the preview job', () => {
    expect(previewDeploymentEnvironment(pr)).toBe('preview/pr-42');
    expect(() => previewDeploymentEnvironment(0)).toThrow(/PR number/);
  });

  it('walks every deployment page before inactivating removed preview cards', async () => {
    const first = Array.from({ length: 100 }, (unused, index) => ({ id: index + 1 }));
    const calls = [];
    const request = async (pathname, init) => {
      calls.push({ pathname, init });
      if (pathname.startsWith(`/repos/${repository}/deployments?`)) {
        return new URL(pathname, 'https://api.github.com').searchParams.get('page') === '1'
          ? first
          : [{ id: 900 }];
      }
      if (pathname.includes('/statuses?')) return [{ state: 'success' }];
      return { state: 'inactive' };
    };

    const inactivated = await deactivatePreviewDeployments({ request, repository, pr, logUrl });

    expect(inactivated).toEqual([...first.map((row) => row.id), 900]);
    const listed = calls.filter((call) => call.pathname.includes('/deployments?'));
    expect(listed).toHaveLength(2);
    expect(listed[0].pathname).toContain('environment=preview%2Fpr-42');
    const statuses = calls.filter((call) => call.pathname.endsWith('/statuses'));
    expect(statuses).toHaveLength(101);
    expect(JSON.parse(statuses[0].init.body)).toMatchObject({
      state: 'inactive',
      environment: 'preview/pr-42',
      description: 'Preview environment removed',
      auto_inactive: false,
      log_url: logUrl,
    });
  });

  it('rejects a GitHub deployment status response with the wrong state', async () => {
    const request = async (pathname) => {
      if (pathname.includes('/deployments?')) return [{ id: 1 }];
      if (pathname.includes('/statuses?')) return [{ state: 'success' }];
      return { state: 'success' };
    };

    await expect(deactivatePreviewDeployments({ request, repository, pr }))
      .rejects.toThrow(/did not report inactive/);
  });

  it('leaves a card GitHub already auto-inactivated alone', async () => {
    const calls = [];
    const request = async (pathname) => {
      calls.push(pathname);
      if (pathname.includes('/deployments?')) return [{ id: 1 }, { id: 2 }];
      if (pathname.includes('/deployments/1/statuses?')) return [{ state: 'inactive' }];
      if (pathname.includes('/statuses?')) return [];
      return { state: 'inactive' };
    };

    const inactivated = await deactivatePreviewDeployments({ request, repository, pr });

    expect(inactivated).toEqual([2]);
    expect(calls.filter((pathname) => pathname.endsWith('/statuses'))).toEqual([
      `/repos/${repository}/deployments/2/statuses`,
    ]);
  });

  it('refuses a non-HTTPS log URL rather than writing it onto a card', async () => {
    const request = async () => [];

    await expect(deactivatePreviewDeployments({
      request,
      repository,
      pr,
      logUrl: 'http://github.com/run',
    })).rejects.toThrow(/log URL/);
  });
});
