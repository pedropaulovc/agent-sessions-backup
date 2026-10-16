import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { migrationTelemetryEvent } from '../azure/migration-telemetry.mjs';

const execute = promisify(execFile);
const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HEARTBEAT_STALE_MS = 180_000;
const AZURE_INTERVAL_MS = 60_000;

export function parseMonitorArguments(args) {
  const options = { repository: 'pedropaulovc/agent-sessions-backup', azure: true };
  const names = new Map([['--run-id', 'runId'], ['--head', 'revision'], ['--attempt', 'attempt'],
    ['--workspace', 'workspace'], ['--repository', 'repository']]);
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (seen.has(arg)) throw new Error('Duplicate monitor argument');
    seen.add(arg);
    if (arg === '--no-azure') { options.azure = false; continue; }
    const name = names.get(arg);
    if (!name || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Invalid monitor arguments');
    options[name] = args[++index];
  }
  if (!/^[1-9][0-9]{0,19}$/.test(options.runId ?? '') || !/^[a-f0-9]{40}$/.test(options.revision ?? '')
    || !/^[1-9][0-9]{0,8}$/.test(options.attempt ?? '')
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)
    || (options.azure && !GUID.test(options.workspace ?? ''))
    || (!options.azure && options.workspace)) {
    throw new Error('Require --run-id, --head (full SHA), --attempt, and --workspace (GUID) or --no-azure');
  }
  return Object.freeze(options);
}

export function migrationProgressQuery({ revision, runId, attempt }) {
  // Validate before interpolating even when called outside the CLI parser.
  if (!/^[a-f0-9]{40}$/.test(revision ?? '') || !/^[1-9][0-9]{0,19}$/.test(runId ?? '')
    || !/^[1-9][0-9]{0,8}$/.test(String(attempt ?? ''))) throw new Error('Invalid progress correlation');
  return `OTelLogs
| where TimeGenerated > ago(24h)
| where ServiceName == 'sessions-index-migration'
| extend originalBody = tostring(Body), IngestedAt = ingestion_time()
| extend body = todynamic(originalBody)
| where toint(body.schemaVersion) == 1
| where body.event in ('migration.copy.progress', 'migration.copy.failure')
    or (body.event == 'migration.auth.diagnostic' and body.stage in ('preflight', 'copy_failure'))
| where tostring(body.revision) == '${revision}' and tostring(body.runId) == '${runId}' and tostring(body.attempt) == '${attempt}'
| extend RecordedAt = todatetime(body.recordedAt),
    EvidenceKind = iff(body.event == 'migration.auth.diagnostic', strcat(tostring(body.event), ':', tostring(body.stage)), tostring(body.event))
| where isnotnull(RecordedAt)
| summarize arg_max(RecordedAt, *) by EvidenceKind
| take 4
| project Body = originalBody, IngestedAt, TimeGenerated`;
}

// Revalidate the original JSON text locally: Kusto dynamic coercion must not turn
// a string counter/schema version into an accepted numeric contract field.
function correlatedEvents(rows, correlation, now) {
  if (!Array.isArray(rows)) throw new Error('Invalid Azure query response');
  const valid = [];
  for (const row of rows) {
    if (typeof row?.Body !== 'string') continue;
    let body;
    try { body = JSON.parse(row.Body); } catch { continue; }
    const event = migrationTelemetryEvent(body);
    if (!event || event.revision !== correlation.revision || event.runId !== correlation.runId
      || event.attempt !== String(correlation.attempt)) continue;
    const recorded = Date.parse(event.recordedAt);
    const ingested = Date.parse(row.IngestedAt);
    if (!Number.isFinite(ingested) || recorded > now + 60_000 || ingested > now + 60_000
      || ingested < recorded - 60_000) continue;
    valid.push({ event, recorded, ingested });
  }
  return valid;
}

