import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { migrationDiagnosticEvidence, migrationProgressEvidence, migrationProgressQuery, monitorMainRun, parseMonitorArguments } from '../../infra/cf/monitor-main-run.mjs';

const time = Date.parse('2026-10-16T16:00:00.000Z');
const correlation = { revision: 'c'.repeat(40), runId: '38887942689', attempt: '2' };
const options = { ...correlation, repository: 'pedropaulovc/agent-sessions-backup', azure: true,
  workspace: '11111111-2222-3333-4444-555555555555' };
const progress = (changes = {}) => ({
  event: 'migration.copy.progress', schemaVersion: 1, status: 'running', phase: 'copying',
  ...correlation, recordedAt: new Date(time).toISOString(), acknowledgedRows: null, passRows: null,
  pendingRows: null, elapsedMs: 0, rowsPerSecond: null, remainingRows: null, etaSeconds: null,
  lastProgressAt: null, ...changes,
});
const row = (changes = {}, ingested = time + 30_000) => ({ Body: JSON.stringify(progress(changes)),
  IngestedAt: new Date(ingested).toISOString(), TimeGenerated: new Date(time).toISOString() });
const run = (changes = {}) => ({ databaseId: correlation.runId, attempt: 2, headSha: correlation.revision,
  status: 'in_progress', conclusion: '', url: 'https://github.com/pedropaulovc/agent-sessions-backup/actions/runs/38887942689',
  jobs: [{ databaseId: 42, name: 'deploy', status: 'in_progress', conclusion: '', steps: [
    { name: 'Copy frozen source', status: 'in_progress', conclusion: '' },
  ] }], ...changes });
const auth = (changes = {}) => ({
  event: 'migration.auth.diagnostic', schemaVersion: 1, ...correlation,
  recordedAt: new Date(time).toISOString(), stage: 'preflight', verification: 'active', tokenStatus: 'active',
  notBefore: null, expiresOn: null, httpStatus: 200, providerCodes: [], providerReason: 'unknown',
  cfRay: null, providerDate: null, requestDurationMs: 12, ...changes,
});
const failure = (changes = {}) => ({
  event: 'migration.copy.failure', schemaVersion: 1, ...correlation,
  recordedAt: new Date(time).toISOString(), phase: 'retiring', operationPhase: 'copy-checkpoint-write', failureKind: 'http',
  httpStatus: 401, providerCodes: [10000], providerReason: 'authentication', cfRay: '0123456789abcdef-LAX',
  providerDate: new Date(time).toISOString(), requestDurationMs: 25, requestAttempt: 1,
  lastSuccessfulRequestAt: null, statementCount: 1, parameterCount: 2, bodyBytes: 100,
  parameterJsonBytes: 20, databaseId: options.workspace, ...changes,
});
const eventRow = (event, ingested = time + 30_000) => ({
  Body: JSON.stringify(event), IngestedAt: new Date(ingested).toISOString(),
  TimeGenerated: event.recordedAt,
});

test('explicit run/full revision/attempt and Azure choice reject ambiguous identities and KQL input', () => {
  const args = ['--run-id', correlation.runId, '--head', correlation.revision, '--attempt', correlation.attempt];
  assert.throws(() => parseMonitorArguments(args), /workspace/);
  assert.equal(parseMonitorArguments([...args, '--no-azure']).azure, false);
  assert.equal(parseMonitorArguments([...args, '--workspace', options.workspace]).workspace, options.workspace);
  assert.throws(() => parseMonitorArguments([...args, '--workspace', options.workspace, '--no-azure']), /workspace/);
  assert.throws(() => parseMonitorArguments([...args, '--no-azure', '--run-id', '999']), /Duplicate/);
  assert.throws(() => parseMonitorArguments([...args.filter((value) => value !== correlation.revision), '--no-azure']), /Invalid/);
  for (const field of ['runId', 'attempt', 'revision']) {
    assert.throws(() => migrationProgressQuery({ ...correlation, [field]: "' or true //" }), /correlation/);
  }
});

