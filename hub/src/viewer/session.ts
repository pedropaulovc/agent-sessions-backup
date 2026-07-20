import { readJsonlLines } from '../ingest/jsonl';
import { isWebHarness } from '../ingest/parse';
import type { NormalizedBlock, NormalizedSession, NormalizedTurn } from '../ingest/normalize';
import { parseChatgptWeb } from '../ingest/parsers/chatgpt-web';
import { parseClaudeCode } from '../ingest/parsers/claude-code';
import { parseClaudeWeb } from '../ingest/parsers/claude-web';
import { parseCodex } from '../ingest/parsers/codex';
import { parseConversationById } from '../ingest/parsers/export-inbox';
import { parsePromptLog } from '../ingest/parsers/history';
import { esc, pageFoot, pageHead, q } from './layout';

/** Turns per page. Pages are turn_index buckets [(p-1)*SIZE, p*SIZE), so a block's page is floor(turn_index/SIZE)+1. */
export const TURNS_PER_PAGE = 200;

interface SessionMeta {
  session_id: string;
  harness: string;
  machine_id: string | null;
  os: string | null;
  cwd: string | null;
  repo_url: string | null;
  git_branch: string | null;
  primary_model: string | null;
  title: string | null;
  started_at: string | null;
  ended_at: string | null;
  parent_session_id: string | null;
  is_sidechain: number;
  turn_count: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_reasoning: number | null;
  tokens_cached: number | null;
  index_state: string;
}

type View = 'chronological' | 'effective';

