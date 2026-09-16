import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { PREVIEW_ACCOUNT_ID, PRODUCTION_ACCOUNT_ID } from '../../infra/cf/preview-trust.mjs';

const provisioner = fileURLToPath(new URL('../../infra/cf/provision-queues.mjs', import.meta.url));
const MAIN_PUSH = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' };
const productionQueue = { queue_name: 'session-rollup', queue_id: 'rollup-id' };
const previewQueue = { queue_name: 'session-rollup-preview', queue_id: 'preview-rollup-id' };
const listResponse = (queues) => ({ status: 200, body: { success: true, result: queues } });

async function runProvision({ target = 'production', environment = MAIN_PUSH, responses = [] } = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'provision-queues-test-'));
  const report = path.join(temporary, 'requests.json');
  const preload = path.join(temporary, 'preload.mjs');
  try {
    await writeFile(report, '[]');
    await writeFile(preload, `
import { writeFileSync } from 'node:fs';
const responses = ${JSON.stringify(responses)};
const report = ${JSON.stringify(report)};
const requests = [];
globalThis.fetch = async (url, init = {}) => {
  requests.push({ url: String(url), method: init.method ?? 'GET', body: init.body ?? null });
  writeFileSync(report, JSON.stringify(requests));
  const response = responses.shift();
  if (!response) throw new Error('unexpected network request');
  return new Response(JSON.stringify(response.body), { status: response.status });
};
`);
    const child = spawnSync(process.execPath, [
      '--import', pathToFileURL(preload).href, provisioner, '--target', target,
    ], {
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        GITHUB_ACTIONS: '',
        GITHUB_EVENT_NAME: '',
        GITHUB_REF: '',
        CLOUDFLARE_ACCOUNT_ID: '',
        CLOUDFLARE_API_TOKEN: 'synthetic-queue-provisioning-token',
        ...environment,
      },
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    if (child.error) throw child.error;
    assert.equal(child.signal, null, 'provisioner must exit without being killed');
    return {
      status: child.status,
      output: `${child.stdout}${child.stderr}`,
      stdout: child.stdout,
      requests: JSON.parse(await readFile(report, 'utf8')),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test('production rejects local, pull-request and non-main contexts before any Cloudflare request', async () => {
  for (const environment of [
    { ...MAIN_PUSH, GITHUB_ACTIONS: '' },
    { ...MAIN_PUSH, GITHUB_EVENT_NAME: 'pull_request' },
    { ...MAIN_PUSH, GITHUB_REF: 'refs/heads/feature' },
  ]) {
    const result = await runProvision({ environment });
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /protected main-push/);
    assert.deepEqual(result.requests, []);
  }
});

test('both targets reject a conflicting account override before network access', async () => {
  for (const [target, account] of [['production', PREVIEW_ACCOUNT_ID], ['preview', PRODUCTION_ACCOUNT_ID]]) {
    const result = await runProvision({
      target,
      environment: { ...MAIN_PUSH, CLOUDFLARE_ACCOUNT_ID: account },
    });
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /does not match the selected target/);
    assert.deepEqual(result.requests, []);
  }
});

test('a main push follows all queue pages and leaves an existing production queue untouched', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ queue_name: `other-${index}`, queue_id: `id-${index}` }));
  const result = await runProvision({ responses: [listResponse(firstPage), listResponse([productionQueue])] });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.requests, [1, 2].map((page) => ({
    url: `https://api.cloudflare.com/client/v4/accounts/${PRODUCTION_ACCOUNT_ID}/queues?per_page=100&page=${page}`,
    method: 'GET',
    body: null,
  })));
  assert.deepEqual(JSON.parse(result.stdout), {
    target: 'production', account_id: PRODUCTION_ACCOUNT_ID,
    queue: 'session-rollup', queue_id: 'rollup-id', created: false,
  });
});

test('a missing queue is created once and a rerun observes the same queue without writing', async () => {
  const created = await runProvision({ responses: [
    listResponse([]), { status: 200, body: { success: true, result: productionQueue } },
  ] });
  assert.equal(created.status, 0, created.output);
  assert.deepEqual(created.requests.map(({ method }) => method), ['GET', 'POST']);
  assert.equal(created.requests[1].url, `https://api.cloudflare.com/client/v4/accounts/${PRODUCTION_ACCOUNT_ID}/queues`);
  assert.deepEqual(JSON.parse(created.requests[1].body), { queue_name: 'session-rollup' });
  assert.equal(JSON.parse(created.stdout).created, true);

  const rerun = await runProvision({ responses: [listResponse([productionQueue])] });
  assert.equal(rerun.status, 0, rerun.output);
  assert.deepEqual(rerun.requests.map(({ method }) => method), ['GET']);
  assert.equal(JSON.parse(rerun.stdout).queue_id, JSON.parse(created.stdout).queue_id);
  assert.equal(JSON.parse(rerun.stdout).created, false);
});

test('standing preview provisions only its pinned account without requiring a production CI context', async () => {
  const result = await runProvision({ target: 'preview', environment: {}, responses: [
    listResponse([]), { status: 200, body: { success: true, result: previewQueue } },
  ] });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.requests.map(({ url }) => new URL(url).pathname), [
    `/client/v4/accounts/${PREVIEW_ACCOUNT_ID}/queues`,
    `/client/v4/accounts/${PREVIEW_ACCOUNT_ID}/queues`,
  ]);
  assert.deepEqual(JSON.parse(result.requests[1].body), { queue_name: 'session-rollup-preview' });
  assert.equal(JSON.parse(result.stdout).queue_id, 'preview-rollup-id');
});

test('an unauthorized or malformed queue listing never turns into a create request', async () => {
  for (const response of [
    { status: 403, body: { success: false, errors: [{ message: 'forbidden' }] } },
    { status: 200, body: { success: true, result: {} } },
  ]) {
    const result = await runProvision({ responses: [response] });
    assert.notEqual(result.status, 0, result.output);
    assert.deepEqual(result.requests.map(({ method }) => method), ['GET']);
    assert.equal(result.stdout, '');
  }
});

test('a create conflict blocks deployment rather than being swallowed; a later rerun is idempotent', async () => {
  const conflict = await runProvision({ responses: [listResponse([]), {
    status: 409, body: { success: false, errors: [{ message: 'queue already exists' }] },
  }] });
  assert.notEqual(conflict.status, 0, conflict.output);
  assert.match(conflict.output, /failed with 409/);
  assert.deepEqual(conflict.requests.map(({ method }) => method), ['GET', 'POST']);
  assert.equal(conflict.stdout, '');
  const rerun = await runProvision({ responses: [listResponse([productionQueue])] });
  assert.equal(rerun.status, 0, rerun.output);
  assert.deepEqual(rerun.requests.map(({ method }) => method), ['GET']);
  assert.equal(JSON.parse(rerun.stdout).created, false);
});