test('freshness uses source heartbeat, not recent Azure ingestion; unknown counters are never zero', () => {
  const unknown = migrationProgressEvidence([], correlation, time);
  assert.equal(unknown.delivery, 'unknown');
  assert.equal(unknown.acknowledgedRows, null);
  const freshUnknown = migrationProgressEvidence([row()], correlation, time + 40_000);
  assert.equal(freshUnknown.delivery, 'fresh');
  assert.equal(freshUnknown.ackEvidence, 'unknown');
  assert.equal(freshUnknown.acknowledgedRows, null);
  assert.equal(freshUnknown.rowsPerSecond, null);
  const stale = migrationProgressEvidence([row({}, time + 600_000)], correlation, time + 600_000);
  assert.equal(stale.delivery, 'stale');
  assert.equal(stale.ackEvidence, 'unknown-stale-heartbeat');
  assert.equal(stale.ingestionLagSeconds, 600);
  assert.equal(stale.rowsPerSecond, null);
  assert.equal(stale.etaSeconds, null);
  const zero = migrationProgressEvidence([row({ acknowledgedRows: 0, passRows: 0 })], correlation, time + 40_000);
  assert.equal(zero.acknowledgedRows, 0, 'observed durable zero remains distinct from unknown');
});

test('cross-run, cross-attempt, cross-revision and invalid counter evidence cannot become live progress', () => {
  for (const changes of [{ runId: '999' }, { attempt: '3' }, { revision: 'd'.repeat(40) },
    { acknowledgedRows: -1 }, { acknowledgedRows: 1.5 }, { pendingRows: '12' },
    { lastProgressAt: new Date(time + 1000).toISOString() },
    { acknowledgedRows: null, lastProgressAt: new Date(time - 1000).toISOString() }]) {
    assert.equal(migrationProgressEvidence([row(changes)], correlation, time + 40_000).delivery, 'unknown');
  }
  const selected = migrationProgressEvidence([row({ runId: '999', acknowledgedRows: 999999 }),
    row({ acknowledgedRows: 12 }), row({ acknowledgedRows: 10, recordedAt: new Date(time - 30_000).toISOString() })], correlation, time + 40_000);
  assert.equal(selected.acknowledgedRows, 12);
});

test('heartbeat does not advance the last durable ACK timestamp or invent ETA from unknown baseline', () => {
  const lastProgressAt = new Date(time - 300_000).toISOString();
  const evidence = migrationProgressEvidence([row({ acknowledgedRows: 500, passRows: 100, lastProgressAt,
    rowsPerSecond: 0, pendingRows: 20, remainingRows: null, etaSeconds: null })], correlation, time + 40_000);
  assert.equal(evidence.delivery, 'fresh');
  assert.equal(evidence.ackEvidence, 'no-recent-ack');
  assert.equal(evidence.lastProgressAt, lastProgressAt);
  assert.notEqual(evidence.lastProgressAt, evidence.heartbeatRecordedAt);
  assert.equal(evidence.remainingRows, null);
  assert.equal(evidence.etaSeconds, null);
  const estimate = migrationProgressEvidence([row({ acknowledgedRows: 500, remainingRows: 100,
    rowsPerSecond: 2, etaSeconds: 50, lastProgressAt: new Date(time - 1000).toISOString() })], correlation, time + 40_000);
  assert.equal(estimate.etaSeconds, 50);
  assert.equal(estimate.ackEvidence, 'recent-ack');
});

test('fresh known-zero remaining rows have zero ETA without a recent rate, unlike unknown or stale evidence', () => {
  const complete = row({ status: 'complete', phase: 'complete', acknowledgedRows: 500,
    remainingRows: 0, rowsPerSecond: null, etaSeconds: 0 });
  const fresh = migrationProgressEvidence([complete], correlation, time + 40_000);
  assert.equal(fresh.delivery, 'fresh');
  assert.equal(fresh.rowsPerSecond, null);
  assert.equal(fresh.remainingRows, 0);
  assert.equal(fresh.etaSeconds, 0);
  const unknown = migrationProgressEvidence([row({ remainingRows: null, rowsPerSecond: null, etaSeconds: 0 })],
    correlation, time + 40_000);
  assert.equal(unknown.remainingRows, null);
  assert.equal(unknown.etaSeconds, null);
  const stale = migrationProgressEvidence([complete], correlation, time + 181_000);
  assert.equal(stale.delivery, 'stale');
  assert.equal(stale.etaSeconds, null);
});

