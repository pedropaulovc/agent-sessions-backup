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
  assertTrustedWorkflowRef,
  assertWorkerModulePayload,
  emptyR2Bucket,
  generatedBuildConfig,
  generatedPrivateAppConfig,
  migrationArtifactSqlNames,
  previewBearerToken,
  previewResourceOwner,
  queueConsumerIdsForQueue,
  resolveBundlerInputPath,
  resourceNames,
  trustedWranglerEnvironment,
  wranglerWorkerBundle,
} from '../../infra/cf/preview-trust.mjs';

const SHA = 'a'.repeat(40);
const SEED = 's'.repeat(48);
const ASSET_SECRET = 'S'.repeat(43);
const DIGEST = 'd'.repeat(64);

function appConfig(overrides = {}) {
  const names = resourceNames(42);
  return generatedPrivateAppConfig({
    accountId: PREVIEW_ACCOUNT_ID,
    main: '/tmp/payload/worker.mjs',
    migrationsDir: '/tmp/payload/migrations',
    names,
    resources: {
      d1: 'd1-id',
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

describe('trusted preview workflow identity', () => {
  it('binds the allowed workflow ref to the validated full repository name', () => {
    const repository = 'pedropaulovc/agent-sessions-backup';
    const expected = `${repository}/.github/workflows/preview-control.yml@refs/heads/main`;
    expect(assertTrustedWorkflowRef(repository, expected)).toBe(expected);
    expect(() => assertTrustedWorkflowRef(
      repository,
      `lookalike/${expected}`,
    )).toThrow(/trusted default-branch preview-control workflow/);
    expect(() => assertTrustedWorkflowRef(
      repository,
      'attacker/agent-sessions-backup/.github/workflows/preview-control.yml@refs/heads/main',
    )).toThrow(/trusted default-branch preview-control workflow/);
  });
});

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
      r2: 'pr-42-agent-sessions',
      kv: 'pr-42-sessions-hub-kv',
      queue: 'pr-42-parse',
      dlq: 'pr-42-parse-dlq',
      host: 'pr-42-app.agent-sessions-nonproduction.workers.dev',
    });
    expect(() => resourceNames(0)).toThrow(/positive integer/);
  });

  it('classifies resource ownership for cleanup, including legacy generation debris', () => {
    expect(previewResourceOwner('pr-42-sessions-index')).toEqual({ pr: 42, legacy: false });
    expect(previewResourceOwner('pr-42-app')).toEqual({ pr: 42, legacy: false });
    expect(previewResourceOwner(`pr-17-g12345-${'a'.repeat(12)}-app`)).toEqual({ pr: 17, legacy: true });
    expect(previewResourceOwner('sessions-index')).toBeNull();
    expect(previewResourceOwner('pr-42-something-else')).toBeNull();
    expect(previewResourceOwner('prefix-pr-42-app')).toBeNull();
  });
});

describe('preview account pinning', () => {
  it('accepts only the approved non-production account', () => {
    expect(() => assertPreviewAccount(PREVIEW_ACCOUNT_ID)).not.toThrow();
    expect(() => assertPreviewAccount(PRODUCTION_ACCOUNT_ID)).toThrow(/production Cloudflare account/);
    expect(() => assertPreviewAccount('f'.repeat(32))).toThrow(/unapproved Cloudflare account/);
  });
});

describe('trusted preview R2 cleanup', () => {
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
        returnEnvelope: true,
      }],
      ['r2/buckets/preview-bucket/objects?per_page=1000&cursor=next%2Fpage%3D%3D', {
        allowNotFound: true,
        returnEnvelope: true,
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

describe('trusted preview synthetic corpus', () => {
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

describe('trusted migration packaging', () => {
  it('accepts canonical baseline metadata without copying it as a migration', () => {
    expect(migrationArtifactSqlNames([
      'source-baseline.json',
      '0002_next.sql',
      'manifest.json',
      'historical-baseline.json',
      '0001_init.sql',
    ])).toEqual(['0001_init.sql', '0002_next.sql']);
    expect(() => migrationArtifactSqlNames([
      'manifest.json',
      '0001_init.sql',
      'attacker.json',
    ])).toThrow(/unexpected migration entry/);
    expect(() => migrationArtifactSqlNames([
      'manifest.json',
      '0001_init.sql',
      'constructor',
    ])).toThrow(/unexpected migration entry/);
  });
});

describe('queue consumer detachment', () => {
  it('detaches only preview-owned consumers and rejects foreign scripts loud', () => {
    expect(queueConsumerIdsForQueue([
      { consumer_id: 'c1', script_name: 'pr-42-app', queue_name: 'pr-42-parse' },
      { consumer_id: 'c2', script_name: `pr-42-g99-${'b'.repeat(12)}-app` },
      { consumer_id: 'c3' },
    ], 'pr-42-parse')).toEqual(['c1', 'c2', 'c3']);
    expect(() => queueConsumerIdsForQueue([
      { consumer_id: 'c4', script_name: 'sessions-hub' },
    ], 'pr-42-parse')).toThrow(/foreign queue consumer/);
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
    expect(config.vars.API_HOST).toBe('pr-42-app.agent-sessions-nonproduction.workers.dev');
    expect(config.vars.VIEWER_HOST).toBe(config.vars.API_HOST);
    expect(config.vars.PREVIEW_PR_NUMBER).toBe('42');
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
    expect(config.d1_databases[0]).toMatchObject({ binding: 'DB', database_name: 'pr-42-sessions-index', database_id: 'd1-id' });
    expect(config.r2_buckets[0]).toMatchObject({ binding: 'RAW', bucket_name: 'pr-42-agent-sessions' });
    expect(config.queues.consumers[0]).toMatchObject({ queue: 'pr-42-parse', dead_letter_queue: 'pr-42-parse-dlq' });
  });

  it('rejects malformed bearers, secrets, and digests', () => {
    expect(() => appConfig({ application: { previewBearer: 'not-a-token' } })).toThrow(/preview bearer/);
    expect(() => appConfig({ application: { assetSigningSecret: 'short' } })).toThrow(/asset signing secret/);
    expect(() => appConfig({ resources: { schemaDigest: 'xyz' } })).toThrow(/invalid schemaDigest/);
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

describe('trusted Wrangler process environment', () => {
  it('preserves machine-readable output without inheriting unrelated secrets', () => {
    expect(trustedWranglerEnvironment({
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
