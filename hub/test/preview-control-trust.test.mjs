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
  assertSameRepositoryOpenPullRequest,
  assertTrustedPreviewQueueRun,
  assertTrustedPreviewQueueWorkflowRef,
  assertTrustedPreviewResetRun,
  assertTrustedPreviewResetWorkflowRef,
  assertTrustedSourceCiRun,
  assertTrustedWorkflowRef,
  assertWorkerModulePayload,
  deleteInDependencyPasses,
  emptyR2Bucket,
  generatedBuildConfig,
  generatedPrivateAppConfig,
  migrationArtifactSqlNames,
  paginatedList,
  previewBearerToken,
  previewResourceOwner,
  queueConsumerIdsForQueue,
  resolveBundlerInputPath,
  resourceNames,
  trustedWranglerEnvironment,
  wranglerWorkerBundle,
} from '../../infra/cf/preview-trust.mjs';
import {
  awaitQueuedPreviewDeployment,
  claimPreviewDeployment,
  completePreviewDeployment,
  deactivatePreviewDeployments,
  findPreviewAnnouncement,
  inactivateSupersededPreviewDeployments,
  previewDeploymentEnvironment,
  queuePreviewDeployment,
  rejectQueuedPreviewDeployments,
  settleQueuedPreviewDeployment,
} from '../../infra/cf/preview-deployment.mjs';

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
  it('binds each trusted workflow ref to the validated full repository name', () => {
    const repository = 'pedropaulovc/agent-sessions-backup';
    const controller = `${repository}/.github/workflows/preview-control.yml@refs/heads/main`;
    const queue = `${repository}/.github/workflows/preview-queue.yml@refs/heads/main`;
    const reset = `${repository}/.github/workflows/preview-close.yml@refs/heads/main`;
    expect(assertTrustedWorkflowRef(repository, controller)).toBe(controller);
    expect(assertTrustedPreviewQueueWorkflowRef(repository, queue)).toBe(queue);
    expect(assertTrustedPreviewResetWorkflowRef(repository, reset)).toBe(reset);
    expect(() => assertTrustedWorkflowRef(
      repository,
      `lookalike/${controller}`,
    )).toThrow(/trusted default-branch preview-control workflow/);
    expect(() => assertTrustedPreviewQueueWorkflowRef(
      repository,
      `attacker/${queue}`,
    )).toThrow(/trusted default-branch preview-queue workflow/);
  });
});

