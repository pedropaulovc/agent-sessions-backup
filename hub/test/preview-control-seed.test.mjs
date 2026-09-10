import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { SYNTHETIC_EXPECTATIONS } from '../scripts/lib/dev-seed.mjs';
import { previewBearerToken } from '../../infra/cf/preview-trust.mjs';

const SEED = 'synthetic-preview-seed-for-cli-regression-only';
const ORIGIN = 'https://pr-150-app.sessions-ppe.workers.dev';
const ASSET_PATH = `/api/v1/files/${SYNTHETIC_EXPECTATIONS.machine}/${SYNTHETIC_EXPECTATIONS.store}/${SYNTHETIC_EXPECTATIONS.externalRelpath}`;
const CLOUDFLARE_404 = '<!DOCTYPE html><html><head><title>Page not found</title><link rel="icon" href="https://workers.cloudflare.com/favicon.ico"></head><body>Not found</body></html>';
const controller = process.env.PREVIEW_CONTROL_PATH
  ?? fileURLToPath(new URL('../../infra/cf/preview-control.mjs', import.meta.url));

async function runSeed(scenario) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'preview-seed-test-'));
  const reportPath = path.join(temporary, 'report.json');
  const preload = path.join(temporary, 'preload.mjs');
  try {
    await writeFile(preload, `
      import { writeFileSync } from 'node:fs';
      const scenario = ${JSON.stringify(scenario)};
      const cloudflare404 = ${JSON.stringify(CLOUDFLARE_404)};
      const expected = ${JSON.stringify(SYNTHETIC_EXPECTATIONS)};
      const requests = [];
      const responses = [];
      const budgets = new WeakMap();
      let now = 0;
      let uploads = 0;
      Date.now = () => now;
      globalThis.setTimeout = (callback, delay) => {
        now += delay;
        queueMicrotask(callback);
        return 0;
      };
      AbortSignal.timeout = (delay) => {
        const signal = new AbortController().signal;
        budgets.set(signal, delay);
        return signal;
      };
      process.on('exit', () => writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({
        requests, elapsed: now, consumed: responses.map((response) => response.bodyUsed),
      })));
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(input);
        const headers = Object.fromEntries(new Headers(init.headers));
        requests.push({
          url: url.href, method: init.method ?? 'GET', headers, redirect: init.redirect,
          body: init.body ? Buffer.from(init.body).toString('base64') : null,
          budget: budgets.get(init.signal), started: now,
        });
        let response;
        if (init.method === 'PUT') {
          uploads += 1;
          if (scenario.stall) {
            now += budgets.get(init.signal) ?? 1_000_000;
            throw new DOMException('Synthetic stalled request', 'TimeoutError');
          }
          const failed = scenario.permanent || uploads <= (scenario.failures ?? 1);
          const status = failed ? (scenario.status ?? 404) : 201;
          response = new Response(failed ? (scenario.body ?? cloudflare404) : 'created', {
            status, headers: { 'content-type': failed ? (scenario.contentType ?? 'text/html; charset=UTF-8') : 'text/plain' },
          });
          const text = response.text.bind(response);
          response.text = async () => {
            const body = await text();
            if (scenario.permanent && scenario.bodyDelay > budgets.get(init.signal)) {
              now += budgets.get(init.signal);
              throw new DOMException('Synthetic body timeout', 'TimeoutError');
            }
            now += scenario.bodyDelay ?? 0;
            return body;
          };
        } else if (url.pathname === '/api/v1/search') {
          const query = url.searchParams.get('q');
          const sessionId = query === expected.searchPhrase ? expected.primarySessionId
            : query === expected.pagerSearchPhrase ? expected.pagerSessionId : null;
          response = Response.json({ hits: sessionId ? [{ session_id: sessionId }] : [] });
        } else {
          throw new Error('Unexpected request: ' + url.href);
        }
        responses.push(response);
        return response;
      };
    `);
    const result = spawnSync(process.execPath, [
      '--import', preload, controller, 'seed', '--pr', '150', '--repository', 'example/sessions',
    ], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PREVIEW_BEARER_SEED: SEED },
    });
    assert.ifError(result.error);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    const output = `${result.stdout}\n${result.stderr}`;
    assert.ok(!output.includes(SEED), 'CLI output must not expose bearer seed');
    assert.ok(!output.includes(previewBearerToken(SEED, 150)), 'CLI output must not expose bearer token');
    return { ...result, ...report, output };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test('seed replays the same fixture PUT after a Cloudflare no-worker 404, then observes indexed sessions', async () => {
  const result = await runSeed({});
  assert.equal(result.status, 0, result.output);
  const uploads = result.requests.filter((request) => request.method === 'PUT');
  assert.equal(uploads.length, 4);
  const { budget: firstBudget, started: firstStarted, ...first } = uploads[0];
  const { budget: secondBudget, started: secondStarted, ...second } = uploads[1];
  assert.deepEqual(second, first, 'replayed URL, method, bytes and all headers must be identical');
  assert.equal(first.url, `${ORIGIN}${ASSET_PATH}`);
  assert.equal(first.headers['x-content-hash'], `sha256:${SYNTHETIC_EXPECTATIONS.externalDigest}`);
  assert.equal(first.headers['content-length'], String(Buffer.from(first.body, 'base64').length));
  assert.equal(first.headers.authorization, `Bearer ${previewBearerToken(SEED, 150)}`);
  assert.equal(first.redirect, 'error');
  assert.ok(firstBudget > 0 && firstBudget <= 10_000);
  assert.ok(secondBudget > 0 && secondBudget <= 10_000);
  assert.ok(secondStarted > firstStarted, 'retry must back off');
  assert.deepEqual(result.consumed, [true, true, true, true, true, true]);
  assert.equal(result.requests.filter((request) => request.method === 'GET').length, 2);
  const summary = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.deepEqual(summary.seeded, [SYNTHETIC_EXPECTATIONS.primarySessionId, SYNTHETIC_EXPECTATIONS.pagerSessionId]);
  assert.ok(result.output.includes(ASSET_PATH), result.output);
  assert.match(result.output, /attempt/i);
});

