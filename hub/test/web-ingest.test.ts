import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { env as testEnvRaw } from 'cloudflare:test';
import worker from '../src/index';
import { chatgptExportZip, chatgptWebConversation, claudeWebConversation, historyLines, unrecognizedExportZip } from './web-fixtures';
import { ccUserLine } from './fixtures';

const CLAUDE_ROOT = '00000000-0000-4000-8000-000000000000';

const testEnv = testEnvRaw as unknown as Env;

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function put(machine: string, store: string, relpath: string, body: Uint8Array): Promise<Response> {
  return SELF.fetch(`https://api.sessions.vza.net/api/v1/files/${machine}/${store}/${encodeURIComponent(relpath)}`, {
    method: 'PUT',
    headers: {
      'x-dev-machine': machine,
      'x-content-hash': `sha256:${await sha256Hex(body)}`,
      'x-file-mtime': '2026-07-01T12:00:00Z',
      'content-length': String(body.length),
    },
    body,
  });
}

const putText = (machine: string, store: string, relpath: string, text: string) =>
  put(machine, store, relpath, new TextEncoder().encode(text));

async function drainQueue(): Promise<void> {
  const pending = await testEnv.DB.prepare("SELECT id, r2_key FROM files WHERE parse_state = 'pending'").all<{ id: number; r2_key: string }>();
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

/** Drain repeatedly until nothing is pending — a recover enqueue flips a sibling file back to pending. */
async function drainAll(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const n = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM files WHERE parse_state = 'pending'").first<{ n: number }>();
    if ((n?.n ?? 0) === 0) return;
    await drainQueue();
  }
}

/** Deliver one explicit message (optionally with a specific content_hash to simulate a stale delivery). */
async function deliverOne(fileId: number, r2Key: string, contentHash?: string): Promise<void> {
  const message = {
    id: String(fileId),
    timestamp: new Date(),
    attempts: 1,
    body: { file_id: fileId, r2_key: r2Key, reason: 'upload' as const, ...(contentHash !== undefined ? { content_hash: contentHash } : {}) },
    ack() {},
    retry() {},
  };
  await worker.queue({ queue: 'parse', messages: [message], ackAll() {}, retryAll() {} } as unknown as MessageBatch<ParseMessage>, testEnv);
}