/** GET /s/{id}?page=N&view=chronological|effective — streamed chat transcript, one page of turns at a time. */
export async function sessionPage(sessionId: string, url: URL, env: Env): Promise<Response> {
  const meta = await env.DB.prepare(
    `SELECT session_id, harness, machine_id, os, cwd, repo_url, git_branch, primary_model, title, started_at, ended_at,
            parent_session_id, is_sidechain, turn_count, tokens_in, tokens_out, tokens_reasoning, tokens_cached, index_state
     FROM sessions WHERE session_id = ?1`,
  )
    .bind(sessionId)
    .first<SessionMeta>();
  if (!meta) return notFound();

  const file = await env.DB.prepare(
    `SELECT f.store, f.relpath, f.r2_key, f.content_hash FROM sessions s JOIN files f ON f.id = s.canonical_file_id WHERE s.session_id = ?1`,
  )
    .bind(sessionId)
    .first<{ store: string; relpath: string; r2_key: string; content_hash: string }>();
  // Cache-busting token for blob URLs: block ids (rowids) are reused across reindexes, so the
  // 1-year immutable cache is keyed on the canonical file's content hash prefix.
  const blobVersion = blobVersionOf(file?.content_hash);

  const view: View = url.searchParams.get('view') === 'effective' ? 'effective' : 'chronological';
  const maxTurn = (
    await env.DB.prepare('SELECT MAX(turn_index) AS m FROM blocks WHERE session_id = ?1')
      .bind(sessionId)
      .first<{ m: number | null }>()
  )?.m ?? null;
  const totalPages = maxTurn === null ? 1 : Math.floor(maxTurn / TURNS_PER_PAGE) + 1;
  const page = clampPage(url.searchParams.get('page'), totalPages);
  const lo = (page - 1) * TURNS_PER_PAGE;
  const hi = page * TURNS_PER_PAGE;

  const children = await env.DB.prepare(
    `SELECT session_id, title FROM sessions WHERE parent_session_id = ?1 ORDER BY started_at`,
  )
    .bind(sessionId)
    .all<{ session_id: string; title: string | null }>();

  // Page = turn_index bucket. Byte window co-monotonic with turn_index (file order), so it covers exactly [lo, hi).
  const startByte = await firstByteFrom(env, sessionId, lo);
  const endByte = await firstByteFrom(env, sessionId, hi);

  // Authoritative per-CONTENT-turn metadata for this page. Match it back to parsed turns by source byte
  // offset rather than ordinal position: a skipped oversized record can leave an unmatched indexed row,
  // which must not shift every later turn's anchor/main-path flag. Register the turn at every persisted block
  // offset because the first block can itself be skipped while a later block from the same turn survives.
  // The value is a queue because whole-document formats can legitimately assign several turns the same
  // synthetic source offset.
  const pageTurns = (
    await env.DB.prepare(
      `WITH page_blocks AS (
         SELECT turn_index, byte_start, on_main_path FROM blocks
         WHERE session_id = ?1 AND turn_index >= ?2 AND turn_index < ?3 AND btype != 'compaction'
       ), turn_meta AS (
         SELECT turn_index, MAX(on_main_path) AS on_main_path FROM page_blocks GROUP BY turn_index
       )
       SELECT p.turn_index, p.byte_start, m.on_main_path
       FROM page_blocks p JOIN turn_meta m ON m.turn_index = p.turn_index
       WHERE p.byte_start IS NOT NULL
       GROUP BY p.turn_index, p.byte_start
       ORDER BY p.turn_index, p.byte_start`,
    )
      .bind(sessionId, lo, hi)
      .all<{ turn_index: number; byte_start: number | null; on_main_path: number }>()
  ).results;
  const pageTurnsByByteStart = new Map<number, Array<{ turnIndex: number; onMainPath: boolean }>>();
  for (const row of pageTurns) {
    if (row.byte_start === null) continue;
    const queue = pageTurnsByByteStart.get(row.byte_start) ?? [];
    queue.push({ turnIndex: row.turn_index, onMainPath: row.on_main_path === 1 });
    pageTurnsByByteStart.set(row.byte_start, queue);
  }

  // Media block ids for this byte window, so <img>/<a> can point at the blob endpoint.
  const mediaIds = await loadMediaIds(env, sessionId, startByte, endByte);

  const head =
    pageHead(meta.title || `Session ${sessionId}`, undefined) +
    renderHeader(meta, children.results, view, url) +
    (view === 'effective'
      ? `<p class="muted small">Effective view — replaced/abandoned turns hidden. <a href="${esc(withView(url, 'chronological'))}">Show all</a></p>`
      : '');

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(head));
      try {
        const parsed = file ? await parseRange(file, meta.harness, sessionId, startByte, endByte, env) : null;
        if (!parsed) {
          controller.enqueue(encoder.encode('<p class="warn">Raw transcript unavailable (R2 object missing).</p>'));
        } else {
          let rendered = 0;
          for (const turn of parsed.turns) {
            const isContent = !turn.compaction && turn.blocks.length > 0;
            const byteStart = turn.blocks[0]?.byteStart ?? turn.byteStart;
            const indexed = isContent && byteStart !== undefined
              ? pageTurnsByByteStart.get(byteStart)?.shift()
              : undefined;
            // Prefer the persisted main-path flag; fall back to the parser's per-page guess only when the
            // D1 lookup has no matching row (e.g. compaction markers, which have no content block rows).
            const onMainPath = indexed ? indexed.onMainPath : turn.onMainPath;
            const html = renderTurn(turn, sessionId, view, mediaIds, indexed?.turnIndex, onMainPath, blobVersion);
            if (html) {
              controller.enqueue(encoder.encode(html));
              rendered++;
            }
          }
          if (rendered === 0) controller.enqueue(encoder.encode('<p class="muted">No turns on this page.</p>'));
        }
      } catch (e) {
        controller.enqueue(encoder.encode(`<p class="warn">Render error: ${esc(String(e))}</p>`));
      }
      controller.enqueue(encoder.encode(renderPager(url, page, totalPages)));
      controller.enqueue(encoder.encode(pageFoot()));
      controller.close();
    },
  });

  console.log(JSON.stringify({ event: 'viewer.session', session: sessionId, page, view }));
  return new Response(stream, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/** Byte offset of the first block at or after turn_index `from`, or undefined when none exists (past the end). */
async function firstByteFrom(env: Env, sessionId: string, from: number): Promise<number | undefined> {
  const row = await env.DB.prepare(
    'SELECT MIN(byte_start) AS bs FROM blocks WHERE session_id = ?1 AND turn_index >= ?2',
  )
    .bind(sessionId, from)
    .first<{ bs: number | null }>();
  return row?.bs ?? undefined;
}

async function loadMediaIds(
  env: Env,
  sessionId: string,
  startByte: number | undefined,
  endByte: number | undefined,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const rows = await env.DB.prepare(
    `SELECT id, byte_start, block_index FROM blocks
     WHERE session_id = ?1 AND btype IN ('image','document')
       AND byte_start >= ?2 AND (?3 IS NULL OR byte_start < ?3)`,
  )
    .bind(sessionId, startByte ?? 0, endByte ?? null)
    .all<{ id: number; byte_start: number; block_index: number }>();
  for (const r of rows.results) map.set(`${r.byte_start}:${r.block_index}`, r.id);
  return map;
}

async function parseRange(
  file: { store: string; relpath: string; r2_key: string },
  harness: string,
  sessionId: string,
  startByte: number | undefined,
  endByte: number | undefined,
  env: Env,
): Promise<NormalizedSession | null> {
  // Single-document formats (web conversations, export archives) can't be byte-range read — a
  // slice of one JSON object doesn't parse. Read the whole object and window by turn offset
  // instead (offsets are monotonic with turn_index, so the same [startByte, endByte) still
  // selects exactly this page's turns). Conversation-sized files make the full reparse cheap.
  if (file.store === 'export-inbox') {
    const obj = await env.RAW.get(file.r2_key);
    if (!obj) return null;
    // Extract + parse ONLY this conversation, not the whole archive: parseExportArchive() would
    // inflate and parse every conversation in the ZIP (potentially hundreds) on every page view. The
    // shared parseConversationById reuses the same conversations.json-only inflation as /raw and
    // parses the conversation from the identical JSON.stringify(conv) ingest used, so the stored
    // per-conversation byte offsets still line up with windowTurns.
    const full = parseConversationById(new Uint8Array(await obj.arrayBuffer()), sessionId);
    return full ? windowTurns(full, startByte, endByte) : null;
  }
  if (isWebHarness(harness)) {
    const obj = await env.RAW.get(file.r2_key);
    if (!obj) return null;
    const text = await obj.text();
    const full = harness === 'chatgpt-web' ? parseChatgptWeb(text, sessionId) : parseClaudeWeb(text, sessionId);
    return windowTurns(full, startByte, endByte);
  }

  const range =
    startByte === undefined
      ? undefined
      : endByte !== undefined
        ? { offset: startByte, length: Math.max(0, endByte - startByte) }
        : { offset: startByte };
  const obj = range ? await env.RAW.get(file.r2_key, { range }) : await env.RAW.get(file.r2_key);
  if (!obj) return null;
  const lines = readJsonlLines(obj.body, startByte ?? 0);
  if (harness === 'codex') return parseCodex(lines, sessionId);
  if (harness === 'prompt-log') return parsePromptLog(lines, sessionId);
  return parseClaudeCode(lines, sessionId);
}

/**
 * Restrict a whole-document parse to the turns of one page. Turn byte offsets are monotonic with
 * turn_index, and [startByte, endByte) came from the same D1 blocks (firstByteFrom), so filtering
 * by the first block's byte offset reproduces exactly the JSONL byte-window contract: the page's
 * content turns, in order, for the render loop to zip against its authoritative D1 rows.
 */
function windowTurns(s: NormalizedSession, startByte: number | undefined, endByte: number | undefined): NormalizedSession {
  if (startByte === undefined) return s;
  s.turns = s.turns.filter((t) => {
    const bs = t.blocks[0]?.byteStart ?? t.byteStart ?? 0;
    return bs >= startByte && (endByte === undefined || bs < endByte);
  });
  return s;
}

function renderTurn(
  turn: NormalizedTurn,
  sessionId: string,
  view: View,
  mediaIds: Map<string, number>,
  turnIndex: number | undefined,
  onMainPath: boolean,
  blobVersion: string,
): string {
  if (turn.compaction) {
    return `<div class="divider">── context compacted ──</div>`;
  }
  if (view === 'effective' && !onMainPath) return '';
  if (turn.blocks.length === 0) return '';

  const rewound = view === 'chronological' && !onMainPath;
  const cls = `turn ${esc(turn.role)}${rewound ? ' rewound' : ''}`;
  // Stable anchor id (present in every view) so search-hit deep links can scroll to the matching turn.
  const anchor = turnIndex === undefined ? '' : ` id="t${turnIndex}"`;
  const model = turn.model ? `<span class="chip">${esc(turn.model)}</span>` : '';
  const ts = turn.ts ? `<span class="muted small">${esc(turn.ts)}</span>` : '';
  const head = `<div class="turnhead"><span class="role">${esc(turn.role)}</span>${model}${ts}</div>`;
  const body = turn.blocks.map((b, bi) => renderBlock(b, bi, sessionId, mediaIds, blobVersion)).join('');
  return `<article${anchor} class="${cls}">${head}<div class="body">${body}</div></article>`;
}

function renderBlock(b: NormalizedBlock, bi: number, sessionId: string, mediaIds: Map<string, number>, blobVersion: string): string {
  const trunc = b.truncated ? `<div class="truncnote">… truncated for indexing</div>` : '';
  switch (b.type) {
    case 'text':
    case 'prompt':
      return `<div class="blocktext">${esc(b.text ?? '')}</div>${trunc}`;
    case 'thinking':
      return `<details class="block"><summary>💭 thinking</summary><pre>${esc(b.text ?? '')}</pre></details>`;
    case 'tool_use': {
      const name = b.toolName ?? 'tool';
      return `<details class="block"><summary>🔧 ${esc(name)}</summary><pre>${esc(prettyToolInput(b.text ?? '', name))}</pre></details>${trunc}`;
    }
    case 'tool_result': {
      const errCls = b.isError ? ' error' : '';
      const icon = b.isError ? '⚠️' : '↩';
      return `<details class="block${errCls}"><summary>${icon} tool result</summary><pre>${esc(b.text ?? '')}</pre></details>${trunc}`;
    }
    case 'image': {
      const id = mediaIds.get(`${b.byteStart}:${bi}`);
      if (id === undefined) return `<div class="muted small">[image${b.mediaType ? ` ${esc(b.mediaType)}` : ''} unavailable]</div>`;
      return `<img class="media" loading="lazy" src="${blobUrl(sessionId, id, blobVersion)}" alt="image">`;
    }
    case 'document': {
      const id = mediaIds.get(`${b.byteStart}:${bi}`);
      const label = `document${b.mediaType ? ` (${esc(b.mediaType)})` : ''}`;
      if (id === undefined) return `<div class="muted small">[${label} unavailable]</div>`;
      return `<div><a href="${blobUrl(sessionId, id, blobVersion)}">📄 ${label}</a></div>`;
    }
    default:
      return '';
  }
}

function renderHeader(
  meta: SessionMeta,
  children: Array<{ session_id: string; title: string | null }>,
  view: View,
  url: URL,
): string {
  const banners: string[] = [];
  if (meta.parent_session_id) {
    banners.push(
      `<div class="banner">↳ Subagent session — <a href="/s/${q(meta.parent_session_id)}">open parent</a></div>`,
    );
  }
  if (children.length) {
    const links = children
      .map((c) => `<a href="/s/${q(c.session_id)}">${esc(c.title || c.session_id)}</a>`)
      .join(' · ');
    banners.push(`<div class="banner">Subagents (${children.length}): ${links}</div>`);
  }
  if (meta.index_state === 'parsing' || meta.index_state === 'error') {
    banners.push(`<div class="warn">Index state: ${esc(meta.index_state)} — content may be incomplete.</div>`);
  }

  const kv: string[] = [`<span class="badge">${esc(meta.harness)}</span>`];
  if (meta.primary_model) kv.push(`<span class="chip">${esc(meta.primary_model)}</span>`);
  if (meta.machine_id) kv.push(`<span class="chip">${esc(meta.machine_id)}</span>`);
  if (meta.cwd) kv.push(`<span class="muted small">${esc(meta.cwd)}</span>`);
  if (meta.repo_url) kv.push(`<span class="muted small">${esc(meta.repo_url)}${meta.git_branch ? ` @ ${esc(meta.git_branch)}` : ''}</span>`);
  if (meta.started_at) kv.push(`<span class="muted small">${esc(meta.started_at)}</span>`);

  const tokens =
    `<span class="muted small">tokens: ${fmtNum(meta.tokens_in)} in · ${fmtNum(meta.tokens_out)} out` +
    (meta.tokens_reasoning ? ` · ${fmtNum(meta.tokens_reasoning)} reasoning` : '') +
    (meta.tokens_cached ? ` · ${fmtNum(meta.tokens_cached)} cached` : '') +
    `</span>`;

  const viewToggle =
    view === 'chronological'
      ? `<a href="${esc(withView(url, 'effective'))}">effective view</a>`
      : `<a href="${esc(withView(url, 'chronological'))}">chronological view</a>`;

  return (
    banners.join('') +
    `<div class="sesshead"><h2 style="margin:0">${esc(meta.title || sessionTitle(meta))}</h2>` +
    `<div class="kv">${kv.join('')}</div>` +
    `<div class="kv">${tokens} · ${viewToggle}</div></div>`
  );
}

function sessionTitle(meta: SessionMeta): string {
  return `Session ${meta.session_id}`;
}

function renderPager(url: URL, page: number, totalPages: number): string {
  if (totalPages <= 1) return '';
  const link = (p: number, label: string) => {
    const u = new URL(url);
    u.searchParams.set('page', String(p));
    return `<a href="${esc(u.pathname + u.search)}">${label}</a>`;
  };
  const prev = page > 1 ? link(page - 1, '← Prev') : `<span class="muted">← Prev</span>`;
  const next = page < totalPages ? link(page + 1, 'Next →') : `<span class="muted">Next →</span>`;
  return `<div class="pager">${prev}<span class="muted small">page ${page} / ${totalPages}</span>${next}</div>`;
}

function withView(url: URL, view: View): string {
  const u = new URL(url);
  u.searchParams.set('view', view);
  u.searchParams.delete('page');
  return u.pathname + u.search;
}

function clampPage(raw: string | null, totalPages: number): number {
  const n = Number(raw ?? 1);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), totalPages);
}

function prettyToolInput(text: string, name: string): string {
  const rest = text.startsWith(name) ? text.slice(name.length).trim() : text;
  try {
    return JSON.stringify(JSON.parse(rest), null, 2);
  } catch {
    return rest || text;
  }
}

function fmtNum(n: number | null): string {
  return (n ?? 0).toLocaleString('en-US');
}

/**
 * Cache-busting version token for blob URLs: first 12 hex of the canonical file's content hash.
 * Only a real sha-256 qualifies — reindex stores the literal 'unknown' for checksum-less R2 objects,
 * which must NOT mint a stable token (it would pin different bytes to one immutable-cached URL). An empty
 * token leaves the blob response revalidatable (no-cache) so later reindexes always refetch.
 */
export function blobVersionOf(contentHash: string | null | undefined): string {
  return contentHash && /^[0-9a-f]{64}$/i.test(contentHash) ? contentHash.slice(0, 12) : '';
}

function blobUrl(sessionId: string, blockId: number, version: string): string {
  const base = `/s/${q(sessionId)}/blob/${blockId}`;
  return version ? `${base}?v=${version}` : base;
}

function notFound(): Response {
  return new Response('<!doctype html><meta charset=utf-8><p>Session not found.</p>', {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
