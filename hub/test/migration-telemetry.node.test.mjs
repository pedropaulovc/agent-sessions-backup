import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as immediate } from 'node:timers/promises';
import { createMigrationTelemetry, migrationTelemetryEvent } from '../../infra/azure/migration-telemetry.mjs';
import { migrationFederationPlan, provisionMigrationFederation } from '../../infra/azure/provision-migration-federation.mjs';

const env = {
  MIGRATION_AZURE_TENANT_ID: '6f10d2eb-7cce-444c-bf11-d6fe61d7b8f8',
  MIGRATION_AZURE_CLIENT_ID: '39e31290-fc09-4ab4-83bf-018433c2ef2e',
  MIGRATION_AZURE_LOGS_ENDPOINT: 'https://dce-agent-backup-payj.westus2-1.ingest.monitor.azure.com/dataCollectionRules/dcr-cf864bcaac834a3da25f1ae1fa86a408/streams/Microsoft-OTLP-Logs/otlp/v1/logs',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/oidc/token?api-version=2.0',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'private-github-request-token',
};
const initial = Date.parse('2026-10-16T16:00:00.000Z');
const progress = (changes = {}) => ({
  event: 'migration.copy.progress', schemaVersion: 1, status: 'running', phase: 'copying',
  recordedAt: new Date(initial).toISOString(), revision: 'c'.repeat(40), runId: '38887942689', attempt: '2',
  acknowledgedRows: null, passRows: null, pendingRows: null, elapsedMs: 0,
  rowsPerSecond: null, remainingRows: null, etaSeconds: null, lastProgressAt: null, ...changes,
});
const provider = {
  httpStatus: 401, providerCodes: [10000], providerReason: 'authentication',
  cfRay: 'a4b8dcbe9f86579a-IAD', providerDate: new Date(initial).toISOString(), requestDurationMs: 25,
};
const failure = (changes = {}) => ({
  event: 'migration.copy.failure', schemaVersion: 1,
  recordedAt: new Date(initial).toISOString(), revision: 'c'.repeat(40), runId: '38887942689', attempt: '2',
  phase: 'retiring', operationPhase: 'copy-checkpoint-write', failureKind: 'http', ...provider, requestAttempt: 1,
  lastSuccessfulRequestAt: new Date(initial - 500).toISOString(),
  statementCount: 1, parameterCount: 3, bodyBytes: 240, parameterJsonBytes: 120,
  databaseId: '11111111-2222-3333-4444-555555555555', ...changes,
});
const auth = (changes = {}) => ({
  event: 'migration.auth.diagnostic', schemaVersion: 1,
  recordedAt: new Date(initial).toISOString(), revision: 'c'.repeat(40), runId: '38887942689', attempt: '2',
  stage: 'preflight', verification: 'active', tokenStatus: 'active',
  notBefore: '2026-10-14T00:00:00.000Z', expiresOn: '2026-11-15T00:00:00.000Z',
  ...provider, httpStatus: 200, providerCodes: [], providerReason: 'unknown', ...changes,
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
function fields(bytes) {
  let offset = 0;
  const varint = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[offset++];
      assert.notEqual(byte, undefined);
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
      shift += 7;
    }
  };
  const result = [];
  while (offset < bytes.length) {
    const tag = varint();
    const wire = tag & 7;
    const number = tag >>> 3;
    if (wire === 2) {
      const length = varint();
      result.push({ number, bytes: bytes.subarray(offset, offset + length) });
      offset += length;
    } else if (wire === 0) varint();
    else if (wire === 1) offset += 8;
    else if (wire === 5) offset += 4;
    else assert.fail(`unexpected protobuf wire type ${wire}`);
  }
  return result;
}
function logBody(bytes) {
  for (const number of [1, 2, 2, 5, 1]) {
    bytes = fields(bytes).find((field) => field.number === number)?.bytes;
    assert.ok(bytes, `required protobuf field ${number}`);
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
function logBodies(bytes) {
  for (const number of [1, 2]) {
    bytes = fields(bytes).find((field) => field.number === number)?.bytes;
    assert.ok(bytes, `required protobuf field ${number}`);
  }
  return fields(bytes).filter((field) => field.number === 2).map((record) => {
    let value = record.bytes;
    for (const number of [5, 1]) value = fields(value).find((field) => field.number === number)?.bytes;
    assert.ok(value, 'required log body');
    return JSON.parse(new TextDecoder().decode(value));
  });
}

test('privacy allowlist preserves unknown counters, strips contents and rejects invalid aggregate evidence', () => {
  const event = migrationTelemetryEvent(progress({ session: 'private session text', rowId: 'private ID', error: new Error('secret') }));
  assert.equal(event.acknowledgedRows, null);
  assert.equal(event.passRows, null);
  assert.equal(event.remainingRows, null);
  assert.equal(Object.hasOwn(event, 'session'), false);
  assert.equal(Object.hasOwn(event, 'rowId'), false);
  assert.equal(Object.hasOwn(event, 'error'), false);
  assert.ok(Object.isFrozen(event));
  for (const changes of [{ acknowledgedRows: -1 }, { pendingRows: NaN }, { passRows: 0.5 },
    { phase: 'private-session-name' }, { revision: 'private revision' }, { runId: null },
    { elapsedMs: null }, { lastProgressAt: 'private text' }, { etaSeconds: Infinity }]) {
    assert.equal(migrationTelemetryEvent(progress(changes)), null);
  }
  assert.equal(migrationTelemetryEvent(progress({ acknowledgedRows: 0 })).acknowledgedRows, 0);
});

test('finite failure and auth allowlists preserve safe context without accepting raw provider data', () => {
  const secrets = { Authorization: 'private bearer', tokenId: 'private token id',
    message: 'private provider message', body: 'private response', sql: 'private SQL',
    params: ['private parameter'], session: 'private session', url: 'https://private.test/?token=private' };
  const codes = [10000];
  const event = migrationTelemetryEvent(failure({ ...secrets, providerCodes: codes }));
  assert.equal(event.phase, 'retiring');
  assert.equal(event.operationPhase, 'copy-checkpoint-write');
  assert.equal(event.httpStatus, 401);
  assert.equal(event.providerReason, 'authentication', '401 is not evidence of token expiry');
  assert.ok(Object.isFrozen(event));
  assert.ok(Object.isFrozen(event.providerCodes));
  codes[0] = 999;
  assert.deepEqual(event.providerCodes, [10000], 'the queue owns a bounded immutable copy');
  for (const key of Object.keys(secrets)) assert.equal(Object.hasOwn(event, key), false);
  const diagnostic = migrationTelemetryEvent(auth(secrets));
  assert.equal(diagnostic.verification, 'active');
  assert.equal(diagnostic.tokenStatus, 'active');
  assert.equal(diagnostic.notBefore, '2026-10-14T00:00:00.000Z');
  assert.equal(diagnostic.expiresOn, '2026-11-15T00:00:00.000Z');
  assert.doesNotMatch(JSON.stringify([event, diagnostic]), /private|Authorization|tokenId/);
  for (const verification of ['unavailable', 'not_configured']) {
    assert.ok(migrationTelemetryEvent(auth({ verification, tokenStatus: null, notBefore: null, expiresOn: null })));
  }
  assert.ok(migrationTelemetryEvent(auth({ verification: 'inactive', tokenStatus: 'expired' })));
});

test('diagnostic bounds reject malformed correlation, statuses, dates, provider codes and request context', () => {
  const invalid = [{ schemaVersion: 2 }, { revision: null }, { runId: '0' }, { attempt: '0' },
    { recordedAt: '2026-10-16T16:00:00Z' }, { httpStatus: 99 }, { httpStatus: 600 }, { httpStatus: '401' },
    { providerCodes: [10000, 'secret'] }, { providerCodes: Array(1) }, { providerCodes: Array(17).fill(1) },
    { providerCodes: [-1] }, { providerCodes: [Infinity] }, { providerCodes: [Number.MAX_SAFE_INTEGER + 1] },
    { providerReason: 'private provider text' }, { cfRay: 'private ray' }, { cfRay: 'a4b8dcbe9f86579a-IAD?token=secret' },
    { providerDate: 'Fri, 16 Oct 2026 16:00:00 GMT' }, { requestDurationMs: -1 }, { requestDurationMs: Infinity }];
  for (const changes of invalid) {
    assert.equal(migrationTelemetryEvent(failure(changes)), null, JSON.stringify(changes));
    assert.equal(migrationTelemetryEvent(auth(changes)), null, JSON.stringify(changes));
  }
  for (const changes of [{ phase: 'copy-checkpoint-write' }, { phase: 'private phase' },
    { operationPhase: 'copying' }, { operationPhase: undefined }, { operationPhase: 'private operation' }, { failureKind: 'private error' },
    { requestAttempt: 0 }, { requestAttempt: 1.5 }, { lastSuccessfulRequestAt: 'private date' },
    { statementCount: -1 }, { parameterCount: 0.5 }, { bodyBytes: NaN }, { parameterJsonBytes: '120' },
    { databaseId: 'private database' }]) assert.equal(migrationTelemetryEvent(failure(changes)), null);
  for (const changes of [{ stage: 'private stage' }, { verification: 'valid' }, { tokenStatus: 'private token' },
    { verification: 'active', tokenStatus: 'disabled' }, { verification: 'inactive', tokenStatus: 'active' },
    { verification: 'unavailable', tokenStatus: 'active' }, { notBefore: 'private date' },
    { expiresOn: '2026-11-15' }]) assert.equal(migrationTelemetryEvent(auth(changes)), null);
  const unknown = migrationTelemetryEvent(failure({ phase: 'unknown', operationPhase: 'unknown', failureKind: 'unknown', httpStatus: null,
    providerCodes: [], providerReason: 'unknown', cfRay: null, providerDate: null, requestDurationMs: null,
    requestAttempt: null, lastSuccessfulRequestAt: null, statementCount: null, parameterCount: null,
    bodyBytes: null, parameterJsonBytes: null, databaseId: null }));
  assert.equal(unknown.requestAttempt, null);
  assert.equal(unknown.databaseId, null);
});

test('absent credentials and unsafe endpoint boundaries perform no network and emit only typed warnings', async () => {
  const endpoints = [env.MIGRATION_AZURE_LOGS_ENDPOINT.replace('https:', 'http:'),
    env.MIGRATION_AZURE_LOGS_ENDPOINT.replace('.azure.com', '.azure.com.evil.test'),
    env.MIGRATION_AZURE_LOGS_ENDPOINT.replace('https://', 'https://user:pass@'),
    `${env.MIGRATION_AZURE_LOGS_ENDPOINT}?token=secret`,
    env.MIGRATION_AZURE_LOGS_ENDPOINT.replace('Microsoft-OTLP-Logs', 'Microsoft-OTLP-Traces')];
  for (const config of [{}, ...endpoints.map((endpoint) => ({ ...env, MIGRATION_AZURE_LOGS_ENDPOINT: endpoint })),
    { ...env, ACTIONS_ID_TOKEN_REQUEST_URL: 'https://evil.test/oidc' },
    { ...env, ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined, MIGRATION_AZURE_ACCESS_TOKEN: 'not-an-auth-bypass' }]) {
    const warnings = [];
    const sink = await createMigrationTelemetry({ env: config, warn: (event) => warnings.push(event),
      fetch() { assert.fail('invalid configuration must not fetch'); } });
    sink.emit(progress());
    await sink.close();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].code, /^(configuration-absent|configuration-invalid|github-oidc-unavailable)$/);
    assert.doesNotMatch(JSON.stringify(warnings), /pass|secret|private|evil/);
  }
});