export function migrationProgressEvidence(rows, correlation, now = Date.now()) {
  const valid = [];
  for (const item of correlatedEvents(rows, correlation, now)) {
    const { event, recorded } = item;
    if (event.event !== 'migration.copy.progress') continue;
    const lastAck = event.lastProgressAt === null ? null : Date.parse(event.lastProgressAt);
    if (lastAck !== null && (lastAck > recorded || event.acknowledgedRows === null)) continue;
    valid.push({ ...item, lastAck });
  }
  valid.sort((left, right) => right.recorded - left.recorded);
  const latest = valid[0];
  if (!latest) return { delivery: 'unknown', reason: 'no-correlated-progress', acknowledgedRows: null,
    lastProgressAt: null, heartbeatRecordedAt: null, heartbeatAgeSeconds: null, ingestedAt: null };
  const { event, recorded, ingested, lastAck } = latest;
  const fresh = now - recorded <= HEARTBEAT_STALE_MS;
  return {
    delivery: fresh ? 'fresh' : 'stale',
    ackEvidence: !fresh ? 'unknown-stale-heartbeat' : lastAck === null ? 'unknown'
      : recorded - lastAck > HEARTBEAT_STALE_MS ? 'no-recent-ack' : 'recent-ack',
    status: event.status, phase: event.phase, elapsedMs: event.elapsedMs,
    acknowledgedRows: event.acknowledgedRows, passRows: event.passRows, pendingRows: event.pendingRows,
    rowsPerSecond: fresh ? event.rowsPerSecond : null,
    remainingRows: event.remainingRows,
    etaSeconds: !fresh ? null : event.remainingRows === 0 ? 0
      : event.remainingRows !== null && event.rowsPerSecond > 0 ? event.etaSeconds : null,
    lastProgressAt: event.lastProgressAt, heartbeatRecordedAt: event.recordedAt,
    heartbeatAgeSeconds: Math.max(0, (now - recorded) / 1000),
    ingestedAt: new Date(ingested).toISOString(), ingestionLagSeconds: Math.max(0, (ingested - recorded) / 1000),
  };
}

// Diagnostics are independent observations, never heartbeats or durable ACKs.
export function migrationDiagnosticEvidence(rows, correlation, now = Date.now()) {
  const evidence = { copyFailure: null, auth: { preflight: null, copy_failure: null } };
  const valid = correlatedEvents(rows, correlation, now).sort((left, right) => right.recorded - left.recorded);
  for (const { event, recorded, ingested } of valid) {
    const failure = event.event === 'migration.copy.failure';
    const auth = event.event === 'migration.auth.diagnostic';
    if (!failure && !auth) continue;
    if (failure ? evidence.copyFailure !== null : evidence.auth[event.stage] !== null) continue;
    const observation = {
      ...event,
      ageSeconds: Math.max(0, (now - recorded) / 1000),
      ingestedAt: new Date(ingested).toISOString(),
      ingestionLagSeconds: Math.max(0, (ingested - recorded) / 1000),
      ...(auth ? { permissionEvidence: 'not-established',
        caveat: 'Active token verification is not proof of D1 permissions' } : {}),
    };
    if (failure) evidence.copyFailure = observation;
    else evidence.auth[event.stage] = observation;
  }
  return evidence;
}

function githubEntries(run) {
  const entries = new Map();
  entries.set('workflow', { scope: 'workflow', status: run.status,
    text: `workflow ${run.status}${run.conclusion ? ` (${run.conclusion})` : ''}: ${run.url}` });
  for (const job of run.jobs) {
    entries.set(`job:${job.databaseId}`, { scope: 'job', status: job.status,
      text: `job ${job.name} -> ${job.status}${job.conclusion ? ` (${job.conclusion})` : ''}` });
    for (const [index, step] of (job.steps ?? []).entries()) {
      entries.set(`step:${job.databaseId}:${index}`, { scope: 'step', status: step.status, conclusion: step.conclusion,
        text: `step ${job.name}: ${step.name} -> ${step.status}${step.conclusion ? ` (${step.conclusion})` : ''}` });
    }
  }
  return entries;
}