test('permanent Cloudflare no-worker 404 fails at the deadline without another upload or search', async () => {
  const result = await runSeed({ permanent: true, bodyDelay: 7_500 });
  assert.notEqual(result.status, 0, result.output);
  assert.ok(result.requests.length > 1, 'the recognized no-worker page should retry');
  assert.ok(result.requests.every((request) => request.method === 'PUT' && request.url === `${ORIGIN}${ASSET_PATH}`));
  assert.ok(result.requests.every((request) => request.started < 120_000));
  assert.ok(result.requests.every((request) => request.budget > 0 && request.budget <= Math.min(10_000, 120_000 - request.started)));
  assert.equal(result.elapsed, 120_000);
  assert.ok(result.consumed.every(Boolean));
  assert.ok(result.output.includes(`${ORIGIN}${ASSET_PATH}`), result.output);
  assert.match(result.output, /404/);
  assert.match(result.output, /timed out|deadline|after 120s/i);
});

test('a successful response whose body finishes after the upload deadline cannot make seed succeed', async () => {
  const result = await runSeed({ failures: 0, bodyDelay: 120_000 });
  assert.notEqual(result.status, 0, result.output);
  assert.equal(result.requests.length, 1);
  assert.deepEqual(result.consumed, [true]);
  assert.ok(result.output.includes(`${ORIGIN}${ASSET_PATH}`), result.output);
  assert.match(result.output, /201/);
  assert.match(result.output, /timed out|deadline|after 120s/i);
});

for (const [name, scenario] of [
  ['application JSON 404', { contentType: 'application/json', body: '{"error":"not found"}' }],
  ['application HTML 404', { body: '<html><title>Page not found</title><body>Unknown file</body></html>' }],
  ['HTML with an unrelated favicon host', { body: CLOUDFLARE_404.replace('workers.cloudflare.com/', 'workers.cloudflare.com.example.org/') }],
  ['Cloudflare page served as plain text', { contentType: 'text/plain' }],
  ['401 authentication denial', { status: 401 }],
  ['403 authorization denial', { status: 403 }],
  ['500 server error', { status: 500 }],
]) {
  test(`${name} fails without replaying the fixture PUT`, async () => {
    const result = await runSeed(scenario);
    assert.notEqual(result.status, 0, result.output);
    assert.equal(result.requests.length, 1);
    assert.equal(result.elapsed, 0);
    assert.deepEqual(result.consumed, [true]);
    assert.ok(result.output.includes(String(scenario.status ?? 404)), result.output);
  });
}

test('a stalled upload is request-bounded and fails without a broad network retry', async () => {
  const result = await runSeed({ stall: true });
  assert.notEqual(result.status, 0, result.output);
  assert.equal(result.requests.length, 1);
  assert.equal(result.elapsed, 10_000);
  assert.ok(result.output.includes(`${ORIGIN}${ASSET_PATH}`), result.output);
});