test('GitHub OIDC audience, Entra scope, cached token and expiry refresh use the actual protobuf sink', async () => {
  let time = initial;
  let assertions = 0;
  let exchanges = 0;
  const bodies = [];
  let accepted = deferred();
  const sink = await createMigrationTelemetry({ env, now: () => time, warn(event) { assert.fail(JSON.stringify(event)); },
    async fetch(url, options) {
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      if (url.startsWith('https://pipelines.actions.githubusercontent.com/')) {
        assertions += 1;
        assert.equal(new URL(url).searchParams.get('audience'), 'api://AzureADTokenExchange');
        assert.equal(options.headers.Authorization, `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`);
        return Response.json({ value: `private-assertion-${assertions}` });
      }
      if (url.startsWith('https://login.microsoftonline.com/')) {
        exchanges += 1;
        assert.equal(url, `https://login.microsoftonline.com/${env.MIGRATION_AZURE_TENANT_ID}/oauth2/v2.0/token`);
        const body = new URLSearchParams(options.body);
        assert.equal(body.get('scope'), 'https://monitor.azure.com/.default');
        assert.equal(body.get('client_id'), env.MIGRATION_AZURE_CLIENT_ID);
        assert.equal(body.get('client_assertion'), `private-assertion-${assertions}`);
        return Response.json({ access_token: `private-entra-${exchanges}`, expires_in: 3600 });
      }
      assert.equal(url, env.MIGRATION_AZURE_LOGS_ENDPOINT);
      assert.equal(options.headers['Content-Type'], 'application/x-protobuf');
      assert.equal(options.headers.Authorization, `Bearer private-entra-${exchanges}`);
      assert.ok(options.body instanceof Uint8Array);
      bodies.push(logBody(options.body));
      accepted.resolve();
      return new Response(null, { status: 204 });
    },
  });
  const deliver = async () => {
    accepted = deferred();
    sink.emit(progress({ recordedAt: new Date(time).toISOString(), elapsedMs: time - initial }));
    await accepted.promise;
    await immediate();
  };
  await deliver();
  time += 3539_000;
  await deliver();
  assert.equal(exchanges, 1, 'cached token remains valid before refresh margin');
  time += 2000;
  await deliver();
  assert.equal(exchanges, 2, 'refreshes before expiry rather than reusing a 5-hour-old token');
  for (let hour = 1; hour <= 5; hour += 1) { time += 3600_000; await deliver(); }
  await sink.close();
  assert.equal(assertions, 7);
  assert.equal(exchanges, 7);
  assert.equal(bodies.length, 8);
  assert.equal(bodies[0].acknowledgedRows, null);
  assert.equal(bodies[0].remainingRows, null);
});

