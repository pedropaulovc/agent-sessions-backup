import { createHash, createHmac } from 'node:crypto';
import { lstat, open, readFile, realpath, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PRODUCTION_ACCOUNT_ID = '18ef3246e9f36d1560485ef53889c0ab';
export const PREVIEW_ACCOUNT_ID = 'cbb04a26e6fa2d0cdc4eb67c735e5669';
export const PREVIEW_WORKERS_DEV_SUFFIX = '.agent-sessions-nonproduction.workers.dev';
export const MAX_WORKER_BUNDLE_BYTES = 20 * 1024 * 1024;

const TRUSTED_MIGRATION_METADATA = new Set([
  'historical-baseline.json',
  'source-baseline.json',
]);

const PRODUCTION_IDENTIFIERS = new Set([
  PRODUCTION_ACCOUNT_ID,
  '5ff65cf3-89c8-4fe6-a3c2-a370293ecea6',
  '8f2cd488-0060-4f32-8025-f5b461c9fe0a',
  '61505c2df55242daa2f572c188819961',
  'eda3b8a8ba1e416fa65e98d0c266a4bb',
  '6a56cdda4766c1d7b5ad0fbe8331048f',
  'sessions-index',
  'sessions-index-preview',
  'agent-sessions-raw',
  'agent-sessions-raw-preview',
  'sessions-hub-kv',
  'sessions-hub-kv-preview',
  'parse',
  'parse-preview',
  'parse-dlq',
  'parse-dlq-preview',
  'sessions-hub',
  'sessions-hub-preview',
]);

export function fail(message) {
  throw new Error(message);
}

export function parseArgs(argv, allowed) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag?.startsWith('--') || value === undefined) fail(`expected --name value, got ${flag ?? '<end>'}`);
    const name = flag.slice(2);
    if (!allowed.has(name)) fail(`unknown argument: ${flag}`);
    if (Object.hasOwn(values, name)) fail(`duplicate argument: ${flag}`);
    values[name] = value;
  }
  return values;
}

export function required(value, name) {
  if (typeof value !== 'string' || value.length === 0) fail(`${name} is required`);
  return value;
}

/**
 * The child environment every Wrangler/migration subprocess gets. Allow-listed, not inherited:
 * the preview job's own environment carries GitHub tokens and the bearer seed, and none of that
 * has any business reaching Wrangler.
 */
export function previewWranglerEnvironment(source, apiToken, accountId) {
  required(apiToken, 'preview Cloudflare API token');
  assertPreviewAccount(accountId);
  const environment = {};
  for (const key of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'TEMP', 'TMP', 'CI']) {
    if (source[key]) environment[key] = source[key];
  }
  environment.CLOUDFLARE_API_TOKEN = apiToken;
  environment.CLOUDFLARE_ACCOUNT_ID = accountId;
  // Wrangler routes --json results and deployment IDs through its normal logger.
  environment.WRANGLER_LOG = 'log';
  environment.NO_COLOR = '1';
  return environment;
}

/**
 * The per-PR preview bearer, derived — not distributed. Every principal that needs it (the
 * preview job baking it into the Worker, the smoke/e2e steps, the owner's machines via
 * `~/.config/agent-sessions/preview-seed`) derives the same token from one standing seed, so
 * the public repo never has to move a secret through logs or job outputs. The Worker holds
 * only the DERIVED per-PR token: reading one preview's Worker vars exposes that one disposable
 * preview, not the seed.
 */
export function previewBearerToken(seed, pr) {
  if (typeof seed !== 'string' || seed.trim().length < 32) {
    fail('preview bearer seed must be at least 32 characters');
  }
  return createHmac('sha256', seed.trim())
    .update(`sessions-preview-bearer:pr-${positiveInteger(pr, 'PR number')}`)
    .digest('base64url');
}

/**
 * Exhaustively follow one Cloudflare list endpoint's pagination. The account-level list
 * APIs disagree on scheme — page/per_page (D1, KV, Queues), cursor (R2 buckets), or no
 * pagination at all (Workers scripts) — and a first-page-only read makes cleanup silently
 * leak resources and existence probes silently miss, so every caller goes through here.
 * `rowsOf` maps one response envelope to its row array (the endpoints also disagree on
 * where the rows live). Fails loud on a non-terminating walk rather than looping forever.
 */
