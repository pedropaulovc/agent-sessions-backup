import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { env as testEnvRaw } from 'cloudflare:test';
import worker from '../src/index';
import { chatgptExportZip, chatgptWebConversation, claudeWebConversation, historyLines } from './web-fixtures';

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
