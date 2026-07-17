import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { viewerRoute } from '../src/viewer/router';
import { previewBearerOk } from '../src/auth/identity';
import { ccLine, ccLinearSession, ccSystemLine, TINY_PNG_B64 } from './fixtures';
import { blobVersionOf } from '../src/viewer/session';

const testEnv = env as unknown as Env;

const SEARCH_SESSION = 'aaaaaaaa-1111-4111-8111-111111111111';
const BIG_SESSION = 'bbbbbbbb-2222-4222-8222-222222222222';
const LONG_SESSION = 'cccccccc-3333-4333-8333-333333333333';
const BLOB_SESSION = 'dddddddd-4444-4444-8444-444444444444';
const REWIND_SESSION = 'eeeeeeee-5555-4555-8555-555555555555';
const SYSTEM_SESSION = 'ffffffff-6666-4666-8666-666666666666';
const UNVER_SESSION = '99999999-7777-4777-8777-777777777777';
const UNKNOWN_MEDIA_SESSION = '88888888-8888-4888-8888-888888888888';
const CODEX_TAIL_SESSION = '77777777-9999-4999-8999-999999999999';
const REPO_SESSION = '66666666-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REPO_URL = 'https://github.com/tester/facetdemo';

// Hostile transcript payloads: an SVG with inline script and an HTML "document".
const SVG_XSS_B64 = btoa('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML_DOC_B64 = btoa('<!doctype html><script>alert(2)</script>');

/**
 * A rewind that crosses the page boundary: a shared prefix forks at turn 3 into (a) a long ABANDONED
 * branch that fills the rest of page 1 (turns 4..199) and (b) the WINNER branch on page 2 (turns 200..259)
 * that carries the session's last message. A page-1-only parse would walk back from turn 199 (on the dead
 * branch) and wrongly call it main-path — so this only renders correctly with the persisted on_main_path flag.
 */
function crossPageRewindSession(sessionId: string): string {
  const lines: string[] = [];
  const push = (uuid: string, parent: string | null, idx: number, text: string) =>
    lines.push(ccLine(sessionId, { uuid, parentUuid: parent, role: idx % 2 === 0 ? 'user' : 'assistant', text }));
  push('s0', null, 0, 'shared start prompt');
  push('s1', 's0', 1, 'shared reply');
  push('s2', 's1', 2, 'shared followup');
  push('s3', 's2', 3, 'fork point');
  let parent = 's3';
  for (let i = 0; i < 196; i++) {
    const idx = 4 + i;
    const uuid = `ab-${i}`;
    push(uuid, parent, idx, idx === 100 ? 'abandonedmarker deep in dead branch' : `abandoned line ${i}`);
    parent = uuid;
  }
  parent = 's3'; // the rewind: winner branch re-forks from the same point
  for (let i = 0; i < 60; i++) {
    const idx = 200 + i;
    const uuid = `win-${i}`;
    push(uuid, parent, idx, idx === 250 ? 'winnermarker on the real path' : `winner line ${i}`);
    parent = uuid;
  }
  return lines.join('\n');
}

// A long session with a unique sentinel planted in a turn past the first page (turn_index 250).
function longSessionWithSentinel(sessionId: string, turns: number, sentinelAt: number): string {
  const lines: string[] = [];
  let parent: string | null = null;
  for (let i = 0; i < turns; i++) {
    const uuid = `L-${i}`;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    const text = i === sentinelAt ? 'zzuniquesentinel marker word' : `filler content line ${i}`;
    lines.push(ccLine(sessionId, { uuid, parentUuid: parent, role, text }));
    parent = uuid;
  }
  return lines.join('\n');
}

/** Codex rollout with `contentTurns` user turns followed by a trailing context_compacted marker (last turn). */
function codexTrailingCompaction(sessionId: string, contentTurns: number): string {
  const ts = '2026-07-02T09:00:00.000Z';
  const lines: string[] = [
    JSON.stringify({ timestamp: ts, type: 'session_meta', payload: { session_id: sessionId, cwd: '/home/tester/src/demo', cli_version: '0.150.0' } }),
    JSON.stringify({ timestamp: ts, type: 'turn_context', payload: { model: 'gpt-test-2' } }),
  ];
  for (let i = 0; i < contentTurns; i++) {
    lines.push(JSON.stringify({
      timestamp: ts,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `codex content turn ${i}` }],
        internal_chat_message_metadata_passthrough: { turn_id: `t${i}` },
      },
    }));
  }
  lines.push(JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'context_compacted' } }));
  return lines.join('\n');
}

