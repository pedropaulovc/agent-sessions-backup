// Protected-production Cloudflare credential diagnostics: closed vocabularies only.
// Provider messages are classified in memory and discarded; no token value, token
// ID, fingerprint, Authorization header, response body or exception text is ever
// logged. One read-only USER-token verification GET, never retried or replayed;
// "active" means only that this endpoint reports the token active, never that it
// holds D1 permissions or that a migration pass is healthy.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMigrationTelemetry } from '../azure/migration-telemetry.mjs';

export const MIGRATION_AUTH_DIAGNOSTIC_EVENT = 'migration.auth.diagnostic';
export const MIGRATION_AUTH_DIAGNOSTIC_STAGES = Object.freeze(['preflight', 'copy_failure']);
export const PROVIDER_REASONS = Object.freeze([
  'authentication', 'authorization', 'token_expired', 'token_not_yet_valid', 'ip_restricted', 'rate_limit', 'unknown',
]);
const TOKEN_VERIFY_URL = 'https://api.cloudflare.com/client/v4/user/tokens/verify';
const TOKEN_STATUSES = new Set(['active', 'disabled', 'expired']);
const PROTECTED_REPOSITORY = 'pedropaulovc/agent-sessions-backup';
const MAX_DEADLINE_MS = 1000;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_PROVIDER_CODES = 16;
// Exact, documented provider phrases only (compared trimmed and case-insensitively).
// Anything else, including near matches, stays `unknown`; no expiry, validity window
// or IP restriction is ever inferred from an HTTP status or a generic code.
const PROVIDER_REASON_PHRASES = new Map([
  ['authentication error', 'authentication'],
  ['invalid api token', 'authentication'],
  ['unauthorized to access requested resource', 'authorization'],
]);
const RFC3339 = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,9})?(?:Z|[+-](\d\d):(\d\d))$/;
const HTTP_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d\d (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d\d:\d\d:\d\d GMT$/;

class DiagnosticRefusal extends Error {}

export function providerCodeList(errors) {
  const codes = [];
  for (const error of Array.isArray(errors) ? errors : []) {
    if (codes.length === MAX_PROVIDER_CODES) break;
    const code = error?.code;
    if (Number.isSafeInteger(code) && code >= 0) codes.push(code);
  }
  return codes;
}

/** One closed reason from exact known phrases (and HTTP 429); conflicts stay unknown. */
export function classifyProviderReason(status, errors) {
  const reasons = new Set();
  for (const error of Array.isArray(errors) ? errors.slice(0, MAX_PROVIDER_CODES) : []) {
    const message = error?.message;
    if (typeof message !== 'string' || message.length > 128) continue;
    const reason = PROVIDER_REASON_PHRASES.get(message.trim().toLowerCase());
    if (reason) reasons.add(reason);
  }
  if (status === 429) reasons.add('rate_limit');
  return reasons.size === 1 ? [...reasons][0] : 'unknown';
}

/** Canonical Ray IDs contain exactly 16 or 20 ASCII characters; header faults are `invalid`. */
export function cloudflareRay(response) {
  try {
    const header = response?.headers?.get('cf-ray');
    if (header === null || header === undefined) return { state: 'absent' };
    if (typeof header === 'string' && /^[0-9a-f]{16}(?:-[A-Z]{3})?$/.test(header)
      && (header.length === 16 || header.length === 20)) return { state: 'valid', ray: header };
    return { state: 'invalid' };
  } catch { return { state: 'invalid' }; }
}

/** The provider's IMF-fixdate `Date` header as canonical ISO, or null. */
export function providerDate(response) {
  try {
    const header = response?.headers?.get('date');
    if (typeof header !== 'string' || !HTTP_DATE.test(header)) return null;
    const at = new Date(Date.parse(header));
    return Number.isFinite(at.getTime()) && at.toUTCString() === header ? at.toISOString() : null;
  } catch { return null; }
}

// RFC 3339 date-time with real calendar/clock fields (V8 alone accepts Feb 30, 24:00).
function rfc3339Instant(value) {
  const match = typeof value === 'string' && value.length <= 40 ? RFC3339.exec(value) : null;
  if (!match) return undefined;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = match.slice(1).map(Number);
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

function isoOrNull(milliseconds) {
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? new Date(milliseconds).toISOString() : null;
}

function elapsed(now, startedAt) {
  const value = Math.round(now() - startedAt);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Operational guard only; GitHub environment protection remains the security boundary. */
export function requireProtectedMigrationDiagnostics(env = process.env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_EVENT_NAME !== 'push'
    || env.PROTECTED_PRODUCTION_MIGRATION !== '1' || env.GITHUB_REPOSITORY !== PROTECTED_REPOSITORY) {
    throw new DiagnosticRefusal('migration auth diagnostics require the protected main-push GitHub Actions job');
  }
}

async function boundedText(reader) {
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) return null;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) return null;
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch { return null; }
  finally { reader.cancel().catch(() => {}); }
}

