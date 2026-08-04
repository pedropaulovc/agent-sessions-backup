import { appendFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  ARTIFACT_FILES,
  MAX_ARTIFACT_BYTES,
  assertContainedRegularFile,
  PREVIEW_WORKERS_DEV_SUFFIX,
  acknowledgedResources,
  assertInventoryItem,
  assertNoProductionIdentifiers,
  assertPreviewAccount,
  assertTrustedWorkflowRef,
  fail,
  fileRecord,
  generatedPrivateAppConfig,
  generatedTrustedWrapperConfig,
  inventoryGenerations,
  headSha,
  parseArgs,
  positiveInteger,
  previewEdgeSessionCookie,
  requiredCloudflareAccessHeaders,
  repositoryName,
  resourceNames,
  sha256Bytes,
  sortCleanupInventory,
  stableJson,
  trustedWranglerEnvironment,
  wranglerWorkerBundle,
  walkRegularFiles,
  writeCanonicalJson,
  workerScriptCoversVersion,
} from './preview-trust.mjs';

const [command, ...rest] = process.argv.slice(2);
const allowed = new Set([
  'account-id', 'artifact', 'head-sha', 'journal', 'pr', 'repository', 'run-id',
  'source-run-id', 'workflow-ref', 'wrangler', 'migrations-cli', 'generation',
  'github-output', 'output', 'trusted-root',
]);
const args = parseArgs(rest, allowed);
const repository = repositoryName(args.repository ?? process.env.GITHUB_REPOSITORY);
const pr = command === 'janitor' ? null : positiveInteger(args.pr, 'PR number');
const previewAccountId = args['account-id'] ?? process.env.CLOUDFLARE_PREVIEW_ACCOUNT_ID;
const previewToken = process.env.CLOUDFLARE_PREVIEW_CONTROL_TOKEN;
const controlUrl = process.env.PREVIEW_CONTROL_URL;

function requireControlEnvironment({ cloudflare = false } = {}) {
  if (!controlUrl) fail('PREVIEW_CONTROL_URL is required');
  const url = new URL(controlUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    fail('PREVIEW_CONTROL_URL must be a credential-free HTTPS origin/path');
  }
  if (cloudflare) {
    assertPreviewAccount(previewAccountId);
    if (!previewToken) fail('CLOUDFLARE_PREVIEW_CONTROL_TOKEN is required');
  }
}

async function readCanonicalJson(file) {
  const raw = await readFile(file, 'utf8');
  const parsed = JSON.parse(raw);
  if (raw !== `${stableJson(parsed)}\n`) fail(`non-canonical JSON rejected: ${file}`);
  return parsed;
}

async function verifyArtifact(directory, expected) {
  const root = path.resolve(directory);
  const files = await walkRegularFiles(root);
  let archiveBytes = 0;
  for (const relative of files) {
    const stat = await lstat(path.join(root, ...relative.split('/')));
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) fail(`oversized or non-file artifact entry: ${relative}`);
    archiveBytes += stat.size;
    if (archiveBytes > MAX_ARTIFACT_BYTES) fail('artifact exceeds total size limit');
  }
  const manifests = {};
  for (const name of ARTIFACT_FILES) manifests[name] = await readCanonicalJson(path.join(root, name));
  const content = manifests['content-manifest.json'];
  if (content.schema !== 'sessions-preview-content/v1' || !Array.isArray(content.files)) {
    fail('invalid content manifest schema');
  }
  const expectedFiles = new Set([...ARTIFACT_FILES, ...content.files.map((item) => item.path)]);
  if (expectedFiles.size !== files.length || files.some((file) => !expectedFiles.has(file))) {
    fail('artifact contains missing or unexpected files');
  }
  let total = 0;
  for (const declared of content.files) {
    if (!declared || typeof declared.path !== 'string' || !/^payload\/(worker\.mjs|migrations\/(?:manifest\.json|[0-9]{4}_[a-z0-9_]+\.sql))$/.test(declared.path)) {
      fail(`unexpected content path: ${declared?.path}`);
    }
    const actual = await fileRecord(path.join(root, ...declared.path.split('/')), declared.path);
    if (stableJson(actual) !== stableJson(declared)) fail(`content digest mismatch: ${declared.path}`);
    total += actual.size;
  }
  if (total > MAX_ARTIFACT_BYTES) fail('artifact exceeds size limit');

  const provenance = manifests['provenance.json'];
  if (provenance.schema !== 'sessions-preview-provenance/v1') fail('invalid provenance schema');
  for (const [field, value] of Object.entries(expected)) {
    if (provenance[field] !== value) fail(`provenance ${field} mismatch`);
  }
  const digest = sha256Bytes(stableJson(content));
  if (provenance.artifactDigest !== digest) fail('artifact digest does not match provenance');
  const trustedRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const toolchainPaths = [
    'hub/package-lock.json',
    'infra/cf/preview-build.mjs',
    'infra/cf/preview-trust.mjs',
  ];
  const toolchainInputs = [];
  for (const relative of toolchainPaths) {
    toolchainInputs.push(await fileRecord(path.join(trustedRoot, relative), relative));
  }
  if (stableJson(provenance.toolchain?.inputs) !== stableJson(toolchainInputs)
    || provenance.toolchain?.digest !== sha256Bytes(stableJson(toolchainInputs))
    || provenance.toolchain?.wrangler !== '4.111.0') {
    fail('provenance toolchain does not match trusted default-branch inputs');
  }
  const build = manifests['build-manifest.json'];
  const migration = manifests['migration-manifest.json'];
  if (build.schema !== 'sessions-preview-build/v1' || build.headSha !== expected.headSha) fail('invalid build manifest');
  if (build.output?.path !== 'payload/worker.mjs') fail('build output is not the expected Worker bundle');
  if (migration.schema !== 'sessions-preview-migrations/v1') fail('invalid migration manifest');
  if (migration.migrationDigest !== provenance.migrationDigest) fail('migration digest mismatch');
  if (build.inputDigest !== provenance.buildInputDigest) fail('build input digest mismatch');
  assertNoProductionIdentifiers(manifests);
  return { root, provenance, build, migration, content };
}

