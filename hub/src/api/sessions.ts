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
  const range = request.headers.get('range') ?? undefined;
  const obj = range ? await env.RAW.get(file.r2_key, { range: parseRange(range) }) : await env.RAW.get(file.r2_key);
  if (!obj) return Response.json({ error: 'r2_object_missing' }, { status: 404 });
  console.log(JSON.stringify({ event: 'access.raw', session: sessionId, range: range ?? null }));
  return new Response(obj.body, {
    status: range ? 206 : 200,
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
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
  if (p.get('to')) add((n) => `started_at <= ?${n}`, p.get('to'));
  if (p.get('harness')) add((n) => `harness = ?${n}`, p.get('harness'));
  if (p.get('machine')) add((n) => `machine_id = ?${n}`, p.get('machine'));
  if (p.get('repo')) add((n) => `repo_url = ?${n}`, p.get('repo'));
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const limit = Math.min(Number(p.get('limit') ?? 200), 1000);

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

function parseRange(header: string): R2Range | undefined {
  const m = header.match(/^bytes=(\d+)-(\d*)$/);
  if (!m) return undefined;
  const offset = Number(m[1]);
  const end = m[2] ? Number(m[2]) : undefined;
  return end !== undefined ? { offset, length: end - offset + 1 } : { offset };
}
