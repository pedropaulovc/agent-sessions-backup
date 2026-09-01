import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { displacedKey } from '../src/api/upload';
import { API } from './hosts';

const testEnv = env as unknown as Env;
const MIB = 1024 * 1024;

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fileUrl(machine: string, store: string, relpath: string): string {
  return `${API}/api/v1/files/${machine}/${store}/${encodeURIComponent(relpath)}`;
}

async function putSimple(machine: string, store: string, relpath: string, bytes: Uint8Array): Promise<Response> {
  return SELF.fetch(fileUrl(machine, store, relpath), {
    method: 'PUT',
    headers: {
      'x-dev-machine': machine,
      'x-content-hash': `sha256:${await sha256Hex(bytes)}`,
      'x-file-size': String(bytes.length),
      'x-file-mtime': '2026-07-01T12:00:00Z',
    },
    body: bytes as BodyInit,
  });
}

async function prevObjectText(machine: string, store: string, relpath: string, oldSha: string): Promise<string | null> {
  const obj = await testEnv.RAW.get(displacedKey(`raw/${machine}/${store}/${relpath}`, oldSha));
  return obj ? await obj.text() : null;
}

async function listPrevKeys(machine: string): Promise<string[]> {
  const page = await testEnv.RAW.list({ prefix: `raw-prev/${machine}/` });
  return page.objects.map((o) => o.key);
}

const enc = (s: string) => new TextEncoder().encode(s);

