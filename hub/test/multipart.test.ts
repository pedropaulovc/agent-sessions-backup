import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { runPrune } from '../src/cron/prune';
import { ccAssistantLine, ccUserLine } from './fixtures';

const testEnv = env as unknown as Env;
const MIB = 1024 * 1024;

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fileUrl(machine: string, store: string, relpath: string): string {
  return `https://api.sessions.vza.net/api/v1/files/${machine}/${store}/${encodeURIComponent(relpath)}`;
}

async function createMp(machine: string, store: string, relpath: string, size: number, hash: string): Promise<Response> {
  return SELF.fetch(`${fileUrl(machine, store, relpath)}?uploads`, {
    method: 'POST',
    headers: {
      'x-dev-machine': machine,
      'x-content-hash': `sha256:${hash}`,
      'x-file-size': String(size),
      'x-file-mtime': '2026-07-01T12:00:00Z',
    },
  });
}

async function putPart(
  machine: string,
  store: string,
  relpath: string,
  uploadId: string,
  partNumber: number,
  body: Uint8Array,
  isLast: boolean,
): Promise<Response> {
  const headers: Record<string, string> = { 'x-dev-machine': machine };
  if (isLast) headers['x-part-is-last'] = '1';
  return SELF.fetch(`${fileUrl(machine, store, relpath)}?uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`, {
    method: 'PUT',
    headers,
    body: body as BufferSource,
  });
}

async function completeMp(
  machine: string,
  store: string,
  relpath: string,
  uploadId: string,
  parts: Array<{ part_number: number; etag: string }>,
): Promise<Response> {
  return SELF.fetch(`${fileUrl(machine, store, relpath)}?uploadId=${encodeURIComponent(uploadId)}`, {
    method: 'POST',
    headers: { 'x-dev-machine': machine, 'content-type': 'application/json' },
    body: JSON.stringify({ parts }),
  });
}

async function abortMp(machine: string, store: string, relpath: string, uploadId: string): Promise<Response> {
  return SELF.fetch(`${fileUrl(machine, store, relpath)}?uploadId=${encodeURIComponent(uploadId)}`, {
    method: 'DELETE',
    headers: { 'x-dev-machine': machine },
  });
}

/** Drive create -> parts -> complete for the given bytes. Splits into fixed-size parts (last is the
 * remainder), flagging the final part so an under-5MiB tail is accepted. */
async function multipartStore(
  machine: string,
  store: string,
  relpath: string,
  bytes: Uint8Array,
  partSize: number,
  opts: { declaredHash?: string } = {},
): Promise<{ createStatus: number; createJson: any; uploadId?: string; complete?: Response; completeJson?: any }> {
  const hash = opts.declaredHash ?? (await sha256Hex(bytes));
  const cr = await createMp(machine, store, relpath, bytes.length, hash);
  const createJson = await cr.json<any>();
  if (cr.status !== 201) return { createStatus: cr.status, createJson };
  const uploadId = createJson.upload_id as string;
  const n = Math.max(1, Math.ceil(bytes.length / partSize));
  const parts: Array<{ part_number: number; etag: string }> = [];
  for (let i = 0; i < n; i++) {
    const slice = bytes.subarray(i * partSize, Math.min((i + 1) * partSize, bytes.length));
    const pr = await putPart(machine, store, relpath, uploadId, i + 1, slice, i === n - 1);
    expect(pr.status, `part ${i + 1}`).toBe(200);
    const prj = await pr.json<any>();
    parts.push({ part_number: prj.part_number, etag: prj.etag });
  }
  const complete = await completeMp(machine, store, relpath, uploadId, parts);
  return { createStatus: cr.status, createJson, uploadId, complete, completeJson: await complete.clone().json<any>() };
}

