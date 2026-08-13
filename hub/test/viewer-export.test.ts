import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import worker from '../src/index';
import { viewerRoute } from '../src/viewer/router';
import { ccAssistantLine, ccUserLine } from './fixtures';
import { chatgptExportZip } from './web-fixtures';

const testEnv = env as unknown as Env;

const MACHINE = 'export-box';
const SLUG = '-home-tester-src-exportdemo';
const PARENT = 'abcdef00-1111-4111-8111-111111111111';
const CHILD = 'abcdef00-2222-4222-8222-222222222222';
const LONELY = 'abcdef00-3333-4333-8333-333333333333';
const CONV_A = 'abcdef00-4444-4444-8444-444444444444';
const CONV_B = 'abcdef00-5555-4555-8555-555555555555';

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function put(store: string, relpath: string, body: Uint8Array | string): Promise<Response> {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return SELF.fetch(`https://api.sessions.vza.net/api/v1/files/${MACHINE}/${store}/${encodeURIComponent(relpath)}`, {
    method: 'PUT',
    headers: {
      'x-dev-machine': MACHINE,
      'x-content-hash': `sha256:${await sha256Hex(bytes)}`,
      'x-file-mtime': '2026-07-01T12:00:00Z',
      'content-length': String(bytes.length),
    },
    body: bytes,
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

async function fetchExport(sessionId: string, envOverride?: Env): Promise<Response> {
  const url = new URL(`https://sessions.vza.net/s/${sessionId}/export.zip`);
  return viewerRoute(new Request(url.toString()), url, envOverride ?? testEnv);
}

function transcript(tag: string): string {
  return `${[
    ccUserLine({ uuid: `${tag}-u1`, text: `question from ${tag}` }),
    ccAssistantLine({ uuid: `${tag}-a1`, parentUuid: `${tag}-u1`, text: `answer from ${tag}` }),
  ].join('\n')}\n`;
}

interface Manifest {
  format: string;
  session_id: string;
  entries: Array<{
    machine: string;
    store: string;
    relpath: string;
    role: string;
    content_hash?: string;
    narrowed?: boolean;
  }>;
}

async function unzipResponse(res: Response): Promise<{ files: Record<string, Uint8Array>; manifest: Manifest }> {
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  const manifestBytes = files['manifest.json'];
  expect(manifestBytes).toBeDefined();
  return { files, manifest: JSON.parse(strFromU8(manifestBytes!)) as Manifest };
}

describe('viewer session export zip', () => {
  it('round-trips a JSONL session: collector-layout entry with the exact canonical bytes + manifest', async () => {
    const relpath = `${SLUG}/${LONELY}.jsonl`;
    const content = transcript('lonely');
    expect((await put('claude-projects', relpath, content)).status).toBe(201);
    await drainQueue();

    const res = await fetchExport(LONELY);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toContain(`session-${LONELY}.zip`);

    const { files, manifest } = await unzipResponse(res);
    expect(manifest.format).toBe('agent-sessions-export/v1');
    expect(manifest.session_id).toBe(LONELY);
    expect(manifest.entries).toHaveLength(1);
    const entry = manifest.entries[0]!;
    expect(entry).toMatchObject({ machine: MACHINE, store: 'claude-projects', relpath, role: 'canonical' });
    const bodyBytes = new TextEncoder().encode(content);
    expect(entry.content_hash).toBe(`sha256:${await sha256Hex(bodyBytes)}`);

    const zipped = files[`${MACHINE}/claude-projects/${relpath}`];
    expect(zipped).toBeDefined();
    expect(strFromU8(zipped!)).toBe(content);
  });

  it('includes subagent transcripts and their .meta.json sidecars one level down', async () => {
    const parentRelpath = `${SLUG}/${PARENT}.jsonl`;
    const childRelpath = `${SLUG}/${PARENT}/subagents/agent-${CHILD}.jsonl`;
    const childMetaRelpath = `${SLUG}/${PARENT}/subagents/agent-${CHILD}.meta.json`;
    expect((await put('claude-projects', parentRelpath, transcript('parent'))).status).toBe(201);
    expect((await put('claude-projects', childRelpath, transcript('child'))).status).toBe(201);
    expect((await put('claude-projects', childMetaRelpath, JSON.stringify({ toolUseId: 'toolu_export_1', agentType: 'general-purpose' }))).status).toBe(201);
    await drainQueue();

    const { files, manifest } = await unzipResponse(await fetchExport(PARENT));
    expect(manifest.entries.map((e) => [e.role, e.relpath])).toEqual([
      ['canonical', parentRelpath],
      ['subagent', childRelpath],
      ['subagent-meta', childMetaRelpath],
    ]);
    for (const e of manifest.entries) expect(files[`${MACHINE}/claude-projects/${e.relpath}`]).toBeDefined();

    // Exporting the subagent itself carries its own sidecar, so the parent link survives re-ingest.
    const child = await unzipResponse(await fetchExport(CHILD));
    expect(child.manifest.entries.map((e) => [e.role, e.relpath])).toEqual([
      ['canonical', childRelpath],
      ['subagent-meta', childMetaRelpath],
    ]);
  });

  it('narrows an archive-backed session to a fresh single-conversation archive (no sibling leak)', async () => {
    const zip = chatgptExportZip([
      { id: CONV_A, title: 'wanted', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'alpha content' }] },
      { id: CONV_B, title: 'sibling', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'beta must not leak' }] },
    ]);
    expect((await put('export-inbox', 'chatgpt-2026.zip', zip)).status).toBe(201);
    await drainQueue();

    const { files, manifest } = await unzipResponse(await fetchExport(CONV_A));
    expect(manifest.entries).toHaveLength(1);
    const entry = manifest.entries[0]!;
    expect(entry.narrowed).toBe(true);
    expect(entry.relpath).toBe(`chatgpt-2026.${CONV_A}.zip`);
    expect(entry.content_hash).toBeUndefined();

    const inner = unzipSync(files[`${MACHINE}/export-inbox/${entry.relpath}`]!);
    const conversations = JSON.parse(strFromU8(inner['conversations.json']!)) as Array<{ conversation_id: string }>;
    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.conversation_id).toBe(CONV_A);
    expect(strFromU8(inner['conversations.json']!)).not.toContain('beta must not leak');
  });

  it('keeps narrowed relpaths injective for session ids that sanitize to the same string', async () => {
    const zip = chatgptExportZip([
      { id: 'collide/x', title: 'slash', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'slash conversation' }] },
      { id: 'collide-x', title: 'dash', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'dash conversation' }] },
    ]);
    expect((await put('export-inbox', 'hostile-ids.zip', zip)).status).toBe(201);
    await drainQueue();

    const url = new URL(`https://sessions.vza.net/s/${encodeURIComponent('collide/x')}/export.zip`);
    const slash = await unzipResponse(await viewerRoute(new Request(url.toString()), url, testEnv));
    const dash = await unzipResponse(await fetchExport('collide-x'));
    const slashRelpath = slash.manifest.entries[0]!.relpath;
    const dashRelpath = dash.manifest.entries[0]!.relpath;
    expect(slashRelpath).not.toBe(dashRelpath);
    // The lossless id keeps its plain suffix; the sanitized one carries a digest disambiguator.
    expect(dashRelpath).toBe('hostile-ids.collide-x.zip');
    expect(slashRelpath).toMatch(/^hostile-ids\.collide-x-[0-9a-f]{16}\.zip$/);
  });

  it('is gated by viewer auth in production and 404s on unknown sessions', async () => {
    const prodRes = await fetchExport(LONELY, { ENVIRONMENT: 'production' } as Env);
    expect(prodRes.status).toBe(302);
    expect(prodRes.headers.get('location')).toBe('/login');

    const missing = await fetchExport('00000000-dead-4dead-8dead-000000000000');
    expect(missing.status).toBe(404);
  });
});