test('eager cold two-hop authentication leaves the one-shot close budget for protobuf ingestion', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let time = initial;
  let ready = false;
  const entered = { github: deferred(), entra: deferred(), ingest: deferred() };
  const requests = [];
  const bodies = [];
  const warnings = [];
  const creating = createMigrationTelemetry({ env, authentication: 'eager', now: () => time,
    warn: (event) => warnings.push(event), fetch(url, options) {
      const stage = url.includes('actions.githubusercontent.com') ? 'github'
        : url.includes('login.microsoftonline.com') ? 'entra' : 'ingest';
      requests.push({ stage, started: time - initial });
      if (stage === 'ingest') bodies.push(...logBodies(options.body));
      const response = stage === 'github' ? Response.json({ value: 'private-assertion' })
        : stage === 'entra' ? Response.json({ access_token: 'private-token', expires_in: 3600 })
          : new Response(null, { status: 204 });
      const result = new Promise((resolve) => setTimeout(() => resolve(response), 550));
      entered[stage].resolve();
      return result;
    },
  }).then((sink) => { ready = true; return sink; });
  await Promise.race([entered.github.promise,
    creating.then(() => assert.fail('eager creation must enter authentication before returning'))]);
  time += 550;
  t.mock.timers.tick(550);
  await entered.entra.promise;
  assert.equal(ready, false, 'the second healthy authentication hop must finish before returning');
  time += 550;
  t.mock.timers.tick(550);
  const sink = await creating;
  assert.deepEqual(requests, [{ stage: 'github', started: 0 }, { stage: 'entra', started: 550 }]);
  sink.emit(auth());
  const closing = sink.close();
  await entered.ingest.promise;
  time += 550;
  t.mock.timers.tick(550);
  await closing;
  assert.deepEqual(requests, [
    { stage: 'github', started: 0 }, { stage: 'entra', started: 550 }, { stage: 'ingest', started: 1100 },
  ]);
  assert.deepEqual(bodies, [migrationTelemetryEvent(auth())]);
  assert.deepEqual(warnings, []);
});

