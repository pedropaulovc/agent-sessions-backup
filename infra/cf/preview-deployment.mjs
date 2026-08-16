import {
  fail,
  headSha,
  positiveInteger,
  repositoryName,
  resourceNames,
  stableJson,
} from './preview-trust.mjs';

const DEPLOYMENTS_PAGE_SIZE = 100;
const MAX_DEPLOYMENT_PAGES = 1_000;

function deploymentContext({ repository, pr }) {
  return {
    repository: repositoryName(repository),
    pr: positiveInteger(pr, 'PR number'),
  };
}

function previewContext({ sha, sourceRunId, runId, ...values }) {
  return {
    ...deploymentContext(values),
    sha: headSha(sha),
    sourceRunId: positiveInteger(sourceRunId, 'source workflow run ID'),
    runId: positiveInteger(runId, 'controller workflow run ID'),
  };
}

function githubRunUrl(repository, runId) {
  return `https://github.com/${repository}/actions/runs/${runId}`;
}

function optionalHttpsUrl(value, name) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length === 0) fail(`${name} must be a non-empty HTTPS URL`);
  let url;
  try { url = new URL(value); } catch { fail(`${name} must be a valid HTTPS URL`); }
  if (url.protocol !== 'https:') fail(`${name} must be a valid HTTPS URL`);
  return value;
}

function deploymentId(value) {
  return positiveInteger(value, 'GitHub deployment ID');
}

function assertRequest(request) {
  if (typeof request !== 'function') fail('GitHub request function is required');
  return request;
}

function optionalCreatedCallback(callback) {
  if (callback == null) return null;
  if (typeof callback !== 'function') fail('preview deployment created callback must be a function');
  return callback;
}

function assertVerify(verify) {
  if (typeof verify !== 'function') fail('preview deployment verification function is required');
  return verify;
}

function postJson(body) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: stableJson(body),
    expectedStatus: 201,
  };
}

function completionDescription(outcome) {
  if (outcome === 'success') return 'Preview deployed and passed remote smoke tests';
  if (outcome === 'failure') return 'Preview provisioned, but remote smoke tests failed';
  fail('preview deployment outcome must be success or failure');
}

export function previewDeploymentEnvironment(pr) {
  return `preview/pr-${positiveInteger(pr, 'PR number')}`;
}

function previewUrl(pr) {
  return `https://${resourceNames(pr).host}`;
}

async function postDeploymentStatus(request, context, id, state, description, options = {}) {
  const body = {
    state,
    environment: previewDeploymentEnvironment(context.pr),
    description,
    auto_inactive: false,
  };
  if (options.environmentUrl) body.environment_url = optionalHttpsUrl(options.environmentUrl, 'environment URL');
  if (options.logUrl) body.log_url = optionalHttpsUrl(options.logUrl, 'log URL');
  const response = await request(
    `/repos/${context.repository}/deployments/${deploymentId(id)}/statuses`,
    postJson(body),
  );
  if (response?.state !== state) fail(`GitHub deployment status did not report ${state}`);
  return response;
}

async function listPreviewDeployments(request, context) {
  const environment = previewDeploymentEnvironment(context.pr);
  const deployments = [];
  for (let page = 1; page <= MAX_DEPLOYMENT_PAGES; page += 1) {
    const query = new URLSearchParams({
      environment,
      per_page: String(DEPLOYMENTS_PAGE_SIZE),
      page: String(page),
    });
    const rows = await request(`/repos/${context.repository}/deployments?${query}`);
    if (!Array.isArray(rows)) fail('GitHub deployment list response must be an array');
    deployments.push(...rows);
    if (rows.length < DEPLOYMENTS_PAGE_SIZE) return deployments;
  }
  fail(`GitHub deployment list exceeded ${MAX_DEPLOYMENT_PAGES} pages`);
}

function deploymentOrder(deployment) {
  const id = deploymentId(deployment?.id);
  const createdAt = Date.parse(deployment?.created_at ?? '');
  if (!Number.isFinite(createdAt)) fail('GitHub deployment created_at must be an ISO timestamp');
  return { id, createdAt };
}

function precedesDeployment(candidate, current) {
  return candidate.createdAt < current.createdAt
    || (candidate.createdAt === current.createdAt && candidate.id < current.id);
}