export async function monitorMainRun(options, {
  execute: exec = execute, sleep: pause = sleep, now = Date.now,
  log = console.log, warn = console.warn,
} = {}) {
  let previous = null;
  let previousEvidence = null;
  const previousDiagnostics = new Map();
  let consecutiveReadFailures = 0;
  let nextAzureQuery = 0;
  let rows = [];
  let azureError = null;
  log(`Monitoring protected run ${options.runId} attempt ${options.attempt} at ${options.revision}`);
  if (!options.azure) log('Azure progress disabled: durable ACK count, rate and ETA are unknown');
  for (;;) {
    let run;
    try {
      const { stdout } = await exec('gh', ['run', 'view', options.runId, '--attempt', String(options.attempt),
        '--repo', options.repository, '--json', 'databaseId,attempt,headSha,status,conclusion,jobs,url'], {
        timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
      });
      run = JSON.parse(stdout);
      consecutiveReadFailures = 0;
    } catch (error) {
      consecutiveReadFailures += 1;
      const transient = /^HTTP 502:/m.test(error?.stderr ?? '');
      warn(`GitHub status unknown (${transient ? 'HTTP 502' : 'read failure'}, ${consecutiveReadFailures}/3); no workflow rerun`);
      if (!transient || consecutiveReadFailures >= 3) throw new Error('GitHub monitor read failed');
      await pause(30_000);
      continue;
    }
    if (run.headSha !== options.revision || String(run.databaseId) !== options.runId
      || String(run.attempt) !== String(options.attempt) || !Array.isArray(run.jobs)) {
      throw new Error('Unexpected workflow revision, run, attempt or jobs response');
    }
    const current = githubEntries(run);
    for (const [key, entry] of current) {
      if (previous?.get(key)?.text === entry.text) continue;
      if (previous === null && entry.scope === 'step' && entry.status !== 'in_progress' && entry.conclusion !== 'failure') continue;
      log(entry.text);
    }
    previous = current;
    if (options.azure) {
      if (now() >= nextAzureQuery || run.status === 'completed') {
        nextAzureQuery = now() + AZURE_INTERVAL_MS;
        try {
          const { stdout } = await exec('az', ['monitor', 'log-analytics', 'query', '--workspace', options.workspace,
            '--analytics-query', migrationProgressQuery(options), '--timespan', 'P1D', '--only-show-errors', '--output', 'json'], {
            timeout: 20_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
          });
          rows = JSON.parse(stdout);
          if (!Array.isArray(rows)) throw new Error('Invalid Azure query response');
          azureError = null;
        } catch {
          if (azureError !== 'query-failed') warn('Azure progress query failed: durable ACK progress unknown; no credential or response details logged');
          azureError = 'query-failed';
        }
      }
      const evidence = azureError ? { delivery: 'unknown', reason: azureError, acknowledgedRows: null,
        lastProgressAt: null, heartbeatRecordedAt: null, heartbeatAgeSeconds: null, ingestedAt: null }
        : migrationProgressEvidence(rows, options, now());
      // Age advances while reusing a query result; print it with changed evidence,
      // not as an otherwise identical line on every GitHub metadata read.
      const comparison = JSON.stringify({ ...evidence, heartbeatAgeSeconds: undefined });
      if (comparison !== previousEvidence) log(`migration progress ${JSON.stringify(evidence)}`);
      previousEvidence = comparison;
      const diagnostics = azureError ? { copyFailure: null, auth: { preflight: null, copy_failure: null } }
        : migrationDiagnosticEvidence(rows, options, now());
      for (const [kind, observation] of [
        ['copy failure', diagnostics.copyFailure],
        ['auth preflight', diagnostics.auth.preflight],
        ['auth copy_failure', diagnostics.auth.copy_failure],
      ]) {
        const diagnostic = observation ?? { availability: 'unknown', reason: azureError ?? 'no-correlated-diagnostic' };
        const comparison = JSON.stringify({ ...diagnostic, ageSeconds: undefined });
        if (comparison !== previousDiagnostics.get(kind)) log(`migration ${kind} ${JSON.stringify(diagnostic)}`);
        previousDiagnostics.set(kind, comparison);
      }
    }
    if (run.status === 'completed') {
      log(`Protected run finished: ${run.conclusion}; Azure may still be ingesting the final event`);
      return run.conclusion === 'success' ? 0 : 1;
    }
    await pause(30_000);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await monitorMainRun(parseMonitorArguments(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