describe('GitHub PR event trust', () => {
  const repository = 'pedropaulovc/agent-sessions-backup';
  const pr = 42;

  it('rejects a fork before a queue card can be created', () => {
    const pull = {
      state: 'open',
      head: { sha: SHA, repo: { full_name: 'attacker/agent-sessions-backup' } },
    };
    expect(() => assertSameRepositoryOpenPullRequest(repository, pr, pull, SHA))
      .toThrow(/same-repository PR/);
  });

  it('accepts only the expected same-repository CI and trusted announcement runs', () => {
    const source = {
      id: 123,
      event: 'pull_request',
      head_sha: SHA,
      repository: { full_name: repository },
      head_repository: { full_name: repository },
      name: 'CI',
      path: '.github/workflows/ci.yml',
      pull_requests: [{ number: pr }],
    };
    const queue = {
      id: 456,
      event: 'pull_request_target',
      // pull_request_target executes default-branch code, so its SHA must not be the PR SHA.
      head_sha: 'b'.repeat(40),
      repository: { full_name: repository },
      head_repository: { full_name: repository },
      name: 'Preview Queue',
      path: '.github/workflows/preview-queue.yml',
    };
    const reset = {
      id: 457,
      event: 'workflow_dispatch',
      repository: { full_name: repository },
      name: 'Preview Close',
      path: '.github/workflows/preview-close.yml',
    };
    expect(assertTrustedSourceCiRun(repository, pr, source, 123, SHA)).toBe(source);
    expect(assertTrustedPreviewQueueRun(repository, queue, 456)).toBe(queue);
    expect(assertTrustedPreviewResetRun(repository, reset, 457)).toBe(reset);
    expect(() => assertTrustedSourceCiRun(
      repository,
      pr,
      { ...source, head_repository: { full_name: 'attacker/agent-sessions-backup' } },
      123,
      SHA,
    )).toThrow(/same-repository PR head/);
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

describe('PR-visible preview deployment cards', () => {
  const repository = 'pedropaulovc/agent-sessions-backup';
  const pr = 42;
  const sourceRunId = 123;
  const controllerRunId = 456;
  const announcementRunId = 654;
  const deploymentId = 789;
  const environment = 'preview/pr-42';
  const url = `https://${resourceNames(pr).host}`;
  const controllerLogUrl = `https://github.com/${repository}/actions/runs/${controllerRunId}`;
  const queueLogUrl = `https://github.com/${repository}/actions/runs/${announcementRunId}`;
  const queueWorkflowRef = `${repository}/.github/workflows/preview-queue.yml@refs/heads/main`;
  const resetWorkflowRef = `${repository}/.github/workflows/preview-close.yml@refs/heads/main`;
  const olderCreatedAt = '2026-08-16T19:00:00.000Z';
  const currentCreatedAt = '2026-08-16T19:01:00.000Z';
  const newerCreatedAt = '2026-08-16T19:02:00.000Z';

  function deploymentListPath() {
    return `/repos/${repository}/deployments?environment=preview%2Fpr-42&per_page=100&page=1`;
  }

  function statusListPath(id) {
    return `/repos/${repository}/deployments/${id}/statuses?per_page=100&page=1`;
  }

  function status(id, state, createdAt = currentCreatedAt, overrides = {}) {
    return { id, state, created_at: createdAt, ...overrides };
  }

  function queuedCard(id, createdAt, overrides = {}) {
    const runId = overrides.announcementRunId ?? announcementRunId;
    return {
      id,
      created_at: createdAt,
      task: 'preview-announce',
      environment,
      ref: SHA,
      sha: SHA,
      transient_environment: true,
      production_environment: false,
      payload: {
        schema: 'sessions-preview-announcement/v1',
        pr,
        head_sha: SHA,
        announcement_run_id: runId,
        announcement_workflow_ref: queueWorkflowRef,
        ...overrides.payload,
      },
      ...overrides.deployment,
    };
  }

  function queueArgs(overrides = {}) {
    return {
      repository,
      pr,
      sha: SHA,
      announcementRunId,
      workflowRef: queueWorkflowRef,
      ...overrides,
    };
  }

  function controllerArgs(overrides = {}) {
    return {
      repository,
      pr,
      sha: SHA,
      sourceRunId,
      runId: controllerRunId,
      ...overrides,
    };
  }

  it('queues an immutable PR-SHA card before source CI can finish', async () => {
    const checks = [];
    const requests = [];
    const request = async (pathname, init) => {
      requests.push({ pathname, init });
      if (pathname === `/repos/${repository}/deployments`) return { id: deploymentId };
      if (pathname === `/repos/${repository}/deployments/${deploymentId}/statuses`) return { state: 'queued' };
      throw new Error(`unexpected request: ${pathname}`);
    };

    const card = await queuePreviewDeployment({
      request,
      verify: async () => { checks.push('verified'); },
      ...queueArgs(),
    });

    expect(checks).toEqual(['verified', 'verified', 'verified']);
    expect(card).toEqual({ deploymentId, environment, url: null });
    expect(JSON.parse(requests[0].init.body)).toEqual({
      ref: SHA,
      task: 'preview-announce',
      auto_merge: false,
      required_contexts: [],
      environment,
      description: 'Preview queued for PR #42',
      transient_environment: true,
      production_environment: false,
      payload: {
        schema: 'sessions-preview-announcement/v1',
        pr,
        head_sha: SHA,
        announcement_run_id: announcementRunId,
        announcement_workflow_ref: queueWorkflowRef,
      },
    });
    expect(JSON.parse(requests[1].init.body)).toEqual({
      state: 'queued',
      environment,
      description: 'Preview is queued until CI completes',
      auto_inactive: false,
      log_url: queueLogUrl,
    });
  });

  it('queues a reset card through the trusted reset workflow', async () => {
    const requests = [];
    const request = async (pathname, init) => {
      requests.push({ pathname, init });
      if (pathname === `/repos/${repository}/deployments`) return { id: deploymentId };
      if (pathname === `/repos/${repository}/deployments/${deploymentId}/statuses`) {
        return { state: 'queued' };
      }
      throw new Error(`unexpected request: ${pathname}`);
    };

    await expect(queuePreviewDeployment({
      request,
      verify: async () => {},
      ...queueArgs({ workflowRef: resetWorkflowRef }),
    })).resolves.toEqual({ deploymentId, environment, url: null });
    expect(JSON.parse(requests[0].init.body)).toMatchObject({
      task: 'preview-reset',
      description: 'Preview reset queued for PR #42',
      payload: { announcement_workflow_ref: resetWorkflowRef },
    });
  });

  it('finds a verified exact announcement card', async () => {
    const request = async (pathname) => {
      if (pathname === deploymentListPath()) return [queuedCard(deploymentId, currentCreatedAt)];
      if (pathname === statusListPath(deploymentId)) return [status(1, 'queued')];
      throw new Error(`unexpected request: ${pathname}`);
    };

    await expect(findPreviewAnnouncement({
      request,
      verifyAnnouncement: async (runId, task) => {
        expect(runId).toBe(announcementRunId);
        expect(task).toBe('preview-announce');
      },
      deploymentId,
      ...controllerArgs(),
    })).resolves.toEqual({
      deploymentId,
      state: 'queued',
      announcementRunId,
      task: 'preview-announce',
    });
  });

  it('returns null for an absent or structurally untrusted announcement card', async () => {
    const absentRequest = async (pathname) => {
      if (pathname === deploymentListPath()) return [];
      throw new Error(`unexpected request: ${pathname}`);
    };
    const untrustedRequest = async (pathname) => {
      if (pathname === deploymentListPath()) {
        return [queuedCard(deploymentId, currentCreatedAt, {
          payload: { announcement_workflow_ref: 'attacker/workflow@refs/heads/main' },
        })];
      }
      throw new Error(`unexpected request: ${pathname}`);
    };
    const verifyAnnouncement = async () => {
      throw new Error('untrusted announcement must not be verified');
    };

    await expect(findPreviewAnnouncement({
      request: absentRequest,
      verifyAnnouncement,
      deploymentId,
      ...controllerArgs(),
    })).resolves.toBeNull();
    await expect(findPreviewAnnouncement({
      request: untrustedRequest,
      verifyAnnouncement,
      deploymentId,
      ...controllerArgs(),
    })).resolves.toBeNull();
  });

  it('waits for Preview Control to finish the exact queued card', async () => {
    const states = ['queued', 'in_progress', 'success'];
    const waits = [];
    let verificationCount = 0;
    const request = async (pathname) => {
      if (pathname === deploymentListPath()) return [queuedCard(deploymentId, currentCreatedAt)];
      if (pathname === statusListPath(deploymentId)) return [status(1, states.shift())];
      throw new Error(`unexpected request: ${pathname}`);
    };

    const card = await awaitQueuedPreviewDeployment({
      request,
      verify: async () => { verificationCount += 1; },
      verifyAnnouncement: async (runId) => { expect(runId).toBe(announcementRunId); },
      deploymentId,
      attempts: 3,
      wait: async (attempt, attempts) => { waits.push([attempt, attempts]); },
      ...queueArgs(),
    });

    expect(card).toEqual({
      deploymentId,
      state: 'success',
      announcementRunId,
      task: 'preview-announce',
    });
    expect(waits).toEqual([[1, 3], [2, 3]]);
    expect(verificationCount).toBe(4);
  });

  it.each(['failure', 'error', 'inactive'])(
    'fails the queue when Preview Control finishes with %s',
    async (state) => {
      const request = async (pathname) => {
        if (pathname === deploymentListPath()) return [queuedCard(deploymentId, currentCreatedAt)];
        if (pathname === statusListPath(deploymentId)) return [status(1, state)];
        throw new Error(`unexpected request: ${pathname}`);
      };

      await expect(awaitQueuedPreviewDeployment({
        request,
        verify: async () => {},
        verifyAnnouncement: async () => {},
        deploymentId,
        ...queueArgs(),
      })).rejects.toThrow(`Preview Control did not succeed: deployment card is ${state}`);
    },
  );

  it('follows a successful same-SHA card after duplicate cleanup retires its own card', async () => {
    const replacementDeploymentId = 790;
    const request = async (pathname) => {
      if (pathname === deploymentListPath()) {
        return [
          queuedCard(deploymentId, currentCreatedAt),
          queuedCard(replacementDeploymentId, newerCreatedAt, {
            announcementRunId: announcementRunId + 1,
          }),
        ];
      }
      if (pathname === statusListPath(deploymentId)) return [status(1, 'inactive')];
      if (pathname === statusListPath(replacementDeploymentId)) return [status(2, 'success')];
      throw new Error(`unexpected request: ${pathname}`);
    };

    await expect(awaitQueuedPreviewDeployment({
      request,
      verify: async () => {},
      verifyAnnouncement: async () => {},
      deploymentId,
      ...queueArgs(),
    })).resolves.toEqual({
      deploymentId: replacementDeploymentId,
      state: 'success',
      announcementRunId: announcementRunId + 1,
      task: 'preview-announce',
    });
  });

  it('fails instead of succeeding while Preview Control remains in progress', async () => {
    const waits = [];
    const request = async (pathname) => {
      if (pathname === deploymentListPath()) return [queuedCard(deploymentId, currentCreatedAt)];
      if (pathname === statusListPath(deploymentId)) return [status(1, 'in_progress')];
      throw new Error(`unexpected request: ${pathname}`);
    };

    await expect(awaitQueuedPreviewDeployment({
      request,
      verify: async () => {},
      verifyAnnouncement: async () => {},
      deploymentId,
      attempts: 2,
      wait: async (attempt, attempts) => { waits.push([attempt, attempts]); },
      ...queueArgs(),
    })).rejects.toThrow(/Preview Control did not finish before wait deadline/);
    expect(waits).toEqual([[1, 2]]);
  });

  it('does not create a queue card when same-repository PR validation rejects a fork', async () => {
    const request = async () => {
      throw new Error('a fork must not create a deployment');
    };

    await expect(queuePreviewDeployment({
      request,
      verify: async () => { throw new Error('PR 42 is not a same-repository PR'); },
      ...queueArgs(),
    })).rejects.toThrow(/same-repository PR/);
  });

  it('never writes queued status after the PR becomes stale between queue writes', async () => {
    let verificationCount = 0;
    const requests = [];
    const request = async (pathname, init) => {
      requests.push({ pathname, init });
      if (pathname === `/repos/${repository}/deployments`) return { id: deploymentId };
      throw new Error(`unexpected request: ${pathname}`);
    };

    await expect(queuePreviewDeployment({
      request,
      verify: async () => {
        verificationCount += 1;
        if (verificationCount === 2) throw new Error('PR head changed before preview control');
      },
      ...queueArgs(),
    })).rejects.toThrow(/head changed/);

    expect(requests).toHaveLength(1);
  });

  it('rechecks the PR head after publishing queued status', async () => {
    let verificationCount = 0;
    const requests = [];
    const request = async (pathname, init) => {
      requests.push({ pathname, init });
      if (pathname === `/repos/${repository}/deployments`) return { id: deploymentId };
      if (pathname === `/repos/${repository}/deployments/${deploymentId}/statuses`) {
        return { state: 'queued' };
      }
      throw new Error(`unexpected request: ${pathname}`);
    };

    await expect(queuePreviewDeployment({
      request,
      verify: async () => {
        verificationCount += 1;
        if (verificationCount === 3) throw new Error('PR closed after queued status');
      },
      ...queueArgs(),
    })).rejects.toThrow(/closed after queued/);

    expect(requests).toHaveLength(2);
  });

  it('waits for the direct PR card and never manufactures a fallback after CI', async () => {
    const waits = [];
    const requests = [];
    let lists = 0;
    const request = async (pathname, init) => {
      requests.push({ pathname, init });
      if (pathname === deploymentListPath()) {
        lists += 1;
        return lists === 1 ? [] : [queuedCard(deploymentId, currentCreatedAt)];
      }
      if (pathname === statusListPath(deploymentId)) return [status(1, 'queued')];
      if (pathname === `/repos/${repository}/deployments/${deploymentId}/statuses`) {
        return { state: 'in_progress' };
      }
      throw new Error(`unexpected request: ${pathname}`);
    };

    const card = await claimPreviewDeployment({
      request,
      verify: async () => {},
      verifyAnnouncement: async (runId) => { expect(runId).toBe(announcementRunId); },
      attempts: 2,
      wait: async (attempt, attempts) => { waits.push([attempt, attempts]); },
      ...controllerArgs(),
    });

    expect(card).toEqual({ deploymentId, environment, url: null });
    expect(waits).toEqual([[1, 2]]);
    expect(requests.map(({ pathname }) => pathname)).toEqual([
      deploymentListPath(),
      deploymentListPath(),
      statusListPath(deploymentId),
      `/repos/${repository}/deployments/${deploymentId}/statuses`,
    ]);
    expect(requests.some(({ pathname }) => pathname === `/repos/${repository}/deployments`)).toBe(false);
    expect(JSON.parse(requests[3].init.body)).toEqual({
      state: 'in_progress',
      environment,
      description: 'Preview provisioning is in progress',
      auto_inactive: false,
      log_url: controllerLogUrl,
    });
  });

  it('claims a card whose initial queued-status write did not persist', async () => {
    const request = async (pathname) => {
      if (pathname === deploymentListPath()) return [queuedCard(deploymentId, currentCreatedAt)];
      if (pathname === statusListPath(deploymentId)) return [];
      if (pathname === `/repos/${repository}/deployments/${deploymentId}/statuses`) {
        return { state: 'in_progress' };
      }
      throw new Error(`unexpected request: ${pathname}`);
    };

    await expect(claimPreviewDeployment({
      request,
      verify: async () => {},
      verifyAnnouncement: async () => {},
      ...controllerArgs(),
    })).resolves.toEqual({ deploymentId, environment, url: null });
  });

  it('claims a fresh manual-reset card without reviving an inactive direct queue card', async () => {
    const resetDeploymentId = 790;
    const request = async (pathname) => {
      if (pathname === deploymentListPath()) {
        return [
          queuedCard(deploymentId, olderCreatedAt, {
            deployment: { task: 'preview-announce' },
          }),
          queuedCard(resetDeploymentId, currentCreatedAt, {
            announcementRunId: 655,
            deployment: { task: 'preview-reset' },
            payload: { announcement_workflow_ref: resetWorkflowRef },
          }),
        ];
      }
      if (pathname === statusListPath(deploymentId)) return [status(1, 'inactive', olderCreatedAt)];
      if (pathname === statusListPath(resetDeploymentId)) return [status(2, 'queued', currentCreatedAt)];
      if (pathname === `/repos/${repository}/deployments/${resetDeploymentId}/statuses`) {
        return { state: 'in_progress' };
      }
      throw new Error(`unexpected request: ${pathname}`);
    };
    const verified = [];

    await expect(claimPreviewDeployment({
      request,
      verify: async () => {},
      verifyAnnouncement: async (runId, task) => { verified.push([runId, task]); },
      ...controllerArgs(),
    })).resolves.toEqual({ deploymentId: resetDeploymentId, environment, url: null });
    expect(verified).toEqual([
      [announcementRunId, 'preview-announce'],
      [655, 'preview-reset'],
    ]);
  });

  it('records the selected card before an in-progress status failure can orphan it', async () => {
    const claimed = [];
    const request = async (pathname) => {
      if (pathname === deploymentListPath()) return [queuedCard(deploymentId, currentCreatedAt)];
      if (pathname === statusListPath(deploymentId)) return [status(1, 'queued')];
      if (pathname === `/repos/${repository}/deployments/${deploymentId}/statuses`) {
        throw new Error('GitHub deployment status unavailable');
      }
      throw new Error(`unexpected request: ${pathname}`);
    };

    await expect(claimPreviewDeployment({
      request,
      verify: async () => {},
      verifyAnnouncement: async () => {},
      onClaimed: async (card) => { claimed.push(card); },
      ...controllerArgs(),
    })).rejects.toThrow(/status unavailable/);

    expect(claimed).toEqual([{ deploymentId, environment, url: null }]);
  });

  it('returns an existing in-progress same-SHA card as an idempotent no-op', async () => {
    const requests = [];
    const request = async (pathname, init) => {
      requests.push({ pathname, init });
      if (pathname === deploymentListPath()) {
        return [
          queuedCard(10, olderCreatedAt, { announcementRunId: 650 }),
          queuedCard(deploymentId, currentCreatedAt),
        ];
      }
      if (pathname === statusListPath(10)) return [status(1, 'failure', olderCreatedAt)];
      if (pathname === statusListPath(deploymentId)) return [status(2, 'in_progress', currentCreatedAt)];
      throw new Error(`unexpected request: ${pathname}`);
    };

    await expect(claimPreviewDeployment({
      request,
      verify: async () => {},
      verifyAnnouncement: async () => {},
      ...controllerArgs(),
    })).resolves.toEqual({
      deploymentId,
      environment,
      url: null,
      alreadyClaimed: true,
    });
    expect(requests).toHaveLength(3);
  });

  it('marks an in-progress card as resumable only for this controller run', async () => {
    const request = async (pathname) => {
      if (pathname === deploymentListPath()) return [queuedCard(deploymentId, currentCreatedAt)];
      if (pathname === statusListPath(deploymentId)) {
        return [status(1, 'in_progress', currentCreatedAt, { log_url: controllerLogUrl })];
      }
      throw new Error(`unexpected request: ${pathname}`);
    };

    await expect(claimPreviewDeployment({
      request,
      verify: async () => {},
      verifyAnnouncement: async () => {},
      ...controllerArgs(),
    })).resolves.toEqual({
      deploymentId,
      environment,
      url: null,
      alreadyClaimed: true,
      claimedByCurrentRun: true,
    });
  });

  it('inactivates a retried queue card when an older same-SHA card is active', async () => {
    const activeDeploymentId = 788;
    const requests = [];
    const request = async (pathname, init) => {
      requests.push({ pathname, init });
      if (pathname === deploymentListPath()) {
        return [
          queuedCard(activeDeploymentId, olderCreatedAt, { announcementRunId: 650 }),
          queuedCard(deploymentId, currentCreatedAt),
        ];
      }
      if (pathname === statusListPath(activeDeploymentId)) {
        return [status(1, 'success', olderCreatedAt)];
      }
      if (pathname === statusListPath(deploymentId)) return [status(2, 'queued', currentCreatedAt)];
      if (pathname === `/repos/${repository}/deployments/${deploymentId}/statuses`) {
        return { state: 'inactive' };
      }
      throw new Error(`unexpected request: ${pathname}`);
    };

    await expect(claimPreviewDeployment({
      request,
      verify: async () => {},
      verifyAnnouncement: async () => {},
      ...controllerArgs(),
    })).resolves.toEqual({
      deploymentId: activeDeploymentId,
      environment,
      url: null,
      alreadyClaimed: true,
    });
    expect(JSON.parse(requests[3].init.body)).toEqual({
      state: 'inactive',
      environment,
      description: 'Preview already claimed for this PR head',
      auto_inactive: false,
      log_url: controllerLogUrl,
    });
  });

  it('does not write a claimed-card status after the head becomes stale', async () => {
    let checks = 0;
    const requests = [];
    const request = async (pathname, init) => {
      requests.push({ pathname, init });
      if (pathname === deploymentListPath()) return [queuedCard(deploymentId, currentCreatedAt)];
      if (pathname === statusListPath(deploymentId)) return [status(1, 'queued')];
      throw new Error(`unexpected request: ${pathname}`);
    };

    await expect(claimPreviewDeployment({
      request,
      verify: async () => {
        checks += 1;
        if (checks === 2) throw new Error('PR head changed before preview control');
      },
      verifyAnnouncement: async () => {},
      ...controllerArgs(),
    })).rejects.toThrow(/head changed/);
    expect(requests.map(({ pathname }) => pathname)).toEqual([
      deploymentListPath(),
      statusListPath(deploymentId),
    ]);
  });

  it('rejects every queued duplicate after failed CI but leaves an in-progress successor alone', async () => {
    const requests = [];
    const request = async (pathname, init) => {
      requests.push({ pathname, init });
      if (pathname === deploymentListPath()) {
        return [
          queuedCard(10, olderCreatedAt, { announcementRunId: 650 }),
          queuedCard(deploymentId, currentCreatedAt),
        ];
      }
      if (pathname === statusListPath(10)) return [status(1, 'queued', olderCreatedAt)];
      if (pathname === statusListPath(deploymentId)) return [status(2, 'in_progress', currentCreatedAt)];
      if (pathname === `/repos/${repository}/deployments/10/statuses`) return { state: 'failure' };
      throw new Error(`unexpected request: ${pathname}`);
    };

    await expect(rejectQueuedPreviewDeployments({
      request,
      verify: async () => {},
      verifyAnnouncement: async () => {},
      ...controllerArgs(),
    })).resolves.toEqual({ rejectedDeploymentIds: [10] });
    expect(JSON.parse(requests.at(-1).init.body)).toEqual({
      state: 'failure',
      environment,
      description: 'Preview was not provisioned because CI did not succeed',
      auto_inactive: false,
      log_url: controllerLogUrl,
    });
  });

  it('rejects a card whose initial status write is absent after failed CI', async () => {
    const request = async (pathname) => {
      if (pathname === deploymentListPath()) return [queuedCard(deploymentId, currentCreatedAt)];
      if (pathname === statusListPath(deploymentId)) return [];
      if (pathname === `/repos/${repository}/deployments/${deploymentId}/statuses`) {
        return { state: 'failure' };
      }
      throw new Error(`unexpected request: ${pathname}`);
    };

    await expect(rejectQueuedPreviewDeployments({
      request,
      verify: async () => {},
      verifyAnnouncement: async () => {},
      ...controllerArgs(),
    })).resolves.toEqual({ rejectedDeploymentIds: [deploymentId] });
  });

  it('does not fail a failed CI when no queue card exists', async () => {
    const request = async (pathname) => {
      if (pathname === deploymentListPath()) return [];
      throw new Error(`unexpected request: ${pathname}`);
    };

    await expect(rejectQueuedPreviewDeployments({
      request,
      verify: async () => {},
      verifyAnnouncement: async () => {},
      ...controllerArgs(),
    })).resolves.toEqual({ rejectedDeploymentIds: [] });
  });

  it('settles a queued card after a reconciliation stale-head race', async () => {
    const requests = [];
    const request = async (pathname, init) => {
      requests.push({ pathname, init });
      if (pathname === deploymentListPath()) return [queuedCard(deploymentId, currentCreatedAt)];
      if (pathname === statusListPath(deploymentId)) return [status(1, 'queued')];
      if (pathname === `/repos/${repository}/deployments/${deploymentId}/statuses`) {
        return { state: 'inactive' };
      }
      throw new Error(`unexpected request: ${pathname}`);
    };

    await expect(settleQueuedPreviewDeployment({
      request,
      verify: async () => {},
      verifyAnnouncement: async () => {},
      deploymentId,
      state: 'inactive',
      description: 'Preview superseded before its queued card could be published',
      ...queueArgs(),
    })).resolves.toEqual({ deploymentId, settled: true });
    expect(JSON.parse(requests.at(-1).init.body)).toMatchObject({
      state: 'inactive',
      description: 'Preview superseded before its queued card could be published',
    });
  });

  it('settles a specific unstatused card after a queue-close race', async () => {
    const request = async (pathname) => {
      if (pathname === deploymentListPath()) return [queuedCard(deploymentId, currentCreatedAt)];
      if (pathname === statusListPath(deploymentId)) return [];
      if (pathname === `/repos/${repository}/deployments/${deploymentId}/statuses`) {
        return { state: 'inactive' };
      }
      throw new Error(`unexpected request: ${pathname}`);
    };

    await expect(settleQueuedPreviewDeployment({
      request,
      verify: async () => {},
      verifyAnnouncement: async () => {},
      deploymentId,
      state: 'inactive',
      description: 'Preview superseded before its queued card could be published',
      ...queueArgs(),
    })).resolves.toEqual({ deploymentId, settled: true });
  });

  it('retires queued and in-progress cards for a superseded SHA only', async () => {
    const requests = [];
    const request = async (pathname, init) => {
      requests.push({ pathname, init });
      if (pathname === deploymentListPath()) {
        return [
          queuedCard(10, olderCreatedAt, { announcementRunId: 650 }),
          queuedCard(deploymentId, currentCreatedAt),
        ];
      }
      if (pathname === statusListPath(10)) return [status(1, 'in_progress', olderCreatedAt)];
      if (pathname === statusListPath(deploymentId)) return [status(2, 'queued', currentCreatedAt)];
      if (pathname === `/repos/${repository}/deployments/${deploymentId}/statuses`
        || pathname === `/repos/${repository}/deployments/10/statuses`) {
        return { state: 'inactive' };
      }
      throw new Error(`unexpected request: ${pathname}`);
    };

    await expect(inactivateSupersededPreviewDeployments({
      request,
      verify: async () => {},
      verifyAnnouncement: async () => {},
      description: 'Preview superseded by a newer PR head',
      ...controllerArgs(),
    })).resolves.toEqual({ inactivatedDeploymentIds: [deploymentId, 10] });
  });

  it('refuses an unverified announcement payload instead of claiming it', async () => {
    const foreignWorkflow = 'attacker/agent-sessions-backup/.github/workflows/preview-queue.yml@refs/heads/main';
    const request = async (pathname) => {
      if (pathname === deploymentListPath()) {
        return [queuedCard(deploymentId, currentCreatedAt, {
          payload: { announcement_workflow_ref: foreignWorkflow },
        })];
      }
      throw new Error(`unexpected request: ${pathname}`);
    };
    const verifyAnnouncement = async () => {
      throw new Error('announcement should not be examined');
    };

    await expect(claimPreviewDeployment({
      request,
      verify: async () => {},
      verifyAnnouncement,
      ...controllerArgs(),
    })).rejects.toThrow(/no verified queued preview deployment card/);
  });

  it('completes the exact card and retires only older verified announcement cards', async () => {
    const requests = [];
    const request = async (pathname, init) => {
      requests.push({ pathname, init });
      if (pathname === deploymentListPath()) {
        return [
          queuedCard(10, olderCreatedAt, { announcementRunId: 650 }),
          queuedCard(deploymentId, currentCreatedAt),
          queuedCard(790, newerCreatedAt, { announcementRunId: 655 }),
        ];
      }
      if (pathname === statusListPath(10)) return [status(1, 'success', olderCreatedAt)];
      if (pathname === statusListPath(deploymentId)) return [status(2, 'in_progress', currentCreatedAt)];
      if (pathname === statusListPath(790)) return [status(3, 'queued', newerCreatedAt)];
      if (pathname === `/repos/${repository}/deployments/${deploymentId}/statuses`) return { state: 'success' };
      if (pathname === `/repos/${repository}/deployments/10/statuses`) return { state: 'inactive' };
      throw new Error(`unexpected request: ${pathname}`);
    };

    const card = await completePreviewDeployment({
      request,
      verify: async () => {},
      verifyAnnouncement: async () => {},
      deploymentId,
      outcome: 'success',
      ...controllerArgs(),
    });

    expect(card).toEqual({
      deploymentId,
      outcome: 'success',
      inactiveDeploymentIds: [10],
      url,
    });
    expect(JSON.parse(requests[4].init.body)).toEqual({
      state: 'success',
      environment,
      description: 'Preview deployed and passed remote smoke tests',
      auto_inactive: false,
      environment_url: url,
      log_url: controllerLogUrl,
    });
    expect(JSON.parse(requests[5].init.body)).toEqual({
      state: 'inactive',
      environment,
      description: 'Superseded by a newer preview attempt',
      auto_inactive: false,
      log_url: controllerLogUrl,
    });
  });

  it.each([
    ['provision-failure', 'Preview provisioning failed', null],
    ['smoke-failure', 'Preview provisioned, but remote smoke tests failed', url],
  ])('records %s with the correct preview URL lifecycle', async (outcome, description, expectedUrl) => {
    const requests = [];
    const request = async (pathname, init) => {
      requests.push({ pathname, init });
      if (pathname === deploymentListPath()) return [queuedCard(deploymentId, currentCreatedAt)];
      if (pathname === statusListPath(deploymentId)) return [status(1, 'in_progress')];
      if (pathname === `/repos/${repository}/deployments/${deploymentId}/statuses`) {
        return { state: 'failure' };
      }
      throw new Error(`unexpected request: ${pathname}`);
    };

    await expect(completePreviewDeployment({
      request,
      verify: async () => {},
      verifyAnnouncement: async () => {},
      deploymentId,
      outcome,
      ...controllerArgs(),
    })).resolves.toEqual({
      deploymentId,
      outcome,
      inactiveDeploymentIds: [],
      url: expectedUrl,
    });
    expect(JSON.parse(requests.at(-1).init.body)).toEqual({
      state: 'failure',
      environment,
      description,
      auto_inactive: false,
      ...(expectedUrl === null ? {} : { environment_url: expectedUrl }),
      log_url: controllerLogUrl,
    });
  });

  it('rejects an unsupported terminal outcome before making a request', async () => {
    await expect(completePreviewDeployment({
      request: async () => { throw new Error('unexpected request'); },
      verify: async () => {},
      verifyAnnouncement: async () => {},
      deploymentId,
      outcome: 'unknown',
      ...controllerArgs(),
    })).rejects.toThrow(/preview deployment outcome is invalid/);
  });

  it('marks cancelled provisioning as an error without publishing a URL', async () => {
    const requests = [];
    const request = async (pathname, init) => {
      requests.push({ pathname, init });
      if (pathname === deploymentListPath()) return [queuedCard(deploymentId, currentCreatedAt)];
      if (pathname === statusListPath(deploymentId)) return [status(1, 'in_progress')];
      if (pathname === `/repos/${repository}/deployments/${deploymentId}/statuses`) {
        return { state: 'error' };
      }
      throw new Error(`unexpected request: ${pathname}`);
    };

    await expect(completePreviewDeployment({
      request,
      verify: async () => {},
      verifyAnnouncement: async () => {},
      deploymentId,
      outcome: 'provision-cancelled',
      ...controllerArgs(),
    })).resolves.toEqual({
      deploymentId,
      outcome: 'provision-cancelled',
      inactiveDeploymentIds: [],
      url: null,
    });
    expect(JSON.parse(requests.at(-1).init.body)).toEqual({
      state: 'error',
      environment,
      description: 'Preview provisioning was cancelled',
      auto_inactive: false,
      log_url: controllerLogUrl,
    });
  });

  it('marks skipped provisioning inactive without publishing a URL', async () => {
    const requests = [];
    const request = async (pathname, init) => {
      requests.push({ pathname, init });
      if (pathname === deploymentListPath()) return [queuedCard(deploymentId, currentCreatedAt)];
      if (pathname === statusListPath(deploymentId)) return [status(1, 'in_progress')];
      if (pathname === `/repos/${repository}/deployments/${deploymentId}/statuses`) {
        return { state: 'inactive' };
      }
      throw new Error(`unexpected request: ${pathname}`);
    };

    await expect(completePreviewDeployment({
      request,
      verify: async () => {},
      verifyAnnouncement: async () => {},
      deploymentId,
      outcome: 'provision-skipped',
      ...controllerArgs(),
    })).resolves.toEqual({
      deploymentId,
      outcome: 'provision-skipped',
      inactiveDeploymentIds: [],
      url: null,
    });
    expect(JSON.parse(requests.at(-1).init.body)).toEqual({
      state: 'inactive',
      environment,
      description: 'Preview provisioning was skipped',
      auto_inactive: false,
      log_url: controllerLogUrl,
    });
  });

  it.each([
    ['smoke-cancelled', 'Preview provisioned, but remote smoke tests were cancelled'],
    ['smoke-skipped', 'Preview provisioned, but remote smoke tests were skipped'],
  ])('keeps the URL after provisioned %s', async (outcome, description) => {
    const requests = [];
    const request = async (pathname, init) => {
      requests.push({ pathname, init });
      if (pathname === deploymentListPath()) return [queuedCard(deploymentId, currentCreatedAt)];
      if (pathname === statusListPath(deploymentId)) return [status(1, 'in_progress')];
      if (pathname === `/repos/${repository}/deployments/${deploymentId}/statuses`) {
        return { state: 'error' };
      }
      throw new Error(`unexpected request: ${pathname}`);
    };

    await expect(completePreviewDeployment({
      request,
      verify: async () => {},
      verifyAnnouncement: async () => {},
      deploymentId,
      outcome,
      ...controllerArgs(),
    })).resolves.toEqual({
      deploymentId,
      outcome,
      inactiveDeploymentIds: [],
      url,
    });
    expect(JSON.parse(requests.at(-1).init.body)).toEqual({
      state: 'error',
      environment,
      description,
      auto_inactive: false,
      environment_url: url,
      log_url: controllerLogUrl,
    });
  });

  it('marks every PR card inactive after its preview resources are removed', async () => {
    const requests = [];
    const request = async (pathname, init) => {
      requests.push({ pathname, init });
      if (pathname === deploymentListPath()) return [{ id: deploymentId }];
      if (pathname === `/repos/${repository}/deployments/${deploymentId}/statuses`) return { state: 'inactive' };
      throw new Error(`unexpected request: ${pathname}`);
    };

    await expect(deactivatePreviewDeployments({
      request,
      repository,
      pr,
      description: 'Preview environment removed',
      logUrl: controllerLogUrl,
    })).resolves.toEqual([deploymentId]);
    expect(JSON.parse(requests[1].init.body)).toEqual({
      state: 'inactive',
      environment,
      description: 'Preview environment removed',
      auto_inactive: false,
      log_url: controllerLogUrl,
    });
  });

  it('walks every deployment-list page before inactivating removed preview cards', async () => {
    const requests = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }));
    const request = async (pathname, init) => {
      requests.push({ pathname, init });
      if (pathname === deploymentListPath()) return firstPage;
      if (pathname === `/repos/${repository}/deployments?environment=preview%2Fpr-42&per_page=100&page=2`) {
        return [{ id: 101 }];
      }
      if (pathname.endsWith('/statuses')) return { state: 'inactive' };
      throw new Error(`unexpected request: ${pathname}`);
    };

    await expect(deactivatePreviewDeployments({ request, repository, pr })).resolves.toHaveLength(101);
    expect(requests.map(({ pathname }) => pathname).filter((pathname) => pathname.includes('?environment='))).toEqual([
      deploymentListPath(),
      `/repos/${repository}/deployments?environment=preview%2Fpr-42&per_page=100&page=2`,
    ]);
  });
});
