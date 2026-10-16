// Protected GitHub Actions -> existing Azure DCR OTLP logs. No Azure API key,
// gateway bearer, session contents, retry queue, or dependency on the copy ACK path.
import { MIGRATION_COPY_PHASES } from '../cf/migration-progress.mjs';

const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PHASES = new Set(MIGRATION_COPY_PHASES);
const STATUSES = new Set(['running', 'complete', 'partial', 'failed']);
const COUNTERS = ['acknowledgedRows', 'passRows', 'pendingRows', 'remainingRows'];
const MEASURES = ['elapsedMs', 'rowsPerSecond', 'etaSeconds'];
const REQUEST_MS = 1000;
const CLOSE_MS = 1000;

class TelemetryFailure extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

// Copy only aggregate contract fields; never stringify arbitrary input or errors.
export function migrationTelemetryEvent(input) {
  if (!input || input.event !== 'migration.copy.progress' || input.schemaVersion !== 1
    || !STATUSES.has(input.status) || !PHASES.has(input.phase) || !validDate(input.recordedAt)
    || typeof input.revision !== 'string' || !/^[a-f0-9]{40}$/.test(input.revision)
    || typeof input.runId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(input.runId)
    || !/^[1-9][0-9]{0,8}$/.test(String(input.attempt ?? ''))) return null;
  const event = {
    event: 'migration.copy.progress', schemaVersion: 1, status: input.status, phase: input.phase,
    recordedAt: input.recordedAt, revision: input.revision, runId: input.runId, attempt: String(input.attempt),
  };
  for (const key of COUNTERS) {
    const value = input[key];
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) return null;
    event[key] = value;
  }
  for (const key of MEASURES) {
    const value = input[key];
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) return null;
    event[key] = value;
  }
  if (event.elapsedMs === null || !Number.isSafeInteger(event.elapsedMs)
    || (input.lastProgressAt !== null && !validDate(input.lastProgressAt))) return null;
  event.lastProgressAt = input.lastProgressAt;
  return Object.freeze(event);
}

function logsEndpoint(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
      || !/^[a-z0-9-]+\.[a-z0-9-]+\.ingest\.monitor\.azure\.com$/.test(url.hostname)
      || !/^\/dataCollectionRules\/dcr-[a-f0-9]{32}\/streams\/Microsoft-OTLP-Logs\/otlp\/v1\/logs$/.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

function oidcEndpoint(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
      || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.actions\.githubusercontent\.com$/.test(url.hostname)) return null;
    url.searchParams.set('audience', 'api://AzureADTokenExchange');
    return url.href;
  } catch { return null; }
}

async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new TelemetryFailure('invalid-auth-response');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) throw new TelemetryFailure('invalid-auth-response');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks));
  } catch (error) {
    if (error instanceof TelemetryFailure) throw error;
    throw new TelemetryFailure('invalid-auth-response');
  } finally { await reader.cancel().catch(() => {}); }
}