test('eager authentication failures are sanitized and never retried by later event batches', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const stage of ['github', 'entra', 'injected-rejection', 'injected-deadline']) {
    const warnings = [];
    const attempts = { github: 0, entra: 0, injected: 0, ingest: 0 };
    const entered = deferred();
    const held = deferred();
    const creating = createMigrationTelemetry({ env, authentication: 'eager',
      warn: (event) => warnings.push(event),
      ...(stage.startsWith('injected') ? { getAccessToken: async () => {
        attempts.injected += 1;
        entered.resolve();
        if (stage === 'injected-deadline') return held.promise; // Ignores abort.
        throw Object.assign(new Error('private startup exception'), { code: 'private code', status: 599 });
      } } : {}),
      async fetch(url) {
        const current = url.includes('actions.githubusercontent.com') ? 'github'
          : url.includes('login.microsoftonline.com') ? 'entra' : 'ingest';
        attempts[current] += 1;
        if (current === stage) return new Response('private provider response', { status: 403 });
        if (current === 'github') return Response.json({ value: 'private-assertion' });
        if (current === 'entra') return Response.json({ access_token: 'private-token', expires_in: 3600 });
        return new Response(null, { status: 204 });
      },
    });
    if (stage === 'injected-deadline') {
      await entered.promise;
      t.mock.timers.tick(1000);
    }
    const sink = await creating;
    const expected = { github: stage === 'github' || stage === 'entra' ? 1 : 0,
      entra: stage === 'entra' ? 1 : 0, injected: stage.startsWith('injected') ? 1 : 0, ingest: 0 };
    assert.deepEqual(attempts, expected, `${stage}: exactly one startup identity attempt`);
    assert.deepEqual(warnings, [], 'startup failure is accounted against events, not a fictional delivery');
    sink.emit(auth());
    await immediate();
    sink.emit(auth({ stage: 'copy_failure' }));
    await sink.close();
    if (stage === 'injected-deadline') {
      held.resolve('private-late-token');
      await immediate();
    }
    assert.deepEqual(attempts, expected, `${stage}: emit/send cannot retry startup authentication or ingest`);
    const summary = warnings.find((event) => event.code === 'delivery-summary');
    assert.ok(summary);
    assert.equal(summary.sentEvents, 0);
    assert.equal(summary.failedEvents, 2);
    assert.equal(summary.abandonedEvents, 0);
    const code = stage === 'github' ? 'github-oidc-http' : stage === 'entra' ? 'entra-http'
      : stage === 'injected-deadline' ? 'request-deadline' : 'transport-failed';
    assert.ok(warnings.some((event) => event.code === code));
    assert.equal(warnings.find((event) => event.code === code).httpStatus,
      stage === 'github' || stage === 'entra' ? 403 : undefined);
    assert.doesNotMatch(JSON.stringify(warnings), /private|assertion|bearer|599/);
  }
});