export async function paginatedList(request, pathname, { pagination, rowsOf, perPage = 100 }) {
  if (typeof request !== 'function') fail('list request function is required');
  const joiner = pathname.includes('?') ? '&' : '?';
  if (pagination === 'none') {
    const envelope = await request(pathname, { allowNotFound: true, returnEnvelope: true });
    return envelope === null ? [] : rowsOf(envelope) ?? [];
  }
  const rows = [];
  if (pagination === 'page') {
    for (let page = 1; page <= 1000; page += 1) {
      const envelope = await request(`${pathname}${joiner}per_page=${perPage}&page=${page}`, {
        allowNotFound: true, returnEnvelope: true,
      });
      if (envelope === null) return rows;
      const batch = rowsOf(envelope) ?? [];
      rows.push(...batch);
      const total = envelope.result_info?.total_count;
      if (batch.length === 0 || batch.length < perPage) return rows;
      if (typeof total === 'number' && rows.length >= total) return rows;
    }
    fail(`page-based listing did not terminate for ${pathname}`);
  }
  if (pagination === 'cursor') {
    const seenCursors = new Set();
    let cursor;
    for (let step = 0; step <= 1000; step += 1) {
      const query = `${joiner}per_page=${perPage}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const envelope = await request(`${pathname}${query}`, { allowNotFound: true, returnEnvelope: true });
      if (envelope === null) return rows;
      const batch = rowsOf(envelope) ?? [];
      rows.push(...batch);
      cursor = envelope.result_info?.cursor;
      if (typeof cursor !== 'string' || cursor.length === 0 || batch.length === 0) return rows;
      if (seenCursors.has(cursor)) fail(`cursor-based listing repeated a cursor for ${pathname}`);
      seenCursors.add(cursor);
    }
    fail(`cursor-based listing did not terminate for ${pathname}`);
  }
  fail(`unsupported pagination mode: ${pagination}`);
}

export async function emptyR2Bucket(bucketName, request) {
  required(bucketName, 'R2 bucket name');
  if (typeof request !== 'function') fail('R2 request function is required');
  const bucketPath = `r2/buckets/${encodeURIComponent(bucketName)}/objects`;
  const keys = [];
  const seenCursors = new Set();
  let cursor;

  for (;;) {
    const query = new URLSearchParams({ per_page: '1000' });
    if (cursor) query.set('cursor', cursor);
    const page = await request(`${bucketPath}?${query}`, {
      allowNotFound: true,
      returnEnvelope: true,
    });
    if (page === null) return 0;
    if (!Array.isArray(page?.result)) fail(`R2 object listing for ${bucketName} is malformed`);
    for (const object of page.result) {
      if (typeof object?.key !== 'string' || object.key.length === 0) {
        fail(`R2 object listing for ${bucketName} contains an invalid key`);
      }
      keys.push(object.key);
    }
    if (page.result_info?.is_truncated !== true) break;
    const next = page.result_info?.cursor;
    if (typeof next !== 'string' || next.length === 0 || seenCursors.has(next)) {
      fail(`R2 object listing for ${bucketName} returned an invalid cursor`);
    }
    seenCursors.add(next);
    cursor = next;
  }

  for (let offset = 0; offset < keys.length; offset += 32) {
    await Promise.all(keys.slice(offset, offset + 32).map((key) => {
      const encodedKey = key.split('/').map(encodeURIComponent).join('/');
      return request(`${bucketPath}/${encodedKey}`, { method: 'DELETE', allowNotFound: true });
    }));
  }
  return keys.length;
}

export function assertWorkerModulePayload(prefix) {
  if (!(prefix instanceof Uint8Array) || prefix.byteLength === 0) fail('Worker bundle is empty');
  if (prefix[0] === 0x2d && prefix[1] === 0x2d) {
    fail('Wrangler emitted a multipart upload envelope instead of a Worker module');
  }
  return prefix;
}

export async function wranglerWorkerBundle(outputDirectory) {
  const workerOutputs = (await readdir(outputDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name);
  if (workerOutputs.length !== 1) {
    fail(`Wrangler emitted ${workerOutputs.length} top-level JavaScript bundles instead of one`);
  }
  const bundle = await assertContainedRegularFile(
    outputDirectory,
    path.join(outputDirectory, workerOutputs[0]),
    'Wrangler worker bundle',
  );
  const handle = await open(bundle, 'r');
  try {
    const prefix = new Uint8Array(2);
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    assertWorkerModulePayload(prefix.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
  return bundle;
}

export function positiveInteger(value, name) {
  if (!/^[1-9][0-9]*$/.test(String(value))) fail(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${name} is outside the safe integer range`);
  return parsed;
}

export function headSha(value) {
  if (!/^[0-9a-f]{40}$/.test(value ?? '')) fail('head SHA must be a lowercase 40-character Git SHA');
  return value;
}

export function repositoryName(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value ?? '')) fail('repository must be owner/name');
  return value;
}

/**
 * Stable per-PR resource names. Each PR gets ONE persistent environment deployed in place —
 * the worker keeps its workers.dev hostname across pushes, and the backing resources survive
 * so hand-uploaded session zips persist. (History: names used to carry a `g<runId>-<sha12>`
 * generation for blue/green promote through the preview front door; the front door is gone
 * and with it the generation machinery. The janitor still recognizes the old generation name
 * shape — see `LEGACY_GENERATION_RE` — purely to sweep leftover debris.)
 */
