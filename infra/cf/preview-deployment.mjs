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
const PREVIEW_ANNOUNCEMENT_SCHEMA = 'sessions-preview-announcement/v1';
const PREVIEW_QUEUE_TASK = 'preview-announce';
const PREVIEW_RESET_TASK = 'preview-reset';

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

function announcementContext({ sha, announcementRunId, workflowRef, ...values }) {
  if (typeof workflowRef !== 'string' || workflowRef.length === 0) {
    fail('preview announcement workflow ref is required');
  }
  return {
    ...deploymentContext(values),
    sha: headSha(sha),
    announcementRunId: positiveInteger(announcementRunId, 'preview announcement workflow run ID'),
    workflowRef,
  };
}

function announcementSearchContext({ sha, ...values }) {
  return {
    ...deploymentContext(values),
    sha: headSha(sha),
  };
}

function expectedAnnouncementWorkflowRef(repository, task) {
  const name = repositoryName(repository);
  if (task === PREVIEW_QUEUE_TASK) {
    return `${name}/.github/workflows/preview-queue.yml@refs/heads/main`;
  }
  if (task === PREVIEW_RESET_TASK) {
    return `${name}/.github/workflows/preview-close.yml@refs/heads/main`;
  }
  return null;
}

function announcementTask(repository, workflowRef) {
  for (const task of [PREVIEW_QUEUE_TASK, PREVIEW_RESET_TASK]) {
    if (workflowRef === expectedAnnouncementWorkflowRef(repository, task)) return task;
  }
  fail('preview announcement must originate from a trusted queue or reset workflow');
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

function optionalCallback(callback, name) {
  if (callback == null) return null;
  if (typeof callback !== 'function') fail(`${name} must be a function`);
  return callback;
}

function assertVerify(verify, name = 'preview deployment verification function') {
  if (typeof verify !== 'function') fail(`${name} is required`);
  return verify;
}

function positiveAttemptCount(value) {
  return positiveInteger(value, 'preview deployment claim attempts');
}

function postJson(body) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: stableJson(body),
    expectedStatus: 201,
  };
}