// Missing, extra-typed or malformed token metadata is unknown, never inactive.
function tokenMetadata(envelope) {
  const result = envelope?.result;
  if (envelope?.success !== true || result === null || typeof result !== 'object' || Array.isArray(result)
    || !TOKEN_STATUSES.has(result.status)) return null;
  const notBefore = result.not_before ?? null;
  const expiresOn = result.expires_on ?? null;
  const validity = [notBefore, expiresOn].map((value) => (value === null ? null : rfc3339Instant(value)));
  if (validity.includes(undefined)) return null;
  return { tokenStatus: result.status, notBefore: validity[0], expiresOn: validity[1] };
}

/**
 * One bounded GET of the fixed USER-token verification endpoint. Every failure,
 * including an HTTP 401 (account-owned tokens are unsupported there), a redirect,
 * a deadline or an unreadable body, is `unavailable`: never invalid or unpermitted.
 */
export async function verifyMigrationToken({
  env = process.env, fetch = globalThis.fetch, now = Date.now,
  setTimeout: schedule = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout,
  deadlineMs = MAX_DEADLINE_MS,
} = {}) {
  // The guard precedes the token read and any request, including for direct callers.
  requireProtectedMigrationDiagnostics(env);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > MAX_DEADLINE_MS) {
    throw new DiagnosticRefusal('migration auth diagnostic deadline must be 1..1000 ms');
  }
  const observed = {
    verification: 'unavailable', tokenStatus: null, notBefore: null, expiresOn: null,
    httpStatus: null, providerCodes: [], providerReason: 'unknown', cfRay: null, providerDate: null,
    requestDurationMs: null,
  };
  const token = env.CLOUDFLARE_API_TOKEN;
  if (typeof token !== 'string' || !token.length || token.length > 4096 || !/^[\x21-\x7e]+$/.test(token)) {
    return { ...observed, verification: 'not_configured' };
  }
  const controller = new AbortController();
  const startedAt = now();
  let settled = false;
  let timer;
  let reader = null;
  // Writes after the deadline are discarded: a late response cannot change the result.
  const record = (patch) => { if (!settled) Object.assign(observed, patch); };
  const exchange = async () => {
    try {
      let response;
      try {
        response = await fetch(TOKEN_VERIFY_URL, {
          method: 'GET', redirect: 'error', signal: controller.signal,
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        });
      } catch { return; }
      if (settled) {
        // Too late: release the body without reading it.
        response?.body?.cancel().catch(() => {});
        return;
      }
      const status = Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599
        ? response.status : null;
      const ray = cloudflareRay(response);
      record({ httpStatus: status, cfRay: ray.state === 'valid' ? ray.ray : null, providerDate: providerDate(response) });
      let text = null;
      try {
        reader = response.body?.getReader() ?? null;
        text = await boundedText(reader);
      } catch { /* Unreadable body stays unknown. */ }
      let envelope = null;
      try { envelope = text === null ? null : JSON.parse(text); } catch { /* Non-JSON stays unknown. */ }
      const errors = Array.isArray(envelope?.errors) ? envelope.errors : [];
      // The endpoint's documented success is HTTP 200; any other status, 2xx included, stays unknown.
      const metadata = status === 200 ? tokenMetadata(envelope) : null;
      record({
        providerCodes: providerCodeList(errors), providerReason: classifyProviderReason(status, errors),
        requestDurationMs: elapsed(now, startedAt),
        ...(metadata ? { ...metadata, verification: metadata.tokenStatus === 'active' ? 'active' : 'inactive' } : {}),
      });
    } catch { /* Diagnostics never throw provider or transport text. */ }
  };
  try {
    await Promise.race([exchange(), new Promise((resolve) => {
      timer = schedule(() => {
        record({ requestDurationMs: elapsed(now, startedAt) });
        settled = true;
        resolve();
      }, deadlineMs);
    })]);
  } finally {
    settled = true;
    cancel(timer);
    controller.abort();
    // A stalled body is cancelled at the deadline, not left pending behind the result.
    reader?.cancel().catch(() => {});
  }
  if (observed.requestDurationMs === null) observed.requestDurationMs = elapsed(now, startedAt);
  return { ...observed, providerCodes: [...observed.providerCodes] };
}