/**
 * Create an immutable deployment card for a provisioned PR preview, then expose the stable
 * workers.dev URL while remote smoke is still running. The caller receives the deployment ID
 * before the in-progress status write so a later terminalizer can recover a failed status call.
 * Each verification immediately precedes its write: a stale trusted workflow must never
 * decorate a newer PR head.
 */
export async function createPreviewDeployment({ request, verify, onCreated = null, ...values }) {
  const context = previewContext(values);
  const github = assertRequest(request);
  const verifyCurrent = assertVerify(verify);
  const recordCreated = optionalCreatedCallback(onCreated);
  const environment = previewDeploymentEnvironment(context.pr);
  const url = previewUrl(context.pr);
  const logUrl = githubRunUrl(context.repository, context.runId);

  await verifyCurrent();
  const deployment = await github(`/repos/${context.repository}/deployments`, postJson({
    ref: context.sha,
    task: 'deploy',
    auto_merge: false,
    required_contexts: [],
    environment,
    description: `Cloudflare preview for PR #${context.pr}`,
    transient_environment: true,
    production_environment: false,
    payload: {
      pr: context.pr,
      source_run_id: context.sourceRunId,
      controller_run_id: context.runId,
    },
  }));
  const id = deploymentId(deployment?.id);
  if (recordCreated) await recordCreated({ deploymentId: id, environment, url });

  await verifyCurrent();
  await postDeploymentStatus(github, context, id, 'in_progress', 'Preview provisioned; remote smoke tests running', {
    environmentUrl: url,
    logUrl,
  });

  return { deploymentId: id, environment, url };
}

/**
 * Complete a deployment card after smoke. Every terminal result inactivates older transient
 * cards for this PR because GitHub's automatic inactivity excludes transient environments.
 */
export async function completePreviewDeployment({ request, verify, deploymentId: id, outcome, ...values }) {
  const context = previewContext(values);
  const github = assertRequest(request);
  const verifyCurrent = assertVerify(verify);
  const currentDeploymentId = deploymentId(id);
  const url = previewUrl(context.pr);
  const logUrl = githubRunUrl(context.repository, context.runId);
  const description = completionDescription(outcome);

  await verifyCurrent();
  await postDeploymentStatus(github, context, currentDeploymentId, outcome, description, {
    environmentUrl: url,
    logUrl,
  });

  const inactiveDeploymentIds = await deactivatePreviewDeployments({
    request: github,
    verify: verifyCurrent,
    ...context,
    exceptDeploymentId: currentDeploymentId,
    description: 'Superseded by a newer preview attempt',
    logUrl,
  });
  return { deploymentId: currentDeploymentId, outcome, inactiveDeploymentIds, url };
}

/**
 * Mark matching transient cards inactive after their stable preview was removed. When a current
 * card is supplied, only strictly older cards are eligible; a same-SHA re-run must not retire a
 * newer in-progress card.
 */
export async function deactivatePreviewDeployments({
  request,
  verify,
  exceptDeploymentId = null,
  description = 'Preview environment removed',
  logUrl = null,
  ...values
}) {
  const context = deploymentContext(values);
  const github = assertRequest(request);
  const verifyCurrent = verify == null ? null : assertVerify(verify);
  const excluded = exceptDeploymentId == null ? null : deploymentId(exceptDeploymentId);
  const deploymentLogUrl = optionalHttpsUrl(logUrl, 'log URL');
  const deployments = await listPreviewDeployments(github, context);
  const current = excluded == null
    ? null
    : deployments.find((deployment) => deploymentId(deployment?.id) === excluded);
  if (excluded != null && current == null) fail('GitHub deployment list omitted the current deployment');
  const currentOrder = current == null ? null : deploymentOrder(current);
  const inactiveDeploymentIds = [];

  for (const deployment of deployments) {
    const id = deploymentId(deployment?.id);
    if (id === excluded) continue;
    if (currentOrder && !precedesDeployment(deploymentOrder(deployment), currentOrder)) continue;
    if (verifyCurrent) await verifyCurrent();
    await postDeploymentStatus(github, context, id, 'inactive', description, { logUrl: deploymentLogUrl });
    inactiveDeploymentIds.push(id);
  }
  return inactiveDeploymentIds;
}
