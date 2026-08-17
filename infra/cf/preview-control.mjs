import { appendFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  MAX_WORKER_BUNDLE_BYTES,
  assertContainedRegularFile,
  assertPreviewAccount,
  deleteInDependencyPasses,
  emptyR2Bucket,
  fail,
  fileRecord,
  generatedBuildConfig,
  generatedPrivateAppConfig,
  headSha,
  migrationSqlNames,
  paginatedList,
  parseArgs,
  positiveInteger,
  previewBearerToken,
  previewResourceOwner,
  previewWranglerEnvironment,
  queueConsumerIdsForQueue,
  repositoryName,
  resolveBundlerInputPath,
  resourceNames,
  sha256Bytes,
  stableJson,
  wranglerWorkerBundle,
  writeCanonicalJson,
} from './preview-trust.mjs';
import { deactivatePreviewDeployments } from './preview-deployment.mjs';
import { migrationDigest } from '../../hub/scripts/lib/migration-manifest.mjs';
import { SYNTHETIC_EXPECTATIONS } from '../../hub/scripts/lib/dev-seed.mjs';

const [command, ...rest] = process.argv.slice(2);
const allowed = new Set([
  'account-id', 'head-sha', 'hub', 'pr', 'repository', 'wrangler', 'migrations-cli',
  'github-output', 'artifact-digest', 'schema-digest', 'prs',
]);
const args = parseArgs(rest, allowed);
const repository = repositoryName(args.repository ?? process.env.GITHUB_REPOSITORY);
const pr = command === 'janitor' || command === 'deployment-inactivate-batch'
  ? null
  : positiveInteger(args.pr, 'PR number');
const previewAccountId = args['account-id'] ?? process.env.CLOUDFLARE_PPE_ACCOUNT_ID;
const previewToken = process.env.CLOUDFLARE_PPE_API_TOKEN;

const MIGRATION_LEDGER_KEY = 'preview_migration_files';

// An empty credential means the repository was never provisioned, not that the code is wrong,
// so say which value is missing and which command installs it rather than failing bare.
const PROVISION_HINT = 'run `node infra/cf/preview-token.mjs --set` (fork PRs never receive these)';

function requireCloudflareEnvironment() {
  if (!previewAccountId) fail(`repository variable CLOUDFLARE_PPE_ACCOUNT_ID is empty — ${PROVISION_HINT}`);
  assertPreviewAccount(previewAccountId);
  if (!previewToken) fail(`repository secret CLOUDFLARE_PPE_API_TOKEN is empty — ${PROVISION_HINT}`);
}

function requireBearerSeed() {
  const seed = process.env.PREVIEW_BEARER_SEED;
  if (typeof seed !== 'string' || seed.trim().length < 32) {
    fail(`repository secret PREVIEW_BEARER_SEED is missing or under 32 characters — ${PROVISION_HINT}`);
  }
  return seed;
}

// A rate-limit rejection means GitHub did not process the request, so replaying it is safe for
// any method. A 5xx is ambiguous — the status may already exist — and POSTing a deployment status
// twice records it twice, so only reads are replayed there.
const GITHUB_RETRY_STATUS = new Set([403, 429, 500, 502, 503, 504]);
const GITHUB_RETRY_STATUS_UNSAFE = new Set([403, 429]);
const GITHUB_SAFE_METHODS = new Set(['GET', 'HEAD']);
const GITHUB_ATTEMPTS = 5;

function retryableStatus(method, status) {
  const safe = GITHUB_SAFE_METHODS.has((method ?? 'GET').toUpperCase());
  return safe ? GITHUB_RETRY_STATUS.has(status) : GITHUB_RETRY_STATUS_UNSAFE.has(status);
}

function retryDelayMs(response, attempt) {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter, 60) * 1000;
  return Math.min(2 ** attempt, 30) * 1000;
}

/**
 * The janitor sweeps many PRs in one run, so a single secondary-rate-limit 403 partway through
 * would leave every later PR's cards advertising a URL that no longer resolves. Back off and
 * retry the statuses GitHub tells us to retry; fail loudly on anything else.
 */