test('oversized authentication responses and invalid token expiry never reach ingestion', async () => {
  for (const malformed of ['oversized-assertion', 'missing-token', 'short-expiry', 'string-expiry', 'header-injection']) {
    const warnings = [];
    let ingestions = 0;
    const sink = await createMigrationTelemetry({ env, warn: (event) => warnings.push(event),
      async fetch(url) {
        if (url.includes('actions.githubusercontent.com')) return Response.json({
          value: malformed === 'oversized-assertion' ? 'x'.repeat(70_000) : 'private-assertion',
        });
        if (url.includes('login.microsoftonline.com')) return Response.json({
          access_token: malformed === 'missing-token' ? undefined
            : malformed === 'header-injection' ? 'private\r\nheader' : 'private-entra-token',
          expires_in: malformed === 'short-expiry' ? 60 : malformed === 'string-expiry' ? '3600' : 3600,
        });
        ingestions += 1;
        return new Response(null, { status: 204 });
      },
    });
    sink.emit(progress());
    await sink.close();
    assert.equal(ingestions, 0, malformed);
    assert.ok(warnings.some((event) => event.code === 'invalid-auth-response'), malformed);
    assert.doesNotMatch(JSON.stringify(warnings), /private-assertion|private-entra|header/);
  }
});

test('one in-flight ingestion coalesces to newest immutable progress without delaying emit', async () => {
  const entered = deferred();
  const release = deferred();
  const bodies = [];
  let active = 0;
  let maximum = 0;
  const warnings = [];
  const sink = await createMigrationTelemetry({ env, getAccessToken: async () => 'private-smoke-token',
    warn: (event) => warnings.push(event), async fetch(_url, options) {
      active += 1;
      maximum = Math.max(maximum, active);
      bodies.push(logBody(options.body));
      if (bodies.length === 1) { entered.resolve(); await release.promise; }
      active -= 1;
      return new Response(null, { status: 204 });
    },
  });
  sink.emit(progress({ acknowledgedRows: 1 }));
  await entered.promise;
  const mutable = progress({ acknowledgedRows: 2 });
  for (let count = 2; count <= 100; count += 1) { mutable.acknowledgedRows = count; sink.emit(mutable); }
  mutable.acknowledgedRows = 999;
  release.resolve();
  await sink.close();
  assert.equal(maximum, 1);
  assert.deepEqual(bodies.map((body) => body.acknowledgedRows), [1, 100]);
  assert.equal(warnings.find((event) => event.code === 'delivery-summary').coalescedEvents, 98);
});