export function resourceNames(pr) {
  const prefix = `pr-${positiveInteger(pr, 'PR number')}-`;
  const names = {
    prefix,
    app: `${prefix}app`,
    d1: `${prefix}sessions-index`,
    r2: `${prefix}agent-sessions`,
    kv: `${prefix}sessions-hub-kv`,
    queue: `${prefix}parse`,
    dlq: `${prefix}parse-dlq`,
    host: `${prefix}app${PREVIEW_WORKERS_DEV_SUFFIX}`,
  };
  for (const [kind, name] of Object.entries(names)) {
    if (kind !== 'host' && kind !== 'prefix' && name.length > 63) {
      fail(`${kind} resource name exceeds Cloudflare's 63-character limit: ${name}`);
    }
    if (kind !== 'host' && !name.startsWith(prefix)) {
      fail(`${kind} resource does not share ${prefix}`);
    }
  }
  return Object.freeze(names);
}

/** Any `pr-N-…` resource name in the preview account, old or new naming scheme. */
export const PREVIEW_RESOURCE_RE = /^pr-([1-9][0-9]*)-(app|sessions-index|agent-sessions|sessions-hub-kv|parse|parse-dlq)$/;
/** The retired blue/green generation naming scheme — always deletable debris. */
export const LEGACY_GENERATION_RE = /^pr-([1-9][0-9]*)-g[1-9][0-9]*-[0-9a-f]{12}-/;

export function assertPreviewAccount(accountId) {
  required(accountId, 'preview account ID');
  if (!/^[0-9a-f]{32}$/.test(accountId)) fail('preview account ID must be a lowercase 32-character ID');
  if (accountId === PRODUCTION_ACCOUNT_ID) fail('refusing the production Cloudflare account');
  if (accountId !== PREVIEW_ACCOUNT_ID) fail(`refusing unapproved Cloudflare account ${accountId}`);
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function fileRecord(file, relativePath) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`artifact input is not a regular file: ${relativePath}`);
  const bytes = await readFile(file);
  return { path: relativePath.replaceAll('\\', '/'), size: bytes.length, sha256: sha256Bytes(bytes) };
}

export async function writeCanonicalJson(file, value) {
  await writeFile(file, `${stableJson(value)}\n`, { encoding: 'utf8', flag: 'wx' });
}

export function assertNoProductionIdentifiers(value, at = '$') {
  if (typeof value === 'string') {
    if (PRODUCTION_IDENTIFIERS.has(value)) fail(`production identifier rejected at ${at}`);
    if (value.includes(PRODUCTION_ACCOUNT_ID)) fail(`production account reference rejected at ${at}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoProductionIdentifiers(item, `${at}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) assertNoProductionIdentifiers(item, `${at}.${key}`);
  }
}

export function migrationSqlNames(entries) {
  if (!Array.isArray(entries) || !entries.includes('manifest.json')) {
    fail('hub/migrations has no manifest.json');
  }
  const trustedMetadata = TRUSTED_MIGRATION_METADATA;
  const sql = [];
  for (const name of entries) {
    if (/^[0-9]{4}_[a-z0-9_]+\.sql$/.test(name)) sql.push(name);
    else if (name !== 'manifest.json' && !trustedMetadata.has(name)) fail(`unexpected migration entry: ${name}`);
  }
  if (sql.length === 0) fail('hub/migrations has no numbered SQL files');
  return sql.sort();
}

export function generatedBuildConfig({ main, workerName }) {
  const config = {
    name: workerName,
    main,
    compatibility_date: '2026-07-01',
    compatibility_flags: ['nodejs_compat'],
    preview_urls: false,
    workers_dev: false,
    routes: [],
    exports: {},
  };
  assertNoProductionIdentifiers(config);
  return config;
}