function completionDetails(outcome, url) {
  if (outcome === 'success') {
    return { state: 'success', description: 'Preview deployed and passed remote smoke tests', environmentUrl: url };
  }
  if (outcome === 'provision-failure') {
    return { state: 'failure', description: 'Preview provisioning failed', environmentUrl: null };
  }
  if (outcome === 'provision-cancelled') {
    return { state: 'error', description: 'Preview provisioning was cancelled', environmentUrl: null };
  }
  if (outcome === 'provision-skipped') {
    return { state: 'inactive', description: 'Preview provisioning was skipped', environmentUrl: null };
  }
  if (outcome === 'smoke-failure') {
    return { state: 'failure', description: 'Preview provisioned, but remote smoke tests failed', environmentUrl: url };
  }
  if (outcome === 'smoke-cancelled') {
    return { state: 'error', description: 'Preview provisioned, but remote smoke tests were cancelled', environmentUrl: url };
  }
  if (outcome === 'smoke-skipped') {
    return { state: 'error', description: 'Preview provisioned, but remote smoke tests were skipped', environmentUrl: url };
  }
  fail('preview deployment outcome is invalid');
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

async function listDeploymentStatuses(request, context, id) {
  const statuses = [];
  for (let page = 1; page <= MAX_DEPLOYMENT_PAGES; page += 1) {
    const query = new URLSearchParams({
      per_page: String(DEPLOYMENTS_PAGE_SIZE),
      page: String(page),
    });
    const rows = await request(
      `/repos/${context.repository}/deployments/${deploymentId(id)}/statuses?${query}`,
    );
    if (!Array.isArray(rows)) fail('GitHub deployment status list response must be an array');
    statuses.push(...rows);
    if (rows.length < DEPLOYMENTS_PAGE_SIZE) return statuses;
  }
  fail(`GitHub deployment status list exceeded ${MAX_DEPLOYMENT_PAGES} pages`);
}

function deploymentOrder(deployment) {
  const id = deploymentId(deployment?.id);
  const createdAt = Date.parse(deployment?.created_at ?? '');
  if (!Number.isFinite(createdAt)) fail('GitHub deployment created_at must be an ISO timestamp');
  return { id, createdAt };
}

function statusOrder(status) {
  const id = positiveInteger(status?.id, 'GitHub deployment status ID');
  const createdAt = Date.parse(status?.created_at ?? '');
  if (!Number.isFinite(createdAt)) fail('GitHub deployment status created_at must be an ISO timestamp');
  return { id, createdAt };
}

function precedes(left, right) {
  return left.createdAt < right.createdAt
    || (left.createdAt === right.createdAt && left.id < right.id);
}

function newest(rows, order) {
  let result = null;
  for (const row of rows) {
    if (result == null || precedes(order(result), order(row))) result = row;
  }
  return result;
}

function announcementPayload(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (value == null || Array.isArray(value) || typeof value !== 'object') return null;
  return value;
}

function exactAnnouncement(deployment, context) {
  try {
    const task = deployment?.task;
    const expectedWorkflowRef = expectedAnnouncementWorkflowRef(context.repository, task);
    if (expectedWorkflowRef == null
      || deployment?.environment !== previewDeploymentEnvironment(context.pr)
      || deployment?.ref !== context.sha
      || deployment?.sha !== context.sha
      || deployment?.transient_environment !== true
      || deployment?.production_environment !== false) {
      return null;
    }
    const payload = announcementPayload(deployment.payload);
    if (payload?.schema !== PREVIEW_ANNOUNCEMENT_SCHEMA
      || payload.pr !== context.pr
      || payload.head_sha !== context.sha
      || payload.announcement_workflow_ref !== expectedWorkflowRef) {
      return null;
    }
    return {
      deployment,
      deploymentId: deploymentId(deployment.id),
      order: deploymentOrder(deployment),
      task,
      announcementRunId: positiveInteger(
        payload.announcement_run_id,
        'preview announcement workflow run ID',
      ),
    };
  } catch {
    return null;
  }
}

async function matchedAnnouncements({ request, verifyAnnouncement, ...values }) {
  const context = announcementSearchContext(values);
  const github = assertRequest(request);
  const verify = assertVerify(verifyAnnouncement, 'preview announcement verification function');
  const matches = [];
  for (const deployment of await listPreviewDeployments(github, context)) {
    const candidate = exactAnnouncement(deployment, context);
    if (candidate == null) continue;
    await verify(candidate.announcementRunId, candidate.task);
    const statuses = await listDeploymentStatuses(github, context, candidate.deploymentId);
    const status = newest(statuses, statusOrder);
    matches.push({
      ...candidate,
      state: status?.state ?? null,
      statusLogUrl: typeof status?.log_url === 'string' ? status.log_url : null,
    });
  }
  return matches.sort((left, right) => {
    if (precedes(left.order, right.order)) return 1;
    if (precedes(right.order, left.order)) return -1;
    return 0;
  });
}

function claimableAnnouncement(matches) {
  const [latest] = matches;
  if (latest == null) return null;
  // A later successful CI for the same immutable SHA may resume a failure/error card when its
  // direct queue event did not create a newer one. `inactive` is permanent retirement: close,
  // stale-head, and duplicate cleanup must never be revived.
  if (latest.state == null
    || latest.state === 'queued'
    || latest.state === 'failure'
    || latest.state === 'success'
    || latest.state === 'in_progress'
    || latest.state === 'error'
    || latest.state === 'pending'
    || latest.state === 'waiting') {
    return latest;
  }
  return null;
}

async function waitForRetry(wait, attempt, attempts) {
  if (attempt === attempts) return;
  await wait(attempt, attempts);
}

/**
 * Create a transient, PR-SHA deployment for either the direct PR queue or an explicit reset.
 * Its queued state is a synchronization point: the credential-bearing workflow_run controller
 * may claim a card only after this write.
 */
export async function queuePreviewDeployment({ request, verify, onCreated = null, ...values }) {
  const context = announcementContext(values);
  const github = assertRequest(request);
  const verifyCurrent = assertVerify(verify);
  const recordCreated = optionalCallback(onCreated, 'preview deployment created callback');
  const environment = previewDeploymentEnvironment(context.pr);
  const url = null;
  const task = announcementTask(context.repository, context.workflowRef);
  const description = task === PREVIEW_QUEUE_TASK
    ? `Preview queued for PR #${context.pr}`
    : `Preview reset queued for PR #${context.pr}`;
  const logUrl = githubRunUrl(context.repository, context.announcementRunId);

  await verifyCurrent();
  const deployment = await github(`/repos/${context.repository}/deployments`, postJson({
    ref: context.sha,
    task,
    auto_merge: false,
    required_contexts: [],
    environment,
    description,
    transient_environment: true,
    production_environment: false,
    payload: {
      schema: PREVIEW_ANNOUNCEMENT_SCHEMA,
      pr: context.pr,
      head_sha: context.sha,
      announcement_run_id: context.announcementRunId,
      announcement_workflow_ref: context.workflowRef,
    },
  }));
  const id = deploymentId(deployment?.id);
  if (recordCreated) await recordCreated({ deploymentId: id, environment, url });

  await verifyCurrent();
  await postDeploymentStatus(github, context, id, 'queued', 'Preview is queued until CI completes', { logUrl });
  await verifyCurrent();
  return { deploymentId: id, environment, url };
}


/**
 * Read one visible card only after its trusted announcement provenance has been verified.
 */
export async function findPreviewAnnouncement({
  request,
  verifyAnnouncement,
  deploymentId: id,
  ...values
}) {
  const context = announcementSearchContext(values);
  const targetId = deploymentId(id);
  const card = (await matchedAnnouncements({
    request: assertRequest(request),
    verifyAnnouncement: assertVerify(
      verifyAnnouncement,
      'preview announcement verification function',
    ),
    ...context,
  })).find((candidate) => candidate.deploymentId === targetId);
  if (card == null) return null;
  return {
    deploymentId: card.deploymentId,
    state: card.state,
    announcementRunId: card.announcementRunId,
    task: card.task,
  };
}

/**
 * Wait for the controller to resolve the exact card published by a trusted queue run.
 * If duplicate cleanup retires that card, wait for its same-SHA queue replacement instead.
 * A successful queue must mean that its visible PR deployment is usable, rather than
 * merely that the controller was scheduled.
 */
export async function awaitQueuedPreviewDeployment({
  request,
  verify,
  verifyAnnouncement,
  deploymentId: id,
  attempts = 1,
  wait = async () => {},
  ...values
}) {
  const context = announcementContext(values);
  const github = assertRequest(request);
  const verifyCurrent = assertVerify(verify);
  const verifyQueuedAnnouncement = assertVerify(
    verifyAnnouncement,
    'preview announcement verification function',
  );
  const targetId = deploymentId(id);
  const completionAttempts = positiveAttemptCount(attempts);
  const waitForCompletion = optionalCallback(wait, 'preview deployment completion wait callback');
  const task = announcementTask(context.repository, context.workflowRef);
  let found = false;
  let lastState = null;

  for (let attempt = 1; attempt <= completionAttempts; attempt += 1) {
    await verifyCurrent();
    const cards = await matchedAnnouncements({
      request: github,
      verifyAnnouncement: verifyQueuedAnnouncement,
      ...announcementSearchContext(context),
    });
    const card = cards.find((candidate) => candidate.deploymentId === targetId);
    if (card != null) {
      found = true;
      if (card.task !== task || card.announcementRunId !== context.announcementRunId) {
        fail('preview deployment card does not belong to this queue run');
      }
      let outcome = card;
      if (card.state === 'inactive') {
        const replacement = cards.find((candidate) =>
          candidate.deploymentId !== targetId
          && candidate.task === task
          && (candidate.state === 'in_progress' || candidate.state === 'success'));
        if (replacement == null) fail('Preview Control did not succeed: deployment card is inactive');
        outcome = replacement;
      }
      lastState = outcome.state;
      if (outcome.state === 'success') {
        await verifyCurrent();
        return {
          deploymentId: outcome.deploymentId,
          state: outcome.state,
          announcementRunId: outcome.announcementRunId,
          task: outcome.task,
        };
      }
      if (outcome.state === 'failure' || outcome.state === 'error' || outcome.state === 'inactive') {
        fail(`Preview Control did not succeed: deployment card is ${outcome.state}`);
      }
      if (outcome.state != null
        && outcome.state !== 'queued'
        && outcome.state !== 'pending'
        && outcome.state !== 'waiting'
        && outcome.state !== 'in_progress') {
        fail(`preview deployment card has an unknown state: ${outcome.state}`);
      }
    }
    await waitForRetry(waitForCompletion, attempt, completionAttempts);
  }

  if (!found) fail('preview deployment card was not found before Preview Control wait deadline');
  fail(`Preview Control did not finish before wait deadline: deployment card is ${lastState}`);
}
/**
 * Claim a card created by queuePreviewDeployment. A completed or already-claimed card is
 * returned as an idempotent no-op so a reconciler cannot redeploy an unchanged PR head.
 */
export async function claimPreviewDeployment({
  request,
  verify,
  verifyAnnouncement,
  onClaimed = null,
  attempts = 1,
  wait = async () => {},
  ...values
}) {
  const context = previewContext(values);
  const announcement = announcementSearchContext(context);
  const github = assertRequest(request);
  const verifyCurrent = assertVerify(verify);
  const verifyQueuedAnnouncement = assertVerify(
    verifyAnnouncement,
    'preview announcement verification function',
  );
  const recordClaimed = optionalCallback(onClaimed, 'preview deployment claimed callback');
  const claimAttempts = positiveAttemptCount(attempts);
  const waitForCard = optionalCallback(wait, 'preview deployment claim wait callback');
  const logUrl = githubRunUrl(context.repository, context.runId);

  for (let attempt = 1; attempt <= claimAttempts; attempt += 1) {
    await verifyCurrent();
    const cards = await matchedAnnouncements({
      request: github,
      verifyAnnouncement: verifyQueuedAnnouncement,
      ...announcement,
    });
    const existing = cards.find((candidate) =>
      candidate.state === 'in_progress' || candidate.state === 'success');
    if (existing != null) {
      for (const duplicate of cards) {
        if (duplicate.deploymentId === existing.deploymentId) continue;
        if (duplicate.state !== 'queued' && duplicate.state != null) continue;
        await verifyCurrent();
        await postDeploymentStatus(
          github,
          context,
          duplicate.deploymentId,
          'inactive',
          'Preview already claimed for this PR head',
          { logUrl },
        );
      }
      const claimedByCurrentRun = existing.statusLogUrl === logUrl;
      return {
        deploymentId: existing.deploymentId,
        environment: previewDeploymentEnvironment(context.pr),
        url: null,
        alreadyClaimed: true,
        ...(claimedByCurrentRun ? { claimedByCurrentRun: true } : {}),
      };
    }
    const card = claimableAnnouncement(cards);
    if (card == null) {
      if (attempt === claimAttempts) break;
      await waitForRetry(waitForCard, attempt, claimAttempts);
      continue;
    }

    if (recordClaimed) await recordClaimed({
      deploymentId: card.deploymentId,
      environment: previewDeploymentEnvironment(context.pr),
      url: null,
    });
    await verifyCurrent();
    await postDeploymentStatus(
      github,
      context,
      card.deploymentId,
      'in_progress',
      'Preview provisioning is in progress',
      { logUrl },
    );
    return {
      deploymentId: card.deploymentId,
      environment: previewDeploymentEnvironment(context.pr),
      url: null,
    };
  }
  fail('no verified queued preview deployment card appeared before the claim deadline');
}

/**
 * Settle every still-queued card for an unsuccessful source CI run. A missing card is a benign
 * no-op: its PR Queue event may not have created one. A card already claimed by a successful
 * controller has an in-progress or terminal status and is deliberately left alone.
 */
export async function rejectQueuedPreviewDeployments({
  request,
  verify,
  verifyAnnouncement,
  attempts = 1,
  wait = async () => {},
  ...values
}) {
  const context = previewContext(values);
  const announcement = announcementSearchContext(context);
  const github = assertRequest(request);
  const verifyCurrent = assertVerify(verify);
  const verifyQueuedAnnouncement = assertVerify(
    verifyAnnouncement,
    'preview announcement verification function',
  );
  const claimAttempts = positiveAttemptCount(attempts);
  const waitForCard = optionalCallback(wait, 'preview deployment claim wait callback');
  const logUrl = githubRunUrl(context.repository, context.runId);

  for (let attempt = 1; attempt <= claimAttempts; attempt += 1) {
    await verifyCurrent();
    const cards = await matchedAnnouncements({
      request: github,
      verifyAnnouncement: verifyQueuedAnnouncement,
      ...announcement,
    });
    if (cards.length === 0) {
      if (attempt === claimAttempts) break;
      await waitForRetry(waitForCard, attempt, claimAttempts);
      continue;
    }

    const rejectedDeploymentIds = [];
    for (const card of cards) {
      if (card.state !== 'queued' && card.state != null) continue;
      await verifyCurrent();
      await postDeploymentStatus(
        github,
        context,
        card.deploymentId,
        'failure',
        'Preview was not provisioned because CI did not succeed',
        { logUrl },
      );
      rejectedDeploymentIds.push(card.deploymentId);
    }
    return { rejectedDeploymentIds };
  }
  return { rejectedDeploymentIds: [] };
}

/**
 * Settle one verified announcement card only while it has no status or remains queued. A caller
 * supplies the authoritative reason (closed/stale PR, failed CI, or missed controller) and
 * revalidates that reason immediately before the terminal write.
 */
export async function settleQueuedPreviewDeployment({
  request,
  verify,
  verifyAnnouncement,
  deploymentId: id,
  state,
  description,
  logUrl = null,
  ...values
}) {
  if (state !== 'failure' && state !== 'inactive') {
    fail('queued preview deployment may settle only to failure or inactive');
  }
  if (typeof description !== 'string' || description.length === 0) {
    fail('queued preview deployment settlement description is required');
  }
  const context = announcementSearchContext(values);
  const github = assertRequest(request);
  const verifyCurrent = assertVerify(verify);
  const verifyQueuedAnnouncement = assertVerify(
    verifyAnnouncement,
    'preview announcement verification function',
  );
  const currentDeploymentId = deploymentId(id);
  const card = (await matchedAnnouncements({
    request: github,
    verifyAnnouncement: verifyQueuedAnnouncement,
    ...context,
  })).find((candidate) => candidate.deploymentId === currentDeploymentId);
  if (card == null || (card.state !== 'queued' && card.state != null)) {
    return { deploymentId: currentDeploymentId, settled: false };
  }
  await verifyCurrent();
  await postDeploymentStatus(github, context, currentDeploymentId, state, description, { logUrl });
  return { deploymentId: currentDeploymentId, settled: true };
}



/**
 * Retire every verified card for one superseded SHA, including a card the former head had already
 * claimed. Matching by SHA prevents this from touching the newer head's card.
 */
export async function inactivateSupersededPreviewDeployments({
  request,
  verify,
  verifyAnnouncement,
  description,
  logUrl = null,
  ...values
}) {
  if (typeof description !== 'string' || description.length === 0) {
    fail('superseded preview deployment description is required');
  }
  const context = announcementSearchContext(values);
  const github = assertRequest(request);
  const verifyCurrent = assertVerify(verify);
  const verifyQueuedAnnouncement = assertVerify(
    verifyAnnouncement,
    'preview announcement verification function',
  );
  const inactivatedDeploymentIds = [];
  for (const card of await matchedAnnouncements({
    request: github,
    verifyAnnouncement: verifyQueuedAnnouncement,
    ...context,
  })) {
    if (card.state === 'inactive') continue;
    await verifyCurrent();
    await postDeploymentStatus(github, context, card.deploymentId, 'inactive', description, { logUrl });
    inactivatedDeploymentIds.push(card.deploymentId);
  }
  return { inactivatedDeploymentIds };
}
/**
 * Complete an exact queued-and-claimed deployment after provisioning and smoke. Terminal results
 * retire only older cards that were created by a verified trusted announcement run.
 */
export async function completePreviewDeployment({
  request,
  verify,
  verifyAnnouncement,
  deploymentId: id,
  outcome,
  ...values
}) {
  const context = previewContext(values);
  const announcement = announcementSearchContext(context);
  const github = assertRequest(request);
  const verifyCurrent = assertVerify(verify);
  const verifyQueuedAnnouncement = assertVerify(
    verifyAnnouncement,
    'preview announcement verification function',
  );
  const currentDeploymentId = deploymentId(id);
  const url = previewUrl(context.pr);
  const logUrl = githubRunUrl(context.repository, context.runId);
  const completion = completionDetails(outcome, url);
  const cards = await matchedAnnouncements({
    request: github,
    verifyAnnouncement: verifyQueuedAnnouncement,
    ...announcement,
  });
  const current = cards.find((card) => card.deploymentId === currentDeploymentId);
  if (current == null) fail('GitHub deployment list omitted the current verified preview card');

  await verifyCurrent();
  await postDeploymentStatus(github, context, currentDeploymentId, completion.state, completion.description, {
    environmentUrl: completion.environmentUrl,
    logUrl,
  });

  const inactiveDeploymentIds = [];
  for (const card of cards) {
    if (card.deploymentId === currentDeploymentId || !precedes(card.order, current.order)) continue;
    await verifyCurrent();
    await postDeploymentStatus(
      github,
      context,
      card.deploymentId,
      'inactive',
      'Superseded by a newer preview attempt',
      { logUrl },
    );
    inactiveDeploymentIds.push(card.deploymentId);
  }
  return {
    deploymentId: currentDeploymentId,
    outcome,
    inactiveDeploymentIds,
    url: completion.environmentUrl,
  };
}

/**
 * Mark every card in a PR environment inactive only after its stable resources were removed.
 * This trusted close/janitor path intentionally includes prior schema versions as well.
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
    if (currentOrder && !precedes(deploymentOrder(deployment), currentOrder)) continue;
    if (verifyCurrent) await verifyCurrent();
    await postDeploymentStatus(github, context, id, 'inactive', description, { logUrl: deploymentLogUrl });
    inactiveDeploymentIds.push(id);
  }
  return inactiveDeploymentIds;
}