/** Minimal codex rollout carrying a git repository_url (only codex sessions populate repo_url) + one message. */
function codexWithRepo(sessionId: string, repoUrl: string, text: string): string {
  const ts = '2026-07-02T09:00:00.000Z';
  return [
    JSON.stringify({ timestamp: ts, type: 'session_meta', payload: { session_id: sessionId, cwd: '/home/tester/src/demo', cli_version: '0.150.0', git: { repository_url: repoUrl, branch: 'main' } } }),
    JSON.stringify({ timestamp: ts, type: 'turn_context', payload: { model: 'gpt-test-2' } }),
    JSON.stringify({ timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }], internal_chat_message_metadata_passthrough: { turn_id: 't1' } } }),
  ].join('\n');
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function putFile(store: string, relpath: string, content: string): Promise<Response> {
  const body = new TextEncoder().encode(content);
  return SELF.fetch(`https://api.sessions.vza.net/api/v1/files/testbox-wsl/${store}/${encodeURIComponent(relpath)}`, {
    method: 'PUT',
    headers: {
      'x-dev-machine': 'testbox-wsl',
      'x-content-hash': `sha256:${await sha256Hex(body)}`,
      'x-file-mtime': '2026-07-01T12:00:00Z',
      'content-length': String(body.length),
    },
    body,
  });
}

async function drainQueue(): Promise<void> {
  const pending = await testEnv.DB.prepare("SELECT id, r2_key FROM files WHERE parse_state = 'pending'").all<{
    id: number;
    r2_key: string;
  }>();
  const messages = pending.results.map((r) => ({
    id: String(r.id),
    timestamp: new Date(),
    attempts: 1,
    body: { file_id: r.id, r2_key: r.r2_key, reason: 'upload' as const },
    ack() {},
    retry() {},
  }));
  if (messages.length === 0) return;
  await worker.queue({ queue: 'parse', messages, ackAll() {}, retryAll() {} } as unknown as MessageBatch<ParseMessage>, testEnv);
}

/** Redeliver one file to the consumer regardless of its parse_state — simulates an admin reindex. */
async function deliverOne(fileId: number, r2Key: string): Promise<void> {
  const message = { id: String(fileId), timestamp: new Date(), attempts: 1, body: { file_id: fileId, r2_key: r2Key, reason: 'reindex' as const }, ack() {}, retry() {} };
  await worker.queue({ queue: 'parse', messages: [message], ackAll() {}, retryAll() {} } as unknown as MessageBatch<ParseMessage>, testEnv);
}

let rewindFileId = 0;
let rewindR2Key = '';

// A session with searchable tool output, an inline image, and an abandoned (rewound) branch.
const SEARCH_CONTENT = [
  ccLine(SEARCH_SESSION, { uuid: 'u1', parentUuid: null, role: 'user', text: 'where is the xenondioxide note?' }),
  ccLine(SEARCH_SESSION, { uuid: 'a1', parentUuid: 'u1', role: 'assistant', text: 'searching', toolUse: { id: 'tu1', name: 'Grep', input: { pattern: 'xenondioxide' } } }),
  ccLine(SEARCH_SESSION, { uuid: 'uOld', parentUuid: 'a1', role: 'user', text: 'abandoned branch attempt' }),
  ccLine(SEARCH_SESSION, { uuid: 'aOld', parentUuid: 'uOld', role: 'assistant', text: 'abandoned assistant reply' }),
  ccLine(SEARCH_SESSION, { uuid: 'u2', parentUuid: 'a1', role: 'user', toolResult: { toolUseId: 'tu1', content: 'xenondioxide appears in notes.md line 12' } }),
  ccLine(SEARCH_SESSION, { uuid: 'a2', parentUuid: 'u2', role: 'assistant', text: 'found the reference' }),
  ccLine(SEARCH_SESSION, { uuid: 'uImg', parentUuid: 'a2', role: 'user', image: { mediaType: 'image/png', data: TINY_PNG_B64 } }),
].join('\n');