test('ACK recency is as of its heartbeat, independent of ingestion and query reuse age', () => {
  for (const [ackAgeSeconds, expected] of [[40, 'recent-ack'], [190, 'no-recent-ack']]) {
    const evidence = migrationProgressEvidence([row({ acknowledgedRows: 500,
      lastProgressAt: new Date(time - ackAgeSeconds * 1000).toISOString() }, time + 140_000)],
    correlation, time + 150_000);
    assert.equal(evidence.delivery, 'fresh');
    assert.equal(evidence.ackEvidence, expected);
    assert.equal(evidence.heartbeatAgeSeconds, 150);
    assert.equal(evidence.ingestionLagSeconds, 140);
  }
  const stale = migrationProgressEvidence([row({ acknowledgedRows: 500,
    lastProgressAt: new Date(time - 40_000).toISOString() })], correlation, time + 181_000);
  assert.equal(stale.delivery, 'stale');
  assert.equal(stale.ackEvidence, 'unknown-stale-heartbeat');
});

test('monitor displays current GH step and correlated Azure progress, queries at bounded cadence, and suppresses unchanged output', async () => {
  let clock = time + 40_000;
  let reads = 0;
  let queries = 0;
  const logs = [];
  const result = await monitorMainRun(options, {
    now: () => clock, sleep: async (ms) => { clock += ms; }, log: (value) => logs.push(value), warn: assert.fail,
    async execute(binary, args, limits) {
      if (binary === 'gh') {
        reads += 1;
        assert.ok(!args.includes('--log') && !args.includes('--log-failed'));
        const complete = reads === 4;
        return { stdout: JSON.stringify(run(complete ? { status: 'completed', conclusion: 'success' } : {})) };
      }
      assert.equal(binary, 'az');
      queries += 1;
      assert.ok(limits.timeout <= 20_000);
      const query = args[args.indexOf('--analytics-query') + 1];
      for (const value of Object.values(correlation)) assert.ok(query.includes(`'${value}'`));
      return { stdout: JSON.stringify([row({ acknowledgedRows: 500 })]) };
    },
  });
  assert.equal(result, 0);
  assert.equal(reads, 4);
  assert.equal(queries, 3, 'initial + 60s + final, never every GitHub read');
  assert.equal(logs.filter((line) => line.includes('step deploy: Copy frozen source')).length, 1);
  assert.equal(logs.filter((line) => line.startsWith('migration progress ')).length, 1, 'unchanged evidence stays quiet');
  assert.ok(logs.some((line) => line.includes('"acknowledgedRows":500')));
});

test('query failure becomes explicit unknown rather than reusing old counters as fresh evidence', async () => {
  let clock = time;
  let reads = 0;
  let queries = 0;
  const logs = [];
  const warnings = [];
  await monitorMainRun(options, {
    now: () => clock, sleep: async (ms) => { clock += ms; }, log: (line) => logs.push(line), warn: (line) => warnings.push(line),
    async execute(binary) {
      if (binary === 'gh') return { stdout: JSON.stringify(run(++reads === 3 ? { status: 'completed', conclusion: 'success' } : {})) };
      if (++queries === 1) return { stdout: JSON.stringify([row({ acknowledgedRows: 500 }, time)]) };
      throw new Error('private Azure exception with token');
    },
  });
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /private|token/);
  const evidence = logs.filter((line) => line.startsWith('migration progress ')).map((line) => JSON.parse(line.slice('migration progress '.length)));
  assert.equal(evidence.at(-1).delivery, 'unknown');
  assert.equal(evidence.at(-1).acknowledgedRows, null);
  assert.equal(evidence.at(-1).reason, 'query-failed');
});

test('GitHub 502 handling is bounded and cannot silently monitor another attempt', async () => {
  let reads = 0;
  const warnings = [];
  const noAzure = { ...options, azure: false };
  const result = await monitorMainRun(noAzure, { log() {}, warn: (line) => warnings.push(line), sleep: async () => {},
    async execute() {
      if (++reads <= 2) throw Object.assign(new Error('private failure'), { stderr: 'HTTP 502: Bad Gateway' });
      return { stdout: JSON.stringify(run({ status: 'completed', conclusion: 'success' })) };
    },
  });
  assert.equal(result, 0);
  assert.equal(reads, 3);
  assert.equal(warnings.length, 2);
  let failedReads = 0;
  await assert.rejects(monitorMainRun(noAzure, { log() {}, warn() {}, sleep: async () => {},
    async execute() { failedReads += 1; throw Object.assign(new Error('private failure'), { stderr: 'HTTP 502: Bad Gateway' }); },
  }), /GitHub monitor read failed/);
  assert.equal(failedReads, 3);
  for (const identity of [{ attempt: 1 }, { databaseId: '999' }, { headSha: 'd'.repeat(40) }]) {
    await assert.rejects(monitorMainRun(noAzure, { log() {}, warn() {},
      async execute() { return { stdout: JSON.stringify(run(identity)) }; },
    }), /Unexpected workflow/);
  }
});