/** Run the parse consumer over everything currently pending (tests get no automatic delivery). */
async function drainQueue(): Promise<void> {
  const pending = await testEnv.DB.prepare(
    "SELECT id, r2_key, content_hash FROM files WHERE parse_state = 'pending'",
  ).all<{ id: number; r2_key: string; content_hash: string }>();
  const messages = pending.results.map((r) => ({
    id: String(r.id),
    timestamp: new Date(),
    attempts: 1,
    body: { file_id: r.id, r2_key: r.r2_key, reason: 'upload' as const, content_hash: r.content_hash },
    ack() {},
    retry() {},
  }));
  if (messages.length === 0) return;
  await worker.queue({ queue: 'parse', messages } as any, testEnv);
}

/** A valid Claude Code session padded past `minBytes` with one big assistant text line (the parser
 * handles >1MB lines), so the object needs multiple >=5MiB parts yet still parses to a real session. */
function bigSession(sessionId: string, marker: string, minBytes: number): string {
  const pad = 'y'.repeat(minBytes);
  return (
    [
      ccUserLine({ uuid: 'u1', text: `${marker} question` }),
      ccAssistantLine({ uuid: 'a1', parentUuid: 'u1', text: `${marker} answer ${pad}` }),
    ].join('\n') + '\n'
  );
}