test('bounded priority batches preserve failure and both auth stages independently of heartbeat coalescing', async () => {
  const entered = deferred();
  const release = deferred();
  const requests = [];
  const warnings = [];
  let active = 0;
  let maximum = 0;
  const sink = await createMigrationTelemetry({ env, getAccessToken: async () => 'private-token',
    warn: (event) => warnings.push(event), async fetch(_url, options) {
      active += 1;
      maximum = Math.max(maximum, active);
      assert.ok(options.body.byteLength <= 16 * 1024);
      requests.push(logBodies(options.body));
      if (requests.length === 1) { entered.resolve(); await release.promise; }
      active -= 1;
      return new Response(null, { status: 204 });
    },
  });
  sink.emit(progress({ acknowledgedRows: 1 }));
  await entered.promise;
  for (let count = 1; count <= 100; count += 1) {
    sink.emit(failure({ requestAttempt: count }));
    sink.emit(auth({ stage: 'preflight' }));
    sink.emit(auth({ stage: 'copy_failure' }));
    sink.emit(progress({ acknowledgedRows: count, status: count === 100 ? 'failed' : 'running' }));
  }
  release.resolve();
  await sink.close();
  assert.equal(maximum, 1);
  assert.equal(requests.length, 2, 'one initial request and one bounded flush, not per-record network work');
  assert.deepEqual(requests[1].map((event) => [event.event, event.stage ?? event.status]), [
    ['migration.copy.failure', undefined], ['migration.auth.diagnostic', 'copy_failure'],
    ['migration.auth.diagnostic', 'preflight'], ['migration.copy.progress', 'failed'],
  ]);
  assert.equal(requests[1][0].requestAttempt, 100);
  assert.equal(requests[1][3].acknowledgedRows, 100);
  assert.equal(warnings.find((event) => event.code === 'delivery-summary').coalescedEvents, 396);
});

test('adjacent terminal failure and failed progress share one request without replacing each other or retrying', async () => {
  for (const status of [204, 403]) {
    const requests = [];
    const warnings = [];
    const sink = await createMigrationTelemetry({ env, getAccessToken: async () => 'private-token',
      warn: (event) => warnings.push(event), async fetch(_url, options) {
        requests.push(logBodies(options.body));
        return new Response(status === 204 ? null : 'private provider response', { status });
      },
    });
    sink.emit(progress({ status: 'failed' }));
    sink.emit(failure());
    await sink.close();
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].map((event) => event.event), ['migration.copy.failure', 'migration.copy.progress']);
    assert.equal(warnings.some((event) => event.code === 'event-invalid'), false);
    if (status === 403) assert.equal(warnings.find((event) => event.code === 'delivery-summary').failedEvents, 2);
    assert.doesNotMatch(JSON.stringify(warnings), /private/);
  }
});

test('maximum bounded diagnostic fields remain complete original JSON within the existing transport cap', async () => {
  const maximum = Number.MAX_SAFE_INTEGER;
  const context = { providerCodes: Array(16).fill(maximum), requestDurationMs: maximum };
  const records = [
    failure({ ...context, requestAttempt: maximum, statementCount: maximum, parameterCount: maximum,
      bodyBytes: maximum, parameterJsonBytes: maximum }),
    auth({ ...context, stage: 'copy_failure' }),
    auth(context),
    progress({ status: 'failed', acknowledgedRows: maximum, passRows: maximum,
      pendingRows: maximum, remainingRows: maximum, elapsedMs: maximum,
      rowsPerSecond: maximum, etaSeconds: maximum }),
  ];
  const requests = [];
  const sink = await createMigrationTelemetry({ env, getAccessToken: async () => 'private-token', warn: assert.fail,
    async fetch(_url, options) {
      assert.ok(options.body.byteLength <= 16 * 1024);
      requests.push(logBodies(options.body));
      return new Response(null, { status: 204 });
    },
  });
  for (const record of records) sink.emit(record);
  await sink.close();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], records.map(migrationTelemetryEvent), 'the shared encoder must not truncate diagnostic JSON');
});

test('authorization failures drop without replay and never reveal response or exception text', async () => {
  const warnings = [];
  let requests = 0;
  const sink = await createMigrationTelemetry({ env, warn: (event) => warnings.push(event),
    getAccessToken: async () => 'private-access-token', async fetch() {
      requests += 1;
      return new Response('private response with session and bearer', { status: 403 });
    },
  });
  sink.emit(progress());
  await sink.close();
  assert.equal(requests, 1, 'no retry or replay loop');
  assert.ok(warnings.some((event) => event.code === 'ingest-http' && event.httpStatus === 403));
  assert.doesNotMatch(JSON.stringify(warnings), /private|session|bearer|access-token/);
  const rejected = await createMigrationTelemetry({ env, warn: (event) => warnings.push(event),
    getAccessToken: async () => { throw new Error('private exception'); }, fetch() { assert.fail('auth failure cannot ingest'); } });
  rejected.emit(progress());
  await rejected.close();
  assert.ok(warnings.some((event) => event.code === 'transport-failed'));
  assert.doesNotMatch(JSON.stringify(warnings), /private exception/);
});