test('actual CLI distinguishes concluded workflow failure from blind reads and identity mismatch', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'migration-monitor-cli-'));
  const preload = path.join(temporary, 'preload.mjs');
  const cli = fileURLToPath(new URL('../../infra/cf/monitor-main-run.mjs', import.meta.url));
  try {
    // Stub only the actual CLI's subprocess boundary, following the Node suite's
    // preload convention. The entrypoint/parser/exit handling execute unchanged.
    await writeFile(preload, `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { promisify } from 'node:util';
      const result = ${JSON.stringify(run({ status: 'completed', conclusion: 'failure' }))};
      function execute() { throw new Error('unexpected callback-style invocation'); }
      execute[promisify.custom] = async (binary) => {
        if (binary !== 'gh') throw new Error('unexpected subprocess');
        if (process.env.MONITOR_TEST_SCENARIO === 'read-failure') throw new Error('private GH failure');
        if (process.env.MONITOR_TEST_SCENARIO === 'identity-mismatch') result.attempt = 1;
        if (process.env.MONITOR_TEST_SCENARIO === 'success') result.conclusion = 'success';
        return { stdout: JSON.stringify(result), stderr: '' };
      };
      childProcess.execFile = execute;
      syncBuiltinESMExports();
    `);
    for (const [scenario, expectedStatus] of [['workflow-failure', 1], ['read-failure', 2],
      ['identity-mismatch', 2], ['success', 0]]) {
      const child = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, cli,
        '--run-id', correlation.runId, '--head', correlation.revision, '--attempt', correlation.attempt, '--no-azure'], {
        encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
        env: { ...process.env, MONITOR_TEST_SCENARIO: scenario },
      });
      assert.equal(child.error, undefined, scenario);
      assert.equal(child.status, expectedStatus, `${scenario}: ${child.stderr}`);
      assert.doesNotMatch(child.stderr, /private GH failure/);
      if (expectedStatus === 1) assert.match(child.stdout, /Protected run finished: failure/);
      if (expectedStatus === 2) assert.doesNotMatch(child.stdout, /Protected run finished:/);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('bounded query selects latest progress, failure and each auth stage while returning original JSON text', () => {
  const query = migrationProgressQuery(correlation);
  assert.ok(query.indexOf('originalBody = tostring(Body)') < query.indexOf('body = todynamic(originalBody)'));
  assert.match(query, /summarize arg_max\(RecordedAt, \*\) by EvidenceKind/);
  assert.match(query, /take 4/);
  assert.match(query, /project Body = originalBody, IngestedAt, TimeGenerated/);
  assert.match(query, /body\.stage in \('preflight', 'copy_failure'\)/);
  for (const value of Object.values(correlation)) assert.ok(query.includes(`'${value}'`));
  assert.doesNotMatch(query, /tostring\(body\)\s*[,;]?\s*$/m);
});

test('original JSON types survive the query boundary and dynamic objects cannot bypass local validation', () => {
  for (const candidate of [
    eventRow(progress({ schemaVersion: '1' })),
    eventRow(progress({ acknowledgedRows: '500' })),
    { ...row(), Body: progress({ acknowledgedRows: 500 }) },
    { ...row(), Body: '{invalid json' },
  ]) {
    assert.equal(migrationProgressEvidence([candidate], correlation, time + 40_000).delivery, 'unknown');
  }
  const malformed = [
    eventRow(auth({ schemaVersion: '1' })),
    eventRow(auth({ httpStatus: '200' })),
    eventRow(failure({ providerCodes: ['10000'] })),
    eventRow(failure({ parameterCount: '2' })),
    { ...eventRow(auth()), Body: auth() },
  ];
  assert.deepEqual(migrationDiagnosticEvidence(malformed, correlation, time + 40_000),
    { copyFailure: null, auth: { preflight: null, copy_failure: null } });
});

