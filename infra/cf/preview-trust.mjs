import { createHash, createPublicKey } from 'node:crypto';
import { lstat, open, readFile, realpath, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PRODUCTION_ACCOUNT_ID = '18ef3246e9f36d1560485ef53889c0ab';
export const PREVIEW_ACCOUNT_ID = 'cbb04a26e6fa2d0cdc4eb67c735e5669';
export const PREVIEW_WORKERS_DEV_SUFFIX = '.agent-sessions-nonproduction.workers.dev';
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const ARTIFACT_FILES = new Set([
  'build-manifest.json',
  'content-manifest.json',
  'migration-manifest.json',
  'provenance.json',
]);

const TRUSTED_MIGRATION_METADATA = new Set([
  'historical-baseline.json',
  'source-baseline.json',
]);

const INVENTORY_KINDS = new Set([
  'd1',
  'r2',
  'kv',
  'queue',
  'app-version',
  'app-worker',
  'edge-version',
  'edge-worker',
]);

const CLEANUP_KIND_ORDER = new Map([
  ['edge-worker', 0],
  ['queue', 1],
  ['app-worker', 2],
  ['edge-version', 3],
  ['app-version', 4],
  ['kv', 5],
  ['r2', 6],
  ['d1', 7],
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

export function trustedWranglerEnvironment(source, apiToken, accountId) {
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

export function previewEdgeSessionCookie(setCookieHeaders) {
  for (const header of setCookieHeaders) {
    if (typeof header !== 'string') continue;
    const match = /(?:^|,\s*)(__Host-preview-edge=[^;,\s]+)/.exec(header);
    if (match) return match[1];
  }
  return null;
}

export function requiredCloudflareAccessHeaders(environment = process.env) {
  const clientId = environment.CF_ACCESS_CLIENT_ID?.trim();
  const clientSecret = environment.CF_ACCESS_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) fail('Cloudflare Access service credentials are required');
  return {
    'cf-access-client-id': clientId,
    'cf-access-client-secret': clientSecret,
  };
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

export function assertTrustedWorkflowRef(repository, workflowRef) {
  const expected = `${repositoryName(repository)}/.github/workflows/preview-control.yml@refs/heads/main`;
  if (workflowRef !== expected) fail('build must run from the trusted default-branch preview-control workflow');
  return workflowRef;
}

export function resourceNames(pr, runId, sha) {
  const prefix = `pr-${positiveInteger(pr, 'PR number')}-`;
  const generation = `g${positiveInteger(runId, 'run ID')}-${headSha(sha).slice(0, 12)}`;
  const names = {
    prefix,
    generation,
    app: `${prefix}${generation}-app`,
    edge: `${prefix}${generation}-edge`,
    d1: `${prefix}${generation}-sessions-index`,
    r2: `${prefix}${generation}-agent-sessions`,
    kv: `${prefix}${generation}-sessions-hub-kv`,
    queue: `${prefix}${generation}-parse`,
    dlq: `${prefix}${generation}-parse-dlq`,
    host: `${prefix}preview.sessions.vza.net`,
  };
  for (const [kind, name] of Object.entries(names)) {
    if (kind !== 'host' && kind !== 'generation' && kind !== 'prefix' && name.length > 63) {
      fail(`${kind} resource name exceeds Cloudflare's 63-character limit: ${name}`);
    }
    if (kind !== 'host' && kind !== 'generation' && !name.startsWith(prefix)) {
      fail(`${kind} resource does not share ${prefix}`);
    }
  }
  return Object.freeze(names);
}

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

export function migrationArtifactSqlNames(entries) {
  if (!Array.isArray(entries) || !entries.includes('manifest.json')) {
    fail('preview artifact has no migration manifest');
  }
  const trustedMetadata = TRUSTED_MIGRATION_METADATA;
  const sql = [];
  for (const name of entries) {
    if (/^[0-9]{4}_[a-z0-9_]+\.sql$/.test(name)) sql.push(name);
    else if (name !== 'manifest.json' && !trustedMetadata.has(name)) fail(`unexpected migration entry: ${name}`);
  }
  if (sql.length === 0) fail('preview artifact has no numbered SQL migrations');
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

function publicJwks(raw, name) {
  let parsed;
  try {
    parsed = JSON.parse(required(raw, name));
  } catch {
    fail(`${name} must be valid JSON`);
  }
  if (!parsed || !Array.isArray(parsed.keys) || parsed.keys.length === 0) fail(`${name} has no keys`);
  for (const key of parsed.keys) {
    if (!key || typeof key !== 'object' || Array.isArray(key)
      || typeof key.kid !== 'string' || typeof key.kty !== 'string'
      || key.notBefore == null || key.notAfter == null || typeof key.revoked !== 'boolean') {
      fail(`${name} contains an invalid public key record`);
    }
    for (const privateField of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']) {
      if (Object.hasOwn(key, privateField)) fail(`${name} contains private key material`);
    }
  }
  return stableJson(parsed);
}

function publicDebugJwk(raw, name) {
  let parsed;
  try {
    parsed = JSON.parse(required(raw, name));
  } catch {
    fail(`${name} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || parsed.kty !== 'EC' || parsed.crv !== 'P-256'
    || parsed.alg !== 'ES256' || parsed.use !== 'sig'
    || !Array.isArray(parsed.key_ops) || parsed.key_ops.length !== 1 || parsed.key_ops[0] !== 'verify'
    || !/^[A-Za-z0-9_-]{43}$/.test(parsed.x ?? '')
    || !/^[A-Za-z0-9_-]{43}$/.test(parsed.y ?? '')
    || parsed.revoked !== false) {
    fail(`${name} must be a non-revoked ES256 public verification JWK`);
  }
  for (const privateField of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']) {
    if (Object.hasOwn(parsed, privateField)) fail(`${name} contains private key material`);
  }
  try {
    createPublicKey({ key: parsed, format: 'jwk' });
  } catch {
    fail(`${name} contains an invalid P-256 public key`);
  }
  return stableJson(parsed);
}


export function generatedPrivateAppConfig({
  accountId, main, migrationsDir, names, resources, assertions, application,
}) {
  assertPreviewAccount(accountId);
  const issuer = new URL(required(assertions?.issuer, 'preview assertion issuer'));
  if (issuer.protocol !== 'https:') fail('preview assertion issuer must use HTTPS');
  const browserJwks = publicJwks(assertions?.browserJwks, 'preview browser assertion JWKS');
  const actionJwks = publicJwks(assertions?.actionJwks, 'preview action assertion JWKS');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(resources.environmentNonce ?? '')) {
    fail('generated preview config has an invalid environment nonce');
  }
  for (const [name, digest] of Object.entries({
    buildInputDigest: resources.buildInputDigest,
    artifactDigest: resources.artifactDigest,
    migrationDigest: resources.migrationDigest,
    schemaDigest: resources.schemaDigest,
  })) {
    if (!/^[0-9a-f]{64}$/.test(digest ?? '')) fail(`generated preview config has an invalid ${name}`);
  }
  const originJwks = publicJwks(assertions?.originJwks, 'preview origin assertion JWKS');
  if (!/^[A-Za-z0-9_-]{43}$/.test(application?.assetSigningSecret ?? '')) {
    fail('preview asset signing secret must be 32 random bytes encoded as base64url');
  }
  const debugImportAssertionPublicJwk = publicDebugJwk(
    application?.debugImportAssertionPublicJwk,
    'DEBUG_IMPORT_ASSERTION_PUBLIC_JWK',
  );
  const debugExportManifestVerifyPublicJwk = publicDebugJwk(
    application?.debugExportManifestVerifyPublicJwk,
    'DEBUG_EXPORT_MANIFEST_VERIFY_PUBLIC_JWK',
  );
  const config = {
    name: names.app,
    account_id: accountId,
    main,
    compatibility_date: '2026-07-01',
    compatibility_flags: ['nodejs_compat'],
    preview_urls: false,
    workers_dev: false,
    routes: [],
    exports: {},
    vars: {
      ENVIRONMENT: 'preview',
      API_HOST: names.host,
      VIEWER_HOST: names.host,
      R2_DASHBOARD_BASE_URL: `https://dash.cloudflare.com/${accountId}/r2/default/buckets/${names.r2}`,
      ENVIRONMENT_NONCE: resources.environmentNonce,
      PREVIEW_ASSERTION_ISSUER: issuer.href,
      PREVIEW_PR_NUMBER: String(resources.pr),
      PREVIEW_HEAD_SHA: resources.headSha,
      PREVIEW_GENERATION: names.generation,
      PREVIEW_ARTIFACT_DIGEST: resources.artifactDigest,
      BUILD_INPUT_DIGEST: resources.buildInputDigest,
      ARTIFACT_DIGEST: resources.artifactDigest,
      MIGRATION_DIGEST: resources.migrationDigest,
      SCHEMA_DIGEST: resources.schemaDigest,
      PENDING_MIGRATIONS: '0',
      PREVIEW_BROWSER_ASSERTION_JWKS: browserJwks,
      PREVIEW_ACTION_ASSERTION_JWKS: actionJwks,
      PREVIEW_ORIGIN_ASSERTION_JWKS: originJwks,
      ASSET_SIGNING_SECRET: application.assetSigningSecret,
      DEBUG_IMPORT_ASSERTION_PUBLIC_JWK: debugImportAssertionPublicJwk,
      DEBUG_EXPORT_MANIFEST_VERIFY_PUBLIC_JWK: debugExportManifestVerifyPublicJwk,
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

export function generatedTrustedWrapperConfig({ accountId, main, names, originJwks }) {
  assertPreviewAccount(accountId);
  const config = {
    name: names.edge,
    account_id: accountId,
    main,
    compatibility_date: '2026-07-01',
    preview_urls: true,
    workers_dev: false,
    routes: [],
    vars: {
      PREVIEW_ORIGIN_ASSERTION_JWKS: publicJwks(originJwks, 'preview origin assertion JWKS'),
    },
    services: [{ binding: 'APP', service: names.app }],
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

export async function walkRegularFiles(root) {
  const found = [];
  async function visit(directory, relative) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail(`links are forbidden in artifacts: ${rel}`);
      if (entry.isDirectory()) await visit(full, rel);
      else if (entry.isFile()) found.push(rel.replaceAll('\\', '/'));
      else fail(`non-regular artifact entry rejected: ${rel}`);
    }
  }
  await visit(root, '');
  return found.sort();
}

export function acknowledgedResources(deleted) {
  if (!Array.isArray(deleted)) fail('deleted resources must be an array');
  return deleted.map(({ kind, id, name, generation }) => ({ kind, id, name, generation }));
}

export function workerScriptCoversVersion(item, inventory) {
  if (!Array.isArray(inventory)) fail('inventory must be an array');
  const workerKind = item?.kind === 'app-version'
    ? 'app-worker'
    : item?.kind === 'edge-version'
      ? 'edge-worker'
      : null;
  if (!workerKind) return false;
  return inventory.some((candidate) =>
    candidate?.kind === workerKind
    && candidate.name === item.name
    && candidate.generation === item.generation);
}

export function sortCleanupInventory(inventory) {
  if (!Array.isArray(inventory)) fail('inventory must be an array');
  return [...inventory].sort(
    (a, b) => (CLEANUP_KIND_ORDER.get(a?.kind) ?? Number.MAX_SAFE_INTEGER)
      - (CLEANUP_KIND_ORDER.get(b?.kind) ?? Number.MAX_SAFE_INTEGER),
  );
}

export function inventoryGenerations(inventory) {
  if (!Array.isArray(inventory)) fail('inventory must be an array');
  const generations = new Set();
  for (const item of inventory) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const generation = item.generation;
    if (/^g[1-9][0-9]*-[0-9a-f]{12}$/.test(generation ?? '')) generations.add(generation);
  }
  return generations;
}

export function assertInventoryItem(item, pr, knownGeneration, { allowMissingId = false } = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) fail('inventory item must be an object');
  if (!INVENTORY_KINDS.has(item.kind)) fail(`unsupported inventory kind: ${item.kind}`);
  const prefix = `pr-${positiveInteger(pr, 'PR number')}-${knownGeneration}-`;
  if (item.id == null) {
    if (!allowMissingId) fail('inventory id is required');
  } else {
    required(item.id, 'inventory id');
  }
  const name = required(item.name, 'inventory name');
  if (!name.startsWith(prefix)) fail(`foreign generation inventory name rejected: ${name}`);
  if (item.pr != null && item.pr !== Number(pr)) fail(`inventory PR mismatch for ${name}`);
  if (item.generation !== knownGeneration) fail(`inventory generation mismatch for ${name}`);
  assertNoProductionIdentifiers(item);
  return item;
}