async function github(pathname, init = {}) {
  const { allowNotFound = false, expectedStatus = null, ...fetchInit } = init;
  const token = process.env.GITHUB_TOKEN;
  if (!token) fail('GITHUB_TOKEN is required for GitHub state checks');
  let response;
  for (let attempt = 0; attempt < GITHUB_ATTEMPTS; attempt += 1) {
    response = await fetch(`https://api.github.com${pathname}`, {
      ...fetchInit,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'sessions-preview-control',
        'x-github-api-version': '2022-11-28',
        ...fetchInit.headers,
      },
    });
    if (!retryableStatus(fetchInit.method, response.status)) break;
    if (attempt === GITHUB_ATTEMPTS - 1) break;
    const delay = retryDelayMs(response, attempt);
    process.stdout.write(`GitHub API ${pathname} returned ${response.status}; retrying in ${delay / 1000}s\n`);
    await new Promise((resolve) => { setTimeout(resolve, delay); });
  }
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok || (expectedStatus != null && response.status !== expectedStatus)) {
    fail(`GitHub API ${pathname} failed with ${response.status}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

function actionRunLogUrl() {
  const runId = process.env.GITHUB_RUN_ID;
  if (!runId) return null;
  return `https://github.com/${repository}/actions/runs/${positiveInteger(runId, 'GitHub Actions run ID')}`;
}

function previewPrNumbers(value) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { fail('PR list must be a JSON array'); }
  if (!Array.isArray(parsed) || parsed.length === 0) fail('PR list must be a non-empty JSON array');
  const numbers = parsed.map((number) => positiveInteger(number, 'PR number'));
  if (new Set(numbers).size !== numbers.length) fail('PR list contains duplicate PR numbers');
  return numbers;
}

/**
 * The one deployment-card operation left in this script. Provisioning cards are GitHub's job:
 * the preview job declares `environment: preview/pr-N`, so GitHub opens the deployment when the
 * job starts and closes it with the job's own conclusion. Nothing can report a state the
 * workflow is not in. Removal is the exception — a resource sweep is not a job conclusion, so
 * close and the janitor retire the card explicitly after the Cloudflare delete succeeds.
 */
async function deactivatePreviewCards(number) {
  return deactivatePreviewDeployments({
    request: github,
    repository,
    pr: number,
    description: 'Preview environment removed',
    logUrl: actionRunLogUrl(),
  });
}

async function inactivateDeploymentCards() {
  const inactiveDeploymentIds = await deactivatePreviewCards(pr);
  process.stdout.write(`${stableJson({ pr, inactiveDeploymentIds })}\n`);
}

async function inactivateDeploymentCardsBatch() {
  const inactiveDeployments = {};
  for (const number of previewPrNumbers(args.prs)) {
    const inactiveDeploymentIds = await deactivatePreviewCards(number);
    if (inactiveDeploymentIds.length > 0) inactiveDeployments[number] = inactiveDeploymentIds;
  }
  process.stdout.write(`${stableJson({ inactiveDeployments })}\n`);
}

