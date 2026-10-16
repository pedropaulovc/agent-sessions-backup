import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { migrationProgressEvidence, migrationProgressQuery, monitorMainRun, parseMonitorArguments } from '../../infra/cf/monitor-main-run.mjs';

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
