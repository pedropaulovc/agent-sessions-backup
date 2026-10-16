import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  classifyProviderReason, runMigrationAuthDiagnostics, verifyMigrationToken,
} from '../../infra/cf/migration-auth-diagnostics.mjs';
import { indexControlClient, migrationCopyFailureEvent } from '../../infra/cf/index-control.mjs';
import { PREVIEW_ACCOUNT_ID } from '../../infra/cf/preview-trust.mjs';
import { readCheckpoint } from '../scripts/lib/index-migration.mjs';

// Synthetic values only: no real credential, Cloudflare account or network is used.
const TOKEN = 'PRIVATE_TOKEN_CANARY_0123456789abcdef';
const CANARY = 'PRIVATE_PROVIDER_SQL_ROW_CANARY';
const REVISION = 'b'.repeat(40);
const RAY = 'a4b8dcbe9f86579a-IAD';
const DATE = 'Fri, 16 Oct 2026 17:42:51 GMT';
const VERIFY_URL = 'https://api.cloudflare.com/client/v4/user/tokens/verify';
const DATABASE_ID = '95dbde60-d5ab-4e2c-989f-fcd44a3ab479';
const CLI = fileURLToPath(new URL('../../infra/cf/migration-auth-diagnostics.mjs', import.meta.url));
const AUTH_FIELDS = ['verification', 'tokenStatus', 'notBefore', 'expiresOn', 'httpStatus', 'providerCodes',
  'providerReason', 'cfRay', 'providerDate', 'requestDurationMs'];
const UNAVAILABLE = { verification: 'unavailable', tokenStatus: null, notBefore: null, expiresOn: null };

const protectedEnv = (overrides = {}) => ({
  GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push',
  PROTECTED_PRODUCTION_MIGRATION: '1', GITHUB_REPOSITORY: 'pedropaulovc/agent-sessions-backup',
  GITHUB_SHA: REVISION, GITHUB_RUN_ID: '38887942689', GITHUB_RUN_ATTEMPT: '2', CLOUDFLARE_API_TOKEN: TOKEN,
  ...overrides,
});

function assertPrivate(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [TOKEN, CANARY, 'Bearer', 'Authentication error', 'Invalid API Token', 'tokens/verify']) {
    assert.ok(!text.includes(secret), `diagnostics must not disclose ${secret.slice(0, 12)}`);
  }
}

function recordingFetch(respond) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return respond(init, calls.length);
  };
  return { fetch, calls };
}

function clock(start = 1_000, step = 5) {
  let at = start;
  return () => (at += step);
}

const verifyResponse = (body, status = 200, headers = { 'cf-ray': RAY, date: DATE }) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

test('token verification reports only endpoint status and canonical UTC validity', async () => {
  for (const [status, verification] of [['active', 'active'], ['disabled', 'inactive'], ['expired', 'inactive']]) {
    const { fetch, calls } = recordingFetch(() => verifyResponse({
      success: true, errors: [], messages: [{ code: 10000, message: CANARY }],
      result: { id: CANARY, status, not_before: '2026-10-14T00:00:00Z', expires_on: '2026-11-15T23:59:59.5+00:00',
        policies: [{ id: CANARY }] },
    }));
    const result = await verifyMigrationToken({ env: protectedEnv(), fetch, now: clock() });
    assert.deepEqual(Object.keys(result).sort(), [...AUTH_FIELDS].sort());
    assert.deepEqual(result, {
      verification, tokenStatus: status, notBefore: '2026-10-14T00:00:00.000Z', expiresOn: '2026-11-15T23:59:59.500Z',
      httpStatus: 200, providerCodes: [], providerReason: 'unknown', cfRay: RAY,
      providerDate: '2026-10-16T17:42:51.000Z', requestDurationMs: 5,
    });
    assertPrivate(result);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, VERIFY_URL);
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.redirect, 'error');
    assert.equal(calls[0].init.body, undefined);
    assert.equal(calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
    assert.ok(calls[0].init.signal instanceof AbortSignal);
  }
  const { fetch } = recordingFetch(() => verifyResponse({ success: true, result: { status: 'active' } }));
  const absent = await verifyMigrationToken({ env: protectedEnv(), fetch, now: clock() });
  assert.deepEqual([absent.verification, absent.notBefore, absent.expiresOn], ['active', null, null]);
});