describe('append-only upload guard (simple PUT)', () => {
  it('append-shaped growth replaces in place without preserving a predecessor', async () => {
    const machine = `guard-append-${crypto.randomUUID().slice(0, 8)}`;
    const relpath = 'projects/x/session1.jsonl';
    const v1 = enc('{"line":1}\n');
    const v2 = enc('{"line":1}\n{"line":2}\n');
    expect((await putSimple(machine, 'claude-projects', relpath, v1)).status).toBe(201);
    expect((await putSimple(machine, 'claude-projects', relpath, v2)).status).toBe(201);
    const canonical = await testEnv.RAW.get(`raw/${machine}/claude-projects/${relpath}`);
    expect(await canonical!.text()).toBe('{"line":1}\n{"line":2}\n');
    expect(await listPrevKeys(machine)).toEqual([]);
  });

  it('an in-place rewrite is accepted but the displaced object is preserved under raw-prev/', async () => {
    const machine = `guard-rewrite-${crypto.randomUUID().slice(0, 8)}`;
    const relpath = 'conversations/conv-1.json';
    const v1 = enc('{"messages":[1]}');
    const v2 = enc('{"messages":[1,2]}'); // longer, but not a byte-prefix extension
    const v1Sha = await sha256Hex(v1);
    expect((await putSimple(machine, 'chatgpt-web', relpath, v1)).status).toBe(201);
    expect((await putSimple(machine, 'chatgpt-web', relpath, v2)).status).toBe(201);
    const canonical = await testEnv.RAW.get(`raw/${machine}/chatgpt-web/${relpath}`);
    expect(await canonical!.text()).toBe('{"messages":[1,2]}');
    expect(await prevObjectText(machine, 'chatgpt-web', relpath, v1Sha)).toBe('{"messages":[1]}');
    const row = await testEnv.DB.prepare('SELECT content_hash FROM files WHERE machine_id = ?1').bind(machine).first<{ content_hash: string }>();
    expect(row!.content_hash).toBe(await sha256Hex(v2));
  });

  it('a shrink preserves the displaced object too', async () => {
    const machine = `guard-shrink-${crypto.randomUUID().slice(0, 8)}`;
    const relpath = 'projects/x/session2.jsonl';
    const v1 = enc('{"line":1}\n{"line":2}\n');
    const v2 = enc('{"line":1}\n');
    const v1Sha = await sha256Hex(v1);
    expect((await putSimple(machine, 'claude-projects', relpath, v1)).status).toBe(201);
    expect((await putSimple(machine, 'claude-projects', relpath, v2)).status).toBe(201);
    expect(await prevObjectText(machine, 'claude-projects', relpath, v1Sha)).toBe('{"line":1}\n{"line":2}\n');
  });

  it('successive rewrites each keep their own predecessor', async () => {
    const machine = `guard-multi-${crypto.randomUUID().slice(0, 8)}`;
    const relpath = 'conversations/conv-2.json';
    const versions = ['{"v":1}', '{"v":2}', '{"v":3}'].map(enc);
    for (const v of versions) expect((await putSimple(machine, 'claude-web', relpath, v)).status).toBe(201);
    expect(await prevObjectText(machine, 'claude-web', relpath, await sha256Hex(versions[0]!))).toBe('{"v":1}');
    expect(await prevObjectText(machine, 'claude-web', relpath, await sha256Hex(versions[1]!))).toBe('{"v":2}');
    expect((await listPrevKeys(machine)).length).toBe(2);
  });

  it('a crash-retry cannot clobber the preserved predecessor (write-once quarantine)', async () => {
    // A rewrite that preserved + replaced canonical but DIED before its D1 upsert leaves the row
    // on the OLD hash while canonical already holds the NEW bytes. The collector's retry re-fails
    // the prefix check and re-preserves — which must NOT copy the new bytes over the real
    // predecessor. Seed that end-state directly (same idiom as the convergence-race tests).
    const machine = `guard-retry-${crypto.randomUUID().slice(0, 8)}`;
    const relpath = 'conversations/conv-crash.json';
    const v1 = enc('{"v":"old"}');
    const v2 = enc('{"v":"new-rewrite"}');
    const v1Sha = await sha256Hex(v1);
    expect((await putSimple(machine, 'chatgpt-web', relpath, v1)).status).toBe(201);
    // Crash window: predecessor already preserved, canonical already replaced, row still on v1.
    const key = `raw/${machine}/chatgpt-web/${relpath}`;
    await testEnv.RAW.put(displacedKey(key, v1Sha), v1);
    await testEnv.RAW.put(key, v2, { sha256: await sha256Hex(v2) });
    // Retry of the same rewrite: still accepted, and the preserved copy still holds the OLD bytes.
    expect((await putSimple(machine, 'chatgpt-web', relpath, v2)).status).toBe(201);
    expect(await prevObjectText(machine, 'chatgpt-web', relpath, v1Sha)).toBe('{"v":"old"}');
  });

  it('never stores replacement bytes under the predecessor key (concurrent-rewrite loser)', async () => {
    // Two concurrent rewrites can both pass the write-once head check; the slower one then
    // reads the canonical key AFTER the faster one replaced it. Seed that end-state (row
    // still on v1's hash, canonical already holding the peer's bytes, quarantine empty):
    // the loser's preservation must SKIP — peer bytes must never be labeled with v1's sha.
    const machine = `guard-race-${crypto.randomUUID().slice(0, 8)}`;
    const relpath = 'conversations/conv-race.json';
    const v1 = enc('{"v":"original"}');
    const peer = enc('{"v":"peer-replacement"}');
    const mine = enc('{"v":"my-rewrite"}');
    const v1Sha = await sha256Hex(v1);
    expect((await putSimple(machine, 'chatgpt-web', relpath, v1)).status).toBe(201);
    const key = `raw/${machine}/chatgpt-web/${relpath}`;
    await testEnv.RAW.put(key, peer, { sha256: await sha256Hex(peer) }); // peer replaced canonical; row still v1
    expect((await putSimple(machine, 'chatgpt-web', relpath, mine)).status).toBe(201);
    expect(await prevObjectText(machine, 'chatgpt-web', relpath, v1Sha)).toBeNull();
    expect(await listPrevKeys(machine)).toEqual([]);
    const canonical = await testEnv.RAW.get(key);
    expect(await canonical!.text()).toBe('{"v":"my-rewrite"}');
  });

  it('a same-hash resync never touches raw-prev/', async () => {
    const machine = `guard-samehash-${crypto.randomUUID().slice(0, 8)}`;
    const relpath = 'projects/x/session3.jsonl';
    const v1 = enc('{"line":1}\n');
    expect((await putSimple(machine, 'claude-projects', relpath, v1)).status).toBe(201);
    // A REAL resync, not just steady-state: the canonical object is gone (lost/corrupt), so
    // the same-hash path must RESTORE it from the request body — while still never treating
    // the repair as a displacement (raw-prev/ stays empty).
    await testEnv.RAW.delete(`raw/${machine}/claude-projects/${relpath}`);
    const resync = await putSimple(machine, 'claude-projects', relpath, v1);
    expect(resync.status).toBe(200);
    const body = await resync.json<{ status: string; restored: boolean }>();
    expect(body.status).toBe('unchanged');
    expect(body.restored).toBe(true);
    const canonical = await testEnv.RAW.get(`raw/${machine}/claude-projects/${relpath}`);
    expect(await canonical!.text()).toBe('{"line":1}\n');
    expect(await listPrevKeys(machine)).toEqual([]);
  });
});