function correlation(env) {
  const decimal = (value) => (typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) ? value : null);
  return {
    revision: typeof env.GITHUB_SHA === 'string' && /^[0-9a-f]{40}$/.test(env.GITHUB_SHA) ? env.GITHUB_SHA : null,
    runId: decimal(env.GITHUB_RUN_ID), attempt: typeof env.GITHUB_RUN_ATTEMPT === 'string'
      && /^[1-9][0-9]{0,8}$/.test(env.GITHUB_RUN_ATTEMPT) ? env.GITHUB_RUN_ATTEMPT : null,
  };
}

/**
 * Guard, verify once, then print and best-effort deliver exactly one diagnostic
 * event through the existing Azure sink. Sink failures never change the outcome.
 */
export async function runMigrationAuthDiagnostics({
  stage, env = process.env, fetch = globalThis.fetch, now = Date.now,
  setTimeout: schedule = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout,
  deadlineMs = MAX_DEADLINE_MS, log = (line) => console.log(line),
  createTelemetry = (options) => createMigrationTelemetry(options),
} = {}) {
  if (!MIGRATION_AUTH_DIAGNOSTIC_STAGES.includes(stage)) {
    throw new DiagnosticRefusal('--stage must be preflight or copy_failure');
  }
  const result = await verifyMigrationToken({ env, fetch, now, setTimeout: schedule, clearTimeout: cancel, deadlineMs });
  const event = Object.freeze({
    event: MIGRATION_AUTH_DIAGNOSTIC_EVENT, schemaVersion: 1, recordedAt: isoOrNull(now()), stage,
    ...result, ...correlation(env),
  });
  try { log(JSON.stringify(event)); } catch { /* Logging only. */ }
  let telemetry = null;
  try { telemetry = await createTelemetry({ env, authentication: 'eager' }); } catch { /* Delivery is best effort. */ }
  try { telemetry?.emit(event); } catch { /* Delivery is best effort. */ }
  try { await telemetry?.close(); } catch { /* The sink close is already bounded. */ }
  return event;
}

async function main(argv) {
  if (argv.length !== 2 || argv[0] !== '--stage' || !MIGRATION_AUTH_DIAGNOSTIC_STAGES.includes(argv[1])) {
    throw new DiagnosticRefusal('usage: migration-auth-diagnostics.mjs --stage preflight|copy_failure');
  }
  await runMigrationAuthDiagnostics({ stage: argv[1] });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    // Only this module's fixed refusal text is printed; never an underlying exception.
    console.error(error instanceof DiagnosticRefusal ? error.message : 'migration auth diagnostics failed');
    process.exitCode = 1;
  });
}