describe('viewer', () => {
  beforeAll(async () => {
    expect((await putFile('claude-projects', `-home-tester-src-demo/${SEARCH_SESSION}.jsonl`, SEARCH_CONTENT)).status).toBe(201);
    expect((await putFile('claude-projects', `-home-tester-src-demo/${BIG_SESSION}.jsonl`, ccLinearSession(BIG_SESSION, 450))).status).toBe(201);
    expect(
      (await putFile('claude-projects', `-home-tester-src-demo/${LONG_SESSION}.jsonl`, longSessionWithSentinel(LONG_SESSION, 260, 250))).status,
    ).toBe(201);
    const blobContent = [
      ccLine(BLOB_SESSION, { uuid: 'b1', parentUuid: null, role: 'user', image: { mediaType: 'image/png', data: TINY_PNG_B64 } }),
      ccLine(BLOB_SESSION, { uuid: 'b2', parentUuid: 'b1', role: 'user', image: { mediaType: 'image/svg+xml', data: SVG_XSS_B64 } }),
      ccLine(BLOB_SESSION, { uuid: 'b3', parentUuid: 'b2', role: 'user', document: { mediaType: 'text/html', data: HTML_DOC_B64 } }),
    ].join('\n');
    expect((await putFile('claude-projects', `-home-tester-src-demo/${BLOB_SESSION}.jsonl`, blobContent)).status).toBe(201);

    const rewindRelpath = `-home-tester-src-demo/${REWIND_SESSION}.jsonl`;
    const rewindRes = await putFile('claude-projects', rewindRelpath, crossPageRewindSession(REWIND_SESSION));
    expect(rewindRes.status).toBe(201);
    rewindFileId = ((await rewindRes.json()) as { file_id: number }).file_id;
    rewindR2Key = `raw/testbox-wsl/claude-projects/${rewindRelpath}`;

    // u1 → a1 with an unlinked system turn in the middle (not part of the parentUuid chain).
    const systemContent = [
      ccLine(SYSTEM_SESSION, { uuid: 'u1', parentUuid: null, role: 'user', text: 'user asks something' }),
      ccSystemLine(SYSTEM_SESSION, { uuid: 'sys1', text: 'SYSTEMREMINDER injected context' }),
      ccLine(SYSTEM_SESSION, { uuid: 'a1', parentUuid: 'u1', role: 'assistant', text: 'assistant answers' }),
    ].join('\n');
    expect((await putFile('claude-projects', `-home-tester-src-demo/${SYSTEM_SESSION}.jsonl`, systemContent)).status).toBe(201);

    expect(
      (await putFile('claude-projects', `-home-tester-src-demo/${UNVER_SESSION}.jsonl`,
        ccLine(UNVER_SESSION, { uuid: 'v1', parentUuid: null, role: 'user', image: { mediaType: 'image/png', data: TINY_PNG_B64 } }),
      )).status,
    ).toBe(201);

    // An unknown content item (server_tool_use) BEFORE the image: the parser emits a text block for the
    // unknown item, so the image is indexed at block_index 1 — the blob extractor must count it identically.
    expect(
      (await putFile('claude-projects', `-home-tester-src-demo/${UNKNOWN_MEDIA_SESSION}.jsonl`,
        ccLine(UNKNOWN_MEDIA_SESSION, {
          uuid: 'um1', parentUuid: null, role: 'assistant',
          unknownFirst: 'server_tool_use',
          image: { mediaType: 'image/png', data: TINY_PNG_B64 },
        }),
      )).status,
    ).toBe(201);

    // Codex session: 200 content turns (indices 0..199) then a trailing compaction marker (index 200 → page 2).
    expect(
      (await putFile('codex-sessions', `2026/07/02/rollout-2026-07-02T09-00-00-${CODEX_TAIL_SESSION}.jsonl`,
        codexTrailingCompaction(CODEX_TAIL_SESSION, 200),
      )).status,
    ).toBe(201);

    // Codex session with a repo_url + a distinctive search token, so the repo facet appears on the search page.
    expect(
      (await putFile('codex-sessions', `2026/07/02/rollout-2026-07-02T09-00-00-${REPO_SESSION}.jsonl`,
        codexWithRepo(REPO_SESSION, REPO_URL, 'facetsentinelword in the repo transcript'),
      )).status,
    ).toBe(201);

    await drainQueue();
  });

  it('search page returns 200 with a highlighted snippet and a link to the session', async () => {
    const res = await SELF.fetch('https://sessions.vza.net/?q=xenondioxide');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<mark>');
    expect(html).toContain('xenondioxide');
    expect(html).toContain(`/s/${SEARCH_SESSION}`);
  });

  it('empty query lists recent sessions', async () => {
    const res = await SELF.fetch('https://sessions.vza.net/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Recent sessions');
    expect(html).toContain(`/s/${BIG_SESSION}`);
  });

  it('marks a selected repo facet active with a toggle-off link that drops the repo param', async () => {
    const res = await SELF.fetch(
      `https://sessions.vza.net/?q=facetsentinelword&repo=${encodeURIComponent(REPO_URL)}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // The selected repo facet renders as active (✓) and its <li> carries the active class.
    const m = html.match(/<li class="active"><a href="([^"]*)">✓ [^<]*facetdemo/);
    expect(m).toBeTruthy();
    // Its toggle link clears the repo param (so a second click removes the filter) while keeping the query.
    const href = m![1]!;
    expect(href).not.toContain('repo=');
    expect(href).toContain('q=facetsentinelword');
  });

  it('session page renders turns with role classes', async () => {
    const res = await SELF.fetch(`https://sessions.vza.net/s/${SEARCH_SESSION}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('turn user');
    expect(html).toContain('turn assistant');
    expect(html).toContain('found the reference');
    // inline image points at the blob endpoint
    expect(html).toMatch(new RegExp(`/s/${SEARCH_SESSION}/blob/\\d+`));
  });

  it('dims off-main-path (rewound) turns in the chronological view', async () => {
    const res = await SELF.fetch(`https://sessions.vza.net/s/${SEARCH_SESSION}?view=chronological`);
    const html = await res.text();
    expect(html).toContain('rewound');
    expect(html).toContain('abandoned assistant reply');
  });

  it('hides off-main-path turns in the effective view', async () => {
    const res = await SELF.fetch(`https://sessions.vza.net/s/${SEARCH_SESSION}?view=effective`);
    const html = await res.text();
    expect(html).not.toContain('abandoned assistant reply');
    expect(html).toContain('found the reference');
  });

  it('paginates a 450-turn session into 3 pages via byte offsets', async () => {
    const p1 = await (await SELF.fetch(`https://sessions.vza.net/s/${BIG_SESSION}`)).text();
    expect(p1).toContain('page 1 / 3');
    expect(p1).toContain('turn number 0 content');
    expect(p1).toContain('turn number 199 content');
    expect(p1).not.toContain('turn number 200 content');

    const p2 = await (await SELF.fetch(`https://sessions.vza.net/s/${BIG_SESSION}?page=2`)).text();
    expect(p2).toContain('page 2 / 3');
    expect(p2).toContain('turn number 200 content');
    expect(p2).toContain('turn number 399 content');
    expect(p2).not.toContain('turn number 400 content');

    const p3 = await (await SELF.fetch(`https://sessions.vza.net/s/${BIG_SESSION}?page=3`)).text();
    expect(p3).toContain('page 3 / 3');
    expect(p3).toContain('turn number 449 content');
  });

  it('paginates a trailing compaction marker onto its own page and renders the divider there', async () => {
    // The marker turn (turn_index 200) has no content blocks; the indexer persists a text-less
    // btype=compaction row so the page count and byte window include it.
    const row = await testEnv.DB.prepare(
      "SELECT id, turn_index, text FROM blocks WHERE session_id = ?1 AND btype = 'compaction'",
    )
      .bind(CODEX_TAIL_SESSION)
      .first<{ id: number; turn_index: number; text: string | null }>();
    expect(row).toBeTruthy();
    expect(row!.turn_index).toBe(200);
    expect(row!.text).toBeNull(); // text-less → excluded by the FTS insert's `WHERE text IS NOT NULL`

    // The text-less compaction rows did not desync the external-content FTS index.
    await expect(
      testEnv.DB.prepare("INSERT INTO blocks_fts(blocks_fts) VALUES('integrity-check')").run(),
    ).resolves.toBeTruthy();

    // Page count includes the marker's page…
    const p1 = await (await SELF.fetch(`https://sessions.vza.net/s/${CODEX_TAIL_SESSION}`)).text();
    expect(p1).toContain('page 1 / 2');
    expect(p1).not.toContain('context compacted');

    // …and the divider renders on the final page (it would be dropped without the persisted row).
    const p2 = await (await SELF.fetch(`https://sessions.vza.net/s/${CODEX_TAIL_SESSION}?page=2`)).text();
    expect(p2).toContain('page 2 / 2');
    expect(p2).toContain('context compacted');
  });

  it('deep-links a search hit past page 1 to the right page with a turn anchor', async () => {
    const res = await SELF.fetch('https://sessions.vza.net/?q=zzuniquesentinel');
    expect(res.status).toBe(200);
    const html = await res.text();
    // turn_index 250 → page floor(250/200)+1 = 2, anchored at #t250.
    expect(html).toContain(`/s/${LONG_SESSION}?page=2#t250`);

    // The anchor target actually exists in the rendered page (default chronological view).
    const p2 = await (await SELF.fetch(`https://sessions.vza.net/s/${LONG_SESSION}?page=2`)).text();
    expect(p2).toContain('id="t250"');
    expect(p2).toContain('zzuniquesentinel');
    // And it is NOT on page 1.
    const p1 = await (await SELF.fetch(`https://sessions.vza.net/s/${LONG_SESSION}`)).text();
    expect(p1).not.toContain('id="t250"');
  });

  it('dims a cross-page rewind correctly on page 1 using the persisted main-path flag', async () => {
    const p1 = await (await SELF.fetch(`https://sessions.vza.net/s/${REWIND_SESSION}`)).text();
    expect(p1).toContain('page 1 / 2');
    // Turn 100 sits deep in the abandoned branch — a page-1-only parse would call it main-path.
    expect(p1).toContain('abandonedmarker');
    expect(p1).toMatch(/<article id="t100" class="turn user rewound"/);
    // A genuinely main-path turn on the same page is not dimmed.
    expect(p1).toMatch(/<article id="t0" class="turn user">/);
  });

  it('hides the cross-page rewind branch in the effective view', async () => {
    const p1 = await (await SELF.fetch(`https://sessions.vza.net/s/${REWIND_SESSION}?view=effective`)).text();
    expect(p1).not.toContain('abandonedmarker');
    expect(p1).not.toContain('id="t100"');
    expect(p1).toContain('shared start prompt'); // main-path prefix still shown
  });

  it('reindex preserves persisted on_main_path flags', async () => {
    const before = await testEnv.DB.prepare(
      'SELECT MAX(on_main_path) AS m FROM blocks WHERE session_id = ?1 AND turn_index = 100',
    )
      .bind(REWIND_SESSION)
      .first<{ m: number }>();
    expect(before?.m).toBe(0); // abandoned

    await deliverOne(rewindFileId, rewindR2Key); // re-parse: delete + reinsert all block rows

    const after = await testEnv.DB.prepare(
      'SELECT MAX(on_main_path) AS m FROM blocks WHERE session_id = ?1 AND turn_index = 100',
    )
      .bind(REWIND_SESSION)
      .first<{ m: number }>();
    expect(after?.m).toBe(0);
    const mainAfter = await testEnv.DB.prepare(
      'SELECT MAX(on_main_path) AS m FROM blocks WHERE session_id = ?1 AND turn_index = 0',
    )
      .bind(REWIND_SESSION)
      .first<{ m: number }>();
    expect(mainAfter?.m).toBe(1); // shared prefix still main-path

    // Still dimmed after reindex.
    const p1 = await (await SELF.fetch(`https://sessions.vza.net/s/${REWIND_SESSION}`)).text();
    expect(p1).toMatch(/<article id="t100" class="turn user rewound"/);
  });

  it('versions blob URLs by the canonical file content hash', async () => {
    const html = await (await SELF.fetch(`https://sessions.vza.net/s/${SEARCH_SESSION}`)).text();
    const hash = await testEnv.DB.prepare(
      'SELECT f.content_hash AS h FROM sessions s JOIN files f ON f.id = s.canonical_file_id WHERE s.session_id = ?1',
    )
      .bind(SEARCH_SESSION)
      .first<{ h: string }>();
    const v = hash!.h.slice(0, 12);
    expect(html).toContain(`/blob/`);
    expect(html).toMatch(new RegExp(`/blob/\\d+\\?v=${v}"`));
  });

  it('redirects a stale/versionless blob request and only serves immutable when version-matched', async () => {
    const block = await testEnv.DB.prepare("SELECT id, file_id FROM blocks WHERE session_id = ?1 AND btype = 'image'")
      .bind(SEARCH_SESSION)
      .first<{ id: number; file_id: number }>();
    const hash = await testEnv.DB.prepare('SELECT content_hash AS h FROM files WHERE id = ?1')
      .bind(block!.file_id)
      .first<{ h: string }>();
    const v = hash!.h.slice(0, 12);

    // Stale version → 302 pointing at the current version.
    const stale = await SELF.fetch(`https://sessions.vza.net/s/${SEARCH_SESSION}/blob/${block!.id}?v=deadbeefdead`, {
      redirect: 'manual',
    });
    expect(stale.status).toBe(302);
    expect(stale.headers.get('location')).toContain(`?v=${v}`);

    // Versionless → also redirected (so stale cached HTML still resolves).
    const bare = await SELF.fetch(`https://sessions.vza.net/s/${SEARCH_SESSION}/blob/${block!.id}`, { redirect: 'manual' });
    expect(bare.status).toBe(302);

    // Matched version → 200 with the immutable cache header.
    const ok = await SELF.fetch(`https://sessions.vza.net/s/${SEARCH_SESSION}/blob/${block!.id}?v=${v}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toContain('immutable');
  });

  it('keeps an unlinked system turn visible in effective view and undimmed in chronological', async () => {
    const chrono = await (await SELF.fetch(`https://sessions.vza.net/s/${SYSTEM_SESSION}?view=chronological`)).text();
    expect(chrono).toContain('SYSTEMREMINDER');
    // The system turn's <article> must not carry the rewound class.
    expect(chrono).toMatch(/<article[^>]*class="turn system"/);
    expect(chrono).not.toMatch(/<article[^>]*class="turn system[^"]*rewound"/);

    const effective = await (await SELF.fetch(`https://sessions.vza.net/s/${SYSTEM_SESSION}?view=effective`)).text();
    expect(effective).toContain('SYSTEMREMINDER'); // not hidden
  });

  it('blobVersionOf tokenizes real sha-256 hashes and rejects unknown/short values', () => {
    const validHash = 'a'.repeat(64);
    expect(blobVersionOf(validHash)).toBe('aaaaaaaaaaaa');
    expect(blobVersionOf(validHash).length).toBe(12);
    expect(blobVersionOf('unknown')).toBe('');
    expect(blobVersionOf('')).toBe('');
    expect(blobVersionOf(null)).toBe('');
    expect(blobVersionOf('xyz')).toBe('');
    expect(blobVersionOf('g'.repeat(64))).toBe(''); // non-hex
  });

  it('serves a checksum-less blob revalidatable (no immutable, no redirect loop)', async () => {
    // Simulate admin reindex having stored 'unknown' for an object R2 could not checksum.
    await testEnv.DB.prepare(
      `UPDATE files SET content_hash = 'unknown'
       WHERE id = (SELECT canonical_file_id FROM sessions WHERE session_id = ?1)`,
    )
      .bind(UNVER_SESSION)
      .run();

    // The renderer must not mint a ?v= token for it.
    const html = await (await SELF.fetch(`https://sessions.vza.net/s/${UNVER_SESSION}`)).text();
    const m = html.match(new RegExp(`/s/${UNVER_SESSION}/blob/(\\d+)("|\\?)`));
    expect(m).toBeTruthy();
    expect(html).not.toContain('?v=unknown');
    expect(html).not.toMatch(new RegExp(`/s/${UNVER_SESSION}/blob/\\d+\\?v=`));

    // Versionless fetch: served directly (no redirect) but revalidatable, never immutable.
    const res = await SELF.fetch(`https://sessions.vza.net/s/${UNVER_SESSION}/blob/${m![1]}`, { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('cache-control')).not.toContain('immutable');
  });

  it('blob endpoint round-trips a base64 png', async () => {
    const block = await testEnv.DB.prepare("SELECT id FROM blocks WHERE session_id = ?1 AND btype = 'image'")
      .bind(SEARCH_SESSION)
      .first<{ id: number }>();
    expect(block).toBeTruthy();
    const res = await SELF.fetch(`https://sessions.vza.net/s/${SEARCH_SESSION}/blob/${block!.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toContain('immutable');
    const got = new Uint8Array(await res.arrayBuffer());
    const want = Uint8Array.from(atob(TINY_PNG_B64), (c) => c.charCodeAt(0));
    expect([...got]).toEqual([...want]);
  });

  it('serves inert images inline but forces hostile MIME (svg, documents) to a download', async () => {
    const imgs = await testEnv.DB.prepare(
      "SELECT id FROM blocks WHERE session_id = ?1 AND btype = 'image' ORDER BY byte_start",
    )
      .bind(BLOB_SESSION)
      .all<{ id: number }>();
    const [pngId, svgId] = imgs.results.map((r) => r.id);
    const doc = await testEnv.DB.prepare("SELECT id FROM blocks WHERE session_id = ?1 AND btype = 'document'")
      .bind(BLOB_SESSION)
      .first<{ id: number }>();

    // PNG: inline, but with nosniff + a scriptless sandbox CSP.
    const png = await SELF.fetch(`https://sessions.vza.net/s/${BLOB_SESSION}/blob/${pngId}`);
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(png.headers.get('x-content-type-options')).toBe('nosniff');
    expect(png.headers.get('content-security-policy')).toBe('sandbox');
    expect(png.headers.get('content-disposition')).toBeNull();

    // SVG masquerading as an image: never inline — forced to an octet-stream attachment.
    const svg = await SELF.fetch(`https://sessions.vza.net/s/${BLOB_SESSION}/blob/${svgId}`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toBe('application/octet-stream');
    expect(svg.headers.get('x-content-type-options')).toBe('nosniff');
    expect(svg.headers.get('content-disposition')).toContain('attachment');

    // Document (text/html here): attachment, octet-stream.
    const d = await SELF.fetch(`https://sessions.vza.net/s/${BLOB_SESSION}/blob/${doc!.id}`);
    expect(d.status).toBe(200);
    expect(d.headers.get('content-type')).toBe('application/octet-stream');
    expect(d.headers.get('content-disposition')).toContain('attachment');
    expect(d.headers.get('content-security-policy')).toBeNull();
  });

  it('blob endpoint 404s for an unknown block', async () => {
    const res = await SELF.fetch(`https://sessions.vza.net/s/${SEARCH_SESSION}/blob/99999999`);
    expect(res.status).toBe(404);
  });

  it('serves media that follows an unknown content item in the same message', async () => {
    // The image is stored at block_index 1 (the unknown item took index 0); the blob extractor must
    // count the unknown item too, or it would test the image against index 0 and 404.
    const img = await testEnv.DB.prepare(
      "SELECT id, block_index FROM blocks WHERE session_id = ?1 AND btype = 'image'",
    )
      .bind(UNKNOWN_MEDIA_SESSION)
      .first<{ id: number; block_index: number }>();
    expect(img!.block_index).toBe(1); // proves the unknown item consumed index 0

    const hash = await testEnv.DB.prepare(
      'SELECT f.content_hash AS h FROM sessions s JOIN files f ON f.id = s.canonical_file_id WHERE s.session_id = ?1',
    )
      .bind(UNKNOWN_MEDIA_SESSION)
      .first<{ h: string }>();
    const res = await SELF.fetch(
      `https://sessions.vza.net/s/${UNKNOWN_MEDIA_SESSION}/blob/${img!.id}?v=${hash!.h.slice(0, 12)}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const got = new Uint8Array(await res.arrayBuffer());
    const want = Uint8Array.from(atob(TINY_PNG_B64), (c) => c.charCodeAt(0));
    expect([...got]).toEqual([...want]);
  });

  it('machines page lists the dev machine and corpus totals', async () => {
    const res = await SELF.fetch('https://sessions.vza.net/machines');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('testbox-wsl');
    expect(html).toContain('sessions ·');
  });

  it('returns 403 in production (auth not yet configured)', async () => {
    const url = new URL('https://sessions.vza.net/');
    const res = await viewerRoute(new Request(url.toString()), url, { ENVIRONMENT: 'production' } as Env);
    expect(res.status).toBe(403);
  });

  it('gates the preview viewer behind the DEV_AUTH bearer (publicly reachable previews)', async () => {
    const url = new URL('https://sessions.vza.net/');
    const previewEnv = { ...testEnv, ENVIRONMENT: 'preview', DEV_AUTH: 'preview-secret-123' } as unknown as Env;

    // No header → 401.
    const noHeader = await viewerRoute(new Request(url.toString()), url, previewEnv);
    expect(noHeader.status).toBe(401);

    // Wrong bearer → 401.
    const wrong = await viewerRoute(
      new Request(url.toString(), { headers: { authorization: 'Bearer nope' } }),
      url,
      previewEnv,
    );
    expect(wrong.status).toBe(401);

    // Correct bearer → the page serves.
    const ok = await viewerRoute(
      new Request(url.toString(), { headers: { authorization: 'Bearer preview-secret-123' } }),
      url,
      previewEnv,
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('Recent sessions');

    // Missing/empty DEV_AUTH secret denies even with a bearer header.
    const noSecret = { ...testEnv, ENVIRONMENT: 'preview', DEV_AUTH: undefined } as unknown as Env;
    const denied = await viewerRoute(
      new Request(url.toString(), { headers: { authorization: 'Bearer preview-secret-123' } }),
      url,
      noSecret,
    );
    expect(denied.status).toBe(401);
  });

  it('leaves the development viewer open (never publicly reachable)', async () => {
    const url = new URL('https://sessions.vza.net/');
    const devEnv = { ...testEnv, ENVIRONMENT: 'development' } as unknown as Env;
    const res = await viewerRoute(new Request(url.toString()), url, devEnv);
    expect(res.status).toBe(200);
  });

  it('fails closed on an unrecognized or missing ENVIRONMENT (mirrors the API allowlist)', async () => {
    const url = new URL('https://sessions.vza.net/');
    // Even with a DEV_AUTH bearer, a non-allowlisted ENVIRONMENT never serves.
    const bogus = { ...testEnv, ENVIRONMENT: 'staging', DEV_AUTH: 'x' } as unknown as Env;
    const bogusRes = await viewerRoute(
      new Request(url.toString(), { headers: { authorization: 'Bearer x' } }),
      url,
      bogus,
    );
    expect(bogusRes.status).toBe(403);

    const missing = { ...testEnv, ENVIRONMENT: undefined } as unknown as Env;
    const missingRes = await viewerRoute(new Request(url.toString()), url, missing);
    expect(missingRes.status).toBe(403);
  });

  it('issues a browser cookie on bearer auth so preview navigations/subresources stay authorized', async () => {
    const url = new URL('https://sessions.vza.net/');
    const secret = 'preview-secret-123';
    const previewEnv = { ...testEnv, ENVIRONMENT: 'preview', DEV_AUTH: secret } as unknown as Env;

    // First request with the bearer serves AND sets the persistence cookie.
    const first = await viewerRoute(
      new Request(url.toString(), { headers: { authorization: `Bearer ${secret}` } }),
      url,
      previewEnv,
    );
    expect(first.status).toBe(200);
    const setCookie = first.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`__Host-preview-auth=${secret}`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');

    // Follow-up carrying ONLY the cookie (no Authorization header) still serves.
    const followUp = await viewerRoute(
      new Request(url.toString(), { headers: { cookie: `__Host-preview-auth=${secret}` } }),
      url,
      previewEnv,
    );
    expect(followUp.status).toBe(200);
    // A cookie-authorized request does not re-issue the cookie (only the bearer path does).
    expect(followUp.headers.get('set-cookie')).toBeNull();

    // Wrong cookie value → 401.
    const badCookie = await viewerRoute(
      new Request(url.toString(), { headers: { cookie: '__Host-preview-auth=wrong' } }),
      url,
      previewEnv,
    );
    expect(badCookie.status).toBe(401);

    // The machine API gate (previewBearerOk) ignores the cookie — bearer header only.
    expect(previewBearerOk(new Request(url.toString(), { headers: { cookie: `__Host-preview-auth=${secret}` } }), previewEnv)).toBe(false);
    expect(previewBearerOk(new Request(url.toString(), { headers: { authorization: `Bearer ${secret}` } }), previewEnv)).toBe(true);
  });
});