test('malformed, missing or contradictory token metadata stays unknown', async () => {
  const active = { success: true, errors: [], result: { status: 'active' } };
  const cases = [
    ['missing result', { success: true, errors: [] }],
    ['null result', { success: true, result: null }],
    ['array result', { success: true, result: [{ status: 'active' }] }],
    ['unknown status', { success: true, result: { status: 'revoked' } }],
    ['case-mismatched status', { success: true, result: { status: 'Active' } }],
    ['impossible calendar date', { success: true, result: { status: 'active', expires_on: '2026-02-30T00:00:00Z' } }],
    ['hour 24', { success: true, result: { status: 'active', not_before: '2026-10-16T24:00:00Z' } }],
    ['missing zone', { success: true, result: { status: 'active', expires_on: '2026-11-15T23:59:59' } }],
    ['numeric date', { success: true, result: { status: 'active', expires_on: 1_792_172_571 } }],
    ['free-text date', { success: true, result: { status: 'active', expires_on: `tomorrow ${CANARY}` } }],
    ['unsuccessful envelope', { ...active, success: false }],
    ['absent success', { result: { status: 'active' } }],
    ['non-JSON body', `${CANARY} <html>`],
    ['oversized body', JSON.stringify({ ...active, padding: CANARY.repeat(1024) })],
  ];
  for (const [name, body] of cases) {
    const { fetch, calls } = recordingFetch(() => verifyResponse(body));
    const result = await verifyMigrationToken({ env: protectedEnv(), fetch, now: clock() });
    assert.deepEqual({ ...result, httpStatus: undefined, providerCodes: undefined, providerReason: undefined,
      cfRay: undefined, providerDate: undefined, requestDurationMs: undefined },
    { ...UNAVAILABLE, httpStatus: undefined, providerCodes: undefined, providerReason: undefined,
      cfRay: undefined, providerDate: undefined, requestDurationMs: undefined }, name);
    assert.equal(result.httpStatus, 200, name);
    assertPrivate(result);
    assert.equal(calls.length, 1, name);
  }
  for (const status of [202, 302, 500]) {
    const { fetch } = recordingFetch(() => verifyResponse(active, status));
    assert.equal((await verifyMigrationToken({ env: protectedEnv(), fetch, now: clock() })).verification,
      'unavailable', `HTTP ${status} never reports active`);
  }
});

test('provider credential rejections are classified only by exact phrases and never replayed', async () => {
  const cases = [
    [401, [{ code: 1000, message: 'Invalid API Token' }, { code: CANARY }, { code: -1 }, { code: 9109, message: CANARY }],
      [1000, 9109], 'authentication'],
    [403, [{ code: 10000, message: ' Authentication error ' }], [10000], 'authentication'],
    [403, [{ code: 9109, message: 'Unauthorized to access requested resource' }], [9109], 'authorization'],
    [401, [{ code: 10000, message: `Authentication error: ${CANARY}` }], [10000], 'unknown'],
    [401, [{ code: 10000, message: 'Authentication error' },
      { code: 9109, message: 'Unauthorized to access requested resource' }], [10000, 9109], 'unknown'],
    [401, [{ code: 10000 }], [10000], 'unknown'],
    [429, [{ code: 971, message: CANARY }], [971], 'rate_limit'],
  ];
  for (const [status, errors, codes, reason] of cases) {
    const { fetch, calls } = recordingFetch(() => verifyResponse({ success: false, errors, messages: [], result: null }, status));
    const result = await verifyMigrationToken({ env: protectedEnv(), fetch, now: clock() });
    assert.deepEqual(result, { ...UNAVAILABLE, httpStatus: status, providerCodes: codes, providerReason: reason,
      cfRay: RAY, providerDate: '2026-10-16T17:42:51.000Z', requestDurationMs: 5 });
    assert.equal(calls.length, 1, 'a rejected verification is never retried');
    assertPrivate(result);
  }
  const many = Array.from({ length: 20 }, (_, index) => ({ code: index }));
  assert.equal(classifyProviderReason(401, many), 'unknown');
  const { fetch } = recordingFetch(() => verifyResponse({ success: false, errors: many }, 401));
  assert.deepEqual((await verifyMigrationToken({ env: protectedEnv(), fetch, now: clock() })).providerCodes,
    Array.from({ length: 16 }, (_, index) => index));
  assert.equal(classifyProviderReason(401, [{ code: 10000, message: 'x'.repeat(200) }]), 'unknown');
  assert.equal(classifyProviderReason(200, 'Authentication error'), 'unknown');
});