export function generatedPrivateAppConfig({
  accountId, main, migrationsDir, names, resources, application,
}) {
  assertPreviewAccount(accountId);
  for (const [name, digest] of Object.entries({
    buildInputDigest: resources.buildInputDigest,
    artifactDigest: resources.artifactDigest,
    migrationDigest: resources.migrationDigest,
    schemaDigest: resources.schemaDigest,
  })) {
    if (!/^[0-9a-f]{64}$/.test(digest ?? '')) fail(`generated preview config has an invalid ${name}`);
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(application?.assetSigningSecret ?? '')) {
    fail('preview asset signing secret must be 32 random bytes encoded as base64url');
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(application?.previewBearer ?? '')) {
    fail('preview bearer must be an HMAC-SHA256 token encoded as base64url');
  }
  const config = {
    name: names.app,
    account_id: accountId,
    main,
    compatibility_date: '2026-07-01',
    compatibility_flags: ['nodejs_compat'],
    preview_urls: false,
    // The one public exposure: each PR environment is self-contained and directly
    // reachable at its stable workers.dev hostname, gated by PREVIEW_BEARER.
    workers_dev: true,
    routes: [],
    exports: {},
    vars: {
      ENVIRONMENT: 'preview',
      API_HOST: names.host,
      VIEWER_HOST: names.host,
      R2_DASHBOARD_BASE_URL: `https://dash.cloudflare.com/${accountId}/r2/default/buckets/${names.r2}`,
      PREVIEW_PR_NUMBER: String(resources.pr),
      PREVIEW_HEAD_SHA: resources.headSha,
      PREVIEW_ARTIFACT_DIGEST: resources.artifactDigest,
      BUILD_INPUT_DIGEST: resources.buildInputDigest,
      ARTIFACT_DIGEST: resources.artifactDigest,
      MIGRATION_DIGEST: resources.migrationDigest,
      SCHEMA_DIGEST: resources.schemaDigest,
      PENDING_MIGRATIONS: '0',
      ASSET_SIGNING_SECRET: application.assetSigningSecret,
      PREVIEW_BEARER: application.previewBearer,
    },
    d1_databases: [{
      binding: 'DB',
      database_name: names.d1,
      database_id: resources.d1,
      migrations_dir: migrationsDir,
    }],
    r2_buckets: [{ binding: 'RAW', bucket_name: names.r2 }],
    kv_namespaces: [{ binding: 'KV', id: resources.kv }],
    durable_objects: { bindings: [] },
    queues: {
      producers: [{ binding: 'PARSE_QUEUE', queue: names.queue }],
      consumers: [{
        queue: names.queue,
        max_batch_size: 5,
        max_retries: 3,
        max_concurrency: 1,
        dead_letter_queue: names.dlq,
      }],
    },
  };
  assertNoProductionIdentifiers(config);
  return config;
}

export function resolveBundlerInputPath(configDirectory, input, pathApi = path) {
  if (typeof input !== 'string' || input.length === 0) fail('bundler input path is required');
  const normalizedInput = pathApi.sep === '\\' ? input.replaceAll('/', '\\') : input;
  return pathApi.resolve(configDirectory, normalizedInput);
}

export async function assertContainedRegularFile(root, candidate, label) {
  const rootReal = await realpath(root);
  const fileReal = await realpath(candidate);
  const prefix = `${rootReal}${path.sep}`;
  if (fileReal !== rootReal && !fileReal.startsWith(prefix)) fail(`${label} escapes its trusted root`);
  const stat = await lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} is not a regular file`);
  return fileReal;
}

/**
 * Classify an account resource name for cleanup. Returns null for names the preview
 * control plane does not own (never touched), otherwise `{ pr, legacy }`.
 */
export function previewResourceOwner(name) {
  if (typeof name !== 'string') return null;
  const legacy = LEGACY_GENERATION_RE.exec(name);
  if (legacy) return { pr: Number(legacy[1]), legacy: true };
  const current = PREVIEW_RESOURCE_RE.exec(name);
  if (current) return { pr: Number(current[1]), legacy: false };
  return null;
}

export function queueConsumerIdsForQueue(consumers, queueName) {
  if (!Array.isArray(consumers)) fail('queue consumers must be an array');
  required(queueName, 'queue name');
  return consumers.map((consumer) => {
    // Every consumer of a pr-N queue was attached by the preview control plane; a consumer
    // claiming a script outside the pr- namespace means the account holds something foreign.
    const script = consumer?.script_name;
    if (typeof script === 'string' && previewResourceOwner(script) === null) {
      fail(`foreign queue consumer rejected on ${queueName}: ${stableJson({ script })}`);
    }
    return required(consumer.consumer_id, 'queue consumer id');
  });
}

/**
 * Delete `items` via `deleteOne`, tolerating dependency ordering: legacy generations
 * deployed edge→app service-binding pairs, and Cloudflare refuses to delete a Worker
 * that another Worker still binds (error 10142). Each pass retries what the previous
 * pass could not delete — removing the edge frees its app for the next pass — and the
 * sweep fails loud with the first error the moment a full pass makes no progress.
 */
export async function deleteInDependencyPasses(items, deleteOne) {
  const deleted = [];
  let remaining = [...items];
  while (remaining.length > 0) {
    const failed = [];
    let firstError = null;
    for (const item of remaining) {
      try {
        await deleteOne(item);
        deleted.push(item);
      } catch (error) {
        failed.push(item);
        firstError ??= error;
      }
    }
    if (failed.length === remaining.length) throw firstError;
    remaining = failed;
  }
  return deleted;
}
