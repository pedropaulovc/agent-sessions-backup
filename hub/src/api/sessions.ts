import { detect } from '../ingest/detect';
import { readJsonlLines } from '../ingest/jsonl';
import { parseClaudeCode } from '../ingest/parsers/claude-code';
import { parseCodex } from '../ingest/parsers/codex';
import type { NormalizedSession } from '../ingest/normalize';

interface SessionRow {
  session_id: string;
  harness: string;
  machine_id: string | null;
  os: string | null;
  canonical_file_id: number | null;
  index_state: string;
  [k: string]: unknown;
}

/** Build the NormalizedSession by stream-parsing the canonical R2 object (D1 holds metadata only). */
export async function loadNormalized(sessionId: string, env: Env): Promise<NormalizedSession | null> {
  const file = await env.DB.prepare(
    `SELECT f.store, f.relpath, f.r2_key FROM sessions s JOIN files f ON f.id = s.canonical_file_id
     WHERE s.session_id = ?1`,
  )
    .bind(sessionId)
    .first<{ store: string; relpath: string; r2_key: string }>();
  if (!file) return null;
  const obj = await env.RAW.get(file.r2_key);
  if (!obj) return null;
  const det = detect(file.store, file.relpath);
  const lines = readJsonlLines(obj.body);
  const parsed =
    det.harness === 'codex' ? await parseCodex(lines, sessionId) : await parseClaudeCode(lines, sessionId);
  if (det.parentSessionId) parsed.parentSessionId = det.parentSessionId;
  return parsed;
}

export async function getSession(sessionId: string, env: Env): Promise<Response> {
  const row = await env.DB.prepare('SELECT * FROM sessions WHERE session_id = ?1').bind(sessionId).first<SessionRow>();
  if (!row) return Response.json({ error: 'not_found' }, { status: 404 });
  const normalized = await loadNormalized(sessionId, env);
  console.log(JSON.stringify({ event: 'access.session', session: sessionId }));
  return Response.json({ meta: row, session: normalized });
}

export async function getSessionRaw(sessionId: string, request: Request, env: Env): Promise<Response> {
  const file = await env.DB.prepare(
    `SELECT f.r2_key FROM sessions s JOIN files f ON f.id = s.canonical_file_id WHERE s.session_id = ?1`,
  )
    .bind(sessionId)
    .first<{ r2_key: string }>();
  if (!file) return Response.json({ error: 'not_found' }, { status: 404 });
  const rangeHeader = request.headers.get('range');
  // A present-but-unparseable Range header (e.g. the suffix form `bytes=-500`, which
  // parseRange doesn't support) must fall back to a full 200 — never claim 206 while
  // actually serving the whole body.
  const parsedRange = rangeHeader ? parseRange(rangeHeader) : undefined;
  const obj = parsedRange ? await env.RAW.get(file.r2_key, { range: parsedRange }) : await env.RAW.get(file.r2_key);
  if (!obj) return Response.json({ error: 'r2_object_missing' }, { status: 404 });
  console.log(JSON.stringify({ event: 'access.raw', session: sessionId, range: rangeHeader ?? null }));
  const headers: Record<string, string> = { 'content-type': 'application/x-ndjson; charset=utf-8' };
  const servedRange = obj.range;
  if (parsedRange && servedRange && 'offset' in servedRange && servedRange.offset !== undefined && servedRange.length !== undefined) {
    const start = servedRange.offset;
    headers['content-range'] = `bytes ${start}-${start + servedRange.length - 1}/${obj.size}`;
  }
  return new Response(obj.body, {
    status: parsedRange ? 206 : 200,
    headers,
  });
}

/** GET /api/v1/sessions — metadata list, or format=ndjson streaming full normalized sessions. */
export async function listSessions(url: URL, env: Env): Promise<Response> {
  const p = url.searchParams;
  const filters: string[] = [];
  const binds: unknown[] = [];
  const add = (template: (n: number) => string, v: unknown) => {
    binds.push(v);
    filters.push(template(binds.length));
  };
  // A session is "in range" if any part of it overlaps [from, to].
  if (p.get('from')) add((n) => `(ended_at >= ?${n} OR started_at >= ?${n})`, p.get('from'));
  if (p.get('to')) add((n) => `started_at <= ?${n}`, normalizeToBound(p.get('to')!));
  if (p.get('harness')) add((n) => `harness = ?${n}`, p.get('harness'));
  if (p.get('machine')) add((n) => `machine_id = ?${n}`, p.get('machine'));
  if (p.get('repo')) add((n) => `repo_url = ?${n}`, p.get('repo'));
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const limit = clampLimit(p.get('limit'), 200, 1000);

  const rows = await env.DB.prepare(
    `SELECT * FROM sessions ${where} ORDER BY started_at DESC LIMIT ${limit}`,
  )
    .bind(...binds)
    .all<SessionRow>();

  const indexedThrough = await env.DB.prepare(
    `SELECT MIN(COALESCE(last_seen_at, created_at)) AS t FROM machines`,
  ).first<{ t: string | null }>();

  if (p.get('format') !== 'ndjson') {
    return Response.json(
      { sessions: rows.results, indexed_through: indexedThrough?.t ?? null },
      { headers: { 'x-indexed-through': indexedThrough?.t ?? '' } },
    );
  }

  const encoder = new TextEncoder();
  const sessions = rows.results;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const row of sessions) {
        const normalized = await loadNormalized(row.session_id, env).catch(() => null);
        controller.enqueue(encoder.encode(`${JSON.stringify({ meta: row, session: normalized })}\n`));
      }
      controller.close();
    },
  });
  console.log(JSON.stringify({ event: 'access.bulk', count: sessions.length }));
  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'x-indexed-through': indexedThrough?.t ?? '',
    },
  });
}

/** Clamp a user-supplied limit to [1, max], falling back to dflt for missing/non-positive/NaN input. */
export function clampLimit(raw: string | null, dflt: number, max: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : dflt;
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date-only `to` bound (e.g. `2026-07-17`) compared against full ISO timestamps
 * (`2026-07-17T09:00:00.000Z`) with `<=` lexicographically excludes the entire day, since
 * any time-of-day suffix sorts after the bare date. Expand it to end-of-day so `to` is
 * inclusive of the whole day, matching the intuitive "through this date" meaning. `from`
 * bounds don't need this: a date-only `from` compared with `>=` already includes the whole
 * day correctly.
 */
export function normalizeToBound(raw: string): string {
  return DATE_ONLY_RE.test(raw) ? `${raw}T23:59:59.999Z` : raw;
}

function parseRange(header: string): R2Range | undefined {
  const m = header.match(/^bytes=(\d+)-(\d*)$/);
  if (!m) return undefined;
  const offset = Number(m[1]);
  const end = m[2] ? Number(m[2]) : undefined;
  return end !== undefined ? { offset, length: end - offset + 1 } : { offset };
}