test('transport failures, redirects and malformed headers are unavailable without echoing exceptions', async () => {
  for (const failure of ['network', 'redirect']) {
    const { fetch, calls } = recordingFetch((init) => {
      assert.equal(init.redirect, 'error', 'redirects are rejected, never followed');
      throw new TypeError(`${failure} https://${CANARY}/?token=${TOKEN}`, { cause: new Error(CANARY) });
    });
    const result = await verifyMigrationToken({ env: protectedEnv(), fetch, now: clock() });
    assert.deepEqual(result, { ...UNAVAILABLE, httpStatus: null, providerCodes: [], providerReason: 'unknown',
      cfRay: null, providerDate: null, requestDurationMs: 5 });
    assert.equal(calls.length, 1);
    assertPrivate(result);
  }
  const { fetch } = recordingFetch(() => verifyResponse({ success: true, result: { status: 'active' } }, 200,
    { 'cf-ray': `${RAY} ${CANARY}`, date: `${DATE} ${CANARY}` }));
  const result = await verifyMigrationToken({ env: protectedEnv(), fetch, now: clock() });
  assert.deepEqual([result.verification, result.cfRay, result.providerDate], ['active', null, null]);
});

test('one deadline bounds headers and body, aborts, and ignores late responses', async (context) => {
  await context.test('headers never arrive', async () => {
    let signal;
    const { fetch } = recordingFetch((init) => { signal = init.signal; return new Promise(() => {}); });
    const started = Date.now();
    const result = await verifyMigrationToken({ env: protectedEnv(), fetch, now: clock(), deadlineMs: 25 });
    assert.ok(Date.now() - started < 1000);
    assert.equal(signal.aborted, true);
    assert.deepEqual(result, { ...UNAVAILABLE, httpStatus: null, providerCodes: [], providerReason: 'unknown',
      cfRay: null, providerDate: null, requestDurationMs: 5 });
  });
  await context.test('late active response after the deadline', async () => {
    let deliver;
    const { fetch } = recordingFetch(() => new Promise((resolve) => { deliver = resolve; }));
    const result = await verifyMigrationToken({ env: protectedEnv(), fetch, now: clock(), deadlineMs: 20 });
    const snapshot = structuredClone(result);
    deliver(verifyResponse({ success: true, result: { status: 'active' } }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(result, snapshot, 'a late response cannot rewrite the reported outcome');
    assert.equal(result.verification, 'unavailable');
    assert.equal(result.httpStatus, null);
  });
  await context.test('body stalls after headers', async () => {
    let cancelled = false;
    const { fetch } = recordingFetch(() => new Response(new ReadableStream({
      pull() { return new Promise(() => {}); },
      cancel() { cancelled = true; },
    }), { status: 200, headers: { 'cf-ray': RAY } }));
    const result = await verifyMigrationToken({ env: protectedEnv(), fetch, now: clock(), deadlineMs: 20 });
    assert.deepEqual([result.verification, result.httpStatus, result.cfRay], ['unavailable', 200, RAY]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(cancelled, true, 'the stalled body is cancelled');
  });
  for (const deadlineMs of [0, 1001, 1.5]) {
    await assert.rejects(verifyMigrationToken({ env: protectedEnv(), fetch: () => assert.fail('no request'), deadlineMs }));
  }
});

test('the operational guard precedes any token read or request', async () => {
  const outside = [
    { GITHUB_ACTIONS: 'false' }, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch' }, { PROTECTED_PRODUCTION_MIGRATION: '0' },
    { GITHUB_REPOSITORY: 'someone/agent-sessions-backup' }, { GITHUB_ACTIONS: undefined },
  ];
  for (const overrides of outside) {
    const env = protectedEnv(overrides);
    delete env.CLOUDFLARE_API_TOKEN;
    Object.defineProperty(env, 'CLOUDFLARE_API_TOKEN', { get: () => assert.fail('token read before the guard') });
    await assert.rejects(runMigrationAuthDiagnostics({ stage: 'preflight', env,
      fetch: () => assert.fail('request before the guard'), log: () => assert.fail('no event outside the guard'),
      createTelemetry: () => assert.fail('no sink outside the guard') }),
    { message: 'migration auth diagnostics require the protected main-push GitHub Actions job' });
  }
  for (const token of [undefined, '', 'with space', `line\n${CANARY}`, 'x'.repeat(4097)]) {
    const result = await verifyMigrationToken({ env: protectedEnv({ CLOUDFLARE_API_TOKEN: token }),
      fetch: () => assert.fail('no request without a usable token') });
    assert.deepEqual(result, { ...UNAVAILABLE, verification: 'not_configured', httpStatus: null, providerCodes: [],
      providerReason: 'unknown', cfRay: null, providerDate: null, requestDurationMs: null });
  }
  for (const stage of [undefined, 'copy', 'PREFLIGHT', 'copy-failure']) {
    await assert.rejects(runMigrationAuthDiagnostics({ stage, env: protectedEnv(),
      fetch: () => assert.fail('no request for an invalid stage') }));
  }
});

test('diagnostic run logs and delivers exactly one correlated event; sink faults never change it', async () => {
  for (const sinkFault of ['none', 'create', 'emit', 'close']) {
    const lines = [];
    const delivered = [];
    let closed = 0;
    const { fetch } = recordingFetch(() => verifyResponse({ success: false,
      errors: [{ code: 10000, message: 'Authentication error' }] }, 401));
    const event = await runMigrationAuthDiagnostics({
      stage: 'copy_failure', env: protectedEnv(), fetch, now: clock(1_792_172_571_000, 5), log: (line) => lines.push(line),
      createTelemetry: async ({ env }) => {
        assert.equal(env.GITHUB_RUN_ID, '38887942689');
        if (sinkFault === 'create') throw new Error(CANARY);
        return {
          emit(record) { delivered.push(record); if (sinkFault === 'emit') throw new Error(CANARY); },
          async close() { closed += 1; if (sinkFault === 'close') throw new Error(CANARY); },
        };
      },
    });
    assert.deepEqual(event, {
      event: 'migration.auth.diagnostic', schemaVersion: 1, recordedAt: '2026-10-16T17:42:51.015Z',
      stage: 'copy_failure', ...UNAVAILABLE, httpStatus: 401, providerCodes: [10000],
      providerReason: 'authentication', cfRay: RAY, providerDate: '2026-10-16T17:42:51.000Z', requestDurationMs: 5,
      revision: REVISION, runId: '38887942689', attempt: '2',
    });
    assert.deepEqual(lines.map((line) => JSON.parse(line)), [event]);
    assert.deepEqual(delivered, sinkFault === 'create' ? [] : [event]);
    assert.equal(closed, sinkFault === 'create' ? 0 : 1);
    assertPrivate(lines.join('\n'));
  }
  const uncorrelated = await runMigrationAuthDiagnostics({
    stage: 'preflight', env: protectedEnv({ GITHUB_SHA: CANARY, GITHUB_RUN_ID: '0', GITHUB_RUN_ATTEMPT: '1;x' }),
    fetch: recordingFetch(() => verifyResponse({ success: true, result: { status: 'active' } })).fetch,
    log: () => {}, createTelemetry: async () => null,
  });
  assert.deepEqual([uncorrelated.revision, uncorrelated.runId, uncorrelated.attempt], [null, null, null]);
});

test('actual diagnostics CLI enforces strict arguments and the guard, printing one safe event', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'migration-auth-diagnostics-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const preload = path.join(directory, 'preload.mjs');
  const requestLog = path.join(directory, 'requests.jsonl');
  // The preload replaces fetch before the CLI loads: no request leaves the process.
  await writeFile(preload, `
    import { appendFileSync } from 'node:fs';
    globalThis.fetch = async (url, init) => {
      appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify({ url: String(url), method: init.method,
        redirect: init.redirect, bearer: init.headers.authorization === 'Bearer ' + ${JSON.stringify(TOKEN)} }) + '\\n');
      return Response.json({ success: true, errors: [], messages: [],
        result: { id: ${JSON.stringify(CANARY)}, status: 'active', expires_on: '2026-11-15T23:59:59Z' } },
      { headers: { 'cf-ray': ${JSON.stringify(RAY)} } });
    };
  `);
  const run = async (args, env) => {
    await rm(requestLog, { force: true });
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, CLI, ...args], {
      encoding: 'utf8', timeout: 30_000,
      // Built from scratch: no inherited Cloudflare token or Azure sink configuration.
      env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1', ...env },
    });
    assert.ifError(result.error);
    let requests = [];
    try { requests = (await readFile(requestLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)); }
    catch { /* No request was made. */ }
    assertPrivate(`${result.stdout}${result.stderr}`);
    return { ...result, requests };
  };
  for (const args of [[], ['--stage'], ['--stage', 'unknown'], ['--stage', 'preflight', '--stage', 'preflight'],
    ['--stage=preflight'], ['--token', TOKEN], ['--stage', 'preflight', '--endpoint', 'https://example.invalid']]) {
    const result = await run(args, protectedEnv());
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'usage: migration-auth-diagnostics.mjs --stage preflight|copy_failure');
    assert.deepEqual(result.requests, []);
  }
  const outside = await run(['--stage', 'preflight'], protectedEnv({ GITHUB_EVENT_NAME: 'pull_request' }));
  assert.equal(outside.status, 1);
  assert.equal(outside.stdout, '');
  assert.deepEqual(outside.requests, []);
  for (const stage of ['preflight', 'copy_failure']) {
    const result = await run(['--stage', stage], protectedEnv());
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.requests, [{ url: VERIFY_URL, method: 'GET', redirect: 'error', bearer: true }]);
    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.length, 1);
    assert.deepEqual({ ...lines[0], recordedAt: undefined, requestDurationMs: undefined }, {
      event: 'migration.auth.diagnostic', schemaVersion: 1, recordedAt: undefined, stage,
      verification: 'active', tokenStatus: 'active', notBefore: null, expiresOn: '2026-11-15T23:59:59.000Z',
      httpStatus: 200, providerCodes: [], providerReason: 'unknown', cfRay: RAY, providerDate: null,
      requestDurationMs: undefined, revision: REVISION, runId: '38887942689', attempt: '2',
    });
  }
});