async function github(pathname, init = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) fail('GITHUB_TOKEN is required for trusted GitHub state checks');
  const response = await fetch(`https://api.github.com${pathname}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'sessions-preview-control',
      'x-github-api-version': '2022-11-28',
      ...init.headers,
    },
  });
  if (!response.ok) fail(`GitHub API ${pathname} failed with ${response.status}`);
  return response.json();
}

async function assertSuccessfulSourceRun(runId, expectedSha) {
  const run = await github(`/repos/${repository}/actions/runs/${runId}`);
  if (run.id !== runId || run.event !== 'pull_request' || run.conclusion !== 'success'
    || run.head_sha !== expectedSha || run.repository?.full_name !== repository
    || run.name !== 'CI' || run.path !== '.github/workflows/ci.yml'
    || !run.pull_requests?.some((pull) => pull.number === pr)) {
    fail('source workflow run is not the successful CI run for this PR head');
  }
}

async function assertCurrentPullRequest(expectedSha) {
  const pull = await github(`/repos/${repository}/pulls/${pr}`);
  if (pull.state !== 'open') fail(`PR ${pr} is not open`);
  if (pull.head?.sha !== expectedSha) fail(`PR ${pr} head changed before preview control`);
  return pull;
}

async function mintOidc(audience) {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) fail('GitHub OIDC request environment is unavailable');
  const separator = requestUrl.includes('?') ? '&' : '?';
  const response = await fetch(`${requestUrl}${separator}audience=${encodeURIComponent(audience)}`, {
    headers: { authorization: `Bearer ${requestToken}` },
  });
  if (!response.ok) fail(`GitHub OIDC mint failed with ${response.status}`);
  const body = await response.json();
  if (typeof body.value !== 'string' || body.value.length < 100) fail('GitHub OIDC response has no assertion');
  return body.value;
}

async function frontDoor(method, pathname, audience, body, { allowMissing = false } = {}) {
  requireControlEnvironment();
  const token = await mintOidc(audience);
  const base = controlUrl.endsWith('/') ? controlUrl : `${controlUrl}/`;
  const response = await fetch(new URL(pathname.replace(/^\//, ''), base), {
    method,
    redirect: 'error',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : stableJson(body),
  });
  if (allowMissing && response.status === 404) return null;
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { fail(`front door returned non-JSON HTTP ${response.status}`); }
  if (!response.ok) fail(`front door ${pathname} rejected with ${response.status}: ${stableJson(parsed)}`);
  return parsed;
}

async function cf(pathname, init = {}) {
  requireControlEnvironment({ cloudflare: true });
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${previewAccountId}/${pathname}`, {
    ...init,
    redirect: 'error',
    headers: {
      authorization: `Bearer ${previewToken}`,
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (init.allowNotFound && response.status === 404) return null;
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { fail(`Cloudflare returned non-JSON HTTP ${response.status}`); }
  const notFoundEnvelope = init.allowNotFound
    && Array.isArray(parsed.errors)
    && parsed.errors.length > 0
    && parsed.errors.every((error) => /not found|does not exist/i.test(String(error?.message)));
  if (notFoundEnvelope) return null;
  if (!response.ok || parsed.success === false) {
    fail(`Cloudflare ${pathname} failed with ${response.status}: ${stableJson(parsed.errors ?? parsed)}`);
  }
  return parsed.result ?? parsed;
}

function inventoryItem(kind, id, name, generation) {
  const item = { kind, id: String(id), name, generation };
  return assertInventoryItem(item, pr, generation);
}

async function saveJournal(file, journal) {
  assertNoProductionIdentifiers(journal);
  await writeFile(file, `${stableJson(journal)}\n`, { encoding: 'utf8', flag: 'w', mode: 0o600 });
}

async function createResources(names, journalPath, journal, control) {
  const created = journal.resources;
  const record = async (item) => {
    if (!created.some((existing) => existing.kind === item.kind && existing.name === item.name)) {
      created.push(item);
      await saveJournal(journalPath, journal);
    }
    await frontDoor('POST', '/_control/record-resource', control.deployAudience, {
      pr,
      head: control.head,
      sourceRunId: control.sourceRunId,
      generation: names.generation,
      resource: item,
    });
    return item.id;
  };
  const create = async (kind, name, pathname, body, idFields) => {
    const existing = created.find((item) => item.kind === kind && item.name === name);
    if (existing) return existing.id;
    const discovered = await resolvePlannedId({ kind, id: null, name, generation: names.generation });
    if (discovered != null) {
      return record(inventoryItem(kind, discovered, name, names.generation));
    }
    const result = await cf(pathname, { method: 'POST', body: stableJson(body) });
    const id = idFields.map((field) => result?.[field]).find((value) => typeof value === 'string' && value.length > 0);
    if (!id) fail(`Cloudflare did not return an ID for ${kind} ${name}`);
    return record(inventoryItem(kind, id, name, names.generation));
  };
  const d1 = await create('d1', names.d1, 'd1/database', { name: names.d1 }, ['uuid', 'id']);
  const r2 = await create('r2', names.r2, 'r2/buckets', { name: names.r2 }, ['name']);
  const kv = await create('kv', names.kv, 'storage/kv/namespaces', { title: names.kv }, ['id']);
  const dlq = await create('queue', names.dlq, 'queues', { queue_name: names.dlq }, ['queue_id', 'id']);
  const queue = await create('queue', names.queue, 'queues', { queue_name: names.queue }, ['queue_id', 'id']);
  return { d1, r2, kv, dlq, queue };
}

function trustedChildEnvironment() {
  return trustedWranglerEnvironment(process.env, previewToken, previewAccountId);
}

function runJson(commandPath, commandArgs, cwd) {
  const result = spawnSync(process.execPath, [commandPath, ...commandArgs], {
    cwd,
    env: trustedChildEnvironment(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15 * 60 * 1000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`trusted command failed with exit ${result.status}: ${(result.stderr ?? result.stdout ?? '').trim().slice(-8000)}`);
  }
  const output = result.stdout.trim();
  try { return JSON.parse(output); } catch { fail(`trusted command did not emit one JSON object: ${output.slice(-2000)}`); }
}

function runWrangler(wrangler, commandArgs, cwd, operation) {
  const result = spawnSync(process.execPath, [wrangler, ...commandArgs], {
    cwd,
    env: trustedChildEnvironment(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15 * 60 * 1000,
  });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status !== 0) fail(`${operation} failed: ${output.trim().slice(-8000)}`);
  return output;
}

function workerVersionId(output) {
  const id = /(?:Worker|Current) Version ID:\s*([0-9a-f]{8}-[0-9a-f-]{27})/i.exec(output)?.[1];
  if (!id) fail('Wrangler did not return an immutable Worker Version ID');
  return id.toLowerCase();
}

function deployPrivateApp(wrangler, configPath, cwd) {
  const output = runWrangler(wrangler, [
    'deploy', '--config', configPath, '--no-bundle', '--strict',
  ], cwd, 'private app deployment');
  if (/Version Preview URL:|https:\/\/[^\s]+\.workers\.dev/i.test(output)) {
    fail('private app deployment unexpectedly exposed a public URL');
  }
  return { id: workerVersionId(output) };
}

function uploadWrapperVersion(wrangler, configPath, cwd) {
  const output = runWrangler(wrangler, [
    'versions', 'upload', '--config', configPath, '--no-bundle', '--strict',
  ], cwd, 'trusted wrapper version upload');
  const url = /Version Preview URL:\s*(https:\/\/[^\s]+\.workers\.dev)/i.exec(output)?.[1];
  if (!url) fail('Wrangler did not return an immutable wrapper Version Preview URL');
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== 'https:' || !parsedUrl.hostname.endsWith(PREVIEW_WORKERS_DEV_SUFFIX)) {
    fail('Wrangler returned an invalid wrapper version URL');
  }
  return { id: workerVersionId(output), url: parsedUrl.href };
}

function flattenTypedInventory(inventory) {
  if (!Array.isArray(inventory)) fail('deletion inventory must be an array');
  const resources = [];
  for (const entry of inventory) {
    if (Array.isArray(entry?.resources)) {
      for (const resource of entry.resources) {
        if (resource.generation !== entry.generation) fail('tuple/resource generation mismatch in deletion inventory');
        resources.push(resource);
      }
    } else {
      resources.push(entry);
    }
  }
  return resources;
}
function containsGenerationBinding(value, generation) {
  if (Array.isArray(value)) return value.some((item) => containsGenerationBinding(item, generation));
  if (!value || typeof value !== 'object') return false;
  if (value.name === 'PREVIEW_GENERATION' && (value.text === generation || value.value === generation)) return true;
  if (typeof value.service === 'string' && value.service.includes(`-${generation}-app`)) return true;
  return Object.values(value).some((item) => containsGenerationBinding(item, generation));
}

async function resolvePlannedId(item) {
  if (item.id != null) return item.id;
  let result;
  let rows;
  if (item.kind === 'r2') {
    result = await cf(`r2/buckets/${encodeURIComponent(item.name)}`, { allowNotFound: true });
    return result ? item.name : null;
  }
  if (item.kind === 'app-worker' || item.kind === 'edge-worker') {
    result = await cf(`workers/scripts/${encodeURIComponent(item.name)}/settings`, { allowNotFound: true });
    return result ? item.name : null;
  }
  if (item.kind === 'd1') {
    result = await cf(`d1/database?name=${encodeURIComponent(item.name)}`, { allowNotFound: true });
    rows = Array.isArray(result) ? result : result?.result ?? [];
    return rows.find((row) => row.name === item.name)?.uuid ?? null;
  }
  if (item.kind === 'kv') {
    result = await cf(`storage/kv/namespaces?title=${encodeURIComponent(item.name)}`, { allowNotFound: true });
    rows = Array.isArray(result) ? result : result?.result ?? [];
    return rows.find((row) => row.title === item.name)?.id ?? null;
  }
  if (item.kind === 'queue') {
    result = await cf('queues', { allowNotFound: true });
    rows = Array.isArray(result) ? result : result?.queues ?? result?.result ?? [];
    return rows.find((row) => row.queue_name === item.name)?.queue_id ?? null;
  }
  result = await cf(`workers/scripts/${encodeURIComponent(item.name)}/versions`, { allowNotFound: true });
  rows = Array.isArray(result) ? result : result?.items ?? result?.result ?? [];
  const matches = rows.filter((row) => containsGenerationBinding(row, item.generation));
  if (matches.length > 1) fail(`multiple Worker versions claim ${item.generation}`);
  return matches[0]?.id ?? null;
}

async function deleteInventory(inventory, ownerPr = pr) {
  const results = [];
  const sorted = sortCleanupInventory(inventory);
  for (const raw of sorted) {
    const generation = raw.generation;
    if (!/^g[1-9][0-9]*-[0-9a-f]{12}$/.test(generation ?? '')) {
      fail(`invalid inventory generation for ${raw.name}`);
    }
    const item = assertInventoryItem(raw, ownerPr, generation, { allowMissingId: true });
    if (workerScriptCoversVersion(item, inventory)) {
      results.push({
        kind: item.kind,
        id: item.id,
        name: item.name,
        generation: item.generation,
        deleted: true,
      });
      continue;
    }
    const resolvedId = await resolvePlannedId(item);
    if (resolvedId != null) {
      let endpoint;
      if (item.kind === 'd1') endpoint = `d1/database/${encodeURIComponent(resolvedId)}`;
      else if (item.kind === 'r2') endpoint = `r2/buckets/${encodeURIComponent(item.name)}`;
      else if (item.kind === 'kv') endpoint = `storage/kv/namespaces/${encodeURIComponent(resolvedId)}`;
      else if (item.kind === 'queue') endpoint = `queues/${encodeURIComponent(resolvedId)}`;
      else if (item.kind.endsWith('-version')) {
        endpoint = `workers/scripts/${encodeURIComponent(item.name)}/versions/${encodeURIComponent(resolvedId)}`;
      } else {
        if (resolvedId !== item.name) fail(`generation Worker recorded ID/name mismatch: ${item.name}`);
        endpoint = `workers/scripts/${encodeURIComponent(item.name)}`;
      }
      await cf(endpoint, { method: 'DELETE', allowNotFound: true });
    }
    results.push({
      kind: item.kind,
      id: item.id,
      name: item.name,
      generation: item.generation,
      deleted: true,
    });
  }
  return results;
}


async function state(audience, allowMissing = false) {
  return frontDoor('GET', `/_control/state?pr=${pr}`, audience, undefined, { allowMissing });
}

async function provision() {
  requireControlEnvironment({ cloudflare: true });
  const sha = headSha(args['head-sha']);
  const runId = positiveInteger(args['run-id'], 'build workflow run ID');
  const sourceRunId = positiveInteger(args['source-run-id'], 'source workflow run ID');
  const workflowRef = assertTrustedWorkflowRef(repository, args['workflow-ref']);
  const artifact = await verifyArtifact(args.artifact, {
    repository,
    pr,
    headSha: sha,
    sourceWorkflowRunId: sourceRunId,
    buildWorkflowRunId: runId,
    trustedWorkflowRef: workflowRef,
  });
  await assertSuccessfulSourceRun(sourceRunId, sha);
  await assertCurrentPullRequest(sha);
  const names = resourceNames(pr, sourceRunId, sha);
  const deployAudience = process.env.PREVIEW_CONTROL_DEPLOY_AUD;
  if (!deployAudience) fail('PREVIEW_CONTROL_DEPLOY_AUD is required');
  const prior = await state(deployAudience, true);
  const priorState = prior?.state ?? prior;
  if (priorState?.lifecycle === 'closed' || priorState?.status === 'closed' || priorState?.closed === true || priorState?.tombstone) {
    fail(`PR ${pr} has a permanent preview tombstone`);
  }
  const exactCandidate = candidateOf(priorState ?? {}, names.generation);
  if (exactCandidate) {
    if (exactCandidate.head !== sha
      || exactCandidate.artifactDigest !== artifact.provenance.artifactDigest
      || exactCandidate.buildInputDigest !== artifact.provenance.buildInputDigest) {
      fail(`recorded generation ${names.generation} does not match this artifact`);
    }
    const summary = {
      generation: names.generation,
      epoch: priorState.epoch,
      priorLiveGeneration: priorState.live?.generation ?? null,
      versionUrl: exactCandidate.versionUrl,
      artifactDigest: exactCandidate.artifactDigest,
      schemaDigest: exactCandidate.schemaDigest,
    };
    if (args['github-output']) {
      await appendFile(path.resolve(args['github-output']), [
        `generation=${summary.generation}`,
        `epoch=${summary.epoch}`,
        `prior_live_generation=${summary.priorLiveGeneration ?? ''}`,
        `artifact_digest=${summary.artifactDigest}`,
        `schema_digest=${summary.schemaDigest}`,
        '',
      ].join('\n'));
    }
    process.stdout.write(`${stableJson(summary)}\n`);
    return;
  }

  const journalPath = path.resolve(args.journal);
  const epoch = priorState?.epoch ?? 1;
  const planned = [
    { kind: 'd1', name: names.d1 },
    { kind: 'r2', name: names.r2 },
    { kind: 'kv', name: names.kv },
    { kind: 'queue', name: names.dlq },
    { kind: 'queue', name: names.queue },
    { kind: 'app-version', name: names.app },
    { kind: 'app-worker', name: names.app },
    { kind: 'edge-version', name: names.edge },
    { kind: 'edge-worker', name: names.edge },
  ];
  const proposedNonce = randomBytes(32).toString('base64url');
  const allocation = await frontDoor('POST', '/_control/begin-generation', deployAudience, {
    pr,
    epoch,
    head: sha,
    sourceRunId,
    generation: names.generation,
    artifactDigest: artifact.provenance.artifactDigest,
    buildInputDigest: artifact.provenance.buildInputDigest,
    environmentNonce: proposedNonce,
    planned,
  });
  const environmentNonce = allocation.environmentNonce ?? proposedNonce;
  const journal = {
    environmentNonce,
    schema: 'sessions-preview-control-journal/v1',
    repository,
    pr,
    headSha: sha,
    generation: names.generation,
    artifactDigest: artifact.provenance.artifactDigest,
    phase: 'planned',
    registered: false,
    resources: Array.isArray(allocation.recorded)
      ? allocation.recorded.map((item) => assertInventoryItem(item, pr, names.generation))
      : [],
  };
  await saveJournal(journalPath, journal);
  const temporary = path.join(os.tmpdir(), `sessions-preview-${pr}-${runId}`);
  await mkdir(temporary, { recursive: false });
  try {
    const resources = await createResources(names, journalPath, journal, { deployAudience, head: sha, sourceRunId });
    const assertions = {
      issuer: process.env.PREVIEW_ASSERTION_ISSUER,
      browserJwks: process.env.PREVIEW_BROWSER_ASSERTION_JWKS,
      actionJwks: process.env.PREVIEW_ACTION_ASSERTION_JWKS,
      originJwks: process.env.PREVIEW_ORIGIN_ASSERTION_JWKS,
    };
    const application = {
      assetSigningSecret: randomBytes(32).toString('base64url'),
      debugImportAssertionPublicJwk: process.env.DEBUG_IMPORT_ASSERTION_PUBLIC_JWK,
      debugExportManifestVerifyPublicJwk: process.env.DEBUG_EXPORT_MANIFEST_VERIFY_PUBLIC_JWK,
    };
    const configResources = {
      ...resources,
      pr,
      headSha: sha,
      buildInputDigest: artifact.provenance.buildInputDigest,
      environmentNonce,
      artifactDigest: artifact.provenance.artifactDigest,
      migrationDigest: artifact.provenance.migrationDigest,
    };
    const migrationDirectory = path.join(artifact.root, 'payload', 'migrations');
    let schemaDigest = allocation.schemaDigest;
    if (!schemaDigest) {
      const migrationConfigPath = path.join(temporary, 'wrangler.migrations.generated.json');
      await writeCanonicalJson(migrationConfigPath, generatedPrivateAppConfig({
        accountId: previewAccountId,
        main: path.join(artifact.root, 'payload', 'worker.mjs'),
        migrationsDir: migrationDirectory,
        names,
        resources: { ...configResources, schemaDigest: '0'.repeat(64) },
        assertions,
        application,
      }));
      journal.phase = 'migrating';
      const migrationJournalPath = `${journalPath}.${names.generation}.migrations.json`;
      journal.migrationJournalPath = migrationJournalPath;
      await saveJournal(journalPath, journal);
      const migration = runJson(path.resolve(args['migrations-cli']), [
        'apply', '--target', 'preview', '--config', migrationConfigPath, '--database', 'DB',
        '--journal', migrationJournalPath, '--artifact-digest', artifact.provenance.artifactDigest,
        '--deployment-id', names.generation,
        '--migrations-dir', migrationDirectory,
        '--manifest', path.join(migrationDirectory, 'manifest.json'),
        '--base-manifest', path.resolve(path.dirname(args['migrations-cli']), '..', 'migrations', 'manifest.json'),
      ], process.cwd());
      if (migration.pendingMigrations !== 0 || !/^[0-9a-f]{64}$/.test(migration.schemaDigest ?? '')) {
        fail('migration runner did not prove zero pending migrations and a schema digest');
      }
      if (migration.migrationDigest !== artifact.provenance.migrationDigest) {
        fail('applied migration digest differs from provenance');
      }
      schemaDigest = migration.schemaDigest;
    }
    journal.phase = 'uploading';
    journal.schemaDigest = schemaDigest;
    await saveJournal(journalPath, journal);

    const recordWorker = async (kind, id, name, extra = {}) => {
      const item = inventoryItem(kind, id, name, names.generation);
      if (!journal.resources.some((existing) => existing.kind === kind && existing.name === name)) {
        journal.resources.push(item);
        await saveJournal(journalPath, journal);
      }
      await frontDoor('POST', '/_control/record-resource', deployAudience, {
        pr,
        head: sha,
        sourceRunId,
        generation: names.generation,
        schemaDigest,
        resource: item,
        ...extra,
      });
      return item;
    };
    const wrangler = path.resolve(args.wrangler);
    let appVersion = journal.resources.find((item) => item.kind === 'app-version' && item.name === names.app);
    let appWorker = journal.resources.find((item) => item.kind === 'app-worker' && item.name === names.app);
    if (appVersion && !appWorker) {
      const id = await resolvePlannedId({
        kind: 'app-worker', id: null, name: names.app, generation: names.generation,
      });
      if (id) appWorker = await recordWorker('app-worker', id, names.app);
    }
    if (appWorker && !appVersion) {
      const id = await resolvePlannedId({
        kind: 'app-version', id: null, name: names.app, generation: names.generation,
      });
      if (id) appVersion = await recordWorker('app-version', id, names.app);
    }
    if (!appVersion || !appWorker) {
      const appConfigPath = path.join(temporary, 'wrangler.app.generated.json');
      await writeCanonicalJson(appConfigPath, generatedPrivateAppConfig({
        accountId: previewAccountId,
        main: path.join(artifact.root, 'payload', 'worker.mjs'),
        migrationsDir: migrationDirectory,
        names,
        resources: { ...configResources, schemaDigest },
        assertions,
        application,
      }));
      const deployed = deployPrivateApp(wrangler, appConfigPath, artifact.root);
      appVersion = await recordWorker('app-version', deployed.id, names.app);
      appWorker = await recordWorker('app-worker', names.app, names.app);
    }

    let edgeVersion = journal.resources.find((item) => item.kind === 'edge-version' && item.name === names.edge);
    let edgeWorker = journal.resources.find((item) => item.kind === 'edge-worker' && item.name === names.edge);
    let wrapperUrl = allocation.versionUrl;
    if (edgeVersion && !edgeWorker) {
      const id = await resolvePlannedId({
        kind: 'edge-worker', id: null, name: names.edge, generation: names.generation,
      });
      if (id) edgeWorker = await recordWorker('edge-worker', id, names.edge);
    }
    if (edgeWorker && !edgeVersion && wrapperUrl) {
      const id = await resolvePlannedId({
        kind: 'edge-version', id: null, name: names.edge, generation: names.generation,
      });
      if (id) edgeVersion = await recordWorker('edge-version', id, names.edge, { versionUrl: wrapperUrl });
    }
    if (!edgeVersion || !edgeWorker || !wrapperUrl) {
      const trustedRoot = path.resolve(args['trusted-root'] ?? '');
      const wrapperSource = path.join(trustedRoot, 'hub', 'gateway', 'preview-front-door.ts');
      await assertContainedRegularFile(trustedRoot, wrapperSource, 'trusted preview wrapper');
      const wrapperEntry = path.join(temporary, 'trusted-wrapper-entry.mjs');
      const wrapperImport = path.relative(temporary, wrapperSource).replaceAll('\\', '/');
      await writeFile(wrapperEntry, [
        `import { trustedPreviewIngress } from ${JSON.stringify(wrapperImport.startsWith('.') ? wrapperImport : `./${wrapperImport}`)};`,
        'export default { fetch: trustedPreviewIngress };',
        '',
      ].join('\n'), { encoding: 'utf8', flag: 'wx' });
      const wrapperOutput = path.join(temporary, 'wrangler-edge-output');
      const wrapperBuildConfigPath = path.join(temporary, 'wrangler.edge-build.generated.json');
      await writeCanonicalJson(wrapperBuildConfigPath, generatedTrustedWrapperConfig({
        accountId: previewAccountId,
        main: wrapperEntry,
        names,
        originJwks: assertions.originJwks,
      }));
      runWrangler(wrangler, [
        'deploy', '--dry-run', '--config', wrapperBuildConfigPath, '--outdir', wrapperOutput,
      ], trustedRoot, 'trusted wrapper build');
      const wrapperBundle = await wranglerWorkerBundle(wrapperOutput);
      const wrapperUploadConfigPath = path.join(temporary, 'wrangler.edge-upload.generated.json');
      await writeCanonicalJson(wrapperUploadConfigPath, generatedTrustedWrapperConfig({
        accountId: previewAccountId,
        main: wrapperBundle,
        names,
        originJwks: assertions.originJwks,
      }));
      if (!edgeWorker) {
        runWrangler(wrangler, [
          'deploy', '--config', wrapperUploadConfigPath, '--no-bundle', '--strict',
        ], trustedRoot, 'trusted wrapper initialization');
        edgeWorker = await recordWorker('edge-worker', names.edge, names.edge);
      }
      const uploaded = uploadWrapperVersion(wrangler, wrapperUploadConfigPath, trustedRoot);
      wrapperUrl = uploaded.url;
      edgeVersion = await recordWorker('edge-version', uploaded.id, names.edge, { versionUrl: wrapperUrl });
    }

    const response = await frontDoor('POST', '/_control/register', deployAudience, {
      pr,
      epoch,
      priorHead: priorState?.expectedHead ?? priorState?.head ?? priorState?.headSha ?? null,
      head: sha,
      sourceRunId,
      generation: names.generation,
      versionUrl: wrapperUrl,
      artifactDigest: artifact.provenance.artifactDigest,
      buildInputDigest: artifact.provenance.buildInputDigest,
      environmentNonce,
      schemaDigest,
      resources: journal.resources,
    });
    journal.phase = 'registered';
    journal.registered = true;
    journal.epoch = response.state?.epoch ?? response.epoch ?? epoch;
    journal.priorLiveGeneration = priorState?.live?.generation ?? null;
    journal.versionUrl = wrapperUrl;
    await saveJournal(journalPath, journal);
    const summary = {
      generation: names.generation,
      epoch: journal.epoch,
      priorLiveGeneration: journal.priorLiveGeneration,
      versionUrl: wrapperUrl,
      artifactDigest: artifact.provenance.artifactDigest,
      schemaDigest,
    };
    if (args['github-output']) {
      await appendFile(path.resolve(args['github-output']), [
        `generation=${summary.generation}`,
        `epoch=${summary.epoch}`,
        `prior_live_generation=${summary.priorLiveGeneration ?? ''}`,
        `artifact_digest=${summary.artifactDigest}`,
        `schema_digest=${summary.schemaDigest}`,
        '',
      ].join('\n'));
    }
    process.stdout.write(`${stableJson(summary)}\n`);
  } catch (error) {
    // The durable allocation ledger owns every recorded partial resource. Preserve it so an
    // exact workflow rerun can resume IDs and secrets; the alarm-backed janitor retires stale
    // unregistered generations after the recovery window.
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function candidateOf(stateRecord, generation) {
  const candidates = Array.isArray(stateRecord.candidates)
    ? stateRecord.candidates
    : Object.values(stateRecord.candidates ?? {});
  return candidates.find((item) => item?.generation === generation)
    ?? (stateRecord.candidate?.generation === generation ? stateRecord.candidate : null);
}

async function candidateAction({ accessHeaders, deployAudience, stateRecord, sha, sourceRunId, generation, method, target, body, headers = {}, purpose }) {
  const digest = body === undefined ? undefined : sha256Bytes(body);
  const grant = await frontDoor('POST', '/_control/smoke-route', deployAudience, {
    pr,
    epoch: stateRecord.epoch,
    head: sha,
    sourceRunId,
    generation,
    audience: 'preview-action',
    method,
    target,
    ...(digest ? { bodyDigest: digest } : {}),
    purpose,
    machineId: 'e2e-machine',
    isAdmin: false,
    expiresIn: 180,
  });
  const bootstrap = new URL(grant.bootstrapUrl);
  const origin = new URL(`https://pr-${pr}-preview.sessions.vza.net`);
  if (bootstrap.protocol !== 'https:' || bootstrap.origin !== origin.origin) fail('front door returned a foreign action bootstrap');
  const first = await fetch(bootstrap, {
    redirect: 'manual',
    headers: { ...accessHeaders, 'cache-control': 'no-store' },
  });
  const location = first.headers.get('location');
  const cookie = previewEdgeSessionCookie([
    ...(first.headers.getSetCookie?.() ?? []),
    first.headers.get('set-cookie'),
  ]);
  if (first.status < 300 || first.status >= 400 || !location || !cookie) {
    fail(`action bootstrap failed: status=${first.status}, location=${location ? 'present' : 'missing'}, sessionCookie=${cookie ? 'present' : 'missing'}`);
  }
  if (new URL(location, bootstrap).origin !== origin.origin) fail('action bootstrap redirected away from the preview host');
  return fetch(new URL(target, origin), {
    method,
    redirect: 'error',
    headers: { ...headers, ...accessHeaders, cookie, 'cache-control': 'no-store' },
    body,
  });
}

async function candidateContext() {
  requireControlEnvironment();
  const sha = headSha(args['head-sha']);
  const sourceRunId = positiveInteger(args['source-run-id'], 'source workflow run ID');
  const generation = args.generation;
  if (generation !== `g${sourceRunId}-${sha.slice(0, 12)}`) {
    fail('generation is not bound to the source run and head SHA');
  }
  await assertCurrentPullRequest(sha);
  const deployAudience = process.env.PREVIEW_CONTROL_DEPLOY_AUD;
  if (!deployAudience) fail('PREVIEW_CONTROL_DEPLOY_AUD is required');
  const current = await state(deployAudience);
  const stateRecord = current.state ?? current;
  const candidate = candidateOf(stateRecord, generation);
  if (!candidate) fail('candidate is not registered');
  return { sha, sourceRunId, generation, deployAudience, stateRecord, candidate };
}

async function smoke() {
  const accessHeaders = requiredCloudflareAccessHeaders();
  const context = await candidateContext();
  const response = await candidateAction({
    accessHeaders,
    ...context,
    method: 'GET',
    target: '/api/v1/preview/diagnostics',
    purpose: 'preview-smoke',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) fail(`candidate diagnostics smoke failed with ${response.status}`);
  const diagnostics = await response.json();
  const expectedArtifact = context.candidate.artifactDigest;
  const expectedSchema = context.candidate.schemaDigest;
  if (diagnostics.headSha !== context.sha
    || diagnostics.generation !== context.generation
    || diagnostics.artifactDigest !== expectedArtifact
    || diagnostics.schemaDigest !== expectedSchema) {
    fail('candidate diagnostics do not match the registered tuple');
  }
  const versionUrl = new URL(context.candidate.versionUrl);
  if (versionUrl.protocol !== 'https:' || !versionUrl.hostname.endsWith(PREVIEW_WORKERS_DEV_SUFFIX)) {
    fail('candidate tuple has an invalid immutable version URL');
  }
  const direct = await fetch(new URL('/api/v1/preview/diagnostics', versionUrl), { redirect: 'error', headers: { accept: 'application/json' } });
  if (![401, 403, 404].includes(direct.status)) fail(`direct Worker origin was not denied (${direct.status})`);
  const smokeDigest = sha256Bytes(stableJson({
    headSha: context.sha,
    generation: context.generation,
    artifactDigest: expectedArtifact,
    schemaDigest: expectedSchema,
    diagnostics,
    directOriginStatus: direct.status,
  }));
  await frontDoor('POST', '/_control/smoke-success', context.deployAudience, {
    pr,
    epoch: context.stateRecord.epoch,
    head: context.sha,
    sourceRunId: context.sourceRunId,
    generation: context.generation,
    smokeDigest,
  });
  process.stdout.write(`${stableJson({ generation: context.generation, smoke: 'passed', smokeDigest, artifactDigest: expectedArtifact, schemaDigest: expectedSchema })}\n`);
}

async function seed() {
  const accessHeaders = requiredCloudflareAccessHeaders();
  const context = await candidateContext();
  const fixtureRoot = new URL('../../hub/test/fixtures/local/', import.meta.url);
  const primary = await readFile(new URL('e2e-synthetic-session.jsonl', fixtureRoot));
  const pager = await readFile(new URL('e2e-pager-session.jsonl', fixtureRoot));
  const asset = Buffer.from((await readFile(new URL('fixture-external.png.base64', fixtureRoot), 'utf8')).trim(), 'base64');
  const externalDigest = '431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460';
  if (sha256Bytes(asset) !== externalDigest) fail('synthetic external asset digest does not match fixture contract');
  const primaryPath = '-workspace-e2e-fixtures/e2e-synthetic-session.jsonl';
  const uploads = [
    [`${primaryPath}.assets/${externalDigest}/fixture-external.png`, asset],
    [primaryPath, primary],
    ['-workspace-e2e-fixtures/e2e-pager-session.jsonl', pager],
  ];
  for (const [relative, bytes] of uploads) {
    const encoded = relative.split('/').map(encodeURIComponent).join('/');
    const target = `/api/v1/files/e2e-machine/claude-projects/${encoded}`;
    const response = await candidateAction({
      accessHeaders,
      ...context,
      method: 'PUT',
      target,
      body: bytes,
      purpose: 'preview-synthetic-seed',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.length),
        'x-content-hash': `sha256:${sha256Bytes(bytes)}`,
        'x-file-mtime': '2026-07-01T00:00:00.000Z',
      },
    });
    if (response.status !== 200 && response.status !== 201) {
      fail(`synthetic candidate upload failed with ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
  }
  const expected = [
    ['e2e-synthetic-session', 'saffron telescope'],
    ['e2e-pager-session', 'machine filtered pagination'],
  ];
  for (const [sessionId, marker] of expected) {
    const deadline = Date.now() + 60_000;
    let last = '';
    let indexed = false;
    while (Date.now() < deadline) {
      const query = new URLSearchParams({ q: marker, machine: 'e2e-machine', limit: '20' });
      const response = await candidateAction({
        accessHeaders,
        ...context,
        method: 'GET',
        target: `/api/v1/search?${query}`,
        purpose: 'preview-synthetic-seed-probe',
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
    if (!indexed) fail(`synthetic session ${sessionId} was not indexed: ${last.slice(0, 500)}`);
  }
  process.stdout.write(`${stableJson({ generation: context.generation, seeded: ['e2e-synthetic-session', 'e2e-pager-session'] })}\n`);
}

async function browserGrant() {
  const context = await candidateContext();
  const grant = await frontDoor('POST', '/_control/grant', context.deployAudience, {
    pr,
    epoch: context.stateRecord.epoch,
    head: context.sha,
    sourceRunId: context.sourceRunId,
    generation: context.generation,
    audience: 'preview-browser',
    method: 'GET',
    target: '/',
    expiresIn: 300,
  });
  const bootstrap = new URL(grant.bootstrapUrl);
  const expectedOrigin = `https://pr-${pr}-preview.sessions.vza.net`;
  if (bootstrap.protocol !== 'https:' || bootstrap.origin !== expectedOrigin || bootstrap.username || bootstrap.password) {
    fail('front door returned an invalid browser bootstrap URL');
  }
  await writeFile(path.resolve(args.output ?? ''), `${stableJson({ bootstrapUrl: bootstrap.href })}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}
async function promote() {

  const context = await candidateContext();
  const candidateHead = context.candidate.head ?? context.candidate.headSha;
  if (candidateHead !== context.sha) fail('candidate is no longer current for this head');
  const response = await frontDoor('POST', '/_control/promote', context.deployAudience, {
    pr,
    epoch: context.stateRecord.epoch,
    head: context.sha,
    sourceRunId: context.sourceRunId,
    generation: context.generation,
    priorLiveGeneration: context.stateRecord.live?.generation ?? null,
  });
  process.stdout.write(`${stableJson(response)}\n`);
}

async function closePreview() {
  requireControlEnvironment({ cloudflare: true });
  const sha = headSha(args['head-sha']);
  const closeAudience = process.env.PREVIEW_CONTROL_CLOSE_AUD;
  if (!closeAudience) fail('PREVIEW_CONTROL_CLOSE_AUD is required');
  const current = await frontDoor('GET', `/_control/close-state?pr=${pr}`, closeAudience, undefined, { allowMissing: true });
  const stateRecord = current?.state ?? current;
  const closeHead = stateRecord?.expectedHead ?? stateRecord?.head ?? stateRecord?.headSha ?? sha;
  const response = await frontDoor('POST', '/_control/close', closeAudience, {
    pr,
    epoch: stateRecord?.epoch ?? 1,
    head: closeHead,
  });
  const inventory = response.inventory ?? response.state?.inventory ?? [];
  if (!Array.isArray(inventory)) fail('close did not return typed deletion inventory');
  const deleted = await deleteInventory(flattenTypedInventory(inventory));
  const closedState = response.state ?? response;
  await frontDoor('POST', '/_control/close-ack', closeAudience, {
    pr,
    epoch: closedState.epoch,
    head: closedState.expectedHead ?? closeHead,
    deleted: acknowledgedResources(deleted),
  });
  process.stdout.write(`${stableJson({ tombstone: true, deleted })}\n`);
}

async function cleanupJournal() {
  requireControlEnvironment({ cloudflare: true });
  let journal;
  try {
    journal = await readCanonicalJson(path.resolve(args.journal));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    process.stdout.write(`${stableJson({ skipped: 'no-journal' })}\n`);
    return;
  }
  if (journal.schema !== 'sessions-preview-control-journal/v1' || journal.pr !== pr) fail('invalid cleanup journal');
  if (journal.registered) {
    process.stdout.write(`${stableJson({ skipped: 'registered-candidate' })}\n`);
    return;
  }
  process.stdout.write(`${stableJson({
    skipped: 'tracked-partial-generation',
    generation: journal.generation,
  })}\n`);
}

async function janitor() {
  requireControlEnvironment({ cloudflare: true });
  const janitorAudience = process.env.PREVIEW_CONTROL_JANITOR_AUD;
  if (!janitorAudience) fail('PREVIEW_CONTROL_JANITOR_AUD is required');
  const registry = await frontDoor('GET', '/_control/list', janitorAudience);
  if (!Array.isArray(registry.states)) fail('janitor registry did not return trusted states');
  const summaries = [];
  const now = Date.now();
  for (const entry of registry.states) {
    const ownerPr = positiveInteger(entry.pr, 'janitor state PR');
    const stateRecord = entry.state ?? {};
    if (typeof stateRecord !== 'object' || Array.isArray(stateRecord)) fail(`invalid janitor state for PR ${ownerPr}`);
    const allocations = entry.allocations ?? [];
    if (!Array.isArray(allocations)) fail(`invalid allocation ledger for PR ${ownerPr}`);
    const protectedGenerations = new Set([
      stateRecord.live?.generation,
      stateRecord.rollback?.generation,
    ].filter(Boolean));
    const deletable = new Set(stateRecord.deletionGenerations ?? []);
    for (const candidate of Array.isArray(stateRecord.candidates) ? stateRecord.candidates : Object.values(stateRecord.candidates ?? {})) {
      const createdValue = candidate.createdAt ?? candidate.created_at;
      const created = typeof createdValue === 'number' ? createdValue : Date.parse(createdValue ?? '');
      if (!protectedGenerations.has(candidate.generation) && Number.isFinite(created) && now - created >= 24 * 60 * 60 * 1000) {
        deletable.add(candidate.generation);
      }
    }
    for (const tuple of stateRecord.deletionInventory ?? []) {
      if (tuple?.generation && !protectedGenerations.has(tuple.generation)) {
        deletable.add(tuple.generation);
      }
    }
    const closed = stateRecord.lifecycle === 'closed' || stateRecord.status === 'closed' || stateRecord.closed === true || Boolean(stateRecord.tombstone);
    for (const allocation of allocations) {
      if (!/^g[1-9][0-9]*-[0-9a-f]{12}$/.test(allocation.generation ?? '')) {
        fail(`invalid partial allocation generation for PR ${ownerPr}`);
      }
      const createdValue = allocation.createdAt ?? allocation.created_at;
      const created = typeof createdValue === 'number' ? createdValue : Date.parse(createdValue ?? '');
      if (!protectedGenerations.has(allocation.generation)
        && (closed || Number.isFinite(created) && now - created >= 24 * 60 * 60 * 1000)) {
        deletable.add(allocation.generation);
      }
    }
    if (closed) {
      for (const generation of inventoryGenerations(stateRecord.inventory ?? [])) {
        if (!protectedGenerations.has(generation)) deletable.add(generation);
      }
    }
    if (deletable.size === 0 && !closed) {
      summaries.push({ pr: ownerPr, deleteGenerations: [], deleted: [] });
      continue;
    }
    const latestAllocation = allocations.at(-1);
    const janitorHead = stateRecord.expectedHead ?? stateRecord.head ?? stateRecord.headSha ?? latestAllocation?.head;
    if (!/^[0-9a-f]{40}$/.test(janitorHead ?? '')) fail(`janitor state has no valid head for PR ${ownerPr}`);
    const response = await frontDoor('POST', '/_control/janitor', janitorAudience, {
      pr: ownerPr,
      epoch: stateRecord.epoch ?? latestAllocation?.epoch ?? 1,
      head: janitorHead,
      deleteGenerations: [...deletable].sort(),
    });
    const inventory = response.inventory ?? [];
    if (!Array.isArray(inventory)) fail(`janitor did not return typed deletion inventory for PR ${ownerPr}`);
    const deleted = await deleteInventory(flattenTypedInventory(inventory), ownerPr);
    const nextState = response.state ?? response;
    await frontDoor('POST', '/_control/janitor-ack', janitorAudience, {
      pr: ownerPr,
      epoch: nextState.epoch,
      head: nextState.expectedHead ?? janitorHead,
      deleted: acknowledgedResources(deleted),
    });
    summaries.push({ pr: ownerPr, deleteGenerations: [...deletable].sort(), deleted });
  }
  process.stdout.write(`${stableJson({ states: summaries })}\n`);
}

if (command === 'provision') await provision();
else if (command === 'seed') await seed();
else if (command === 'smoke') await smoke();
else if (command === 'browser-grant') await browserGrant();
else if (command === 'promote') await promote();
else if (command === 'close') await closePreview();
else if (command === 'cleanup-journal') await cleanupJournal();
else if (command === 'janitor') await janitor();
else fail(`unknown preview-control command: ${command ?? '<none>'}`);
