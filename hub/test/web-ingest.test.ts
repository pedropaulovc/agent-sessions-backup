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
});