test('copy client failures carry bounded request context through phase annotation without new text', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let at = 1_792_172_000_000;
  const responses = [];
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init.body });
    const next = responses.shift();
    at += next.durationMs;
    return next.response();
  };
  const ok = (durationMs = 7) => ({ durationMs, response: () => Response.json({ success: true,
    result: [{ success: true, results: [{ value: '{}' }] }] }) });
  const waits = [];
  const client = indexControlClient(PREVIEW_ACCOUNT_ID, TOKEN, {
    permit: async () => {}, wait: async (delay) => { waits.push(delay); }, now: () => at,
  });
  const db = client.db(DATABASE_ID);
  const sql = `SELECT ${CANARY}`;
  const params = [CANARY, 'x'];

  responses.push(ok(7));
  await db.query(sql, params);
  const lastSuccess = at;
  responses.push({ durationMs: 37, response: () => Response.json({ success: false, errors: [
    { code: 10000, message: 'Authentication error' }, { code: 7500, message: CANARY }] },
  { status: 401, headers: { 'cf-ray': RAY, date: DATE } }) });
  const before = calls.length;
  let rejection;
  // Phase annotation adds only its existing suffix; typed fields survive on the same object.
  await assert.rejects(readCheckpoint(db, CANARY), (error) => { rejection = error; return true; });
  assert.equal(calls.length, before + 1, 'a credential rejection is never replayed');
  assert.equal(rejection.d1Phase, 'checkpoint-read');
  assert.ok(rejection.message.endsWith(' phase=checkpoint-read'));
  assertPrivate(`${rejection.message} ${rejection.stack} ${JSON.stringify(rejection)}`);
  const recordedAt = Date.UTC(2026, 9, 16, 17, 42, 51, 908);
  const event = migrationCopyFailureEvent(rejection, { recordedAt, copyPhase: 'copying' });
  const encoded = Buffer.byteLength(calls.at(-1).body, 'utf8');
  assert.deepEqual(event, {
    event: 'migration.copy.failure', schemaVersion: 1, recordedAt: '2026-10-16T17:42:51.908Z',
    phase: 'copying', operationPhase: 'checkpoint-read', failureKind: 'http', httpStatus: 401, providerCodes: [10000, 7500],
    providerReason: 'authentication', cfRay: RAY, providerDate: '2026-10-16T17:42:51.000Z',
    requestDurationMs: 37, requestAttempt: 1, lastSuccessfulRequestAt: new Date(lastSuccess).toISOString(),
    statementCount: 1, parameterCount: 1, bodyBytes: encoded,
    parameterJsonBytes: Buffer.byteLength(JSON.stringify([CANARY]), 'utf8'), databaseId: DATABASE_ID,
  });
  assertPrivate(event);

  // An HTTP 200 whose statement failed is not a successful request.
  responses.push({ durationMs: 3, response: () => Response.json({ success: true,
    result: [{ success: false, error: `no such table: ${CANARY}` }] }) });
  await assert.rejects(db.batch([{ sql, params }, { sql, params: [] }]), (error) => {
    const statement = migrationCopyFailureEvent(error, { recordedAt });
    assert.deepEqual([statement.phase, statement.operationPhase, statement.failureKind, statement.httpStatus,
      statement.providerReason, statement.requestDurationMs, statement.statementCount, statement.parameterCount,
      statement.lastSuccessfulRequestAt],
    ['unknown', 'unknown', 'provider', 200, 'unknown', 3, 2, 2, new Date(lastSuccess).toISOString()]);
    assertPrivate(statement);
    return true;
  });

  // Only the failed attempt is timed; an earlier unambiguous 429 counts as an attempt.
  responses.push({ durationMs: 2, response: () => new Response(null, { status: 429, headers: { 'retry-after': '1' } }) });
  responses.push({ durationMs: 11, response: () => { throw new TypeError(`fetch failed ${CANARY}`); } });
  await assert.rejects(db.query(sql, params), (error) => {
    const transport = migrationCopyFailureEvent(error, { recordedAt });
    assert.deepEqual([transport.failureKind, transport.httpStatus, transport.requestAttempt, transport.requestDurationMs,
      transport.providerReason, transport.cfRay, transport.providerDate],
    ['network', null, 2, 11, 'unknown', null, null]);
    assertPrivate(transport);
    return true;
  });
  assert.deepEqual(waits, [1000]);
});