test('diagnostics independently select newest correlated kind and stage, rejecting invalid identity and timing', () => {
  const latest = new Date(time + 10_000).toISOString();
  const rows = [eventRow(auth()), eventRow(auth({ recordedAt: latest, requestDurationMs: 50 })),
    eventRow(auth({ stage: 'copy_failure', verification: 'unavailable', tokenStatus: null })),
    eventRow(failure()), eventRow(failure({ recordedAt: latest, httpStatus: 403, providerReason: 'authorization' }))];
  for (const changes of [{ runId: '999' }, { attempt: '3' }, { revision: 'd'.repeat(40) },
    { recordedAt: new Date(time + 200_000).toISOString() }]) {
    rows.push(eventRow(auth(changes)), eventRow(failure(changes)));
  }
  rows.push(eventRow(auth({ recordedAt: new Date(time + 20_000).toISOString() }), time - 100_000));
  rows.push(eventRow(failure({ recordedAt: latest }), time + 200_000));
  const evidence = migrationDiagnosticEvidence(rows, correlation, time + 40_000);
  assert.equal(evidence.copyFailure.httpStatus, 403);
  assert.equal(evidence.copyFailure.recordedAt, latest);
  assert.equal(evidence.copyFailure.phase, 'retiring');
  assert.equal(evidence.copyFailure.operationPhase, 'copy-checkpoint-write');
  assert.equal(evidence.auth.preflight.requestDurationMs, 50);
  assert.equal(evidence.auth.copy_failure.verification, 'unavailable');
  assert.equal(evidence.auth.preflight.permissionEvidence, 'not-established');
  assert.match(evidence.auth.preflight.caveat, /not proof of D1 permissions/);
});

test('auth and failure use their own recency and ingestion timing without refreshing stale progress or ETA', () => {
  const recent = time + 300_000;
  const rows = [row({ acknowledgedRows: 500, rowsPerSecond: 2, remainingRows: 100, etaSeconds: 50,
    lastProgressAt: new Date(time - 1000).toISOString() }, recent),
  eventRow(auth({ recordedAt: new Date(recent).toISOString() }), recent + 10_000),
  eventRow(failure({ recordedAt: new Date(recent - 20_000).toISOString() }), recent + 10_000)];
  const progressEvidence = migrationProgressEvidence(rows, correlation, recent + 40_000);
  assert.equal(progressEvidence.delivery, 'stale');
  assert.equal(progressEvidence.heartbeatRecordedAt, new Date(time).toISOString());
  assert.equal(progressEvidence.ackEvidence, 'unknown-stale-heartbeat');
  assert.equal(progressEvidence.rowsPerSecond, null);
  assert.equal(progressEvidence.etaSeconds, null);
  const diagnostics = migrationDiagnosticEvidence(rows, correlation, recent + 40_000);
  assert.equal(diagnostics.auth.preflight.ageSeconds, 40);
  assert.equal(diagnostics.auth.preflight.ingestionLagSeconds, 10);
  assert.equal(diagnostics.auth.preflight.ingestedAt, new Date(recent + 10_000).toISOString());
  assert.equal(diagnostics.copyFailure.ageSeconds, 60);
  assert.equal(diagnostics.copyFailure.ingestionLagSeconds, 30);
  assert.equal(migrationProgressEvidence(rows.slice(1), correlation, recent + 40_000).delivery, 'unknown');
  for (const observation of [diagnostics.auth.preflight, diagnostics.copyFailure]) {
    for (const key of ['acknowledgedRows', 'lastProgressAt', 'rowsPerSecond', 'etaSeconds', 'heartbeatRecordedAt']) {
      assert.equal(Object.hasOwn(observation, key), false);
    }
  }
});

test('diagnostic evidence and monitor output exclude raw errors, headers, SQL, parameters and unrecognized fields', async () => {
  const privateFields = { token: 'PRIVATE_TOKEN', error: 'PRIVATE_ERROR', headers: { Authorization: 'PRIVATE_HEADER' },
    sql: 'PRIVATE_SQL', params: ['PRIVATE_PARAMETER'], session: 'PRIVATE_SESSION', rows: ['PRIVATE_ROW'],
    acknowledgedRows: 999, rowsPerSecond: 999, etaSeconds: 1 };
  const rows = [eventRow(auth(privateFields)), eventRow(failure(privateFields))];
  const evidence = migrationDiagnosticEvidence(rows, correlation, time + 40_000);
  assert.ok(evidence.auth.preflight && evidence.copyFailure);
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_|acknowledgedRows|rowsPerSecond|etaSeconds/);
  const logs = [];
  await monitorMainRun(options, {
    now: () => time + 40_000, log: (line) => logs.push(line), warn: assert.fail,
    async execute(binary) {
      return { stdout: JSON.stringify(binary === 'gh' ? run({ status: 'completed', conclusion: 'failure' }) : rows) };
    },
  });
  assert.doesNotMatch(logs.join('\n'), /PRIVATE_|999/);
  assert.ok(logs.some((line) => line.startsWith('migration auth preflight ') && line.includes('"verification":"active"')));
  assert.ok(logs.some((line) => line.startsWith('migration copy failure ') && line.includes('"httpStatus":401')
    && line.includes('"phase":"retiring"') && line.includes('"operationPhase":"copy-checkpoint-write"')));
  assert.ok(logs.some((line) => line.startsWith('migration progress ') && line.includes('"delivery":"unknown"')));
});