describe('chatgpt-web ingest end-to-end', () => {
  const CONV_ID = 'cgpt-ingest-1';
  beforeAll(async () => {
    const conv = chatgptWebConversation({
      id: CONV_ID,
      title: 'Photosynthesis chat',
      turns: [
        { node: 'n1', parent: 'root-node', role: 'user', text: 'explain chlorophyll fluorescence' },
        { node: 'n2', parent: 'n1', role: 'assistant', text: 'Chlorophyll re-emits absorbed light as fluorescence.', model: 'gpt-test-4o' },
      ],
    });
    expect((await putText('webbox', 'chatgpt-web', `${CONV_ID}.json`, conv)).status).toBe(201);
    await drainQueue();
  });

  it('indexes the conversation with harness/model/title and makes it searchable', async () => {
    const row = await testEnv.DB.prepare('SELECT * FROM sessions WHERE session_id = ?1').bind(CONV_ID).first();
    expect(row!.harness).toBe('chatgpt-web');
    expect(row!.primary_model).toBe('gpt-test-4o');
    expect(row!.index_state).toBe('ready');

    const res = await SELF.fetch('https://api.sessions.vza.net/api/v1/search?q=fluorescence&facets=1', { headers: { 'x-dev-machine': 'webbox' } });
    const body = (await res.json()) as { hits: Array<{ session_id: string }>; facets: Record<string, Record<string, number>> };
    expect(body.hits.some((h) => h.session_id === CONV_ID)).toBe(true);
    expect(body.facets['harness']!['chatgpt-web']).toBeGreaterThanOrEqual(1);
  });

  it('serves the normalized session and renders the viewer page', async () => {
    const res = await SELF.fetch(`https://api.sessions.vza.net/api/v1/sessions/${CONV_ID}`, { headers: { 'x-dev-machine': 'webbox' } });
    const body = (await res.json()) as { session: { turns: unknown[]; harness: string } };
    expect(body.session.harness).toBe('chatgpt-web');
    expect(body.session.turns.length).toBe(2);

    const page = await SELF.fetch(`https://sessions.vza.net/s/${CONV_ID}`, { headers: { 'x-dev-machine': 'webbox' } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('fluorescence');
  });
});

describe('prompt-log ingest is machine-scoped (two machines, two sessions)', () => {
  beforeAll(async () => {
    await putText('boxA', 'claude', 'history.jsonl', historyLines([{ display: 'boxA unique prompt gamma', timestamp: 1_700_000_000_000 }]).join('\n'));
    await putText('boxB', 'claude', 'history.jsonl', historyLines([{ display: 'boxB unique prompt delta', timestamp: 1_700_000_000_000 }]).join('\n'));
    await drainQueue();
  });

  it('produces one prompt-log session per machine, neither superseding the other', async () => {
    const rows = await testEnv.DB.prepare("SELECT session_id, machine_id FROM sessions WHERE harness = 'prompt-log' ORDER BY session_id").all<{ session_id: string; machine_id: string }>();
    const ids = rows.results.map((r) => r.session_id);
    expect(ids).toContain('promptlog:boxA:claude');
    expect(ids).toContain('promptlog:boxB:claude');

    const res = await SELF.fetch('https://api.sessions.vza.net/api/v1/search?q=gamma', { headers: { 'x-dev-machine': 'boxA' } });
    expect(((await res.json()) as { hits: unknown[] }).hits.length).toBe(1);
  });

  it('stamps the machine-scoped session id onto the files row and flips it to parsing on changed re-upload', async () => {
    // Fix 2: upload/reindex must pass machine_id to detect() so files.session_id is populated —
    // otherwise canonical/recovery/parsing-flip queries (keyed on session_id) can't find the row.
    const fileRow = await testEnv.DB.prepare("SELECT session_id FROM files WHERE machine_id = 'boxA' AND relpath = 'history.jsonl'").first<{ session_id: string }>();
    expect(fileRow?.session_id).toBe('promptlog:boxA:claude');

    // A changed-hash re-upload of the canonical prompt log flips its session to 'parsing' (needs
    // the row's session_id to be non-null to match).
    await putText('boxA', 'claude', 'history.jsonl', historyLines([
      { display: 'boxA unique prompt gamma', timestamp: 1_700_000_000_000 },
      { display: 'boxA follow-up epsilon', timestamp: 1_700_000_500_000 },
    ]).join('\n'));
    const mid = await testEnv.DB.prepare("SELECT index_state FROM sessions WHERE session_id = 'promptlog:boxA:claude'").first<{ index_state: string }>();
    expect(mid?.index_state).toBe('parsing');
    await drainQueue();
    const done = await testEnv.DB.prepare("SELECT index_state FROM sessions WHERE session_id = 'promptlog:boxA:claude'").first<{ index_state: string }>();
    expect(done?.index_state).toBe('ready');
  });
});

describe('claude-web image blocks render as inert placeholders, never blob-backed media (Fix 3)', () => {
  it('indexes an image reference as searchable text with no btype=image row', async () => {
    const CONV = 'cw-image-1';
    const conv = claudeWebConversation({
      uuid: CONV,
      name: 'Screenshot chat',
      messages: [
        { uuid: 'm1', parent: CLAUDE_ROOT, sender: 'human', content: [
          { type: 'text', text: 'what is in this screenshot' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png' } },
        ] },
      ],
    });
    expect((await putText('webbox', 'claude-web', `${CONV}.json`, conv)).status).toBe(201);
    await drainQueue();

    const media = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM blocks WHERE session_id = ?1 AND btype IN ('image','document')").bind(CONV).first<{ n: number }>();
    expect(media?.n).toBe(0); // no blob-backed media rows -> the blob endpoint is never asked
    const placeholder = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM blocks WHERE session_id = ?1 AND text = '[image/png]'").bind(CONV).first<{ n: number }>();
    expect(placeholder?.n).toBe(1);
  });
});

describe('export ZIP ingest fans out and only backfills gaps', () => {
  it('indexes every conversation in the archive as its own session', async () => {
    const zip = chatgptExportZip([
      { id: 'exp-ingest-a', title: 'A', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'archived alpha topic' }] },
      { id: 'exp-ingest-b', title: 'B', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'archived beta topic' }] },
    ]);
    expect((await put('webbox', 'export-inbox', 'chatgpt-export-2026.zip', zip)).status).toBe(201);
    await drainQueue();

    for (const id of ['exp-ingest-a', 'exp-ingest-b']) {
      const row = await testEnv.DB.prepare('SELECT harness, index_state FROM sessions WHERE session_id = ?1').bind(id).first<{ harness: string; index_state: string }>();
      expect(row?.harness).toBe('chatgpt-web');
      expect(row?.index_state).toBe('ready');
    }
    const search = await SELF.fetch('https://api.sessions.vza.net/api/v1/search?q=archived', { headers: { 'x-dev-machine': 'webbox' } });
    expect(((await search.json()) as { hits: unknown[] }).hits.length).toBe(2);
  });

  it('does not overwrite a conversation already captured live by CDP', async () => {
    const CONV = 'exp-gap-1';
    // CDP capture lands first: the authoritative, fuller copy.
    const live = chatgptWebConversation({
      id: CONV,
      title: 'Live capture',
      turns: [
        { node: 'n1', parent: 'root-node', role: 'user', text: 'live captured question' },
        { node: 'n2', parent: 'n1', role: 'assistant', text: 'live captured answer with extra detail', model: 'gpt-test-4o' },
      ],
    });
    expect((await putText('webbox', 'chatgpt-web', `${CONV}.json`, live)).status).toBe(201);
    await drainQueue();

    // An export archive containing the SAME conversation id (a thinner backfill copy) must not clobber it.
    const zip = chatgptExportZip([{ id: CONV, title: 'Export copy', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'live captured question' }] }]);
    expect((await put('webbox', 'export-inbox', 'chatgpt-export-later.zip', zip)).status).toBe(201);
    await drainQueue();

    const row = await testEnv.DB.prepare(
      `SELECT s.title, s.turn_count, f.store FROM sessions s JOIN files f ON f.id = s.canonical_file_id WHERE s.session_id = ?1`,
    )
      .bind(CONV)
      .first<{ title: string; turn_count: number; store: string }>();
    expect(row?.store).toBe('chatgpt-web'); // still owned by the live capture
    expect(row?.title).toBe('Live capture');
    expect(row?.turn_count).toBe(2);
  });

  it('re-uploading an archive without a conversation clears that conversation stale session (Fix 1)', async () => {
    const relpath = 'chatgpt-export-stale.zip';
    const withBoth = chatgptExportZip([
      { id: 'stale-a', title: 'A', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'stale-marker alpha kept' }] },
      { id: 'stale-b', title: 'B', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'stale-marker beta dropped' }] },
    ]);
    expect((await put('webbox', 'export-inbox', relpath, withBoth)).status).toBe(201);
    await drainQueue();
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id IN ('stale-a','stale-b')").first<{ n: number }>()).toMatchObject({ n: 2 });

    // Re-upload the SAME path with only conversation A. B must be fully removed.
    const withOnlyA = chatgptExportZip([
      { id: 'stale-a', title: 'A', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'stale-marker alpha kept' }] },
    ]);
    expect((await put('webbox', 'export-inbox', relpath, withOnlyA)).status).toBe(201);
    await drainQueue();

    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = 'stale-b'").first<{ n: number }>()).toMatchObject({ n: 0 });
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM blocks WHERE session_id = 'stale-b'").first<{ n: number }>()).toMatchObject({ n: 0 });
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = 'stale-a'").first<{ n: number }>()).toMatchObject({ n: 1 });

    const search = await SELF.fetch('https://api.sessions.vza.net/api/v1/search?q=stale-marker', { headers: { 'x-dev-machine': 'webbox' } });
    const ids = ((await search.json()) as { hits: Array<{ session_id: string }> }).hits.map((h) => h.session_id);
    expect(ids).toContain('stale-a');
    expect(ids).not.toContain('stale-b');
  });

  it('clears a conversation that is still present but now parses to zero turns (round 2 Fix 1)', async () => {
    const relpath = 'chatgpt-export-empty.zip';
    const both = chatgptExportZip([
      { id: 'zt-a', title: 'A', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'zeroturn-marker alpha kept' }] },
      { id: 'zt-b', title: 'B', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'zeroturn-marker beta present' }] },
    ]);
    expect((await put('webbox', 'export-inbox', relpath, both)).status).toBe(201);
    await drainQueue();
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = 'zt-b'").first<{ n: number }>()).toMatchObject({ n: 1 });

    // Re-upload: B is still present in the archive but its conversation now has no turns.
    const emptied = chatgptExportZip([
      { id: 'zt-a', title: 'A', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'zeroturn-marker alpha kept' }] },
      { id: 'zt-b', title: 'B', turns: [] },
    ]);
    expect((await put('webbox', 'export-inbox', relpath, emptied)).status).toBe(201);
    await drainQueue();

    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = 'zt-b'").first<{ n: number }>()).toMatchObject({ n: 0 });
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM blocks WHERE session_id = 'zt-b'").first<{ n: number }>()).toMatchObject({ n: 0 });
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = 'zt-a'").first<{ n: number }>()).toMatchObject({ n: 1 });
  });

  it('a stale export message (hash moved on) does not publish the old archive sessions (round 2 Fix 2)', async () => {
    const relpath = 'chatgpt-export-race.zip';
    const v1 = chatgptExportZip([{ id: 'race-conv', title: 'export-v1', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'race version one' }] }]);
    const r1 = await put('webbox', 'export-inbox', relpath, v1);
    const fileId = ((await r1.json()) as { file_id: number }).file_id;
    const r2Key = 'raw/webbox/export-inbox/chatgpt-export-race.zip';
    const v1Hash = await sha256Hex(v1);
    await drainQueue();
    expect(await testEnv.DB.prepare("SELECT title FROM sessions WHERE session_id = 'race-conv'").first<{ title: string }>()).toMatchObject({ title: 'export-v1' });

    // Re-upload v2 (same path, new bytes) so the row's content_hash moves on; leave it pending.
    const v2 = chatgptExportZip([{ id: 'race-conv', title: 'export-v2', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'race version two' }] }]);
    expect((await put('webbox', 'export-inbox', relpath, v2)).status).toBe(201);

    // A STALE message carrying v1's hash reaches the consumer after the re-upload: it must recheck
    // the row hash, see it moved on, and NOT re-publish v1's content.
    await deliverOne(fileId, r2Key, v1Hash);
    expect(await testEnv.DB.prepare("SELECT parse_state FROM files WHERE id = ?1").bind(fileId).first<{ parse_state: string }>()).toMatchObject({ parse_state: 'pending' });

    // The fresh message parses v2 normally.
    await drainQueue();
    expect(await testEnv.DB.prepare("SELECT title FROM sessions WHERE session_id = 'race-conv'").first<{ title: string }>()).toMatchObject({ title: 'export-v2' });
  });

  it('recovers a conversation from an older overlapping archive when the newer one drops it (round 2 Fix 3)', async () => {
    const first = chatgptExportZip([{ id: 'ovl-conv', title: 'from-ex1', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'overlap-marker from archive one' }] }]);
    const r1 = await put('webbox', 'export-inbox', 'export-ovl-1.zip', first);
    const ex1Id = ((await r1.json()) as { file_id: number }).file_id;
    await drainQueue();

    // A later archive also contains the conversation and takes ownership of the single session row.
    const second = chatgptExportZip([{ id: 'ovl-conv', title: 'from-ex2', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'overlap-marker from archive two' }] }]);
    expect((await put('webbox', 'export-inbox', 'export-ovl-2.zip', second)).status).toBe(201);
    await drainQueue();
    expect(await testEnv.DB.prepare("SELECT title FROM sessions WHERE session_id = 'ovl-conv'").first<{ title: string }>()).toMatchObject({ title: 'from-ex2' });

    // Re-upload the later archive WITHOUT the conversation. It's deleted, but ex1 still has it —
    // the recover fan-out re-enqueues ex1, whose reparse re-claims the conversation.
    const secondEmpty = chatgptExportZip([{ id: 'ovl-other', title: 'unrelated', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'unrelated conversation content' }] }]);
    expect((await put('webbox', 'export-inbox', 'export-ovl-2.zip', secondEmpty)).status).toBe(201);
    await drainAll();

    const row = await testEnv.DB.prepare(
      `SELECT s.title, f.id AS canon FROM sessions s JOIN files f ON f.id = s.canonical_file_id WHERE s.session_id = 'ovl-conv'`,
    ).first<{ title: string; canon: number }>();
    expect(row?.canon).toBe(ex1Id); // recovered, now owned by the older archive
    expect(row?.title).toBe('from-ex1');
  });

  it('a re-uploaded VALID empty archive clears every conversation it owned (round 3 Fix 1)', async () => {
    const relpath = 'chatgpt-export-emptyarray.zip';
    const full = chatgptExportZip([
      { id: 'ea-a', title: 'A', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'emptyarray-marker one' }] },
      { id: 'ea-b', title: 'B', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'emptyarray-marker two' }] },
    ]);
    expect((await put('webbox', 'export-inbox', relpath, full)).status).toBe(201);
    await drainQueue();
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id IN ('ea-a','ea-b')").first<{ n: number }>()).toMatchObject({ n: 2 });

    // A well-formed but empty conversations.json array is VALID and clears everything this file owned.
    expect((await put('webbox', 'export-inbox', relpath, chatgptExportZip([]))).status).toBe(201);
    await drainQueue();
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id IN ('ea-a','ea-b')").first<{ n: number }>()).toMatchObject({ n: 0 });
    const fileState = await testEnv.DB.prepare("SELECT parse_state FROM files WHERE relpath = ?1 AND store = 'export-inbox'").bind(relpath).first<{ parse_state: string }>();
    expect(fileState?.parse_state).toBe('parsed');
  });

  it('a non-empty archive with an unrecognized layout is marked error and keeps old sessions (round 4 Fix 3)', async () => {
    const relpath = 'chatgpt-export-drift.zip';
    const good = chatgptExportZip([{ id: 'drift-keep', title: 'Keep', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'drift-marker preserved' }] }]);
    expect((await put('webbox', 'export-inbox', relpath, good)).status).toBe(201);
    await drainQueue();
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = 'drift-keep'").first<{ n: number }>()).toMatchObject({ n: 1 });

    // Re-upload a NON-empty conversations.json whose layout drifted (no mapping/chat_messages). This
    // must NOT be treated as an empty export (which would wipe drift-keep); it is flagged 'error'.
    expect((await put('webbox', 'export-inbox', relpath, unrecognizedExportZip())).status).toBe(201);
    await drainQueue();

    const fileRow = await testEnv.DB.prepare("SELECT parse_state, parse_error FROM files WHERE relpath = ?1 AND store = 'export-inbox'").bind(relpath).first<{ parse_state: string; parse_error: string | null }>();
    expect(fileRow?.parse_state).toBe('error');
    expect(fileRow?.parse_error).toBeTruthy();
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = 'drift-keep'").first<{ n: number }>()).toMatchObject({ n: 1 });
  });

  it('an export backfill recovers a conversation whose live web capture is in error state (round 4 Fix 2)', async () => {
    const CONV = 'rec-web-1';
    // A live CDP capture lands and indexes the conversation first.
    const live = chatgptWebConversation({
      id: CONV,
      title: 'Live original',
      turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'recover-marker live original' }],
    });
    expect((await putText('webbox', 'chatgpt-web', `${CONV}.json`, live)).status).toBe(201);
    await drainQueue();

    // The live session then goes bad (e.g. a later reparse failed): index_state='error'. Its file
    // stays canonical, and archive rows have session_id NULL, so chooseRecoveryCandidate() can't see
    // an export backfill — the export write itself must be allowed to recover it.
    await testEnv.DB.prepare("UPDATE sessions SET index_state = 'error' WHERE session_id = ?1").bind(CONV).run();

    const zip = chatgptExportZip([{ id: CONV, title: 'Export recovered', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'recover-marker from export backfill' }] }]);
    expect((await put('webbox', 'export-inbox', 'rec-web.zip', zip)).status).toBe(201);
    await drainQueue();

    const row = await testEnv.DB.prepare(
      `SELECT s.title, s.index_state, f.store FROM sessions s JOIN files f ON f.id = s.canonical_file_id WHERE s.session_id = ?1`,
    )
      .bind(CONV)
      .first<{ title: string; index_state: string; store: string }>();
    expect(row?.index_state).toBe('ready'); // recovered, no longer errored
    expect(row?.store).toBe('export-inbox'); // the export took ownership to fill the gap
    expect(row?.title).toBe('Export recovered');
  });

  it('bulk NDJSON parses a shared export archive once, not once per conversation (round 4 Fix 5)', async () => {
    const zip = chatgptExportZip([
      { id: 'cache-a', title: 'A', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'cachemarker alpha' }] },
      { id: 'cache-b', title: 'B', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'cachemarker beta' }] },
      { id: 'cache-c', title: 'C', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'cachemarker gamma' }] },
    ]);
    expect((await put('cachebox', 'export-inbox', 'cache.zip', zip)).status).toBe(201);
    await drainQueue();

    // Spy on the R2 reads while streaming the bulk NDJSON: the three sibling conversations share one
    // ZIP, so the per-request archive cache must fetch + parse it exactly once (pre-fix: 3 times).
    const zipKey = 'raw/cachebox/export-inbox/cache.zip';
    const realGet = testEnv.RAW.get.bind(testEnv.RAW);
    let zipGets = 0;
    (testEnv.RAW as unknown as { get: unknown }).get = (key: string, opts?: unknown) => {
      if (key === zipKey) zipGets++;
      return (realGet as (k: string, o?: unknown) => unknown)(key, opts);
    };
    try {
      const res = await SELF.fetch('https://api.sessions.vza.net/api/v1/sessions?format=ndjson&machine=cachebox', {
        headers: { 'x-dev-machine': 'cachebox' },
      });
      const body = await res.text();
      // All three conversations were actually emitted (so the count is meaningful).
      for (const id of ['cache-a', 'cache-b', 'cache-c']) expect(body).toContain(id);
    } finally {
      (testEnv.RAW as unknown as { get: unknown }).get = realGet;
    }
    expect(zipGets).toBe(1);
  });

  it('raw for an archive-backed session returns only that conversation, not the whole ZIP (round 4 Fix 7)', async () => {
    const zip = chatgptExportZip([
      { id: 'raw-a', title: 'A', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'rawmarker-alpha only in A' }] },
      { id: 'raw-b', title: 'B', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'rawmarker-beta only in B' }] },
    ]);
    expect((await put('webbox', 'export-inbox', 'raw.zip', zip)).status).toBe(201);
    await drainQueue();

    const res = await SELF.fetch('https://api.sessions.vza.net/api/v1/sessions/raw-a/raw', { headers: { 'x-dev-machine': 'webbox' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const text = await res.text();
    const obj = JSON.parse(text) as { conversation_id?: string }; // a single conversation object, not a ZIP
    expect(obj.conversation_id).toBe('raw-a');
    expect(text).toContain('rawmarker-alpha');
    expect(text).not.toContain('rawmarker-beta'); // sibling conversation B must not leak
  });

  it('a re-upload landing after the write loop does not let a stale parse delete a dropped conversation — markParsed runs before cleanup (round 4 Fix 1)', async () => {
    const relpath = 'chatgpt-export-reorder.zip';
    const r2Key = 'raw/webbox/export-inbox/chatgpt-export-reorder.zip';
    // The archive owns A and B.
    const withBoth = chatgptExportZip([
      { id: 'reorder-a', title: 'A', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'reorder-marker alpha' }] },
      { id: 'reorder-b', title: 'B', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'reorder-marker beta' }] },
    ]);
    const r1 = await put('webbox', 'export-inbox', relpath, withBoth);
    const fileId = ((await r1.json()) as { file_id: number }).file_id;
    await drainQueue();
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id IN ('reorder-a','reorder-b')").first<{ n: number }>()).toMatchObject({ n: 2 });

    // Re-upload the SAME path with only A (drops B), leaving it pending. R2 now holds [A] and the
    // row's content_hash has moved on; the file still OWNS both A and B in sessions until cleanup.
    const withOnlyA = chatgptExportZip([
      { id: 'reorder-a', title: 'A', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'reorder-marker alpha' }] },
    ]);
    expect((await put('webbox', 'export-inbox', relpath, withOnlyA)).status).toBe(201);
    const withOnlyAHash = await sha256Hex(withOnlyA);

    // Deliver a message carrying withOnlyA's hash — it passes the early recheck and writes A off the
    // current R2 bytes ([A]). Then simulate ANOTHER re-upload landing mid-parse (after the write
    // loop) by mutating the row's content_hash the first time the parse reaches its post-write-loop
    // step. With the fix that step is the guarded markParsed, which now fails and skips cleanup, so
    // B survives for the fresh parse; pre-fix, cleanup ran first and deleted B before markParsed
    // noticed — leaving no row if that fresh parse were delayed/dropped.
    const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
    let mutated = false;
    const mutateOnce = async () => {
      if (mutated) return;
      mutated = true;
      await realPrepare('UPDATE files SET content_hash = ?2 WHERE id = ?1').bind(fileId, 'sha256:reuploaded-mid-parse').run();
    };
    const wrapBound = (bound: { run: () => unknown; all: () => unknown; first: (c?: string) => unknown; bind: (...a: unknown[]) => unknown }): unknown => ({
      run: async () => {
        await mutateOnce();
        return bound.run();
      },
      all: async () => {
        await mutateOnce();
        return bound.all();
      },
      first: async (c?: string) => {
        await mutateOnce();
        return bound.first(c);
      },
      bind: (...a: unknown[]) => wrapBound(bound.bind(...a) as never),
    });
    (testEnv.DB as unknown as { prepare: unknown }).prepare = (sql: string) => {
      const stmt = realPrepare(sql);
      const isPostWriteLoopStep =
        sql.includes('UPDATE files SET parse_state') || sql.includes('SELECT session_id FROM sessions WHERE canonical_file_id');
      if (mutated || !isPostWriteLoopStep) return stmt;
      return { bind: (...a: unknown[]) => wrapBound(stmt.bind(...a) as never) };
    };
    try {
      await deliverOne(fileId, r2Key, withOnlyAHash);
    } finally {
      (testEnv.DB as unknown as { prepare: unknown }).prepare = realPrepare;
    }

    // The stale parse must NOT have deleted B — it waits for the fresh (current-hash) parse.
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = 'reorder-b'").first<{ n: number }>()).toMatchObject({ n: 1 });
    expect(mutated).toBe(true); // the injection actually fired at the post-write-loop step
  });

  it('a corrupt replacement archive is marked error and keeps the old sessions (round 3 Fix 7)', async () => {
    const relpath = 'chatgpt-export-corrupt.zip';
    const good = chatgptExportZip([{ id: 'corrupt-keep', title: 'Keep', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'corrupt-marker preserved' }] }]);
    expect((await put('webbox', 'export-inbox', relpath, good)).status).toBe(201);
    await drainQueue();
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = 'corrupt-keep'").first<{ n: number }>()).toMatchObject({ n: 1 });

    // Re-upload unreadable bytes at the same path: preservation-first keeps the old session, but
    // the file is flagged 'error' so /status surfaces it (never silently 'parsed').
    expect((await put('webbox', 'export-inbox', relpath, new Uint8Array([0x50, 0x4b, 3, 4, 9, 9, 9, 9]))).status).toBe(201);
    await drainQueue();

    const fileRow = await testEnv.DB.prepare("SELECT parse_state, parse_error FROM files WHERE relpath = ?1 AND store = 'export-inbox'").bind(relpath).first<{ parse_state: string; parse_error: string | null }>();
    expect(fileRow?.parse_state).toBe('error');
    expect(fileRow?.parse_error).toBeTruthy();
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = 'corrupt-keep'").first<{ n: number }>()).toMatchObject({ n: 1 });
  });

  it('raw for a chatgpt-web session ignores Range and serves application/json; a JSONL canonical still honors Range (round 6 Fix 1)', async () => {
    const conv = chatgptWebConversation({ id: 'rawweb-1', title: 'T', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'rawweb marker alpha content' }] });
    expect((await putText('webbox', 'chatgpt-web', 'rawweb-1.json', conv)).status).toBe(201);
    await drainQueue();

    // A Range on a web-capture (single-JSON) session must be IGNORED — otherwise the client gets an
    // invalid JSON fragment mislabeled application/x-ndjson.
    const web = await SELF.fetch('https://api.sessions.vza.net/api/v1/sessions/rawweb-1/raw', {
      headers: { 'x-dev-machine': 'webbox', range: 'bytes=0-9' },
    });
    expect(web.status).toBe(200); // NOT 206
    expect(web.headers.get('content-type')).toContain('application/json');
    expect(web.headers.get('content-range')).toBeNull();
    const text = await web.text();
    expect((JSON.parse(text) as { conversation_id?: string }).conversation_id).toBe('rawweb-1'); // full valid JSON, not 10 bytes

    // Control: a real JSONL canonical still honors Range (206 + content-range).
    const sid = '77777777-2222-4333-8444-555555555555';
    const jsonl = `${ccUserLine({ uuid: 'rr1', text: 'jsonl range control content here' })}\n`;
    expect((await putText('webbox', 'claude-projects', `-home-tester-src-rawrange/${sid}.jsonl`, jsonl)).status).toBe(201);
    await drainQueue();
    const jl = await SELF.fetch(`https://api.sessions.vza.net/api/v1/sessions/${sid}/raw`, {
      headers: { 'x-dev-machine': 'webbox', range: 'bytes=0-9' },
    });
    expect(jl.status).toBe(206);
    expect(jl.headers.get('content-range')).toBeTruthy();
  });

  it('a changed-hash archive re-upload flips its owned sessions to parsing before the reparse (round 6 Fix 5)', async () => {
    const relpath = 'reparse-flip.zip';
    const v1 = chatgptExportZip([{ id: 'flip-a', title: 'A', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'flipmarker v1' }] }]);
    expect((await put('webbox', 'export-inbox', relpath, v1)).status).toBe(201);
    await drainQueue();
    expect(await testEnv.DB.prepare("SELECT index_state FROM sessions WHERE session_id = 'flip-a'").first<{ index_state: string }>()).toMatchObject({ index_state: 'ready' });

    // Re-upload with NEW bytes and DON'T drain: the upload handler must flip the archive's owned
    // sessions to 'parsing' immediately (det.sessionId is undefined for an archive, so the
    // single-session flip doesn't cover it), not leave them 'ready' over the now-overwritten ZIP.
    const v2 = chatgptExportZip([{ id: 'flip-a', title: 'A2', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'flipmarker v2 changed' }] }]);
    expect((await put('webbox', 'export-inbox', relpath, v2)).status).toBe(201);
    expect(await testEnv.DB.prepare("SELECT index_state FROM sessions WHERE session_id = 'flip-a'").first<{ index_state: string }>()).toMatchObject({ index_state: 'parsing' });

    await drainQueue();
    expect(await testEnv.DB.prepare("SELECT index_state FROM sessions WHERE session_id = 'flip-a'").first<{ index_state: string }>()).toMatchObject({ index_state: 'ready' });
  });

  it('an archive whose R2 object is missing on reparse errors its owned sessions and kicks recovery (round 6 Fix 4)', async () => {
    const ex1 = chatgptExportZip([{ id: 'r2m-x', title: 'x-from-1', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'r2mmarker x from one' }] }]);
    const r1 = await put('webbox', 'export-inbox', 'r2m-ex1.zip', ex1);
    const ex1Id = ((await r1.json()) as { file_id: number }).file_id;
    await drainQueue();

    const ex2 = chatgptExportZip([
      { id: 'r2m-x', title: 'x-from-2', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'r2mmarker x from two' }] },
      { id: 'r2m-y', title: 'y-from-2', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'r2mmarker y only in two' }] },
    ]);
    const r2 = await put('webbox', 'export-inbox', 'r2m-ex2.zip', ex2);
    const ex2Id = ((await r2.json()) as { file_id: number }).file_id;
    const ex2Key = 'raw/webbox/export-inbox/r2m-ex2.zip';
    await drainQueue();

    // Delete ex2's raw object, then reparse it (a reindex). The generic catch can't flip archive
    // sessions (files.session_id NULL); parseExportInto must error the owned sessions + kick recovery.
    await testEnv.RAW.delete(ex2Key);
    await deliverOne(ex2Id, ex2Key);
    await drainAll();

    // Y lived only in ex2 -> honestly 'error'. X still lives in ex1 -> recovered to 'ready' on ex1.
    expect(await testEnv.DB.prepare("SELECT index_state FROM sessions WHERE session_id = 'r2m-y'").first<{ index_state: string }>()).toMatchObject({ index_state: 'error' });
    const afterX = await testEnv.DB.prepare(
      `SELECT s.index_state, f.id AS canon FROM sessions s JOIN files f ON f.id = s.canonical_file_id WHERE s.session_id = 'r2m-x'`,
    ).first<{ index_state: string; canon: number }>();
    expect(afterX?.index_state).toBe('ready');
    expect(afterX?.canon).toBe(ex1Id);
  });

  it('an invalid replacement flips owned sessions to error and a sibling archive recovers the overlap (round 4 Fix 10)', async () => {
    // ex1 has X; ex2 has X and Y. ex2 becomes canonical for both.
    const ex1 = chatgptExportZip([{ id: 'inv-x', title: 'x-from-1', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'invmarker x from one' }] }]);
    const r1 = await put('webbox', 'export-inbox', 'inv-ex1.zip', ex1);
    const ex1Id = ((await r1.json()) as { file_id: number }).file_id;
    await drainQueue();

    const ex2 = chatgptExportZip([
      { id: 'inv-x', title: 'x-from-2', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'invmarker x from two' }] },
      { id: 'inv-y', title: 'y-from-2', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'invmarker y only in two' }] },
    ]);
    expect((await put('webbox', 'export-inbox', 'inv-ex2.zip', ex2)).status).toBe(201);
    await drainQueue();
    const beforeX = await testEnv.DB.prepare("SELECT index_state FROM sessions WHERE session_id = 'inv-x'").first<{ index_state: string }>();
    expect(beforeX?.index_state).toBe('ready');
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = 'inv-y'").first<{ n: number }>()).toMatchObject({ n: 1 });

    // Replace ex2 with unreadable bytes: preservation keeps the rows, but they can no longer be
    // reconstructed, so both owned sessions flip to 'error' and the sibling recovery is kicked.
    expect((await put('webbox', 'export-inbox', 'inv-ex2.zip', new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3, 4]))).status).toBe(201);
    await drainAll();

    // Y lived only in ex2 -> stays 'error' (honest: its only raw copy is corrupt, not a 'ready' lie).
    expect(await testEnv.DB.prepare("SELECT index_state FROM sessions WHERE session_id = 'inv-y'").first<{ index_state: string }>()).toMatchObject({ index_state: 'error' });
    // X still lives in ex1 -> recovered to 'ready', canonical back to the older archive.
    const afterX = await testEnv.DB.prepare(
      `SELECT s.index_state, f.id AS canon FROM sessions s JOIN files f ON f.id = s.canonical_file_id WHERE s.session_id = 'inv-x'`,
    ).first<{ index_state: string; canon: number }>();
    expect(afterX?.index_state).toBe('ready');
    expect(afterX?.canon).toBe(ex1Id);
  });
});

describe('prompt-log file rows upgrade a legacy NULL session_id on re-upload (round 3 Fix 2)', () => {
  it('a changed-hash re-upload stamps harness/session_id via the ON CONFLICT update', async () => {
    await putText('legacybox', 'claude', 'history.jsonl', historyLines([{ display: 'legacy prompt zeta', timestamp: 1_700_000_000_000 }]).join('\n'));
    await drainQueue();

    // Simulate a row created before machine-scoped prompt-log ids existed.
    await testEnv.DB.prepare("UPDATE files SET session_id = NULL, harness = NULL WHERE machine_id = 'legacybox' AND relpath = 'history.jsonl'").run();

    await putText('legacybox', 'claude', 'history.jsonl', historyLines([
      { display: 'legacy prompt zeta', timestamp: 1_700_000_000_000 },
      { display: 'legacy prompt eta', timestamp: 1_700_000_100_000 },
    ]).join('\n'));

    const row = await testEnv.DB.prepare("SELECT harness, session_id FROM files WHERE machine_id = 'legacybox' AND relpath = 'history.jsonl'").first<{ harness: string; session_id: string }>();
    expect(row?.harness).toBe('prompt-log');
    expect(row?.session_id).toBe('promptlog:legacybox:claude');
  });
});