const CC_SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('multipart upload', () => {
  it('create -> part -> complete stores the object and enqueues the parse (indexes like the simple path)', async () => {
    const content = bigSession(CC_SID, 'niobium', 6 * MIB);
    const bytes = new TextEncoder().encode(content);
    const relpath = `demo/${CC_SID}.jsonl`;
    const res = await multipartStore('mp-box', 'claude', relpath, bytes, 5 * MIB);
    expect(res.createStatus).toBe(201); // opened a real multipart upload (not the unchanged short-circuit)
    expect(res.complete!.status).toBe(201);
    expect(res.completeJson.status).toBe('stored');

    // Object bytes are exactly what we sent.
    const obj = await testEnv.RAW.get(`raw/mp-box/claude/${relpath}`);
    expect(obj!.size).toBe(bytes.length);

    // files row landed pending, tracking row cleaned up.
    const file = await testEnv.DB.prepare('SELECT parse_state, content_hash, size FROM files WHERE machine_id = ?1 AND relpath = ?2')
      .bind('mp-box', relpath)
      .first<{ parse_state: string; content_hash: string; size: number }>();
    expect(file!.parse_state).toBe('pending');
    expect(file!.size).toBe(bytes.length);
    const track = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM multipart_uploads').first<{ n: number }>();
    expect(track!.n).toBe(0);

    // Parse enqueued on complete -> session becomes searchable, just like a simple PUT.
    await drainQueue();
    const parsed = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE machine_id = ?1 AND relpath = ?2')
      .bind('mp-box', relpath)
      .first<{ parse_state: string }>();
    expect(parsed!.parse_state).toBe('parsed');
    const search = await SELF.fetch('https://api.sessions.vza.net/api/v1/search?q=niobium', {
      headers: { 'x-dev-machine': 'mp-box' },
    });
    const body = await search.json<{ hits: Array<{ session_id: string }> }>();
    expect(body.hits.some((h) => h.session_id === CC_SID)).toBe(true);
  });

  it('simple PUT and completed multipart of identical bytes store byte-identical objects (positive control)', async () => {
    // A file that fits a single request goes through the simple PUT; the SAME bytes forced through
    // multipart must land the identical object. (Bytes must exceed 5MiB so multipart is legal.)
    const content = bigSession('bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', 'osmium', 6 * MIB);
    const bytes = new TextEncoder().encode(content);
    const hash = await sha256Hex(bytes);

    const simple = await SELF.fetch(fileUrl('twin-box', 'claude', 'simple/s.jsonl'), {
      method: 'PUT',
      headers: {
        'x-dev-machine': 'twin-box',
        'x-content-hash': `sha256:${hash}`,
        'x-file-mtime': '2026-07-01T12:00:00Z',
        'content-length': String(bytes.length),
      },
      body: bytes as BufferSource,
    });
    expect(simple.status).toBe(201);

    const mp = await multipartStore('twin-box', 'claude', 'multi/m.jsonl', bytes, 5 * MIB);
    expect(mp.complete!.status).toBe(201);

    const a = await testEnv.RAW.get('raw/twin-box/claude/simple/s.jsonl');
    const b = await testEnv.RAW.get('raw/twin-box/claude/multi/m.jsonl');
    const [ab, bb] = [new Uint8Array(await a!.arrayBuffer()), new Uint8Array(await b!.arrayBuffer())];
    expect(bb.length).toBe(ab.length);
    expect(await sha256Hex(bb)).toBe(await sha256Hex(ab));
  });

  it('rejects a non-final part under 5MiB (part-size enforcement), accepts the flagged last part', async () => {
    const bytes = new Uint8Array(6 * MIB).fill(7);
    const hash = await sha256Hex(bytes);
    const cr = await createMp('small-part-box', 'claude', 'x.bin', bytes.length, hash);
    const { upload_id: uploadId } = await cr.json<any>();

    // A 1MiB part NOT flagged last -> 400.
    const tooSmall = await putPart('small-part-box', 'claude', 'x.bin', uploadId, 1, bytes.subarray(0, 1 * MIB), false);
    expect(tooSmall.status).toBe(400);
    expect((await tooSmall.json<any>()).error).toBe('part_too_small');

    // Same 1MiB flagged last -> accepted (a small final part is legal).
    const ok = await putPart('small-part-box', 'claude', 'x.bin', uploadId, 1, bytes.subarray(0, 1 * MIB), true);
    expect(ok.status).toBe(200);
    await abortMp('small-part-box', 'claude', 'x.bin', uploadId); // cleanup
  });

  it('deletes the object and returns 422 when the reassembled hash does not match the declared hash', async () => {
    const bytes = new Uint8Array(6 * MIB).fill(3);
    const wrongHash = await sha256Hex(new Uint8Array(6 * MIB).fill(9)); // declare a DIFFERENT content
    const relpath = 'mismatch.bin';
    const res = await multipartStore('mismatch-box', 'claude', relpath, bytes, 5 * MIB, { declaredHash: wrongHash });
    expect(res.complete!.status).toBe(422);
    expect(res.completeJson.error).toBe('checksum_mismatch');

    // Object deleted, no files row created, tracking row removed.
    const obj = await testEnv.RAW.head(`raw/mismatch-box/claude/${relpath}`);
    expect(obj).toBeNull();
    const file = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM files WHERE machine_id = ?1 AND relpath = ?2')
      .bind('mismatch-box', relpath)
      .first<{ n: number }>();
    expect(file!.n).toBe(0);
    const track = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM multipart_uploads').first<{ n: number }>();
    expect(track!.n).toBe(0);
  });

  it('short-circuits create with 200 unchanged when the hub already holds these exact bytes', async () => {
    const bytes = new TextEncoder().encode(bigSession('cccccccc-dddd-4eee-8fff-000000000000', 'yttrium', 6 * MIB));
    const relpath = 'demo/unchanged.jsonl';
    const first = await multipartStore('unchanged-box', 'claude', relpath, bytes, 5 * MIB);
    expect(first.complete!.status).toBe(201);

    // A second create for the same path+hash opens NO upload and returns unchanged.
    const hash = await sha256Hex(bytes);
    const again = await createMp('unchanged-box', 'claude', relpath, bytes.length, hash);
    expect(again.status).toBe(200);
    expect((await again.json<any>()).status).toBe('unchanged');
    const track = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM multipart_uploads').first<{ n: number }>();
    expect(track!.n).toBe(0);
  });

  it('abort removes the tracking row; a later complete for that upload is 404; unknown abort is idempotent', async () => {
    const bytes = new Uint8Array(6 * MIB).fill(1);
    const hash = await sha256Hex(bytes);
    const cr = await createMp('abort-box', 'claude', 'a.bin', bytes.length, hash);
    const { upload_id: uploadId } = await cr.json<any>();
    await putPart('abort-box', 'claude', 'a.bin', uploadId, 1, bytes.subarray(0, 5 * MIB), false);

    const ab = await abortMp('abort-box', 'claude', 'a.bin', uploadId);
    expect(ab.status).toBe(200);
    expect((await ab.json<any>()).status).toBe('aborted');
    const track = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM multipart_uploads WHERE upload_id = ?1').bind(uploadId).first<{ n: number }>();
    expect(track!.n).toBe(0);

    // Completing an aborted/unknown upload -> 404.
    const comp = await completeMp('abort-box', 'claude', 'a.bin', uploadId, [{ part_number: 1, etag: 'x' }]);
    expect(comp.status).toBe(404);

    // Aborting an unknown upload is a no-op success.
    const gone = await abortMp('abort-box', 'claude', 'a.bin', 'no-such-upload-id');
    expect(gone.status).toBe(200);
    expect((await gone.json<any>()).status).toBe('gone');
  });

  it('rejects a create with a missing/blank content hash before opening any upload', async () => {
    const res = await SELF.fetch(`${fileUrl('bad-hdr-box', 'claude', 'x.bin')}?uploads`, {
      method: 'POST',
      headers: { 'x-dev-machine': 'bad-hdr-box', 'x-file-size': '100' },
    });
    expect(res.status).toBe(400);
    expect((await res.json<any>()).error).toBe('missing_or_bad_x_content_hash');
    const track = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM multipart_uploads').first<{ n: number }>();
    expect(track!.n).toBe(0);
  });
});