test('terminal query captures post-failure auth without extra queries, while unchanged diagnostics stay quiet', async () => {
  let clock = time + 40_000;
  let reads = 0;
  let queries = 0;
  const logs = [];
  const result = await monitorMainRun(options, {
    now: () => clock, sleep: async (ms) => { clock += ms; }, log: (line) => logs.push(line), warn: assert.fail,
    async execute(binary) {
      if (binary === 'gh') return { stdout: JSON.stringify(run(++reads === 4
        ? { status: 'completed', conclusion: 'failure' } : {})) };
      queries += 1;
      const rows = [row({ acknowledgedRows: 500 }), eventRow(auth()), eventRow(failure())];
      if (reads === 4) rows.push(eventRow(auth({ stage: 'copy_failure',
        recordedAt: new Date(time + 120_000).toISOString(), verification: 'inactive', tokenStatus: 'expired' }),
      time + 125_000));
      return { stdout: JSON.stringify(rows) };
    },
  });
  assert.equal(result, 1);
  assert.equal(reads, 4);
  assert.equal(queries, 3, 'initial, sixty-second cadence, final only; no ingestion settle loop');
  assert.equal(logs.filter((line) => line.startsWith('migration auth preflight ')).length, 1);
  assert.equal(logs.filter((line) => line.startsWith('migration copy failure ')).length, 1);
  const postFailure = logs.filter((line) => line.startsWith('migration auth copy_failure '));
  assert.equal(postFailure.length, 2, 'unknown initially, observed only from terminal query');
  const observed = JSON.parse(postFailure.at(-1).slice('migration auth copy_failure '.length));
  assert.equal(observed.tokenStatus, 'expired');
  assert.equal(observed.ageSeconds, 10);
  assert.equal(observed.ingestionLagSeconds, 5);
  assert.match(logs.at(-1), /Azure may still be ingesting the final event/);
});

test('Azure query failure invalidates diagnostics instead of presenting cached auth as current evidence', async () => {
  let clock = time + 40_000;
  let reads = 0;
  let queries = 0;
  const logs = [];
  const warnings = [];
  await monitorMainRun(options, {
    now: () => clock, sleep: async (ms) => { clock += ms; },
    log: (line) => logs.push(line), warn: (line) => warnings.push(line),
    async execute(binary) {
      if (binary === 'gh') return { stdout: JSON.stringify(run(++reads === 3
        ? { status: 'completed', conclusion: 'failure' } : {})) };
      if (++queries === 1) return { stdout: JSON.stringify([eventRow(auth()), eventRow(failure())]) };
      throw new Error('PRIVATE_PROVIDER_ERROR');
    },
  });
  for (const prefix of ['migration auth preflight ', 'migration copy failure ']) {
    const observations = logs.filter((line) => line.startsWith(prefix)).map((line) => JSON.parse(line.slice(prefix.length)));
    assert.equal(observations.length, 2);
    assert.equal(observations[0].recordedAt, new Date(time).toISOString());
    assert.deepEqual(observations[1], { availability: 'unknown', reason: 'query-failed' });
  }
  assert.equal(warnings.length, 1);
  assert.doesNotMatch([...logs, ...warnings].join('\n'), /PRIVATE_PROVIDER_ERROR/);
});

test('no-Azure optout performs only the GitHub read and emits no auth or failure observations', async () => {
  const logs = [];
  let reads = 0;
  const result = await monitorMainRun({ ...options, azure: false }, {
    log: (line) => logs.push(line), warn: assert.fail,
    async execute(binary) {
      assert.equal(binary, 'gh');
      reads += 1;
      return { stdout: JSON.stringify(run({ status: 'completed', conclusion: 'success' })) };
    },
  });
  assert.equal(result, 0);
  assert.equal(reads, 1);
  assert.ok(logs.some((line) => line.includes('durable ACK count, rate and ETA are unknown')));
  assert.equal(logs.some((line) => /^migration (auth|copy failure) /.test(line)), false);
});
