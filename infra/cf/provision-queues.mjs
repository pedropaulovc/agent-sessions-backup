import {
  PREVIEW_ACCOUNT_ID,
  PRODUCTION_ACCOUNT_ID,
  fail,
  paginatedList,
  parseArgs,
  required,
  stableJson,
} from './preview-trust.mjs';

// Production runs only in the protected main deployment job. Standing preview uses the
// same explicit CLOUDFLARE_API_TOKEN as its following Wrangler deploy, scoped to preview.
const args = parseArgs(process.argv.slice(2), new Set(['target']));
const target = required(args.target, 'target');
if (target !== 'production' && target !== 'preview') fail('target must be production or preview');
if (target === 'production' && (
  process.env.GITHUB_ACTIONS !== 'true'
  || process.env.GITHUB_EVENT_NAME !== 'push'
  || process.env.GITHUB_REF !== 'refs/heads/main'
)) {
  fail('production queue provisioning requires the protected main-push GitHub Actions deployment');
}
const accountId = target === 'production' ? PRODUCTION_ACCOUNT_ID : PREVIEW_ACCOUNT_ID;
if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_ACCOUNT_ID !== accountId) {
  fail('CLOUDFLARE_ACCOUNT_ID does not match the selected target');
}
const token = required(process.env.CLOUDFLARE_API_TOKEN, 'CLOUDFLARE_API_TOKEN');
const queueName = target === 'production' ? 'session-rollup' : 'session-rollup-preview';

async function cf(pathname, init = {}) {
  // paginatedList requests its envelope explicitly. A failed list must never be treated as
  // an empty account: authentication and API errors stop deployment before any resource write.
  const { returnEnvelope = false, allowNotFound: _allowNotFound, ...fetchInit } = init;
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/${pathname}`, {
    ...fetchInit,
    redirect: 'error',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(fetchInit.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  let envelope;
  try { envelope = await response.json(); } catch { fail(`Cloudflare returned non-JSON HTTP ${response.status}`); }
  if (!response.ok || envelope.success !== true) {
    fail(`Cloudflare ${pathname} failed with ${response.status}: ${stableJson(envelope.errors ?? envelope)}`);
  }
  return returnEnvelope ? envelope : envelope.result;
}

const queues = await paginatedList(cf, 'queues', {
  pagination: 'page',
  rowsOf(envelope) {
    const rows = envelope.result ?? envelope.queues;
    if (!Array.isArray(rows)) fail('Cloudflare queue list did not return an array');
    return rows;
  },
});
let queue = queues.find((item) => item.queue_name === queueName);
const created = queue === undefined;
if (created) queue = await cf('queues', { method: 'POST', body: stableJson({ queue_name: queueName }) });
const queueId = required(queue?.queue_id ?? queue?.id, `${queueName} queue ID`);
process.stdout.write(`${stableJson({ target, account_id: accountId, queue: queueName, queue_id: queueId, created })}\n`);