test('hung network and throwing diagnostics cannot hang close or mask the caller error', async () => {
  const entered = deferred();
  const sink = await createMigrationTelemetry({ env, getAccessToken: async () => 'private-token',
    warn() { throw new Error('diagnostic failure'); }, fetch(_url, options) {
      entered.resolve();
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('private abort')), { once: true }));
    },
  });
  sink.emit(progress());
  await entered.promise;
  const started = Date.now();
  const primary = new Error('primary migration failure');
  await assert.rejects(async () => { try { throw primary; } finally { await sink.close(); } }, (error) => error === primary);
  assert.ok(Date.now() - started < 1800, 'close is bounded independently of network');
  sink.emit(progress({ acknowledgedRows: 1 }));
});

test('close accounts in-flight and all pending records once and remains terminal after late settlements', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const outcome of ['resolve', 'reject', 'request-deadline']) {
    let time = initial;
    const identityEntered = deferred();
    const identity = deferred();
    const ingestEntered = deferred();
    const held = deferred();
    const warnings = [];
    const requests = [];
    const sink = await createMigrationTelemetry({ env, now: () => time,
      getAccessToken: async () => {
        identityEntered.resolve();
        return identity.promise;
      },
      warn: (event) => warnings.push(event), fetch(_url, options) {
        requests.push({ records: logBodies(options.body), signal: options.signal });
        ingestEntered.resolve();
        return held.promise; // Intentionally ignores the close abort.
      },
    });
    sink.emit(progress({ acknowledgedRows: 1 }));
    await identityEntered.promise;
    sink.emit(progress({ acknowledgedRows: 2 }));
    sink.emit(progress({ acknowledgedRows: 3 }));
    sink.emit(failure());
    sink.emit(auth());
    sink.emit(auth({ stage: 'copy_failure' }));
    const closing = sink.close();
    const alsoClosing = sink.close();
    // Start ingestion later than close so its independent request deadline
    // cannot win the race and misclassify the still-unknown in-flight outcome.
    time += 250;
    t.mock.timers.tick(250);
    identity.resolve('private-token');
    await ingestEntered.promise;
    time += 750;
    t.mock.timers.tick(750);
    await Promise.all([closing, alsoClosing]);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].records, [migrationTelemetryEvent(progress({ acknowledgedRows: 1 }))]);
    assert.equal(requests[0].signal.aborted, true);
    assert.deepEqual(warnings.map((event) => event.code), ['close-deadline', 'delivery-summary']);
    for (const warning of warnings) {
      assert.equal(warning.sentEvents, 0);
      assert.equal(warning.failedEvents, 0, 'an abandoned in-flight outcome is not a confirmed failure');
      assert.equal(warning.abandonedEvents, 5, 'one in-flight record plus four pending kinds/stages');
      assert.equal(warning.coalescedEvents, 1);
      assert.equal(warning.droppedEvents, 0);
    }
    const atClose = JSON.stringify(warnings);
    if (outcome === 'request-deadline') {
      time += 250;
      t.mock.timers.tick(250);
      await immediate();
    }
    if (outcome === 'reject') held.reject(new Error('private late transport error'));
    else held.resolve(new Response(null, { status: 204 }));
    await immediate();
    await immediate();
    time += 2000;
    t.mock.timers.tick(2000);
    await immediate();
    sink.emit(progress({ acknowledgedRows: 100 }));
    sink.emit({ invalid: true });
    await sink.close();
    assert.equal(JSON.stringify(warnings), atClose, `${outcome}: no late accounting or repeated summary`);
    assert.equal(requests.length, 1, `${outcome}: pending evidence must not replay after close`);
  }
});

