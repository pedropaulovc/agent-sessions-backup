import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { previewBearerToken } from '../../infra/cf/preview-trust.mjs';

// `smoke()` waits out two transients that only ever appear against real Cloudflare: a fresh
// Worker answering 500 before it serves any binding, and a just-deployed version still serving
// the previous one. Both are invisible to `seed`, so this drives the `smoke` verb directly with
// the same stubbed clock and fetch, and asserts the budget rule the loops exist to honour:
// nothing is issued once the settle deadline is spent.
const SEED = 'synthetic-preview-smoke-for-cli-regression-only';
const PR = 150;
const ORIGIN = `https://pr-${PR}-app.sessions-ppe.workers.dev`;
const DIAGNOSTICS = `${ORIGIN}/api/v1/preview/diagnostics`;
const SHA = 'a'.repeat(40);
const ARTIFACT = 'b'.repeat(64);
const SCHEMA = 'c'.repeat(64);
const SETTLE_MS = 90_000;
const controller = process.env.PREVIEW_CONTROL_PATH
  ?? fileURLToPath(new URL('../../infra/cf/preview-control.mjs', import.meta.url));

async function runSmoke(scenario) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'preview-smoke-test-'));
  const reportPath = path.join(temporary, 'report.json');
  const preload = path.join(temporary, 'preload.mjs');
  try {
    await writeFile(preload, `
      import { writeFileSync } from 'node:fs';
      const scenario = ${JSON.stringify(scenario)};
      const expected = ${JSON.stringify({ headSha: SHA, artifactDigest: ARTIFACT, schemaDigest: SCHEMA })};
      const requests = [];
      const budgets = new WeakMap();
      let now = 0;
      let unauthenticated = 0;
      let authenticated = 0;
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
        requests, elapsed: now,
      })));
      globalThis.fetch = async (input, init = {}) => {
        const headers = Object.fromEntries(new Headers(init.headers));
        const authorized = Boolean(headers.authorization);
        const budget = budgets.get(init.signal);
        requests.push({
          url: new URL(input).href, authorized, budget, started: now,
          redirect: init.redirect, cacheControl: headers['cache-control'],
        });
        // A response that takes real time makes the clock land off the poll interval. Without
        // it every timestamp is a multiple of the poll and a loop that overshoots the deadline
        // can still come out even, which would let a fixed sleep pass the elapsed assertion.
        now += scenario.responseDelay ?? 0;
        if (!authorized) {
          unauthenticated += 1;
          if (scenario.activationFailures === 'always' || unauthenticated <= (scenario.activationFailures ?? 0)) {
            return new Response(scenario.activationBody ?? 'internal error', { status: 500 });
          }
          if (unauthenticated <= (scenario.routeFailures ?? 0)) {
            return Response.json({
              error_code: 1042,
              error_name: 'workers_dev_script_not_found',
              detail: 'No Workers script was found for this host on workers.dev.',
            }, { status: 404 });
          }
          if (scenario.unauthenticatedStatus) {
            return new Response('unexpected', { status: scenario.unauthenticatedStatus });
          }
          return new Response('denied', { status: 401 });
        }
        authenticated += 1;
        // A body that aborts mid-stream is the case that escaped the retry boundary before
        // 21e13fe: \`fetch\` had already resolved, so the rejection came from \`text()\`.
        if (authenticated <= (scenario.bodyAborts ?? 0)) {
          const response = new Response('{}', { status: 200 });
          response.text = async () => {
            now += budget;
            throw new DOMException('Synthetic body reset', 'TimeoutError');
          };
          return response;
        }
        if (authenticated <= (scenario.bodyAborts ?? 0) + (scenario.staleReads ?? 0)) {
          return Response.json({ ...expected, headSha: 'f'.repeat(40) });
        }
        if (scenario.authenticatedStatus) {
          return new Response('nope', { status: scenario.authenticatedStatus });
        }
        return Response.json(expected);
      };
    `);
    const result = spawnSync(process.execPath, [
      '--import', preload, controller, 'smoke',
      '--pr', String(PR), '--repository', 'example/sessions',
      '--head-sha', SHA, '--artifact-digest', ARTIFACT, '--schema-digest', SCHEMA,
    ], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PREVIEW_BEARER_SEED: SEED },
    });
    assert.ifError(result.error);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    const output = `${result.stdout}\n${result.stderr}`;
    assert.ok(!output.includes(SEED), 'CLI output must not expose bearer seed');
    assert.ok(!output.includes(previewBearerToken(SEED, PR)), 'CLI output must not expose bearer token');
    return { ...result, ...report, output };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

