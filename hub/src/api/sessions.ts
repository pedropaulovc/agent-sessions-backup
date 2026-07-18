import { detect } from '../ingest/detect';
import { isWebHarness, parseObject } from '../ingest/parse';
import { extractConversationById, parseConversationById, parseExportArchive } from '../ingest/parsers/export-inbox';
import type { ExportArchive } from '../ingest/parsers/export-inbox';
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

/**
 * Build the NormalizedSession by stream-parsing the canonical R2 object (D1 holds metadata only).
 *
 * `archiveCache` (optional, per-request) memoizes parsed export ZIPs by r2_key. In the NDJSON bulk
 * path many sibling sessions share ONE export archive; without the cache each row re-fetches and
 * re-parses the same ZIP, so a single 200-conversation export triggers 200 full archive reads in
 * one response. With it, each archive is fetched + parsed once per request. Non-archive sessions
 * ignore it.
 */
export async function loadNormalized(
  sessionId: string,
  env: Env,
  archiveCache?: Map<string, ExportArchive>,
): Promise<NormalizedSession | null> {
  const file = await env.DB.prepare(
    `SELECT f.store, f.relpath, f.r2_key, s.parent_tool_use_id FROM sessions s JOIN files f ON f.id = s.canonical_file_id
     WHERE s.session_id = ?1`,
  )
    .bind(sessionId)
    .first<{ store: string; relpath: string; r2_key: string; parent_tool_use_id: string | null }>();
  if (!file) return null;
  const det = detect(file.store, file.relpath);
  if (det.kind === 'export-archive') {
    const cached = archiveCache?.get(file.r2_key);
    if (cached) return cached.sessions.find((s) => s.id === sessionId) ?? null;
    const obj = await env.RAW.get(file.r2_key);
    if (!obj) return null;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    // Bulk NDJSON path (a cache is supplied): many sibling sessions share ONE ZIP — parse it whole
    // once and memoize, so N sessions cost one archive parse. A single-session read (no cache) must
    // NOT parse every conversation: extract + parse ONLY this one (same targeted path the viewer uses).
    if (archiveCache) {
      const archive = parseExportArchive(bytes);
      archiveCache.set(file.r2_key, archive);
      return archive.sessions.find((s) => s.id === sessionId) ?? null;
    }
    return parseConversationById(bytes, sessionId);
  }
  const obj = await env.RAW.get(file.r2_key);
  if (!obj) return null;
  const parsed = await parseObject(det.harness, sessionId, obj);
  if (det.parentSessionId) parsed.parentSessionId = det.parentSessionId;
  // The queue consumer links parent_tool_use_id onto the sessions row (via the sibling
  // .meta.json), but a plain reparse of the JSONL here never reproduces it — the transcript
  // itself doesn't carry its own tool_use_id. Without this, /api/v1/sessions/{subagent} and
  // bulk NDJSON silently omit it even after the consumer successfully linked it.
  if (file.parent_tool_use_id) parsed.parentToolUseId = file.parent_tool_use_id;
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
    `SELECT f.store, f.relpath, f.r2_key FROM sessions s JOIN files f ON f.id = s.canonical_file_id WHERE s.session_id = ?1`,
  )
    .bind(sessionId)
    .first<{ store: string; relpath: string; r2_key: string }>();
  if (!file) return Response.json({ error: 'not_found' }, { status: 404 });

  // An archive-backed session's canonical object is the WHOLE export ZIP (every other conversation
  // and its attachment blobs). Streaming it raw would leak all of that under one session's id;
  // extract and serve ONLY this conversation's JSON instead. Byte-range semantics are meaningless
  // for a single JSON document pulled out of a ZIP, so Range is ignored here — it stays supported
  // for real JSONL canonicals below, whose byte offsets address the served file directly.
  const det = detect(file.store, file.relpath);
  if (det.kind === 'export-archive') {
    const obj = await env.RAW.get(file.r2_key);
    if (!obj) return Response.json({ error: 'r2_object_missing' }, { status: 404 });
    const conv = extractConversationById(new Uint8Array(await obj.arrayBuffer()), sessionId);
    if (conv === undefined) return Response.json({ error: 'not_found' }, { status: 404 });
    console.log(JSON.stringify({ event: 'access.raw', session: sessionId, range: null }));
    return new Response(conv, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }

  // A chatgpt-web/claude-web session's canonical is ONE JSON document, not byte-addressable JSONL
  // (detect() calls it kind='session', so without this it would fall through to the Range path
  // below). Honoring a Range would hand back an invalid JSON fragment, and application/x-ndjson
  // mislabels it — serve the whole body as application/json, ignoring Range.
  if (isWebHarness(det.harness)) {
    const obj = await env.RAW.get(file.r2_key);
    if (!obj) return Response.json({ error: 'r2_object_missing' }, { status: 404 });
    console.log(JSON.stringify({ event: 'access.raw', session: sessionId, range: null }));
    return new Response(obj.body, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }

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

/**
 * `indexed_through` scoped to the request's own machine/harness filter (not the whole
 * fleet), so a caller filtering to one machine or harness gets a freshness signal that
 * actually describes the data they asked for: machine filter -> that machine's own
 * last_seen_at; harness filter -> MIN over machines that have EVER produced a session of
 * that harness (a machine with zero sessions of the filtered harness can't make the signal
 * look stale for a report that will never include it); no filter -> fleet-wide MIN, same as
 * before. `machine` wins if both are given — it's the more specific, unambiguous filter.
 */
async function computeIndexedThrough(env: Env, p: URLSearchParams): Promise<string | null> {
  const machine = p.get('machine');
  const harness = p.get('harness');
  const row = await (machine
    ? env.DB.prepare(`SELECT MIN(COALESCE(last_seen_at, created_at)) AS t FROM machines WHERE machine_id = ?1`).bind(machine)
    : harness
      ? env.DB
          .prepare(
            `SELECT MIN(COALESCE(last_seen_at, created_at)) AS t FROM machines
             WHERE machine_id IN (SELECT DISTINCT machine_id FROM sessions WHERE harness = ?1)`,
          )
          .bind(harness)
      : env.DB.prepare(`SELECT MIN(COALESCE(last_seen_at, created_at)) AS t FROM machines`)
  ).first<{ t: string | null }>();
  return row?.t ?? null;
}

/** GET /api/v1/sessions — metadata list (one page + cursor), or format=ndjson streaming the
 * COMPLETE filtered set of full normalized sessions across as many internal pages as needed
 * (that's the point of the bulk format — a daily-report caller shouldn't have to paginate a
 * stream). `limit` is a page-size cap either way (default 200, hard max 1000 via
 * clampLimit); for JSON it bounds one response's `sessions` array, for ndjson it's the
 * internal per-page fetch size only — it does not cap how many lines the stream emits. */
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
  // started_at alone isn't a stable sort key — real data can share a timestamp (bulk
  // backfill, synthetic/imported sessions), which would let OFFSET-based paging skip or
  // repeat rows across a page boundary that lands mid-tie. session_id as a tiebreak makes
  // the ordering total, so paging is deterministic regardless of how many sessions share a
  // started_at.
  const orderBy = 'ORDER BY started_at DESC, session_id ASC';

  const indexedThrough = await computeIndexedThrough(env, p);

  if (p.get('format') !== 'ndjson') {
    const offset = decodeCursor(p.get('cursor'));
    const rows = await env.DB.prepare(`SELECT * FROM sessions ${where} ${orderBy} LIMIT ${limit + 1} OFFSET ${offset}`)
      .bind(...binds)
      .all<SessionRow>();
    const hasMore = rows.results.length > limit;
    const page = hasMore ? rows.results.slice(0, limit) : rows.results;
    return Response.json(
      { sessions: page, indexed_through: indexedThrough, cursor: hasMore ? encodeCursor(offset + limit) : undefined },
      { headers: { 'x-indexed-through': indexedThrough ?? '' } },
    );
  }

  const encoder = new TextEncoder();
  // One archive parse per export ZIP per request, shared across all its conversations' rows
  // AND across every internal page below (a ZIP's sessions can span a page boundary).
  const archiveCache = new Map<string, ExportArchive>();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let offset = 0;
      let total = 0;
      for (;;) {
        const rows = await env.DB.prepare(`SELECT * FROM sessions ${where} ${orderBy} LIMIT ${limit} OFFSET ${offset}`)
          .bind(...binds)
          .all<SessionRow>();
        for (const row of rows.results) {
          const normalized = await loadNormalized(row.session_id, env, archiveCache).catch(() => null);
          controller.enqueue(encoder.encode(`${JSON.stringify({ meta: row, session: normalized })}\n`));
        }
        total += rows.results.length;
        if (rows.results.length < limit) break; // last page was short -> exhausted
        offset += limit;
      }
      console.log(JSON.stringify({ event: 'access.bulk', count: total }));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'x-indexed-through': indexedThrough ?? '',
    },
  });
}