test('close is a quiescent diagnostics boundary even when authentication or ingestion ignores abort', async () => {
  for (const stage of ['github', 'entra', 'ingest']) {
    for (const outcome of ['resolve', 'reject']) {
      const entered = deferred();
      const held = deferred();
      const warnings = [];
      const requests = [];
      const sink = await createMigrationTelemetry({ env, warn: (event) => warnings.push(event),
        ...(stage === 'ingest' ? { getAccessToken: async () => 'private-smoke-token' } : {}),
        async fetch(url) {
          requests.push(url);
          const current = url.includes('actions.githubusercontent.com') ? 'github'
            : url.includes('login.microsoftonline.com') ? 'entra' : 'ingest';
          if (current === stage) {
            entered.resolve();
            return held.promise; // Intentionally ignores AbortSignal.
          }
          if (current === 'github') return Response.json({ value: 'private-assertion' });
          if (current === 'entra') return Response.json({ access_token: 'private-token', expires_in: 3600 });
          return new Response(null, { status: 204 });
        },
      });
      sink.emit(progress());
      sink.emit(failure());
      sink.emit(auth({ stage: 'copy_failure' }));
      // Start close before the later auth/ingest stages are entered, exercising
      // its earlier total deadline rather than only the per-request timeout.
      const closing = sink.close();
      await entered.promise;
      await closing;
      const diagnosticsAtClose = JSON.stringify(warnings);
      const requestsAtClose = requests.length;
      assert.ok(warnings.some((event) => event.code === 'close-deadline' || event.code === 'request-deadline'));
      if (outcome === 'reject') held.reject(new Error('private late network failure'));
      else held.resolve(stage === 'github' ? Response.json({ value: 'private-assertion' })
        : stage === 'entra' ? Response.json({ access_token: 'private-token', expires_in: 3600 })
          : new Response(null, { status: 204 }));
      await immediate();
      await immediate();
      sink.emit(progress({ acknowledgedRows: 100 }));
      await sink.close();
      assert.equal(JSON.stringify(warnings), diagnosticsAtClose, `${stage}/${outcome}: late diagnostics`);
      assert.equal(requests.length, requestsAtClose, `${stage}/${outcome}: HTTP issued after close`);
    }
  }
});

test('federation planning is idempotent and refuses changing existing trust', () => {
  const worker = { name: 'cf-worker-federation', issuer: 'https://existing-worker.test', subject: 'existing-worker', audiences: ['existing'] };
  assert.equal(migrationFederationPlan([worker]), 'create');
  const migration = { name: 'migration-github-production', issuer: 'https://token.actions.githubusercontent.com',
    subject: 'repo:pedropaulovc@577970/agent-sessions-backup@1303581136:environment:production', audiences: ['api://AzureADTokenExchange'] };
  assert.equal(migrationFederationPlan([worker, migration]), 'unchanged');
  assert.throws(() => migrationFederationPlan([worker, { ...migration, subject: 'repo:other/unsafe:ref:refs/heads/main' }]), /drift/);
  assert.throws(() => migrationFederationPlan([worker, { ...migration, audiences: [...migration.audiences, 'extra'] }]), /drift/);
  assert.deepEqual(worker.audiences, ['existing']);
});

test('provisioning observes, creates only missing trust, and refuses legacy trust', async (t) => {
  const writes = [];
  const worker = { name: 'cf-worker-federation' };
  let credentials = [worker];
  const az = async (args) => {
    if (args[0] === 'account') return { id: '07aba226-fd59-489a-b07b-4158fef12a5d', tenantId: env.MIGRATION_AZURE_TENANT_ID };
    if (args[0] === 'role') return [{ scope: '/existing/dcr', roleDefinitionName: 'Monitoring Metrics Publisher' }];
    if (args[0] === 'monitor' && args[2] === 'rule') return { id: '/existing/dcr', immutableId: 'dcr-cf864bcaac834a3da25f1ae1fa86a408' };
    if (args[0] === 'monitor') return { logsIngestion: { endpoint: 'https://dce-agent-backup-payj.westus2-1.ingest.monitor.azure.com' } };
    if (args[1] === 'show') return { clientId: env.MIGRATION_AZURE_CLIENT_ID, principalId: 'existing-principal' };
    if (args[2] === 'list') return credentials;
    assert.deepEqual(args.slice(0, 3), ['identity', 'federated-credential', 'create']);
    writes.push(args);
    return {};
  };
  const observed = await provisionMigrationFederation('--observe', { az });
  assert.equal(observed.federation, 'create');
  assert.equal(writes.length, 0);
  const applied = await provisionMigrationFederation('--apply', { az });
  assert.equal(applied.federation, 'created');
  assert.equal(writes.length, 1);
  credentials = [worker, {
    name: 'migration-github-production',
    issuer: 'https://token.actions.githubusercontent.com',
    subject: 'repo:pedropaulovc/agent-sessions-backup:environment:production',
    audiences: ['api://AzureADTokenExchange'],
  }];
  const writesBeforeDrift = writes.length;
  for (const mode of ['--observe', '--apply']) {
    await t.test(`${mode} refuses legacy trust without writes`, async () => {
      await assert.rejects(() => provisionMigrationFederation(mode, { az }), /drift/);
      assert.equal(writes.length, writesBeforeDrift);
    });
  }
});
