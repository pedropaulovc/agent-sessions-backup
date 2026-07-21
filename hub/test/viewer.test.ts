import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { viewerRoute } from '../src/viewer/router';
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
const OFFSET_MATCH_SESSION = '55555555-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TITLE_SESSION = '44444444-cccc-4ccc-8ccc-cccccccccccc';
const TEAMMATE_TITLE_SESSION = '33333333-dddd-4ddd-8ddd-dddddddddddd';
const PREFIXED_TURN_TITLE_SESSION = '22222222-eeee-4eee-8eee-eeeeeeeeeeee';
const SERVER_TOOL_TITLE_SESSION = '11111111-ffff-4fff-8fff-ffffffffffff';
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

async function seedPreviewBootstrap(nonce: string, expiresAt = Date.now() + 60_000): Promise<string> {
  const hash = await sha256Hex(new TextEncoder().encode(nonce));
  const key = `preview_auth:${hash}`;
  await testEnv.DB.prepare('INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2')
    .bind(key, String(expiresAt))
    .run();
  return key;
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

    const titleContent = [
      ccSystemLine(TITLE_SESSION, { uuid: 'title-system', text: 'System prompt must not become the title' }),
      JSON.stringify({ type: 'attachment', uuid: 'title-hook', parentUuid: 'title-system', payload: { kind: 'hook', output: 'Hook output must not become the title' } }),
      ccLine(TITLE_SESSION, { uuid: 'title-tool-use', parentUuid: 'title-hook', role: 'assistant', toolUse: { id: 'title-tu', name: 'Read', input: { file_path: '/tmp/title' } } }),
      ccLine(TITLE_SESSION, { uuid: 'title-tool-result', parentUuid: 'title-tool-use', role: 'user', toolResult: { toolUseId: 'title-tu', content: 'Tool result must not become the title' } }),
      ccLine(TITLE_SESSION, { uuid: 'title-server-tool', parentUuid: 'title-tool-result', role: 'assistant', unknownFirst: 'server_tool_use' }),
      ccLine(TITLE_SESSION, { uuid: 'title-agents', parentUuid: 'title-server-tool', role: 'user', text: '# AGENTS.md instructions\nInjected agent instructions' }),
      ccLine(TITLE_SESSION, { uuid: 'title-local', parentUuid: 'title-agents', role: 'assistant', text: '<local-command-caveat>Injected local command</local-command-caveat>' }),
      ccLine(TITLE_SESSION, { uuid: 'title-plugins', parentUuid: 'title-local', role: 'user', text: '<recommended_plugins>Injected plugin list</recommended_plugins>' }),
      ccLine(TITLE_SESSION, { uuid: 'title-command', parentUuid: 'title-plugins', role: 'assistant', text: '<command-name>Injected command</command-name>' }),
      ccLine(TITLE_SESSION, { uuid: 'title-stdout', parentUuid: 'title-command', role: 'user', text: '<local-command-stdout>Injected stdout</local-command-stdout>' }),
      ccLine(TITLE_SESSION, { uuid: 'title-user', parentUuid: 'title-stdout', role: 'user', text: 'First real title interaction' }),
      ccLine(TITLE_SESSION, { uuid: 'title-assistant', parentUuid: 'title-user', role: 'assistant', text: 'titlequerysentinel response' }),
      JSON.stringify({ type: 'ai-title', title: 'Generated title must not be used' }),
    ].join('\n');
    expect(
      (await putFile('claude-projects', `-home-tester-src-demo/${TITLE_SESSION}.jsonl`, titleContent)).status,
    ).toBe(201);

    const teammateTitleContent = [
      ccSystemLine(TEAMMATE_TITLE_SESSION, { uuid: 'teammate-system', text: 'Teammate system prelude' }),
      ccLine(TEAMMATE_TITLE_SESSION, { uuid: 'teammate-agents', parentUuid: 'teammate-system', role: 'user', text: '# AGENTS.md instructions\nInjected before teammate' }),
      ccLine(TEAMMATE_TITLE_SESSION, {
        uuid: 'teammate-message',
        parentUuid: 'teammate-agents',
        role: 'user',
        text: '<teammate-message teammate_id="team-lead" summary="Fix &amp; verify &quot;quoted&quot; &#x1F680;">Ignore wrapper body</teammate-message>',
      }),
      ccLine(TEAMMATE_TITLE_SESSION, { uuid: 'teammate-response', parentUuid: 'teammate-message', role: 'assistant', text: 'teammatetitlequerysentinel response' }),
    ].join('\n');
    expect(
      (await putFile('claude-projects', `-home-tester-src-demo/${TEAMMATE_TITLE_SESSION}.jsonl`, teammateTitleContent)).status,
    ).toBe(201);

    const serverToolTitleContent = [
      ccSystemLine(SERVER_TOOL_TITLE_SESSION, { uuid: 'server-tool-system', text: 'Server tool system prelude' }),
      ccLine(SERVER_TOOL_TITLE_SESSION, {
        uuid: 'server-tool-with-text',
        parentUuid: 'server-tool-system',
        role: 'assistant',
        unknownFirst: 'server_tool_use',
        text: 'Real text after server tool metadata',
      }),
      ccLine(SERVER_TOOL_TITLE_SESSION, { uuid: 'server-tool-query', parentUuid: 'server-tool-with-text', role: 'user', text: 'servertooltitlequerysentinel response' }),
    ].join('\n');
    expect(
      (await putFile('claude-projects', `-home-tester-src-demo/${SERVER_TOOL_TITLE_SESSION}.jsonl`, serverToolTitleContent)).status,
    ).toBe(201);

    const offsetMatchContent = [
      ccLine(OFFSET_MATCH_SESSION, { uuid: 'om-1', parentUuid: null, role: 'user', text: 'offset first turn' }),
      ccLine(OFFSET_MATCH_SESSION, { uuid: 'om-2', parentUuid: 'om-1', role: 'assistant', text: 'offset second turn' }),
      ccLine(OFFSET_MATCH_SESSION, { uuid: 'om-3', parentUuid: 'om-2', role: 'user', text: 'offset third turn' }),
    ].join('\n');
    expect(
      (await putFile('claude-projects', `-home-tester-src-demo/${OFFSET_MATCH_SESSION}.jsonl`, offsetMatchContent)).status,
    ).toBe(201);

    await drainQueue();

    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO sessions (session_id, harness, machine_id, title, started_at, index_state)
         VALUES (?1, 'claude-code', 'testbox-wsl', 'Stored prefixed-turn title', '2026-07-01T10:00:00Z', 'ready')`,
      ).bind(PREFIXED_TURN_TITLE_SESSION),
      testEnv.DB.prepare(
        `INSERT INTO blocks (session_id, file_id, turn_index, block_index, role, btype, text) VALUES
         (?1, 1, 0, 0, 'user', 'text', '# AGENTS.md instructions injected in first block'),
         (?1, 1, 0, 1, 'user', 'text', 'Same-turn text must not become the title'),
         (?1, 1, 1, 0, 'assistant', 'text', 'First later turn title'),
         (?1, 1, 2, 0, 'user', 'text', 'sameturntitlesentinel query target')`,
      ).bind(PREFIXED_TURN_TITLE_SESSION),
    ]);
    await testEnv.DB.prepare(
      `INSERT INTO blocks_fts(rowid, text)
       SELECT id, text FROM blocks WHERE session_id = ?1`,
    ).bind(PREFIXED_TURN_TITLE_SESSION).run();
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

  it('titles recent sessions from the first user/agent text, excluding system instructions, hooks, and tools', async () => {
    const html = await (await SELF.fetch('https://sessions.vza.net/')).text();
    expect(html).toContain(`<a href="/s/${TITLE_SESSION}">First real title interaction</a>`);
    expect(html).not.toContain('Generated title must not be used');
    expect(html).not.toContain('System prompt must not become the title');
    expect(html).not.toContain('Hook output must not become the title');
    expect(html).not.toContain('Tool result must not become the title');
    expect(html).not.toContain('Injected agent instructions');
    expect(html).not.toContain('Injected local command');
    expect(html).not.toContain('Injected plugin list');
    expect(html).not.toContain('Injected command');
    expect(html).not.toContain('Injected stdout');
    expect(html).toContain(`<a href="/s/${TEAMMATE_TITLE_SESSION}">Fix &amp; verify &quot;quoted&quot; 🚀</a>`);

    const sorted = await (await SELF.fetch('https://sessions.vza.net/?harness=claude-code&sort=total_tokens')).text();
    expect(sorted).toContain(`<a href="/s/${TITLE_SESSION}">First real title interaction</a>`);
  });

  it('titles query results from the first user/agent text, not the matching turn or stored title', async () => {
    const html = await (await SELF.fetch('https://sessions.vza.net/?q=titlequerysentinel')).text();
    expect(html).toContain(`<a href="/s/${TITLE_SESSION}?page=1#t10">First real title interaction</a>`);
    expect(html).not.toContain('Generated title must not be used');
  });

  it('uses the decoded team-lead teammate summary as the title', async () => {
    const html = await (await SELF.fetch('https://sessions.vza.net/?q=teammatetitlequerysentinel')).text();
    expect(html).toContain(
      `<a href="/s/${TEAMMATE_TITLE_SESSION}?page=1#t3">Fix &amp; verify &quot;quoted&quot; 🚀</a>`,
    );
    expect(html).not.toContain('Ignore wrapper body');
  });

  it('rejects the entire turn when its first text block has an injected prefix', async () => {
    const html = await (await SELF.fetch('https://sessions.vza.net/?q=sameturntitlesentinel')).text();
    expect(html).toContain(
      `<a href="/s/${PREFIXED_TURN_TITLE_SESSION}?page=1#t2">First later turn title</a>`,
    );
    expect(html).not.toContain('Same-turn text must not become the title');
  });

  it('skips preserved server tool metadata without suppressing real text later in the same turn', async () => {
    const html = await (await SELF.fetch('https://sessions.vza.net/?q=servertooltitlequerysentinel')).text();
    expect(html).toContain(
      `<a href="/s/${SERVER_TOOL_TITLE_SESSION}?page=1#t2">Real text after server tool metadata</a>`,
    );
    expect(html).not.toContain('{&quot;type&quot;:&quot;server_tool_use&quot;');
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

  it('matches turn metadata at any block offset so skipped D1 records cannot shift later turns', async () => {
    const rows = (
      await testEnv.DB.prepare(
        'SELECT turn_index, byte_start FROM blocks WHERE session_id = ?1 ORDER BY turn_index',
      )
        .bind(OFFSET_MATCH_SESSION)
        .all<{ turn_index: number; byte_start: number }>()
    ).results;
    expect(rows).toHaveLength(3);

    // Simulate a previously indexed turn whose source record is now skipped by the bounded JSONL reader.
    // Later D1 turns keep their authoritative indices, leaving this row unmatched by the fresh raw parse.
    await testEnv.DB.prepare(
      'UPDATE blocks SET turn_index = turn_index + 1 WHERE session_id = ?1 AND turn_index >= 1',
    ).bind(OFFSET_MATCH_SESSION).run();
    await testEnv.DB.prepare(
      `INSERT INTO blocks
         (session_id, file_id, turn_index, block_index, role, btype, byte_start, byte_len, truncated, text, on_main_path)
       SELECT session_id, file_id, 1, 0, 'assistant', 'text', ?2, 1, 0, NULL, 0
       FROM blocks WHERE session_id = ?1 AND turn_index = 0 LIMIT 1`,
    ).bind(OFFSET_MATCH_SESSION, rows[0]!.byte_start + 1).run();

    // The old turn 2 also had an oversized first block, followed by the smaller block that still exists in
    // the raw parse. Its authoritative index/main-path metadata must match at that later surviving offset,
    // not only at MIN(byte_start) for the turn.
    await testEnv.DB.prepare(
      'UPDATE blocks SET block_index = block_index + 1, on_main_path = 0 WHERE session_id = ?1 AND turn_index = 2',
    ).bind(OFFSET_MATCH_SESSION).run();
    await testEnv.DB.prepare(
      `INSERT INTO blocks
         (session_id, file_id, turn_index, block_index, role, btype, byte_start, byte_len, truncated, text, on_main_path)
       SELECT session_id, file_id, 2, 0, 'assistant', 'tool_result', ?2, 1, 0, NULL, 0
       FROM blocks WHERE session_id = ?1 AND turn_index = 0 LIMIT 1`,
    ).bind(OFFSET_MATCH_SESSION, rows[0]!.byte_start + 2).run();

    const chronological = await (
      await SELF.fetch(`https://sessions.vza.net/s/${OFFSET_MATCH_SESSION}?view=chronological`)
    ).text();
    expect(chronological).not.toContain('id="t1"');
    expect(chronological).toMatch(/<article id="t2" class="turn assistant rewound">[\s\S]*?offset second turn/);
    expect(chronological).toMatch(/<article id="t3" class="turn user">[\s\S]*?offset third turn/);

    const effective = await (
      await SELF.fetch(`https://sessions.vza.net/s/${OFFSET_MATCH_SESSION}?view=effective`)
    ).text();
    expect(effective).not.toContain('offset second turn');
    expect(effective).not.toContain('id="t2"');
    expect(effective).toContain('offset third turn');
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

  it('redirects to /login in production when unauthenticated', async () => {
    const url = new URL('https://sessions.vza.net/');
    const res = await viewerRoute(new Request(url.toString()), url, { ENVIRONMENT: 'production' } as Env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('redirects to /login in preview when unauthenticated (publicly reachable previews)', async () => {
    const url = new URL('https://sessions.vza.net/');
    const previewEnv = { ...testEnv, ENVIRONMENT: 'preview' } as unknown as Env;
    const res = await viewerRoute(new Request(url.toString()), url, previewEnv);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('preview: a DEV_AUTH bearer authorizes and is issued a short-lived preview cookie', async () => {
    const url = new URL('https://sessions.vza.net/');
    const previewEnv = { ...testEnv, ENVIRONMENT: 'preview', DEV_AUTH: 'preview-secret' } as unknown as Env;
    const res = await viewerRoute(
      new Request(url.toString(), { headers: { authorization: 'Bearer preview-secret' } }),
      url,
      previewEnv,
    );
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('__Host-preview-auth=preview-secret');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
  });

  it('preview: the issued preview cookie authorizes subsequent requests (no bearer needed)', async () => {
    const url = new URL('https://sessions.vza.net/');
    const previewEnv = { ...testEnv, ENVIRONMENT: 'preview', DEV_AUTH: 'preview-secret' } as unknown as Env;
    const res = await viewerRoute(
      new Request(url.toString(), { headers: { cookie: '__Host-preview-auth=preview-secret' } }),
      url,
      previewEnv,
    );
    expect(res.status).toBe(200);
    // A cookie request is already authenticated — no need to re-issue.
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('preview: a bootstrap nonce atomically becomes a browser cookie and redirects to a relative path', async () => {
    const nonce = 'valid-preview-bootstrap-nonce';
    const key = await seedPreviewBootstrap(nonce);
    const url = new URL('https://branch.sessions-hub.workers.dev/_preview/bootstrap');
    url.searchParams.set('token', nonce);
    url.searchParams.set('next', '/s/example?view=chronological&page=4#turn-700');
    const previewEnv = { ...testEnv, ENVIRONMENT: 'preview', DEV_AUTH: 'preview-secret' } as unknown as Env;

    const res = await viewerRoute(new Request(url), url, previewEnv);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/s/example?view=chronological&page=4#turn-700');
    expect(res.headers.get('set-cookie')).toContain('__Host-preview-auth=preview-secret');
    expect(res.headers.get('set-cookie')).toContain('HttpOnly');
    expect(res.headers.get('set-cookie')).toContain('Secure');
    expect(res.headers.get('set-cookie')).toContain('SameSite=Strict');
    expect(await testEnv.DB.prepare('SELECT value FROM meta WHERE key = ?1').bind(key).first()).toBeNull();
  });

  it('preview: concurrent bootstrap attempts consume the nonce exactly once', async () => {
    const nonce = 'concurrent-preview-bootstrap-nonce';
    await seedPreviewBootstrap(nonce);
    const url = new URL('https://branch.sessions-hub.workers.dev/_preview/bootstrap');
    url.searchParams.set('token', nonce);
    const previewEnv = { ...testEnv, ENVIRONMENT: 'preview', DEV_AUTH: 'preview-secret' } as unknown as Env;

    const responses = await Promise.all([
      viewerRoute(new Request(url), url, previewEnv),
      viewerRoute(new Request(url), url, previewEnv),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([302, 404]);
  });

  it('preview: invalid, expired, and reused bootstrap nonces share the same rejection', async () => {
    const expired = 'expired-preview-bootstrap-nonce';
    await seedPreviewBootstrap(expired, Date.now() - 1);
    const previewEnv = { ...testEnv, ENVIRONMENT: 'preview', DEV_AUTH: 'preview-secret' } as unknown as Env;
    const request = async (token: string) => {
      const url = new URL('https://branch.sessions-hub.workers.dev/_preview/bootstrap');
      url.searchParams.set('token', token);
      return viewerRoute(new Request(url), url, previewEnv);
    };

    const invalid = await request('never-seeded-preview-bootstrap-nonce');
    const expiredResponse = await request(expired);
    const reused = await request(expired);

    for (const response of [invalid, expiredResponse, reused]) {
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('not found');
      expect(response.headers.get('set-cookie')).toBeNull();
    }
  });

  it('preview: rejects an open redirect without consuming the nonce', async () => {
    const nonce = 'open-redirect-preview-bootstrap-nonce';
    const key = await seedPreviewBootstrap(nonce);
    const url = new URL('https://branch.sessions-hub.workers.dev/_preview/bootstrap');
    url.searchParams.set('token', nonce);
    url.searchParams.set('next', '//evil.example/steal');
    const previewEnv = { ...testEnv, ENVIRONMENT: 'preview', DEV_AUTH: 'preview-secret' } as unknown as Env;

    const res = await viewerRoute(new Request(url), url, previewEnv);

    expect(res.status).toBe(404);
    expect(res.headers.get('location')).toBeNull();
    expect(await testEnv.DB.prepare('SELECT value FROM meta WHERE key = ?1').bind(key).first()).not.toBeNull();
    await testEnv.DB.prepare('DELETE FROM meta WHERE key = ?1').bind(key).run();
  });

  it('production: the preview bootstrap route is disabled and cannot consume a nonce', async () => {
    const nonce = 'production-disabled-preview-bootstrap-nonce';
    const key = await seedPreviewBootstrap(nonce);
    const url = new URL('https://sessions.vza.net/_preview/bootstrap');
    url.searchParams.set('token', nonce);
    const prodEnv = { ...testEnv, ENVIRONMENT: 'production', DEV_AUTH: 'preview-secret' } as unknown as Env;

    const res = await viewerRoute(new Request(url), url, prodEnv);

    expect(res.status).toBe(404);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await testEnv.DB.prepare('SELECT value FROM meta WHERE key = ?1').bind(key).first()).not.toBeNull();
    await testEnv.DB.prepare('DELETE FROM meta WHERE key = ?1').bind(key).run();
  });

  it('production ignores DEV_AUTH entirely (a bearer still redirects to /login)', async () => {
    const url = new URL('https://sessions.vza.net/');
    const prodEnv = { ...testEnv, ENVIRONMENT: 'production', DEV_AUTH: 'preview-secret' } as unknown as Env;
    const res = await viewerRoute(
      new Request(url.toString(), { headers: { authorization: 'Bearer preview-secret' } }),
      url,
      prodEnv,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('leaves the development viewer open (never publicly reachable)', async () => {
    const url = new URL('https://sessions.vza.net/');
    const devEnv = { ...testEnv, ENVIRONMENT: 'development' } as unknown as Env;
    const res = await viewerRoute(new Request(url.toString()), url, devEnv);
    expect(res.status).toBe(200);
  });

  it('fails closed on an unrecognized or missing ENVIRONMENT (any non-development value is gated)', async () => {
    const url = new URL('https://sessions.vza.net/');
    // A non-allowlisted ENVIRONMENT is treated like preview/production: no session → redirect to /login.
    const bogus = { ...testEnv, ENVIRONMENT: 'staging' } as unknown as Env;
    const bogusRes = await viewerRoute(new Request(url.toString()), url, bogus);
    expect(bogusRes.status).toBe(302);
    expect(bogusRes.headers.get('location')).toBe('/login');

    const missing = { ...testEnv, ENVIRONMENT: undefined } as unknown as Env;
    const missingRes = await viewerRoute(new Request(url.toString()), url, missing);
    expect(missingRes.status).toBe(302);
    expect(missingRes.headers.get('location')).toBe('/login');
  });
});

describe('viewer result pagination and facet layout', () => {
  const PAGINATION_HARNESS = 'viewer-pagination-test';
  const PAGINATION_MACHINE = 'viewer-pagination-machine';
  const PAGINATION_MARKER = 'viewerpaginationmarker';

  beforeAll(async () => {
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < 25; i++) {
      const id = `viewer-pagination-${String(i).padStart(2, '0')}`;
      // Exercise both halves of the keyset's total order: item 14 ties item 15's
      // timestamp exactly across the page-1 boundary, while items 0/1 are NULL and
      // must remain traversable at the end via COALESCE(started_at, '').
      const day = i === 14 ? 16 : i + 1;
      const startedAt = i < 2 ? null : `2026-07-${String(day).padStart(2, '0')}T12:00:00Z`;
      statements.push(
        testEnv.DB.prepare(
          `INSERT INTO sessions
             (session_id, harness, machine_id, os, primary_model, title, started_at, index_state)
           VALUES (?1, ?2, ?3, 'linux', 'pagination-model', ?4, ?5, 'ready')`,
        ).bind(id, PAGINATION_HARNESS, PAGINATION_MACHINE, `Pagination item ${i}`, startedAt),
      );
      statements.push(
        testEnv.DB.prepare(
          `INSERT INTO blocks (session_id, file_id, turn_index, block_index, role, btype, text)
           VALUES (?1, 1, 0, 0, 'user', 'text', ?2)`,
        ).bind(id, `Pagination item ${i} ${PAGINATION_MARKER}`),
      );
    }
    await testEnv.DB.batch(statements);
    await testEnv.DB.prepare(
      `INSERT INTO blocks_fts(rowid, text)
       SELECT id, text FROM blocks WHERE session_id LIKE 'viewer-pagination-%'`,
    ).run();
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO sessions (session_id, harness, machine_id, os, primary_model, title, started_at, ended_at, tokens_in, tokens_out, tokens_reasoning, index_state)
         VALUES ('viewer-sort-short', 'viewer-sort-test', 'viewer-sort-machine', 'linux', 'sort-model', 'Short session', '2026-07-01T10:00:00Z', '2026-07-01T10:02:00Z', 10, 5, 0, 'ready')`,
      ),
      testEnv.DB.prepare(
        `INSERT INTO sessions (session_id, harness, machine_id, os, primary_model, title, started_at, ended_at, tokens_in, tokens_out, tokens_reasoning, index_state)
         VALUES ('viewer-sort-long', 'viewer-sort-test', 'viewer-sort-machine', 'linux', 'sort-model', 'Long session', '2026-07-01T10:00:00Z', '2026-07-01T13:30:00Z', 100, 50, 25, 'ready')`,
      ),
      testEnv.DB.prepare(
        `INSERT INTO sessions (session_id, harness, machine_id, os, primary_model, title, started_at, ended_at, tokens_in, tokens_out, tokens_reasoning, tokens_cached, index_state)
         VALUES ('viewer-sort-reasoning', 'viewer-sort-test', 'viewer-sort-machine', 'linux', 'sort-model', 'Reasoning-heavy session', '2026-07-01T10:00:00Z', '2026-07-01T10:30:00Z', 20, 10, 500, 10000, 'ready')`,
      ),
      testEnv.DB.prepare(
        `INSERT INTO blocks (session_id, file_id, turn_index, block_index, role, btype, text) VALUES
         ('viewer-sort-short', 1, 0, 0, 'user', 'text', 'Short session viewersortmarker'),
         ('viewer-sort-long', 1, 0, 0, 'user', 'text', 'Long session viewersortmarker'),
         ('viewer-sort-reasoning', 1, 0, 0, 'user', 'text', 'Reasoning-heavy session viewersortmarker')`,
      ),
    ]);
    await testEnv.DB.prepare(
      `INSERT INTO blocks_fts(rowid, text) SELECT id, text FROM blocks WHERE session_id LIKE 'viewer-sort-%'`,
    ).run();
  });

  function pageHref(html: string, rel: 'next' | 'prev'): string {
    const match = html.match(new RegExp(`<a rel="${rel}" href="([^"]+)"`));
    expect(match, `${rel} link should be present`).toBeTruthy();
    return match![1]!.replaceAll('&amp;', '&');
  }

  function recentIds(html: string): string[] {
    return [...html.matchAll(/<a href="\/s\/(viewer-pagination-[^"]+)">/g)].map((match) => match[1]!);
  }

  it('renders auto-submitting filters in a bounded, responsive left sidebar', async () => {
    const res = await SELF.fetch(
      `https://sessions.vza.net/?q=${PAGINATION_MARKER}&harness=${PAGINATION_HARNESS}&machine=${PAGINATION_MACHINE}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.indexOf('<aside class="sidebar facets">')).toBeLessThan(html.indexOf('<section class="content search-results">'));
    expect(html).toContain('class="facet-controls"');
    expect(html).toContain('onchange="this.form.requestSubmit()"');
    expect(html).toContain(`<option value="${PAGINATION_HARNESS}" selected>`);
    expect(html).toContain(`<option value="${PAGINATION_MACHINE}" selected>`);
    // flex items default to min-width:auto, which let a long repo/cwd facet expand this
    // nominally 220px-content sidebar to 460px+ in production. The outer width includes
    // its 20px padding + border; links wrap while their count stays intact.
    expect(html).toContain('.sidebar { flex: 0 0 240px; width: 240px; min-width: 0; max-width: 240px; }');
    expect(html).toContain('.facets li a { min-width: 0; overflow-wrap: anywhere; }');
    expect(html).toContain('.facets li .n { flex: 0 0 auto;');
    expect(html).toContain('@media (max-width: 760px)');
    expect(html).toContain('.sidebar { flex-basis: auto; width: 100%; max-width: none; }');
  });

  it('paginates full-text results in both directions while preserving query and filter state', async () => {
    const first = await (await SELF.fetch(
      `https://sessions.vza.net/?q=${PAGINATION_MARKER}&harness=${PAGINATION_HARNESS}&machine=${PAGINATION_MACHINE}&limit=10`,
    )).text();
    expect(first).toContain('Showing 1–10');
    expect(first).toContain('Page 1');
    expect(first).not.toContain('<a rel="prev"');

    const secondHref = pageHref(first, 'next');
    expect(secondHref).toContain(`q=${PAGINATION_MARKER}`);
    expect(secondHref).toContain(`harness=${PAGINATION_HARNESS}`);
    expect(secondHref).toContain(`machine=${PAGINATION_MACHINE}`);
    expect(secondHref).toContain('limit=10');
    const second = await (await SELF.fetch(`https://sessions.vza.net${secondHref}`)).text();
    expect(second).toContain('Showing 11–20');
    expect(second).toContain('Page 2');
    expect(pageHref(second, 'prev')).toBe(`/?q=${PAGINATION_MARKER}&harness=${PAGINATION_HARNESS}&machine=${PAGINATION_MACHINE}&limit=10`);

    const thirdHref = pageHref(second, 'next');
    const third = await (await SELF.fetch(`https://sessions.vza.net${thirdHref}`)).text();
    expect(third).toContain('Showing 21–25');
    expect(third).toContain('Page 3');
    expect(third).not.toContain('<a rel="next"');
    expect(third).toContain('<span class="muted">Next →</span>');
  });

  it('paginates and filters the default recent-session list, including recovery from the last page', async () => {
    const first = await (await SELF.fetch(
      `https://sessions.vza.net/?harness=${PAGINATION_HARNESS}&limit=10`,
    )).text();
    expect(first).toContain('Showing 1–10 recent sessions');
    expect(first.match(/<div class="hit">/g)).toHaveLength(10);

    const second = await (await SELF.fetch(`https://sessions.vza.net${pageHref(first, 'next')}`)).text();
    const third = await (await SELF.fetch(`https://sessions.vza.net${pageHref(second, 'next')}`)).text();
    expect(third).toContain('Showing 21–25 recent sessions');
    expect(third.match(/<div class="hit">/g)).toHaveLength(5);
    expect(pageHref(third, 'prev')).toContain(`harness=${PAGINATION_HARNESS}`);
    expect(third).not.toContain(`/s/${BIG_SESSION}`);

    const backToSecond = await (await SELF.fetch(`https://sessions.vza.net${pageHref(third, 'prev')}`)).text();
    expect(recentIds(backToSecond)).toEqual(recentIds(second));
  });

  it('resets pagination when a facet changes but preserves the text query', async () => {
    const first = await (await SELF.fetch(
      `https://sessions.vza.net/?q=${PAGINATION_MARKER}&harness=${PAGINATION_HARNESS}&limit=10`,
    )).text();
    const second = await (await SELF.fetch(`https://sessions.vza.net${pageHref(first, 'next')}`)).text();
    const controls = second.match(/<form class="facet-controls"[\s\S]*?<\/form>/)?.[0] ?? '';
    expect(controls).toContain(`name="q" value="${PAGINATION_MARKER}"`);
    expect(controls).not.toContain('name="cursor"');
    expect(controls).not.toContain('name="limit"');
  });

  it('filters by session time and sorts by session time or total tokens', async () => {
    const relevanceSorted = await (await SELF.fetch('https://sessions.vza.net/?q=viewersortmarker&harness=viewer-sort-test')).text();
    expect(relevanceSorted).toContain('<option value="recent" selected>Relevance</option>');

    const timeSorted = await (await SELF.fetch('https://sessions.vza.net/?q=viewersortmarker&harness=viewer-sort-test&sort=session_time')).text();
    expect(timeSorted).toContain('<option value="session_time" selected>Session time</option>');
    expect(timeSorted).toContain('>Session time</h3>');
    expect(timeSorted.indexOf('Long session')).toBeLessThan(timeSorted.indexOf('Short session'));
    expect(timeSorted).toContain('Over 2 hours');

    const tokenSorted = await (await SELF.fetch('https://sessions.vza.net/?q=viewersortmarker&harness=viewer-sort-test&sort=total_tokens')).text();
    expect(tokenSorted).toContain('<option value="total_tokens" selected>Total tokens</option>');
    expect(tokenSorted.indexOf('Long session')).toBeLessThan(tokenSorted.indexOf('Short session'));
    expect(tokenSorted.indexOf('Long session')).toBeLessThan(tokenSorted.indexOf('Reasoning-heavy session'));
    expect(tokenSorted.indexOf('Reasoning-heavy session')).toBeLessThan(tokenSorted.indexOf('Short session'));
    expect(tokenSorted).toContain('30 tokens');
    expect(tokenSorted).not.toContain('530 tokens');

    const shortOnly = await (await SELF.fetch('https://sessions.vza.net/?q=viewersortmarker&harness=viewer-sort-test&session_time=under-5m')).text();
    expect(shortOnly).toContain('Short session');
    expect(shortOnly).not.toContain('Long session');
  });

  it('facets calendar session dates and filters both recent and full-text results to the selected day', async () => {
    const recent = await (await SELF.fetch(
      `https://sessions.vza.net/?harness=${PAGINATION_HARNESS}`,
    )).text();
    expect(recent).toContain('>Session date/time</h3>');
    expect(recent).toContain(`href="/?harness=${PAGINATION_HARNESS}&amp;session_date=2026-07-25"`);

    const recentDay = await (await SELF.fetch(
      `https://sessions.vza.net/?harness=${PAGINATION_HARNESS}&session_date=2026-07-25`,
    )).text();
    expect(recentDay).toContain('Pagination item 24');
    expect(recentDay).not.toContain('Pagination item 23');

    const searchDay = await (await SELF.fetch(
      `https://sessions.vza.net/?q=${PAGINATION_MARKER}&harness=${PAGINATION_HARNESS}&session_date=2026-07-25`,
    )).text();
    expect(searchDay).toContain('Pagination item 24');
    expect(searchDay).not.toContain('Pagination item 23');
  });

  it('keeps the recent-session boundary stable when a newer session is ingested between pages', async () => {
    const first = await (await SELF.fetch(
      `https://sessions.vza.net/?harness=${PAGINATION_HARNESS}&limit=10`,
    )).text();
    const firstIds = recentIds(first);
    expect(firstIds).toEqual(
      Array.from({ length: 10 }, (_, i) => `viewer-pagination-${String(24 - i).padStart(2, '0')}`),
    );
    const nextHref = pageHref(first, 'next');

    // Positive control: the old OFFSET 10 page shifts when a new row lands ahead of page 1.
    const offsetPage = async () => (await testEnv.DB.prepare(
      `SELECT session_id FROM sessions WHERE harness = ?1
       ORDER BY COALESCE(started_at, '') DESC, session_id DESC LIMIT 10 OFFSET 10`,
    ).bind(PAGINATION_HARNESS).all<{ session_id: string }>()).results.map((row) => row.session_id);
    const offsetBefore = await offsetPage();

    await testEnv.DB.prepare(
      `INSERT INTO sessions
         (session_id, harness, machine_id, os, primary_model, title, started_at, index_state)
       VALUES ('viewer-pagination-new', ?1, ?2, 'linux', 'pagination-model', 'Newer concurrent session',
               '2026-07-26T12:00:00Z', 'ready')`,
    ).bind(PAGINATION_HARNESS, PAGINATION_MACHINE).run();

    const offsetAfter = await offsetPage();
    expect(offsetAfter).not.toEqual(offsetBefore);
    expect(offsetAfter).toContain(firstIds.at(-1)!); // repeats the last row from page 1

    // The viewer cursor names page 1's last (started_at, session_id), so the newly inserted
    // row cannot move its page-2 boundary. No repeat and no skipped pre-existing row.
    const second = await (await SELF.fetch(`https://sessions.vza.net${nextHref}`)).text();
    const secondIds = recentIds(second);
    expect(secondIds).toEqual(
      Array.from({ length: 10 }, (_, i) => `viewer-pagination-${String(14 - i).padStart(2, '0')}`),
    );
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
    expect(secondIds).not.toContain('viewer-pagination-new');
  });
});