async function cf(pathname, init = {}) {
  requireCloudflareEnvironment();
  const { allowNotFound = false, returnEnvelope = false, ...fetchInit } = init;
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${previewAccountId}/${pathname}`, {
    ...fetchInit,
    redirect: 'error',
    headers: {
      authorization: `Bearer ${previewToken}`,
      accept: 'application/json',
      ...(fetchInit.body ? { 'content-type': 'application/json' } : {}),
      ...fetchInit.headers,
    },
  });
  if (allowNotFound && response.status === 404) return null;
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { fail(`Cloudflare returned non-JSON HTTP ${response.status}`); }
  const notFoundEnvelope = allowNotFound
    && Array.isArray(parsed.errors)
    && parsed.errors.length > 0
    && parsed.errors.every((error) => /not found|does not exist/i.test(String(error?.message)));
  if (notFoundEnvelope) return null;
  if (!response.ok || parsed.success === false) {
    fail(`Cloudflare ${pathname} failed with ${response.status}: ${stableJson(parsed.errors ?? parsed)}`);
  }
  return returnEnvelope ? parsed : parsed.result ?? parsed;
}

/** One parameterized statement against a preview D1 over the REST API. */
async function d1Query(databaseId, sql, params = []) {
  const rows = await cf(`d1/database/${encodeURIComponent(databaseId)}/query`, {
    method: 'POST',
    body: stableJson({ sql, params }),
  });
  const first = Array.isArray(rows) ? rows[0] : rows;
  if (first?.success === false) fail(`D1 query failed: ${stableJson(first.errors ?? first)}`);
  return first?.results ?? [];
}

async function resolveExistingId(kind, name) {
  if (kind === 'r2') {
    const result = await cf(`r2/buckets/${encodeURIComponent(name)}`, { allowNotFound: true });
    return result ? name : null;
  }
  if (kind === 'worker') {
    const result = await cf(`workers/scripts/${encodeURIComponent(name)}/settings`, { allowNotFound: true });
    return result ? name : null;
  }
  if (kind === 'd1') {
    const rows = await paginatedList(cf, `d1/database?name=${encodeURIComponent(name)}`, {
      pagination: 'page', rowsOf: (envelope) => envelope.result,
    });
    return rows.find((row) => row.name === name)?.uuid ?? null;
  }
  if (kind === 'kv') {
    const rows = await paginatedList(cf, `storage/kv/namespaces?title=${encodeURIComponent(name)}`, {
      pagination: 'page', rowsOf: (envelope) => envelope.result,
    });
    return rows.find((row) => row.title === name)?.id ?? null;
  }
  if (kind === 'queue') {
    const rows = await paginatedList(cf, 'queues', {
      pagination: 'page', rowsOf: (envelope) => envelope.result ?? envelope.queues,
    });
    return rows.find((row) => row.queue_name === name)?.queue_id ?? null;
  }
  fail(`unsupported resource kind: ${kind}`);
}

async function ensureResource(kind, name, pathname, body, idFields) {
  const existing = await resolveExistingId(kind, name);
  if (existing != null) return existing;
  const result = await cf(pathname, { method: 'POST', body: stableJson(body) });
  const id = idFields.map((field) => result?.[field]).find((value) => typeof value === 'string' && value.length > 0);
  if (!id) fail(`Cloudflare did not return an ID for ${kind} ${name}`);
  return id;
}

/** Create-if-missing for the persistent per-PR backing resources; idempotent on rerun. */
async function ensureBackingResources(names) {
  const d1 = await ensureResource('d1', names.d1, 'd1/database', { name: names.d1 }, ['uuid', 'id']);
  const r2 = await ensureResource('r2', names.r2, 'r2/buckets', { name: names.r2 }, ['name']);
  const kv = await ensureResource('kv', names.kv, 'storage/kv/namespaces', { title: names.kv }, ['id']);
  const dlq = await ensureResource('queue', names.dlq, 'queues', { queue_name: names.dlq }, ['queue_id', 'id']);
  const queue = await ensureResource('queue', names.queue, 'queues', { queue_name: names.queue }, ['queue_id', 'id']);
  return { d1, r2, kv, dlq, queue };
}

/**
 * The persistent-D1 divergence guard. Wrangler's ledger tracks applied migrations by NAME
 * only, so a PR that edits a migration file its own preview already applied would silently
 * keep the old schema — the classic mystery drift. We record each applied file's sha256 in
 * the preview's `meta` table; when the artifact disagrees with what was actually applied
 * (edited bytes, or an applied name that left the manifest), the D1 is reset — deleted and
 * recreated empty — and migrations apply from scratch. Loud by design: the reset drops any
 * hand-uploaded session data, and re-uploading is one self-serve command.
 */
/** A D1 error that means the table simply isn't there yet — anything else must propagate. */
function isMissingTable(error) {
  return /no such table/i.test(String(error?.message ?? error));
}

async function migrationDivergence(databaseId, artifactMigrations) {
  let applied;
  try {
    applied = await d1Query(databaseId, "SELECT name FROM d1_migrations ORDER BY id");
  } catch (error) {
    // Only a provably-fresh database (no wrangler ledger table) skips the guard; an auth
    // failure, 5xx, or network error must not silently report "not diverged".
    if (!isMissingTable(error)) throw error;
    return { diverged: false, reason: 'fresh database (no migration ledger)' };
  }
  const appliedNames = applied.map((row) => row.name);
  if (appliedNames.length === 0) return { diverged: false, reason: 'no applied migrations' };
  const byName = new Map(artifactMigrations.map((item) => [item.filename, item.sha256]));
  for (const name of appliedNames) {
    if (!byName.has(name)) return { diverged: true, reason: `applied migration ${name} left the manifest` };
  }
  let ledger = {};
  try {
    const rows = await d1Query(databaseId, 'SELECT value FROM meta WHERE key = ?1', [MIGRATION_LEDGER_KEY]);
    if (rows[0]?.value) ledger = JSON.parse(rows[0].value);
  } catch (error) {
    // A pre-guard database has no meta table; any other failure must propagate.
    if (!isMissingTable(error)) throw error;
  }
  for (const name of appliedNames) {
    const recorded = ledger[name];
    if (recorded && recorded !== byName.get(name)) {
      return { diverged: true, reason: `applied migration ${name} was edited after it ran here` };
    }
  }
  return { diverged: false, reason: 'applied prefix matches the artifact' };
}

async function recordMigrationLedger(databaseId, artifactMigrations, appliedNames) {
  const byName = new Map(artifactMigrations.map((item) => [item.filename, item.sha256]));
  const ledger = {};
  for (const name of appliedNames) {
    if (byName.has(name)) ledger[name] = byName.get(name);
  }
  await d1Query(
    databaseId,
    'INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    [MIGRATION_LEDGER_KEY, stableJson(ledger)],
  );
}

function previewChildEnvironment() {
  return previewWranglerEnvironment(process.env, previewToken, previewAccountId);
}

function runJson(commandPath, commandArgs, cwd) {
  const result = spawnSync(process.execPath, [commandPath, ...commandArgs], {
    cwd,
    env: previewChildEnvironment(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15 * 60 * 1000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`preview command failed with exit ${result.status}: ${(result.stderr ?? result.stdout ?? '').trim().slice(-8000)}`);
  }
  const output = result.stdout.trim();
  try { return JSON.parse(output); } catch { fail(`preview command did not emit one JSON object: ${output.slice(-2000)}`); }
}

function runWrangler(wrangler, commandArgs, cwd, operation) {
  const result = spawnSync(process.execPath, [wrangler, ...commandArgs], {
    cwd,
    env: previewChildEnvironment(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15 * 60 * 1000,
  });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status !== 0) fail(`${operation} failed: ${output.trim().slice(-8000)}`);
  return output;
}

function deployApp(wrangler, configPath, cwd, expectedHost) {
  const output = runWrangler(wrangler, [
    'deploy', '--config', configPath, '--no-bundle', '--strict',
  ], cwd, 'preview app deployment');
  // workers_dev: true is deliberate — the stable workers.dev hostname IS the preview's
  // public address. Anything else appearing here means the config drifted.
  const urls = [...output.matchAll(/https:\/\/[^\s]+\.workers\.dev/gi)].map((match) => match[0]);
  const foreign = urls.filter((url) => new URL(url).hostname !== expectedHost);
  if (foreign.length > 0) fail(`preview deployment exposed an unexpected URL: ${foreign[0]}`);
  // An empty match set proves nothing — require positive confirmation the deploy landed
  // on the stable hostname, or a wrangler output-format change silently voids this gate.
  if (urls.length === 0) fail(`preview deployment did not report the expected workers.dev URL for ${expectedHost}`);
  return output;
}

/**
 * Bundle the PR's own hub source with its own pinned Wrangler, in the job that deploys it.
 * Nothing crosses a trust boundary here, so there is no artifact, manifest set, or provenance
 * to verify: the digests below exist for DRIFT detection — smoke asserts the live Worker reports
 * exactly the bundle and schema this run deployed — not to attest anything to a later job.
 */
async function buildPreviewBundle({ hubRoot, wrangler, names, workDirectory }) {
  const entrypoint = path.join(hubRoot, 'src', 'preview.ts');
  await assertContainedRegularFile(hubRoot, entrypoint, 'preview entrypoint');
  const configPath = path.join(workDirectory, 'wrangler.preview-build.json');
  const metafilePath = path.join(workDirectory, 'esbuild-meta.json');
  const bundleDirectory = path.join(workDirectory, 'bundle');
  await writeCanonicalJson(configPath, generatedBuildConfig({ main: entrypoint, workerName: names.app }));

  runWrangler(wrangler, [
    'deploy', '--dry-run', '--config', configPath,
    '--outdir', bundleDirectory, '--metafile', metafilePath,
  ], hubRoot, 'preview bundle');

  const bundle = await wranglerWorkerBundle(bundleDirectory);
  const output = await fileRecord(bundle, 'worker.mjs');
  if (output.size > MAX_WORKER_BUNDLE_BYTES) fail('Worker bundle exceeds the size limit');

  const metadata = JSON.parse(await readFile(metafilePath, 'utf8'));
  if (!metadata.inputs || typeof metadata.inputs !== 'object') fail('Wrangler did not produce an input metafile');
  const inputs = [];
  for (const input of Object.keys(metadata.inputs).sort()) {
    if (input.startsWith('<')) continue;
    const file = resolveBundlerInputPath(path.dirname(configPath), input);
    await assertContainedRegularFile(hubRoot, file, `bundler input ${input}`);
    inputs.push(await fileRecord(file, path.relative(hubRoot, file)));
  }
  inputs.push(await fileRecord(path.join(hubRoot, 'package-lock.json'), 'package-lock.json'));
  inputs.sort((left, right) => left.path.localeCompare(right.path));

  return {
    bundle,
    artifactDigest: output.sha256,
    buildInputDigest: sha256Bytes(stableJson(inputs)),
  };
}

/**
 * Build, migrate, and deploy one PR's self-contained preview, in place, from a single checkout.
 * Every name is derived from the PR number, so a re-run is idempotent and a concurrent run for
 * a different PR cannot collide. The account pin and production-identifier scan stay: they guard
 * against a misconfigured account or a copy-pasted production ID, which is an accident this job
 * can still plausibly have.
 */
async function provision() {
  requireCloudflareEnvironment();
  const seed = requireBearerSeed();
  const sha = headSha(args['head-sha']);
  const hubRoot = path.resolve(args.hub ?? 'hub');
  if (!args.wrangler) fail('--wrangler is required');
  if (!args['migrations-cli']) fail('--migrations-cli is required');
  const wrangler = path.resolve(args.wrangler);
  const names = resourceNames(pr);

  const migrationsDirectory = path.join(hubRoot, 'migrations');
  const migrationManifestPath = path.join(migrationsDirectory, 'manifest.json');
  // A stray file in migrations/ would be silently ignored by the runner; reject it here.
  migrationSqlNames(await readdir(migrationsDirectory));
  const migrationManifest = JSON.parse(await readFile(migrationManifestPath, 'utf8'));
  if (!Array.isArray(migrationManifest.migrations)) fail('migration manifest has no migrations');
  const expectedMigrationDigest = migrationDigest(migrationManifest);

  const temporary = await mkdtemp(path.join(os.tmpdir(), `sessions-preview-${pr}-`));
  try {
    const build = await buildPreviewBundle({ hubRoot, wrangler, names, workDirectory: temporary });
    const resources = await ensureBackingResources(names);

    const divergence = await migrationDivergence(resources.d1, migrationManifest.migrations);
    if (divergence.diverged) {
      process.stderr.write(`!! preview D1 reset: ${divergence.reason} — dropping ${names.d1} and reapplying from scratch\n`);
      await cf(`d1/database/${encodeURIComponent(resources.d1)}`, { method: 'DELETE', allowNotFound: true });
      resources.d1 = await ensureResource('d1', names.d1, 'd1/database', { name: names.d1 }, ['uuid', 'id']);
      // The index rows are gone with the database, so the stored R2 objects would be
      // unreachable orphans — drop them in the same reset to keep the two stores consistent.
      await emptyR2Bucket(names.r2, cf);
    }

    const application = {
      assetSigningSecret: randomBytes(32).toString('base64url'),
      previewBearer: previewBearerToken(seed, pr),
    };
    const configResources = {
      ...resources,
      pr,
      headSha: sha,
      buildInputDigest: build.buildInputDigest,
      artifactDigest: build.artifactDigest,
      migrationDigest: expectedMigrationDigest,
    };
    const generateConfig = (file, schemaDigest) => writeCanonicalJson(file, generatedPrivateAppConfig({
      accountId: previewAccountId,
      main: build.bundle,
      migrationsDir: migrationsDirectory,
      names,
      resources: { ...configResources, schemaDigest },
      application,
    }));

    const migrationConfigPath = path.join(temporary, 'wrangler.migrations.generated.json');
    await generateConfig(migrationConfigPath, '0'.repeat(64));
    const migration = runJson(path.resolve(args['migrations-cli']), [
      'apply', '--target', 'preview', '--config', migrationConfigPath, '--database', 'DB',
      '--journal', path.join(temporary, `preview-${pr}.migrations.json`),
      '--artifact-digest', build.artifactDigest,
      '--deployment-id', `pr-${pr}-${sha.slice(0, 12)}`,
      '--migrations-dir', migrationsDirectory,
      '--manifest', migrationManifestPath,
      // The immutable committed baseline, the same evidence production migrations use. The
      // PR-vs-protected-base check is CI's `migrations.mjs check`, which gates this job.
      '--base-manifest', path.join(migrationsDirectory, 'source-baseline.json'),
    ], hubRoot);
    if (migration.pendingMigrations !== 0 || !/^[0-9a-f]{64}$/.test(migration.schemaDigest ?? '')) {
      fail('migration runner did not prove zero pending migrations and a schema digest');
    }
    if (migration.migrationDigest !== expectedMigrationDigest) {
      fail('applied migration digest differs from the checked-out manifest');
    }
    await recordMigrationLedger(
      resources.d1,
      migrationManifest.migrations,
      migrationManifest.migrations.map((item) => item.filename),
    );

    const appConfigPath = path.join(temporary, 'wrangler.app.generated.json');
    await generateConfig(appConfigPath, migration.schemaDigest);
    deployApp(wrangler, appConfigPath, hubRoot, names.host);

    const summary = {
      url: `https://${names.host}`,
      d1Reset: divergence.diverged,
      artifactDigest: build.artifactDigest,
      schemaDigest: migration.schemaDigest,
    };
    if (args['github-output']) {
      await appendFile(path.resolve(args['github-output']), [
        `url=${summary.url}`,
        `artifact_digest=${summary.artifactDigest}`,
        `schema_digest=${summary.schemaDigest}`,
        '',
      ].join('\n'));
    }
    process.stdout.write(`${stableJson(summary)}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function bearerContext() {
  const seed = requireBearerSeed();
  const names = resourceNames(pr);
  const origin = `https://${names.host}`;
  const token = previewBearerToken(seed, pr);
  return { names, origin, token };
}

