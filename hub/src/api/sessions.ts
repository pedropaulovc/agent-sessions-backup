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
 * that harness, OR that have an UNRESOLVED (`pending`/`error`) `files` row detected as that
 * harness even before it's parsed into a `sessions` row (upload.ts/detect.ts stamp
 * `files.harness` at upload time, ahead of the queue consumer) — otherwise a machine with a
 * pending/error file of the filtered harness would be invisible to this query and make the
 * signal look fresher than the data it's still missing. `parsed` files are excluded because
 * their sessions are already covered by the `sessions` arm above; `superseded`/`skipped`
 * files are excluded because they're terminal and can NEVER produce a sessions row — an
 * unfiltered files arm let a machine whose only harness-X file was a lower-priority
 * `superseded` duplicate drag the harness-X MIN stale forever, even though nothing on that
 * machine could ever appear in `/api/v1/sessions?harness=X`. No filter -> fleet-wide MIN,
 * same as before. `machine` wins if both are given — it's the more specific, unambiguous
 * filter.
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
             WHERE machine_id IN (
               SELECT machine_id FROM sessions WHERE harness = ?1
               UNION
               SELECT machine_id FROM files WHERE harness = ?1 AND parse_state IN ('pending', 'error')
             )`,
          )
          .bind(harness)
      : env.DB.prepare(`SELECT MIN(COALESCE(last_seen_at, created_at)) AS t FROM machines`)
  ).first<{ t: string | null }>();
  return row?.t ?? null;
}

/** A page of `sessions`, keyed by (started_at, session_id) — see SessionsCursor.
 * `startedAt` here is always the COALESCE(started_at, '')-normalized value (see
 * startedAtKey below), never a raw possibly-NULL column value. */
interface SessionsCursor {
  startedAt: string;
  sessionId: string;
}

/** `sessions.started_at` is nullable (ingest writes `s.startedAt ?? null` — an undated
 * session is a real, if rare, case). Both the ORDER BY and the keyset predicate below
 * coalesce it to `''`, which — under DESC — sorts after every real ISO timestamp, so
 * undated sessions land last rather than vanishing from a NULL three-valued-logic
 * comparison (`started_at < ?` and `started_at = ?` both evaluate UNKNOWN for a NULL row,
 * silently dropping it from every page). Cursors must be built from this same coalesced
 * value so they round-trip through the undated region instead of decoding as invalid. */
function startedAtKey(row: SessionRow): string {
  return (row.started_at as string | null) ?? '';
}

/**
 * Keyset pagination cursor for /api/v1/sessions: encodes the LAST ROW ALREADY SEEN
 * (started_at, session_id), not an offset. `/api/v1/search` still uses an offset cursor
 * (encodeCursor/decodeCursor below, unchanged) — its FTS5 bm25-ranked ordering has no
 * natural keyset column pair, so migrating it is a separate discussion (tracked on task
 * #11), not done here.
 *
 * Why keyset, not offset: this endpoint runs against an ACTIVELY INGESTING corpus. An
 * offset cursor is "skip N rows of the CURRENT ordering" — if a new session is ingested
 * between two page fetches with a started_at that sorts ahead of the caller's position, it
 * shifts every row after it by one, so the next page (still "skip N") either repeats a row
 * the caller already saw or skips one it never saw. A keyset cursor instead says "give me
 * rows after THIS SPECIFIC BOUNDARY" — a new row can only ever land before or after that
 * boundary in the total (started_at DESC, session_id ASC) order, never invalidate it. This
 * also kills OFFSET's O(n) scan-and-discard cost on a page far into a large result set.
 */
function encodeSessionsCursor(c: SessionsCursor): string {
  return btoa(JSON.stringify([c.startedAt, c.sessionId]));
}
function decodeSessionsCursor(cursor: string | null): SessionsCursor | null {
  if (!cursor) return null;
  try {
    const decoded: unknown = JSON.parse(atob(cursor));
    if (Array.isArray(decoded) && decoded.length === 2 && typeof decoded[0] === 'string' && typeof decoded[1] === 'string') {
      return { startedAt: decoded[0], sessionId: decoded[1] };
    }
  } catch {
    // Invalid base64, invalid JSON, or the wrong shape (e.g. a stale offset-style cursor
    // from before this change) — fail open to the first page, same as the offset cursor
    // below and /api/v1/search's cursor: never 500 on a garbage/hand-edited cursor.
  }
  return null;
}

/** Matches `ORDER BY COALESCE(started_at, '') DESC, session_id ASC` (see listSessions):
 * strictly-newer started_at, OR equal started_at with a strictly-greater session_id (the ASC
 * tiebreak direction). Both sides use the same COALESCE as the ORDER BY — see startedAtKey's
 * comment for why a raw nullable started_at comparison silently drops undated rows. Appends
 * its binds to `binds` and returns the SQL fragment to AND into WHERE. */
function keysetFilter(cursor: SessionsCursor, binds: unknown[]): string {
  binds.push(cursor.startedAt, cursor.startedAt, cursor.sessionId);
  const n = binds.length;
  return `(COALESCE(started_at, '') < ?${n - 2} OR (COALESCE(started_at, '') = ?${n - 1} AND session_id > ?${n}))`;
}

// Each ndjson row costs ~2-3 subrequests in loadNormalized (a D1 lookup, an R2 read, and
// sometimes an additional archive fetch) against a Worker invocation's ~1000 subrequest
// budget — plus the pagination SELECTs themselves. 300 leaves comfortable headroom rather
// than looping to exhaustion regardless of corpus size (which was itself the bug: unbounded
// per-invocation work that a large machine/day/fleet could blow the budget on mid-stream,
// aborting a "complete" export partway through with no way to tell the caller it was cut off).
export const NDJSON_MAX_ROWS_PER_REQUEST = 300;

/** GET /api/v1/sessions — metadata list (one page + cursor), or format=ndjson streaming up
 * to NDJSON_MAX_ROWS_PER_REQUEST rows. If more match than that cap, the ndjson stream ends
 * with one control line `{"cursor": "..."}` (no `meta`/`session` keys, so it's
 * distinguishable from a normal row) instead of silently truncating — callers resume with
 * `?cursor=...&format=ndjson` for the remainder. `limit` is the internal per-DB-query page
 * size either way (default 200, hard max 1000 via clampLimit) — it does not change the
 * ndjson total cap. */
export async function listSessions(url: URL, env: Env): Promise<Response> {
  const p = url.searchParams;
  const baseFilters: string[] = [];
  const baseBinds: unknown[] = [];
  const add = (template: (n: number) => string, v: unknown) => {
    baseBinds.push(v);
    baseFilters.push(template(baseBinds.length));
  };
  // A session is "in range" if any part of it overlaps [from, to].
  if (p.get('from')) add((n) => `(ended_at >= ?${n} OR started_at >= ?${n})`, p.get('from'));
  if (p.get('to')) add((n) => `started_at <= ?${n}`, normalizeToBound(p.get('to')!));
  if (p.get('harness')) add((n) => `harness = ?${n}`, p.get('harness'));
  if (p.get('machine')) add((n) => `machine_id = ?${n}`, p.get('machine'));
  if (p.get('repo')) add((n) => `repo_url = ?${n}`, p.get('repo'));
  const limit = clampLimit(p.get('limit'), 200, 1000);
  // started_at alone isn't a stable sort key — real data can share a timestamp (bulk
  // backfill, synthetic/imported sessions), or be NULL entirely (see startedAtKey's comment
  // above). session_id as a tiebreak makes the ordering total, which both makes paging
  // deterministic AND is what the keyset cursor above keys off of — a non-total order would
  // make "rows after this boundary" ambiguous. COALESCE(started_at, '') sorts NULL rows last
  // under DESC (empty string is lexicographically before every real ISO timestamp) instead
  // of silently dropping them from keyset comparisons. NOTE: this expression bypasses the
  // `sessions_started`/`sessions_facets` indexes on the raw `started_at` column — fine at
  // current table sizes (~3k sessions, full scan is cheap); revisit with an expression index
  // if this table grows large enough for that to matter.
  const orderBy = "ORDER BY COALESCE(started_at, '') DESC, session_id ASC";

  const indexedThrough = await computeIndexedThrough(env, p);

  /** One page's query for `fetchLimit` rows after `cursor` (or from the top if null),
   * respecting the base filters above. Rebuilds WHERE per call since the keyset boundary
   * changes page to page (unlike a fixed OFFSET, which was the whole problem). */
  const pageQuery = (cursor: SessionsCursor | null, fetchLimit: number): { sql: string; binds: unknown[] } => {
    const filters = [...baseFilters];
    const binds = [...baseBinds];
    if (cursor) filters.push(keysetFilter(cursor, binds));
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    return { sql: `SELECT * FROM sessions ${where} ${orderBy} LIMIT ${fetchLimit}`, binds };
  };

  if (p.get('format') !== 'ndjson') {
    const cursor = decodeSessionsCursor(p.get('cursor'));
    const { sql, binds } = pageQuery(cursor, limit + 1);
    const rows = await env.DB.prepare(sql).bind(...binds).all<SessionRow>();
    const hasMore = rows.results.length > limit;
    const page = hasMore ? rows.results.slice(0, limit) : rows.results;
    const last = page.at(-1);
    const nextCursor =
      hasMore && last ? encodeSessionsCursor({ startedAt: startedAtKey(last), sessionId: last.session_id }) : undefined;
    return Response.json(
      { sessions: page, indexed_through: indexedThrough, cursor: nextCursor },
      { headers: { 'x-indexed-through': indexedThrough ?? '' } },
    );
  }

  const encoder = new TextEncoder();
  // One archive parse per export ZIP per request, shared across all its conversations' rows
  // AND across every internal page below (a ZIP's sessions can span a page boundary).
  const archiveCache = new Map<string, ExportArchive>();
  let cursor = decodeSessionsCursor(p.get('cursor'));
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let emitted = 0;
      let lastRow: SessionRow | undefined;
      let cappedOut = false;
      while (emitted < NDJSON_MAX_ROWS_PER_REQUEST) {
        const fetchLimit = Math.min(limit, NDJSON_MAX_ROWS_PER_REQUEST - emitted);
        const { sql, binds } = pageQuery(cursor, fetchLimit);
        const rows = await env.DB.prepare(sql).bind(...binds).all<SessionRow>();
        for (const row of rows.results) {
          const normalized = await loadNormalized(row.session_id, env, archiveCache).catch(() => null);
          controller.enqueue(encoder.encode(`${JSON.stringify({ meta: row, session: normalized })}\n`));
        }
        emitted += rows.results.length;
        const last = rows.results.at(-1);
        if (last) {
          lastRow = last;
          cursor = { startedAt: startedAtKey(last), sessionId: last.session_id };
        }
        if (rows.results.length < fetchLimit) break; // short page -> exhausted, not just capped
        if (emitted >= NDJSON_MAX_ROWS_PER_REQUEST) {
          cappedOut = true;
          break;
        }
      }
      if (cappedOut && lastRow) {
        const trailer = { cursor: encodeSessionsCursor({ startedAt: startedAtKey(lastRow), sessionId: lastRow.session_id }) };
        controller.enqueue(encoder.encode(`${JSON.stringify(trailer)}\n`));
      }
      console.log(JSON.stringify({ event: 'access.bulk', count: emitted, truncated: cappedOut }));
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

/** Opaque pagination cursor: a base64-encoded OFFSET. /api/v1/search (search.ts imports
 * these) still uses this — see encodeSessionsCursor's comment above for why
 * /api/v1/sessions moved to a keyset cursor instead. Lives here (not search.ts) because
 * sessions.ts is the base query-helpers module search.ts already imports from (clampLimit,
 * normalizeToBound); putting it there instead would make the two files import each other. */
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