// Every request has to be answerable inside what is left of the settle deadline. A floor, or a
// deadline checked only after a response, lets the last request start with time it does not
// have — both were real defects in this file, caught in review rather than here.
function assertInsideDeadline(result) {
  // Per-request bounds are not sufficient on their own: an overlong final wait can carry the
  // clock past the deadline before the loop reports failure, with every request still inside it.
  assert.ok(result.elapsed <= SETTLE_MS,
    `smoke ran ${result.elapsed}ms, past the ${SETTLE_MS}ms settle deadline`);
  for (const request of result.requests) {
    assert.ok(request.started < SETTLE_MS,
      `request at ${request.started}ms started past the ${SETTLE_MS}ms deadline`);
    assert.ok(request.budget > 0, `request at ${request.started}ms got a non-positive budget`);
    assert.ok(request.started + request.budget <= SETTLE_MS,
      `request at ${request.started}ms could run ${request.budget}ms past the deadline`);
  }
}

test('smoke waits out the activation 500 on the unauthenticated request, then verifies the artifact', async () => {
  const result = await runSmoke({ activationFailures: 2 });
  assert.equal(result.status, 0, result.output);
  const unauthenticated = result.requests.filter((request) => !request.authorized);
  assert.equal(unauthenticated.length, 3, 'two 500s must be retried, the 401 ends the loop');
  assert.ok(unauthenticated[1].started > unauthenticated[0].started, 'retries must back off');
  assert.equal(unauthenticated[0].url, DIAGNOSTICS);
  assert.equal(unauthenticated[0].redirect, 'error');
  assert.equal(unauthenticated[0].cacheControl, 'no-store');
  assert.match(result.stdout, /"smoke":"passed"/);
  assertInsideDeadline(result);
});

test('smoke waits out a Cloudflare 1042 after healthz becomes routable', async () => {
  const result = await runSmoke({ routeFailures: 2 });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.requests.filter((request) => !request.authorized).length, 3);
  assert.match(result.stdout, /"smoke":"passed"/);
  assertInsideDeadline(result);
});

test('smoke fails on a persistent Cloudflare 1042 within the deadline', async () => {
  const result = await runSmoke({ routeFailures: 100, responseDelay: 700 });
  assert.equal(result.status, 1);
  assert.ok(result.requests.length > 1, 'the Cloudflare 1042 must be retried');
  assertInsideDeadline(result);
});

test('smoke retries an authenticated diagnostics body that aborts mid-stream', async () => {
  const result = await runSmoke({ bodyAborts: 1 });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.requests.filter((request) => request.authorized).length, 2);
  assert.match(result.stdout, /"smoke":"passed"/);
  assertInsideDeadline(result);
});

test('smoke waits for a stale version to propagate instead of failing the deploy', async () => {
  const result = await runSmoke({ staleReads: 2 });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.requests.filter((request) => request.authorized).length, 3);
  assert.match(result.stdout, /do not match yet/);
  assertInsideDeadline(result);
});

test('smoke fails inside the settle deadline when the runtime never stops returning 500', async () => {
  // 700ms per response is deliberately not a divisor of the 3s poll: the clock lands off the
  // interval, so a loop that sleeps a fixed 3s overshoots the deadline instead of landing on it.
  const result = await runSmoke({ activationFailures: 'always', responseDelay: 700 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /internal error/);
  assert.ok(result.requests.length > 1, 'the 500 must have been retried, not reported once');
  assertInsideDeadline(result);
});

test('smoke fails immediately when the unauthenticated request is not denied', async () => {
  const result = await runSmoke({ unauthenticatedStatus: 200 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /was not denied \(200\)/);
  assert.equal(result.requests.length, 1, 'an open preview is a defect, not a transient');
  assert.ok(result.elapsed < SETTLE_MS, 'a permanent failure must not burn the settle budget');
});

test('smoke fails immediately on an unexpected authenticated status', async () => {
  const result = await runSmoke({ authenticatedStatus: 503 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /diagnostics smoke failed with 503/);
  assert.equal(result.requests.filter((request) => request.authorized).length, 1);
});