test('copy failure events trust only typed redacted D1 metadata and closed vocabularies', () => {
  const recordedAt = Date.UTC(2026, 9, 16);
  const empty = {
    httpStatus: null, providerCodes: [], providerReason: 'unknown', cfRay: null, providerDate: null,
    requestDurationMs: null, requestAttempt: null, lastSuccessfulRequestAt: null, statementCount: null,
    parameterCount: null, bodyBytes: null, parameterJsonBytes: null, databaseId: null,
  };
  const untyped = Object.assign(new Error(CANARY), {
    d1Phase: 'copy-checkpoint-write', providerStatus: 401, providerCodes: [10000], providerReason: 'token_expired',
    providerRay: RAY, d1FailureKind: 'http', databaseId: DATABASE_ID, statementCount: 1,
  });
  assert.deepEqual(migrationCopyFailureEvent(untyped, { recordedAt, copyPhase: 'retiring' }), {
    event: 'migration.copy.failure', schemaVersion: 1, recordedAt: '2026-10-16T00:00:00.000Z',
    phase: 'retiring', operationPhase: 'copy-checkpoint-write', failureKind: 'unknown', ...empty,
  }, 'an untyped error cannot assert provider or credential context');
  const invariant = Object.assign(new Error(CANARY), { code: 'checkpoint-fence', d1Phase: 'copy-checkpoint-write' });
  assert.equal(migrationCopyFailureEvent(invariant, { recordedAt }).failureKind, 'invariant');
  const hostile = Object.assign(new Error(CANARY), {
    d1Diagnostic: true, d1Phase: CANARY, d1FailureKind: '__proto__', providerStatus: 99,
    providerCodes: [1, -1, 1.5, CANARY, ...Array.from({ length: 20 }, (_, index) => index + 2)],
    providerReason: CANARY, providerRay: `${RAY}\n${CANARY}`, providerDate: '2026-10-16T17:42:51Z',
    requestDurationMs: -1, requestAttempt: 0, lastSuccessfulRequestAtMs: CANARY, statementCount: 1.5,
    parameterCount: Number.MAX_SAFE_INTEGER + 1, bodyBytes: '12', parameterJsonBytes: null, databaseId: CANARY,
  });
  const sanitized = migrationCopyFailureEvent(hostile, { recordedAt, copyPhase: CANARY });
  assert.deepEqual(sanitized, {
    event: 'migration.copy.failure', schemaVersion: 1, recordedAt: '2026-10-16T00:00:00.000Z',
    phase: 'unknown', operationPhase: 'unknown', failureKind: 'unknown', ...empty,
    providerCodes: [1, ...Array.from({ length: 15 }, (_, index) => index + 2)],
  });
  assertPrivate(sanitized);
  assert.deepEqual(migrationCopyFailureEvent(undefined, { recordedAt, copyPhase: 'copy-checkpoint-write' }), {
    event: 'migration.copy.failure', schemaVersion: 1, recordedAt: '2026-10-16T00:00:00.000Z',
    phase: 'unknown', operationPhase: 'unknown', failureKind: 'unknown', ...empty,
  });
});
