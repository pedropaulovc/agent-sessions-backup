import {
  fail,
  positiveInteger,
  repositoryName,
  stableJson,
} from './preview-trust.mjs';

/**
 * Preview deployment cards are GitHub's, not ours. The preview job declares
 * `environment: preview/pr-<n>`, so Actions opens the deployment when the job starts and closes
 * it with the job's own conclusion — the card can never claim a state the workflow is not in.
 *
 * The one thing a job conclusion cannot express is REMOVAL: close and the janitor delete the
 * Cloudflare resources long after the run that created them ended, and the card would otherwise
 * keep advertising a URL that now 404s. Retiring those cards is all this module does.
 */

const DEPLOYMENTS_PAGE_SIZE = 100;
const MAX_DEPLOYMENT_PAGES = 1_000;

export function previewDeploymentEnvironment(pr) {
  return `preview/pr-${positiveInteger(pr, 'PR number')}`;
}

function deploymentContext({ repository, pr }) {
  return {
    repository: repositoryName(repository),
    pr: positiveInteger(pr, 'PR number'),
  };
}

function deploymentId(value) {
  return positiveInteger(value, 'GitHub deployment ID');
}

function optionalHttpsUrl(value, name) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length === 0) fail(`${name} must be a non-empty HTTPS URL`);
  let url;
  try { url = new URL(value); } catch { fail(`${name} must be a valid HTTPS URL`); }
  if (url.protocol !== 'https:') fail(`${name} must be a valid HTTPS URL`);
  return value;
}

async function postDeploymentStatus(request, context, id, state, description, logUrl) {
  const body = {
    state,
    environment: previewDeploymentEnvironment(context.pr),
    description,
    auto_inactive: false,
  };
  if (logUrl) body.log_url = logUrl;
  const response = await request(
    `/repos/${context.repository}/deployments/${deploymentId(id)}/statuses`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stableJson(body),
      expectedStatus: 201,
    },
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

/**
 * Mark every card in a PR's preview environment inactive, after its Cloudflare resources were
 * removed. Every page is walked: a first-page-only read leaves older cards advertising a URL
 * that no longer resolves.
 */
export async function deactivatePreviewDeployments({
  request,
  description = 'Preview environment removed',
  logUrl = null,
  ...values
}) {
  if (typeof request !== 'function') fail('GitHub request function is required');
  const context = deploymentContext(values);
  const deploymentLogUrl = optionalHttpsUrl(logUrl, 'log URL');
  const inactiveDeploymentIds = [];
  for (const deployment of await listPreviewDeployments(request, context)) {
    const id = deploymentId(deployment?.id);
    await postDeploymentStatus(request, context, id, 'inactive', description, deploymentLogUrl);
    inactiveDeploymentIds.push(id);
  }
  return inactiveDeploymentIds;
}