describe('prune cron: dangling multipart uploads', () => {
  beforeEach(async () => {
    await testEnv.DB.prepare('DELETE FROM multipart_uploads').run();
  });

  it('aborts and forgets uploads older than 7 days, keeps recent ones', async () => {
    await testEnv.DB.prepare("INSERT INTO machines (machine_id, os) VALUES ('prune-box','linux') ON CONFLICT (machine_id) DO NOTHING").run();
    const oldKey = 'raw/prune-box/claude/old-dangling.bin';
    const freshKey = 'raw/prune-box/claude/fresh.bin';
    const oldMpu = await testEnv.RAW.createMultipartUpload(oldKey);
    const freshMpu = await testEnv.RAW.createMultipartUpload(freshKey);
    // Upload a real part to the old one so there is something to abort.
    await testEnv.RAW.resumeMultipartUpload(oldKey, oldMpu.uploadId).uploadPart(1, new Uint8Array(5 * MIB).fill(4));

    await testEnv.DB.prepare(
      `INSERT INTO multipart_uploads (upload_id, machine_id, store, relpath, r2_key, content_hash, mtime, size, created_at)
       VALUES (?1,'prune-box','claude','old-dangling.bin',?2,'deadbeef',NULL,100,'2020-01-01T00:00:00.000Z')`,
    )
      .bind(oldMpu.uploadId, oldKey)
      .run();
    await testEnv.DB.prepare(
      `INSERT INTO multipart_uploads (upload_id, machine_id, store, relpath, r2_key, content_hash, mtime, size)
       VALUES (?1,'prune-box','claude','fresh.bin',?2,'cafef00d',NULL,100)`,
    )
      .bind(freshMpu.uploadId, freshKey)
      .run();

    await runPrune(testEnv);

    const oldRow = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM multipart_uploads WHERE upload_id = ?1').bind(oldMpu.uploadId).first<{ n: number }>();
    const freshRow = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM multipart_uploads WHERE upload_id = ?1').bind(freshMpu.uploadId).first<{ n: number }>();
    expect(oldRow!.n).toBe(0); // pruned
    expect(freshRow!.n).toBe(1); // survived
    // Cleanup the fresh upload we left open.
    await testEnv.RAW.resumeMultipartUpload(freshKey, freshMpu.uploadId).abort();
  });
});