describe('append-only upload guard (multipart complete)', () => {
  async function multipartUpload(machine: string, store: string, relpath: string, bytes: Uint8Array): Promise<Response> {
    const hash = await sha256Hex(bytes);
    const create = await SELF.fetch(`${fileUrl(machine, store, relpath)}?uploads`, {
      method: 'POST',
      headers: {
        'x-dev-machine': machine,
        'x-content-hash': `sha256:${hash}`,
        'x-file-size': String(bytes.length),
        'x-file-mtime': '2026-07-01T12:00:00Z',
      },
    });
    expect(create.status).toBe(201);
    const { upload_id: uploadId } = await create.json<{ upload_id: string }>();
    const partSize = 5 * MIB;
    const parts: Array<{ part_number: number; etag: string }> = [];
    for (let offset = 0, n = 1; offset < bytes.length; offset += partSize, n++) {
      const chunk = bytes.subarray(offset, Math.min(offset + partSize, bytes.length));
      const isLast = offset + partSize >= bytes.length;
      const headers: Record<string, string> = { 'x-dev-machine': machine, 'x-part-size': String(partSize) };
      if (isLast) headers['x-part-is-last'] = '1';
      const part = await SELF.fetch(`${fileUrl(machine, store, relpath)}?uploadId=${encodeURIComponent(uploadId)}&partNumber=${n}`, {
        method: 'PUT', headers, body: chunk as BodyInit,
      });
      expect(part.status).toBe(200);
      parts.push(await part.json<{ part_number: number; etag: string }>());
    }
    return SELF.fetch(`${fileUrl(machine, store, relpath)}?uploadId=${encodeURIComponent(uploadId)}`, {
      method: 'POST',
      headers: {
        'x-dev-machine': machine,
        'x-content-hash': `sha256:${hash}`,
        'x-file-size': String(bytes.length),
        'x-file-mtime': '2026-07-01T12:00:00Z',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ parts }),
    });
  }

  it('a multipart rewrite that does not extend the stored file preserves the displaced object', async () => {
    const machine = `guard-mp-${crypto.randomUUID().slice(0, 8)}`;
    const relpath = 'projects/x/big.jsonl';
    const v1 = new Uint8Array(1 * MIB).fill(0x41); // 'A' — simple PUT original
    const v1Sha = await sha256Hex(v1);
    expect((await putSimple(machine, 'claude-projects', relpath, v1)).status).toBe(201);
    const v2 = new Uint8Array(6 * MIB).fill(0x42); // 'B' — first MiB differs: not an extension
    const complete = await multipartUpload(machine, 'claude-projects', relpath, v2);
    expect(complete.status).toBe(201);
    const preserved = await testEnv.RAW.get(displacedKey(`raw/${machine}/claude-projects/${relpath}`, v1Sha));
    expect(preserved).not.toBeNull();
    expect(preserved!.size).toBe(1 * MIB);
    expect(new Uint8Array(await preserved!.arrayBuffer())[0]).toBe(0x41);
    const canonical = await testEnv.RAW.get(`raw/${machine}/claude-projects/${relpath}`);
    expect(canonical!.size).toBe(6 * MIB);
  });

  it('a multipart append extension replaces in place without preserving a predecessor', async () => {
    const machine = `guard-mp-append-${crypto.randomUUID().slice(0, 8)}`;
    const relpath = 'projects/x/big-append.jsonl';
    const v1 = new Uint8Array(1 * MIB).fill(0x41);
    expect((await putSimple(machine, 'claude-projects', relpath, v1)).status).toBe(201);
    const v2 = new Uint8Array(6 * MIB).fill(0x42);
    v2.set(v1, 0); // first MiB identical: a true prefix extension
    const complete = await multipartUpload(machine, 'claude-projects', relpath, v2);
    expect(complete.status).toBe(201);
    expect(await listPrevKeys(machine)).toEqual([]);
    const canonical = await testEnv.RAW.get(`raw/${machine}/claude-projects/${relpath}`);
    expect(canonical!.size).toBe(6 * MIB);
  });
});