async function previewFetch(context, target, init = {}) {
  return fetch(new URL(target, context.origin), {
    redirect: 'error',
    ...init,
    headers: {
      authorization: `Bearer ${context.token}`,
      'cache-control': 'no-store',
      ...init.headers,
    },
  });
}

const DIAGNOSTICS_SETTLE_MS = 90_000;
const DIAGNOSTICS_POLL_MS = 3_000;
const DIAGNOSTICS_REQUEST_MS = 15_000;

async function smoke() {
  const context = bearerContext();
  const expectedArtifact = args['artifact-digest'];
  const expectedSchema = args['schema-digest'];
  const sha = headSha(args['head-sha']);
  if (!/^[0-9a-f]{64}$/.test(expectedArtifact ?? '') || !/^[0-9a-f]{64}$/.test(expectedSchema ?? '')) {
    fail('smoke requires --artifact-digest and --schema-digest from the provision step');
  }

  // The bearer is the entire gate: the same request without it must be rejected.
  const unauthenticated = await fetch(new URL('/api/v1/preview/diagnostics', context.origin), {
    redirect: 'error',
    headers: { accept: 'application/json', 'cache-control': 'no-store' },
  });
  if (unauthenticated.status !== 401) {
    fail(`unauthenticated preview request was not denied (${unauthenticated.status})`);
  }

  // A just-deployed Worker version does not reach every edge location at once, so the first
  // diagnostics read can legitimately answer from the previous version. Waiting is not a weaker
  // assertion — every field must still match exactly — it just refuses to call propagation lag a
  // failed deploy. Observed on PR #139: a deploy whose bundle was unchanged served the previous
  // headSha for seconds, then the correct one.
  let diagnostics = null;
  let stalled = null;
  const deadline = Date.now() + DIAGNOSTICS_SETTLE_MS;
  for (let attempt = 0; ; attempt += 1) {
    // Every request is bounded by whichever comes first, its own cap or the settle deadline, so
    // one stalled connection cannot stretch the wait past the budget.
    const budget = Math.min(DIAGNOSTICS_REQUEST_MS, Math.max(deadline - Date.now(), 1_000));
    let response = null;
    try {
      response = await previewFetch(context, '/api/v1/preview/diagnostics', {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(budget),
      });
    } catch (error) {
      // A stalled or reset edge connection is the same transient class as a stale version;
      // remember it so a run that only ever stalls fails saying so.
      stalled = error;
    }
    if (response && !response.ok) {
      fail(`preview diagnostics smoke failed with ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
    if (response) {
      stalled = null;
      diagnostics = await response.json();
      if (diagnostics.headSha === sha
        && diagnostics.artifactDigest === expectedArtifact
        && diagnostics.schemaDigest === expectedSchema) break;
    }
    if (Date.now() >= deadline) {
      const seen = stalled ? `last attempt failed: ${stalled.message}` : stableJson(diagnostics);
      fail(`preview diagnostics still do not match the provisioned artifact after `
        + `${Math.round(DIAGNOSTICS_SETTLE_MS / 1000)}s: ${seen}`);
    }
    if (attempt === 0) process.stdout.write('preview diagnostics do not match yet; waiting for the deploy to propagate\n');
    await new Promise((resolve) => { setTimeout(resolve, DIAGNOSTICS_POLL_MS); });
  }
  process.stdout.write(`${stableJson({ smoke: 'passed', url: context.origin, artifactDigest: expectedArtifact, schemaDigest: expectedSchema })}\n`);
}

async function seed() {
  const context = bearerContext();
  const fixtureRoot = new URL('../../hub/test/fixtures/local/', import.meta.url);
  const primary = await readFile(new URL('e2e-synthetic-session.jsonl', fixtureRoot));
  const pager = await readFile(new URL('e2e-pager-session.jsonl', fixtureRoot));
  const asset = Buffer.from((await readFile(new URL('fixture-external.png.base64', fixtureRoot), 'utf8')).trim(), 'base64');
  const {
    externalDigest,
    externalRelpath,
    machine,
    pagerRelpath,
    pagerSearchPhrase,
    pagerSessionId,
    primaryRelpath,
    primarySessionId,
    searchPhrase,
    store,
  } = SYNTHETIC_EXPECTATIONS;
  if (sha256Bytes(asset) !== externalDigest) fail('synthetic external asset digest does not match fixture contract');
  const uploads = [
    [externalRelpath, asset],
    [primaryRelpath, primary],
    [pagerRelpath, pager],
  ];
  for (const [relative, bytes] of uploads) {
    const encoded = relative.split('/').map(encodeURIComponent).join('/');
    const target = `/api/v1/files/${encodeURIComponent(machine)}/${encodeURIComponent(store)}/${encoded}`;
    const response = await previewFetch(context, target, {
      method: 'PUT',
      body: bytes,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.length),
        'x-content-hash': `sha256:${sha256Bytes(bytes)}`,
        'x-file-mtime': '2026-07-01T00:00:00.000Z',
      },
    });
    if (response.status !== 200 && response.status !== 201) {
      fail(`synthetic preview upload failed with ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
  }
  const expected = [
    [primarySessionId, searchPhrase],
    [pagerSessionId, pagerSearchPhrase],
  ];
  for (const [sessionId, marker] of expected) {
    const deadline = Date.now() + 60_000;
    let last = '';
    let indexed = false;
    while (Date.now() < deadline) {
      const query = new URLSearchParams({ q: marker, machine, limit: '20' });
      const response = await previewFetch(context, `/api/v1/search?${query}`, {
        headers: { accept: 'application/json' },
      });
      last = await response.text();
      if (response.ok) {
        const body = JSON.parse(last);
        if (Array.isArray(body.hits) && body.hits.some((hit) => hit.session_id === sessionId)) {
          indexed = true;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!indexed) {
      const status = await previewFetch(context, '/api/v1/status', { headers: { accept: 'application/json' } });
      fail(`synthetic session ${sessionId} was not indexed: search=${last.slice(0, 500)}; status=${status.status}:${(await status.text()).slice(0, 1000)}`);
    }
  }
  process.stdout.write(`${stableJson({ url: context.origin, seeded: [primarySessionId, pagerSessionId] })}\n`);
}

/** Detach consumers then delete one named resource set (queue-safe ordering). */
async function deleteResourceSet(ownerPr, names) {
  const deleted = [];
  for (const queueName of [names.queue, names.dlq]) {
    const queueId = await resolveExistingId('queue', queueName);
    if (queueId == null) continue;
    const consumers = await cf(`queues/${encodeURIComponent(queueId)}/consumers`, { allowNotFound: true });
    for (const consumerId of queueConsumerIdsForQueue(consumers ?? [], queueName)) {
      await cf(
        `queues/${encodeURIComponent(queueId)}/consumers/${encodeURIComponent(consumerId)}`,
        { method: 'DELETE', allowNotFound: true },
      );
    }
  }
  const plan = [
    ['worker', names.app, (id) => `workers/scripts/${encodeURIComponent(id)}`],
    ['worker', names.legacyApp, (id) => `workers/scripts/${encodeURIComponent(id)}`],
    ['queue', names.queue, (id) => `queues/${encodeURIComponent(id)}`],
    ['queue', names.dlq, (id) => `queues/${encodeURIComponent(id)}`],
    ['kv', names.kv, (id) => `storage/kv/namespaces/${encodeURIComponent(id)}`],
    ['r2', names.r2, (id) => `r2/buckets/${encodeURIComponent(id)}`],
    ['d1', names.d1, (id) => `d1/database/${encodeURIComponent(id)}`],
  ];
  for (const [kind, name, endpoint] of plan) {
    const id = await resolveExistingId(kind, name);
    if (id == null) continue;
    if (kind === 'r2') await emptyR2Bucket(name, cf);
    await cf(endpoint(id), { method: 'DELETE', allowNotFound: true });
    deleted.push({ kind, name, pr: ownerPr });
  }
  return deleted;
}

/**
 * Enumerate every preview-account resource the control plane owns (`pr-N-…` names),
 * including debris from the retired per-generation naming scheme.
 */
async function listOwnedResources() {
  const owned = [];
  const record = (kind, name, id) => {
    const owner = previewResourceOwner(name);
    if (owner) owned.push({ kind, name, id, ...owner });
  };
  // Workers scripts is the one account list with no documented pagination; the rest are
  // walked to exhaustion — a first-page-only read here silently leaks closed previews.
  const workers = await paginatedList(cf, 'workers/scripts', {
    pagination: 'none', rowsOf: (envelope) => envelope.result,
  });
  for (const script of workers) record('worker', script.id ?? script.name, script.id ?? script.name);
  const databases = await paginatedList(cf, 'd1/database', {
    pagination: 'page', rowsOf: (envelope) => envelope.result,
  });
  for (const database of databases) record('d1', database.name, database.uuid);
  const buckets = await paginatedList(cf, 'r2/buckets', {
    pagination: 'cursor', rowsOf: (envelope) => envelope.result?.buckets ?? envelope.buckets,
  });
  for (const bucket of buckets) record('r2', bucket.name, bucket.name);
  const namespaces = await paginatedList(cf, 'storage/kv/namespaces', {
    pagination: 'page', rowsOf: (envelope) => envelope.result,
  });
  for (const namespace of namespaces) record('kv', namespace.title, namespace.id);
  const queues = await paginatedList(cf, 'queues', {
    pagination: 'page', rowsOf: (envelope) => envelope.result ?? envelope.queues,
  });
  for (const queue of queues) record('queue', queue.queue_name, queue.queue_id);
  return owned;
}

async function deleteOwnedResource(item) {
  if (item.kind === 'queue') {
    const consumers = await cf(`queues/${encodeURIComponent(item.id)}/consumers`, { allowNotFound: true });
    for (const consumerId of queueConsumerIdsForQueue(consumers ?? [], item.name)) {
      await cf(
        `queues/${encodeURIComponent(item.id)}/consumers/${encodeURIComponent(consumerId)}`,
        { method: 'DELETE', allowNotFound: true },
      );
    }
  }
  if (item.kind === 'r2') await emptyR2Bucket(item.name, cf);
  const endpoint = {
    worker: `workers/scripts/${encodeURIComponent(item.name)}`,
    queue: `queues/${encodeURIComponent(item.id)}`,
    kv: `storage/kv/namespaces/${encodeURIComponent(item.id)}`,
    r2: `r2/buckets/${encodeURIComponent(item.name)}`,
    d1: `d1/database/${encodeURIComponent(item.id)}`,
  }[item.kind];
  await cf(endpoint, { method: 'DELETE', allowNotFound: true });
}

const CLEANUP_ORDER = { worker: 0, queue: 1, kv: 2, r2: 3, d1: 4 };

async function closePreview() {
  requireCloudflareEnvironment();
  const names = resourceNames(pr);
  const deleted = await deleteResourceSet(pr, names);
  // Also sweep any retired per-generation debris this PR left behind.
  const legacy = (await listOwnedResources()).filter((item) => item.pr === pr && item.legacy);
  legacy.sort((a, b) => CLEANUP_ORDER[a.kind] - CLEANUP_ORDER[b.kind]);
  for (const item of await deleteInDependencyPasses(legacy, deleteOwnedResource)) {
    deleted.push({ kind: item.kind, name: item.name, pr });
  }
  process.stdout.write(`${stableJson({ closed: pr, deleted })}\n`);
}

/**
 * Daily sweep. Deletes (a) every resource of a CLOSED PR — covering closes the close
 * workflow missed or raced — and (b) all retired per-generation debris regardless of PR
 * state, since the current control plane never creates that shape.
 */
async function janitor() {
  requireCloudflareEnvironment();
  const owned = await listOwnedResources();
  const prNumbers = [...new Set(owned.map((item) => item.pr))].sort((a, b) => a - b);
  const closedPrs = new Set();
  const unresolvedPrs = new Set();
  for (const number of prNumbers) {
    let pull;
    try {
      // A definitive 404 means the PR number never existed — its debris is deletable.
      pull = await github(`/repos/${repository}/pulls/${number}`, { allowNotFound: true });
    } catch {
      // Fail CLOSED on an unknown PR state: a GitHub rate limit or outage must never
      // classify a live PR as closed and delete its persistent preview data.
      unresolvedPrs.add(number);
      continue;
    }
    if (pull === null || pull.state === 'closed') closedPrs.add(number);
  }
  if (unresolvedPrs.size > 0) {
    process.stderr.write(`!! janitor: skipping PRs with unresolved GitHub state: ${[...unresolvedPrs].sort((a, b) => a - b).join(', ')}\n`);
  }
  const deletable = owned.filter((item) =>
    closedPrs.has(item.pr) || (item.legacy && !unresolvedPrs.has(item.pr)));
  deletable.sort((a, b) =>
    a.pr - b.pr || CLEANUP_ORDER[a.kind] - CLEANUP_ORDER[b.kind]);
  const deleted = [];
  for (const item of await deleteInDependencyPasses(deletable, deleteOwnedResource)) {
    deleted.push({ kind: item.kind, name: item.name, pr: item.pr, legacy: item.legacy });
  }
  const closedPrNumbers = [...closedPrs].sort((a, b) => a - b);
  if (args['github-output']) {
    await appendFile(path.resolve(args['github-output']), `closed_prs=${stableJson(closedPrNumbers)}\n`);
  }
  process.stdout.write(`${stableJson({ closedPrs: closedPrNumbers, deleted })}\n`);
}

if (command === 'provision') await provision();
else if (command === 'deployment-inactivate') await inactivateDeploymentCards();
else if (command === 'deployment-inactivate-batch') await inactivateDeploymentCardsBatch();
else if (command === 'seed') await seed();
else if (command === 'smoke') await smoke();
else if (command === 'close') await closePreview();
else if (command === 'janitor') await janitor();
else fail(`unknown preview-control command: ${command ?? '<none>'}`);