// Race as well as abort: the close/ACK boundary does not trust fetch to honor a signal.
async function deadline(operation, controller, milliseconds, code = 'request-deadline') {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new TelemetryFailure(code)); }, milliseconds);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function createMigrationTelemetry({
  env = process.env, fetch = globalThis.fetch, now = Date.now,
  warn = (event) => console.warn(JSON.stringify(event)), getAccessToken,
} = {}) {
  let sentEvents = 0;
  let failedEvents = 0;
  let coalescedEvents = 0;
  let droppedEvents = 0;
  let diagnosticsClosed = false;
  const warningAt = new Map();
  const warning = (code, status) => {
    if (diagnosticsClosed) return;
    const time = now();
    if (warningAt.has(code) && time - warningAt.get(code) < 30_000) return;
    warningAt.set(code, time);
    try {
      warn(Object.freeze({ event: 'migration.telemetry.warning', code,
        ...(Number.isInteger(status) ? { httpStatus: status } : {}),
        sentEvents, failedEvents, coalescedEvents, droppedEvents }));
    } catch { /* Telemetry diagnostics cannot replace a migration error. */ }
  };
  const disabled = (code) => {
    warning(code);
    return { emit() {}, async close() {} };
  };
  const tenant = env.MIGRATION_AZURE_TENANT_ID;
  const client = env.MIGRATION_AZURE_CLIENT_ID;
  const endpoint = logsEndpoint(env.MIGRATION_AZURE_LOGS_ENDPOINT);
  if (!tenant && !client && !env.MIGRATION_AZURE_LOGS_ENDPOINT) return disabled('configuration-absent');
  if (!GUID.test(tenant ?? '') || !GUID.test(client ?? '') || !endpoint) return disabled('configuration-invalid');
  const oidcUrl = oidcEndpoint(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  const oidcToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!getAccessToken && (!oidcUrl || typeof oidcToken !== 'string' || !oidcToken.length
    || oidcToken.length > 32 * 1024 || /[\r\n]/.test(oidcToken))) return disabled('github-oidc-unavailable');
  let encodeLogsChunks;
  try {
    // Node 22.22.2 (CI) strips this module's erasable TS natively. Import only
    // when configured so unconfigured local/preview copying never loads TS.
    ({ encodeLogsChunks } = await import('../../hub/gateway/otlp-protobuf.ts'));
  } catch { return disabled('encoder-unavailable'); }
  let cache = null;
  let pending = null;
  let inflight = null;
  let activeController = null;
  let scheduled = false;
  let closing = false;
  let stopped = false;

  async function request(url, options, stage, readJson = false) {
    const controller = new AbortController();
    activeController = controller;
    try {
      return await deadline(async () => {
        let response;
        try { response = await fetch(url, { ...options, redirect: 'error', signal: controller.signal }); }
        catch { throw new TelemetryFailure(`${stage}-network`); }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new TelemetryFailure(`${stage}-http`, response.status);
        }
        if (readJson) return boundedJson(response);
        void response.body?.cancel().catch(() => {});
      }, controller, REQUEST_MS);
    } finally { if (activeController === controller) activeController = null; }
  }

  async function token() {
    if (getAccessToken) {
      const controller = new AbortController();
      activeController = controller;
      try {
        const value = await deadline(() => getAccessToken({ signal: controller.signal }), controller, REQUEST_MS);
        if (typeof value !== 'string' || !value.length || value.length > 32 * 1024 || /[\r\n]/.test(value)) {
          throw new TelemetryFailure('invalid-auth-response');
        }
        return value;
      } finally { if (activeController === controller) activeController = null; }
    }
    if (cache && now() < cache.refreshAt) return cache.token;
    const assertion = await request(oidcUrl, {
      headers: { Authorization: `Bearer ${oidcToken}` },
    }, 'github-oidc', true);
    if (typeof assertion.value !== 'string' || !assertion.value.length || assertion.value.length > 32 * 1024) {
      throw new TelemetryFailure('invalid-auth-response');
    }
    if (stopped) throw new TelemetryFailure('closed');
    const data = await request(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: client, grant_type: 'client_credentials',
        scope: 'https://monitor.azure.com/.default',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion.value }).toString(),
    }, 'entra', true);
    if (typeof data.access_token !== 'string' || !data.access_token.length || data.access_token.length > 32 * 1024
      || /[\r\n]/.test(data.access_token) || !Number.isFinite(data.expires_in)
      || data.expires_in <= 60 || data.expires_in > 86400) throw new TelemetryFailure('invalid-auth-response');
    if (stopped) throw new TelemetryFailure('closed');
    cache = { token: data.access_token, refreshAt: now() + (data.expires_in - 60) * 1000 };
    return cache.token;
  }

  async function send(event) {
    const accessToken = await token();
    if (stopped) return;
    const { chunks, dropped } = encodeLogsChunks({ resourceLogs: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'sessions-index-migration' } }] },
      scopeLogs: [{ scope: { name: 'migration-progress', version: '1' }, logRecords: [{
        timeUnixNano: (BigInt(Date.parse(event.recordedAt)) * 1_000_000n).toString(),
        severityNumber: 9, severityText: 'INFO', body: { stringValue: JSON.stringify(event) },
      }] }],
    }] }, 16 * 1024);
    if (dropped || chunks.length !== 1) throw new TelemetryFailure('encoding-failed');
    try {
      await request(endpoint, { method: 'POST',
        headers: { 'Content-Type': 'application/x-protobuf', Authorization: `Bearer ${accessToken}` },
        body: chunks[0] }, 'ingest');
      sentEvents += 1;
    } catch (error) {
      if (error?.status === 401 || error?.status === 403) cache = null;
      throw error;
    }
  }

  function start() {
    scheduled = false;
    if (inflight || stopped || !pending) return;
    inflight = (async () => {
      while (pending && !stopped) {
        const event = pending;
        pending = null;
        try { await send(event); }
        catch (error) {
          failedEvents += 1;
          warning(error instanceof TelemetryFailure ? error.code : 'transport-failed', error?.status);
        }
      }
    })().finally(() => {
      inflight = null;
      if (pending && !stopped) start();
    });
  }

  return {
    emit(input) {
      if (closing || stopped) return;
      try {
        const event = migrationTelemetryEvent(input);
        if (!event) { droppedEvents += 1; warning('event-invalid'); return; }
        if (pending) coalescedEvents += 1;
        pending = event;
        if (!inflight && !scheduled) { scheduled = true; queueMicrotask(start); }
      } catch { droppedEvents += 1; warning('event-invalid'); }
    },
    async close() {
      if (stopped) return;
      closing = true;
      start();
      const controller = new AbortController();
      try {
        await deadline(() => inflight, controller, CLOSE_MS, 'close-deadline');
      } catch { warning('close-deadline'); }
      finally {
        stopped = true;
        activeController?.abort();
        pending = null;
        cache = null;
      }
      if (failedEvents || coalescedEvents || droppedEvents) warning('delivery-summary');
      // Existing asynchronous fetch/body operations may ignore abort and settle
      // later. close() is the terminal diagnostics boundary, not a network join.
      diagnosticsClosed = true;
    },
  };
}