/** Opaque pagination cursor: a base64-encoded OFFSET. Shared by /api/v1/sessions and
 * /api/v1/search (search.ts imports these) so both endpoints' cursors have the identical
 * shape and failure behavior — a hand-edited or stale cursor resets to the first page
 * instead of 500ing. Lives here (not search.ts) because sessions.ts is the base
 * query-helpers module search.ts already imports from (clampLimit, normalizeToBound);
 * putting it there instead would make the two files import each other. */
export function encodeCursor(offset: number): string {
  return btoa(String(offset));
}
export function decodeCursor(cursor: string | null): number {
  if (!cursor) return 0;
  let decoded: string;
  try {
    decoded = atob(cursor);
  } catch {
    return 0;
  }
  const n = Number(decoded);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/** Clamp a user-supplied limit to [1, max], falling back to dflt for missing/non-positive/NaN input. */
export function clampLimit(raw: string | null, dflt: number, max: number): number {
  const n = Number(raw);
  // Flooring a positive fraction below 1 (e.g. limit=0.5) would otherwise produce 0: search then
  // runs with LIMIT 0, returns no hits, and still emits a cursor for the next (equally empty)
  // page — a caller that follows cursors loops forever. Clamp the floored value up to 1 too.
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(1, Math.floor(n)), max) : dflt;
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
  if (!Number.isSafeInteger(offset)) return undefined;
  if (!m[2]) return { offset };
  const end = Number(m[2]);
  // An inverted range (bytes=100-50) would otherwise compute a negative length and get
  // forwarded to R2 as a "valid" partial request — fall back to a full 200 instead, the same
  // way an unparseable Range header is already treated.
  if (!Number.isSafeInteger(end) || end < offset) return undefined;
  return { offset, length: end - offset + 1 };
}
