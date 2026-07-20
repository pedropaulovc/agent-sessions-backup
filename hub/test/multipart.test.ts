import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { convergeMultipartRow, recordUploadedObject } from '../src/api/upload';
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

async function stateOf(id: number): Promise<string | null> {
  const row = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1').bind(id).first<{ parse_state: string }>();
  return row?.parse_state ?? null;
}

async function reservedByOf(id: number): Promise<number | null> {
  const row = await testEnv.DB.prepare('SELECT reserved_by FROM files WHERE id = ?1').bind(id).first<{ reserved_by: number | null }>();
  return row?.reserved_by ?? null;
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
  partSize: number,
  isLast: boolean,
): Promise<Response> {
  const headers: Record<string, string> = { 'x-dev-machine': machine, 'x-part-size': String(partSize) };
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
  hash: string,
  size: number,
): Promise<Response> {
  return SELF.fetch(`${fileUrl(machine, store, relpath)}?uploadId=${encodeURIComponent(uploadId)}`, {
    method: 'POST',
    headers: {
      'x-dev-machine': machine,
      'content-type': 'application/json',
      'x-content-hash': `sha256:${hash}`,
      'x-file-size': String(size),
      'x-file-mtime': '2026-07-01T12:00:00Z',
    },
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
 * remainder), flagging the final part so an under-part-size tail is accepted. `declaredHash` lets a
 * test declare a hash that does NOT match the bytes (to exercise the verify-mismatch path). */
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
    const pr = await putPart(machine, store, relpath, uploadId, i + 1, slice, partSize, i === n - 1);
    expect(pr.status, `part ${i + 1}`).toBe(200);
    const prj = await pr.json<any>();
    parts.push({ part_number: prj.part_number, etag: prj.etag });
  }
  const complete = await completeMp(machine, store, relpath, uploadId, parts, hash, bytes.length);
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

/** A valid Claude Code session padded past `minBytes` with sub-2MiB records, so the object needs
 * multiple >=5MiB parts while every individual JSONL record remains indexable. */
function bigSession(sessionId: string, marker: string, minBytes: number): string {
  const lines = [ccUserLine({ uuid: 'u1', text: `${marker} question` })];
  let parentUuid = 'u1';
  let remaining = minBytes;
  let index = 1;
  while (remaining > 0) {
    const uuid = `a${index}`;
    const padBytes = Math.min(remaining, MIB);
    lines.push(ccAssistantLine({ uuid, parentUuid, text: `${marker} answer ${'y'.repeat(padBytes)}` }));
    parentUuid = uuid;
    remaining -= padBytes;
    index++;
  }
  return `${lines.join('\n')}\n`;
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

    const file = await testEnv.DB.prepare('SELECT parse_state, content_hash, size FROM files WHERE machine_id = ?1 AND relpath = ?2')
      .bind('mp-box', relpath)
      .first<{ parse_state: string; content_hash: string; size: number }>();
    expect(file!.parse_state).toBe('pending');
    expect(file!.size).toBe(bytes.length);

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

  it('enforces R2 part rules: rejects a non-uniform non-final part and a sub-5MiB declared size, accepts a smaller flagged tail', async () => {
    const bytes = new Uint8Array(6 * MIB).fill(7);
    const hash = await sha256Hex(bytes);
    const cr = await createMp('part-rules-box', 'claude', 'x.bin', bytes.length, hash);
    const { upload_id: uploadId } = await cr.json<any>();

    // Non-final part smaller than the declared part size -> 400 non_uniform_part.
    const nonUniform = await putPart('part-rules-box', 'claude', 'x.bin', uploadId, 1, bytes.subarray(0, 4 * MIB), 5 * MIB, false);
    expect(nonUniform.status).toBe(400);
    expect((await nonUniform.json<any>()).error).toBe('non_uniform_part');

    // Declared part size below R2's 5MiB floor -> 400 bad_or_small_part_size.
    const tooSmallDecl = await putPart('part-rules-box', 'claude', 'x.bin', uploadId, 1, bytes.subarray(0, 1 * MIB), 1 * MIB, false);
    expect(tooSmallDecl.status).toBe(400);
    expect((await tooSmallDecl.json<any>()).error).toBe('bad_or_small_part_size');

    // A 1MiB part flagged last, declared size 5MiB -> accepted (a small final part is legal).
    const okLast = await putPart('part-rules-box', 'claude', 'x.bin', uploadId, 1, bytes.subarray(0, 1 * MIB), 5 * MIB, true);
    expect(okLast.status).toBe(200);
    await abortMp('part-rules-box', 'claude', 'x.bin', uploadId); // cleanup
  });

  it('deletes the object and returns 422 when the reassembled hash does not match the declared hash', async () => {
    const bytes = new Uint8Array(6 * MIB).fill(3);
    const wrongHash = await sha256Hex(new Uint8Array(6 * MIB).fill(9)); // declare a DIFFERENT content
    const relpath = 'mismatch.bin';
    const res = await multipartStore('mismatch-box', 'claude', relpath, bytes, 5 * MIB, { declaredHash: wrongHash });
    expect(res.complete!.status).toBe(422);
    expect(res.completeJson.error).toBe('checksum_mismatch');

    // Object deleted, no files row created.
    const obj = await testEnv.RAW.head(`raw/mismatch-box/claude/${relpath}`);
    expect(obj).toBeNull();
    const file = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM files WHERE machine_id = ?1 AND relpath = ?2')
      .bind('mismatch-box', relpath)
      .first<{ n: number }>();
    expect(file!.n).toBe(0);
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
  });

  it('the same-hash shortcut leaves a FRESH reservation alone but re-enqueues a STALE one (round 15, 3608955878)', async () => {
    const bytes = new TextEncoder().encode(bigSession('aaaaaaaa-bbbb-4ccc-8ddd-000000000000', 'gadolinium', 6 * MIB));
    const relpath = 'demo/aaaaaaaa-bbbb-4ccc-8ddd-000000000000.jsonl';
    const first = await multipartStore('mpgate-box', 'claude', relpath, bytes, 5 * MIB);
    expect(first.complete!.status).toBe(201);
    const hash = await sha256Hex(bytes);
    const row = await testEnv.DB.prepare("SELECT id FROM files WHERE machine_id = 'mpgate-box' AND relpath = ?1").bind(relpath).first<{ id: number }>();
    const id = row!.id;

    // Mark it a FRESH reservation, as if a live export cleanup owns it.
    await testEnv.DB
      .prepare("UPDATE files SET parse_state = 'reserved', reserved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), reserved_by = 999999 WHERE id = ?1")
      .bind(id)
      .run();

    // Same-hash create → the unchanged shortcut calls markPendingAndEnqueue, which the centralized gate (round
    // 15) no-ops for a fresh reservation. POSITIVE CONTROL: without the gate this large-file resync path flips it
    // to 'pending' + clears reserved_by, stealing the sibling out from under the cleanup before its deletes drain.
    const fresh = await createMp('mpgate-box', 'claude', relpath, bytes.length, hash);
    expect(fresh.status).toBe(200);
    const freshBody = await fresh.json<any>();
    expect(freshBody.status).toBe('unchanged');
    expect(freshBody.requeued).toBe(false); // gated — not requeued
    expect(await stateOf(id)).toBe('reserved');
    expect(await reservedByOf(id)).toBe(999999);

    // Age it past the staleness threshold → the shortcut heals it like any non-terminal row.
    await testEnv.DB.prepare("UPDATE files SET reserved_at = '2020-01-01T00:00:00.000Z' WHERE id = ?1").bind(id).run();
    const stale = await createMp('mpgate-box', 'claude', relpath, bytes.length, hash);
    const staleBody = await stale.json<any>();
    expect(staleBody.requeued).toBe(true);
    expect(await stateOf(id)).toBe('pending');
    expect(await reservedByOf(id)).toBeNull();
  });

  it('abort makes a later complete for that upload fail; an unknown abort is idempotent', async () => {
    const bytes = new Uint8Array(6 * MIB).fill(1);
    const hash = await sha256Hex(bytes);
    const cr = await createMp('abort-box', 'claude', 'a.bin', bytes.length, hash);
    const { upload_id: uploadId } = await cr.json<any>();
    await putPart('abort-box', 'claude', 'a.bin', uploadId, 1, bytes.subarray(0, 5 * MIB), 5 * MIB, false);

    const ab = await abortMp('abort-box', 'claude', 'a.bin', uploadId);
    expect(ab.status).toBe(200);
    expect((await ab.json<any>()).status).toBe('aborted');

    // Completing an aborted upload -> 400 (R2 no longer knows the uploadId).
    const comp = await completeMp('abort-box', 'claude', 'a.bin', uploadId, [{ part_number: 1, etag: 'x' }], hash, bytes.length);
    expect(comp.status).toBe(400);

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
  });
});

describe('multipart reservation repair regression', () => {
  it('same-hash missing-object repair preserves a fresh cleanup reservation (3609060881)', async () => {
    const bytes = new TextEncoder().encode(bigSession('eeeeeeee-ffff-4000-8000-000000000000', 'reservation-repair', 6 * MIB));
    const machine = 'mp-repair-reservation';
    const relpath = 'demo/reserved-repair.jsonl';
    const first = await multipartStore(machine, 'claude', relpath, bytes, 5 * MIB);
    expect(first.complete?.status).toBe(201);
    const row = await testEnv.DB.prepare('SELECT id, r2_key FROM files WHERE machine_id = ?1 AND relpath = ?2')
      .bind(machine, relpath)
      .first<{ id: number; r2_key: string }>();

    await testEnv.DB.prepare(
      "UPDATE files SET parse_state = 'reserved', reserved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), reserved_by = 424242, reserved_reason = 'recover' WHERE id = ?1",
    ).bind(row!.id).run();
    await testEnv.RAW.delete(row!.r2_key); // force createMultipart to fall through into a same-hash repair

    const repaired = await multipartStore(machine, 'claude', relpath, bytes, 5 * MIB);
    expect(repaired.createStatus).toBe(201);
    expect(repaired.complete?.status).toBe(201);
    // POSITIVE CONTROL: the old unconditional conflict update changed this to pending and cleared the owner.
    expect(await stateOf(row!.id)).toBe('reserved');
    expect(await reservedByOf(row!.id)).toBe(424242);
    expect(await testEnv.RAW.head(row!.r2_key)).not.toBeNull();

    // Changed bytes preserve the cleanup window too, but upgrade the deferred intent to a full upload.
    const changed = new TextEncoder().encode(bigSession('eeeeeeee-ffff-4000-8000-000000000000', 'changed-bytes', 6 * MIB));
    expect((await multipartStore(machine, 'claude', relpath, changed, 5 * MIB)).complete?.status).toBe(201);
    expect(await stateOf(row!.id)).toBe('reserved');
    expect(await reservedByOf(row!.id)).toBe(424242);
    const changedRow = await testEnv.DB.prepare('SELECT reserved_reason FROM files WHERE id = ?1')
      .bind(row!.id)
      .first<{ reserved_reason: string | null }>();
    expect(changedRow?.reserved_reason).toBe('upload');
  });
});

describe('multipart review fixes', () => {
  async function checkFiles(machine: string, items: Array<{ store: string; relpath: string; sha256: string }>): Promise<{ missing: Array<{ store: string; relpath: string }> }> {
    const res = await SELF.fetch('https://api.sessions.vza.net/api/v1/files/check', {
      method: 'POST',
      headers: { 'x-dev-machine': machine, 'content-type': 'application/json' },
      body: JSON.stringify({ files: items }),
    });
    return res.json();
  }

  it('a completed multipart canonical object has a NATIVE checksum and files/check does not report it missing', async () => {
    const bytes = new Uint8Array(6 * MIB).fill(5);
    const hash = await sha256Hex(bytes);
    const relpath = 'fc/mp.bin';
    expect((await multipartStore('fc-box', 'claude', relpath, bytes, 5 * MIB)).complete!.status).toBe(201);

    // The canonical object is written by the staging->canonical put({sha256}), so it carries a NATIVE
    // checksum (not a trusted metadata string) — the whole point of the staging redesign.
    const obj = await testEnv.RAW.head(`raw/fc-box/claude/${relpath}`);
    const nativeHex = obj!.checksums.sha256
      ? [...new Uint8Array(obj!.checksums.sha256)].map((b) => b.toString(16).padStart(2, '0')).join('')
      : undefined;
    expect(nativeHex).toBe(hash);

    const present = await checkFiles('fc-box', [{ store: 'claude', relpath, sha256: hash }]);
    expect(present.missing).toEqual([]); // not re-uploaded on every backfill

    // And a genuinely-absent object IS reported missing (proves the check verifies R2, not just D1).
    await testEnv.RAW.delete(`raw/fc-box/claude/${relpath}`);
    const gone = await checkFiles('fc-box', [{ store: 'claude', relpath, sha256: hash }]);
    expect(gone.missing).toEqual([{ store: 'claude', relpath }]);
  });

  it('PRESERVATION: a mismatched multipart complete leaves the previous canonical object intact', async () => {
    // Upload v1 normally.
    const v1 = new TextEncoder().encode(bigSession('dddddddd-1111-4222-8333-444444444444', 'ruthenium', 6 * MIB));
    const relpath = 'preserve/keep.jsonl';
    expect((await multipartStore('preserve-box', 'claude', relpath, v1, 5 * MIB)).complete!.status).toBe(201);
    const v1Hash = await sha256Hex(v1);

    // Now a NEW upload for the same path whose parts don't hash to the declared hash: create with the
    // (correct) v2 hash but upload v1's bytes as the parts. Complete must 422 AND leave canonical = v1.
    const v2 = new Uint8Array(6 * MIB).fill(200);
    const v2Hash = await sha256Hex(v2);
    const cr = await createMp('preserve-box', 'claude', relpath, v2.length, v2Hash);
    const { upload_id } = await cr.json<any>();
    // upload v1's bytes (5MiB + remainder) under the v2 upload
    const p1 = await putPart('preserve-box', 'claude', relpath, upload_id, 1, v1.subarray(0, 5 * MIB), 5 * MIB, false);
    const p2 = await putPart('preserve-box', 'claude', relpath, upload_id, 2, v1.subarray(5 * MIB), 5 * MIB, true);
    const parts = [await p1.json<any>(), await p2.json<any>()].map((j) => ({ part_number: j.part_number, etag: j.etag }));
    const comp = await completeMp('preserve-box', 'claude', relpath, upload_id, parts, v2Hash, v2.length);
    expect(comp.status).toBe(422);

    // The previous canonical object (v1) is byte-identical and intact — the backup was NOT destroyed.
    const canonical = await testEnv.RAW.get(`raw/preserve-box/claude/${relpath}`);
    expect(await sha256Hex(new Uint8Array(await canonical!.arrayBuffer()))).toBe(v1Hash);
    // And no staging object was left behind (keys are upload-unique, so list the prefix).
    const staging = await testEnv.RAW.list({ prefix: 'mpu-staging/preserve-box/' });
    expect(staging.objects).toHaveLength(0);
  });

  it('canonical is not overwritten until verification passes: an in-flight upload leaves the old object', async () => {
    const v1 = new Uint8Array(6 * MIB).fill(11);
    const v1Hash = await sha256Hex(v1);
    const relpath = 'staging/vis.bin';
    expect((await multipartStore('vis-box', 'claude', relpath, v1, 5 * MIB)).complete!.status).toBe(201);

    // Open a new upload and push a part, but do NOT complete — canonical must still be v1.
    const v2 = new Uint8Array(6 * MIB).fill(22);
    const cr = await createMp('vis-box', 'claude', relpath, v2.length, await sha256Hex(v2));
    const { upload_id } = await cr.json<any>();
    await putPart('vis-box', 'claude', relpath, upload_id, 1, v2.subarray(0, 5 * MIB), 5 * MIB, false);

    const mid = await testEnv.RAW.get(`raw/vis-box/claude/${relpath}`);
    expect(await sha256Hex(new Uint8Array(await mid!.arrayBuffer()))).toBe(v1Hash); // still the old bytes
    await abortMp('vis-box', 'claude', relpath, upload_id);
  });

  it('CONCURRENCY: two overlapping uploads for the same path both complete with independent staging', async () => {
    const relpath = 'race/same.bin';
    const a = new Uint8Array(6 * MIB).fill(0xa1);
    const b = new Uint8Array(6 * MIB).fill(0xb2);
    const aHash = await sha256Hex(a);
    const bHash = await sha256Hex(b);

    // Two independent multipart uploads for the SAME machine/store/relpath.
    const tokA = (await (await createMp('race-box', 'claude', relpath, a.length, aHash)).json<any>()).upload_id as string;
    const tokB = (await (await createMp('race-box', 'claude', relpath, b.length, bHash)).json<any>()).upload_id as string;
    // Upload-unique staging: the two tokens carry different nonces, so their staging keys differ.
    expect(tokA.split('.')[0]).not.toBe(tokB.split('.')[0]);

    const partsFor = async (tok: string, bytes: Uint8Array) => {
      const p1 = await putPart('race-box', 'claude', relpath, tok, 1, bytes.subarray(0, 5 * MIB), 5 * MIB, false);
      const p2 = await putPart('race-box', 'claude', relpath, tok, 2, bytes.subarray(5 * MIB), 5 * MIB, true);
      return [await p1.json<any>(), await p2.json<any>()].map((j) => ({ part_number: j.part_number, etag: j.etag }));
    };
    const partsA = await partsFor(tokA, a);
    const partsB = await partsFor(tokB, b);

    // Complete both CONCURRENTLY. With a shared staging key, one request's read/copy/delete could
    // clobber the other's completed staging object (500/422); upload-unique keys keep them independent.
    const [rA, rB] = await Promise.all([
      completeMp('race-box', 'claude', relpath, tokA, partsA, aHash, a.length),
      completeMp('race-box', 'claude', relpath, tokB, partsB, bHash, b.length),
    ]);
    expect(rA.status, 'complete A').toBe(201);
    expect(rB.status, 'complete B').toBe(201);

    // Canonical holds one of the two verified objects (last writer wins), byte-exact — not a mix.
    const canonical = await testEnv.RAW.get(`raw/race-box/claude/${relpath}`);
    const canonHash = await sha256Hex(new Uint8Array(await canonical!.arrayBuffer()));
    expect([aHash, bHash]).toContain(canonHash);
    // The D1 row settled on one of the two valid uploads, not a corrupt/half state.
    const row = await testEnv.DB.prepare(
      'SELECT content_hash FROM files WHERE machine_id = ?1 AND store = ?2 AND relpath = ?3',
    )
      .bind('race-box', 'claude', relpath)
      .first<{ content_hash: string }>();
    expect([aHash, bHash]).toContain(row!.content_hash);
    // Neither upload left a staging object behind.
    const staging = await testEnv.RAW.list({ prefix: 'mpu-staging/race-box/' });
    expect(staging.objects).toHaveLength(0);
  });

  it('handles a near-limit relpath: fixed-shape staging key keeps create + complete under R2 key limit', async () => {
    // A canonical raw/ key that fits under R2's 1024-byte object-key limit, but whose relpath is long
    // enough that the OLD verbatim staging key (mpu-staging/<m>/<store>/<relpath>.<uuid>) would cross
    // it — so create would 400 exactly for a long-but-valid path once it goes multipart. The hashed
    // fixed-shape staging key stays short regardless, so both create and complete succeed.
    const relpath = 'deep/' + 'x'.repeat(980) + '.bin';
    expect(`raw/longpath-box/claude/${relpath}`.length).toBeLessThan(1024);
    const bytes = new Uint8Array(6 * MIB).fill(7);
    const res = await multipartStore('longpath-box', 'claude', relpath, bytes, 5 * MIB);
    expect(res.createStatus).toBe(201);
    expect(res.complete!.status).toBe(201);
    const canonical = await testEnv.RAW.get(`raw/longpath-box/claude/${relpath}`);
    expect(await sha256Hex(new Uint8Array(await canonical!.arrayBuffer()))).toBe(await sha256Hex(bytes));
  });

  it('rejects a create for a file larger than R2 single-put finalize limit (5 GiB)', async () => {
    const res = await SELF.fetch(`${fileUrl('big-box', 'claude', 'huge.bin')}?uploads`, {
      method: 'POST',
      headers: {
        'x-dev-machine': 'big-box',
        'x-content-hash': `sha256:${'a'.repeat(64)}`,
        'x-file-size': String(5 * 1024 * 1024 * 1024 + 1),
      },
    });
    expect(res.status).toBe(400);
    expect((await res.json<any>()).error).toBe('file_too_large');
  });

  it('create re-opens a fresh upload (not unchanged) when the same-hash R2 object is missing/corrupt', async () => {
    const bytes = new Uint8Array(6 * MIB).fill(6);
    const hash = await sha256Hex(bytes);
    const relpath = 'reopen/mp.bin';
    expect((await multipartStore('reopen-box', 'claude', relpath, bytes, 5 * MIB)).complete!.status).toBe(201);

    // Same-hash create while the object is present -> unchanged short-circuit.
    const unchanged = await createMp('reopen-box', 'claude', relpath, bytes.length, hash);
    expect(unchanged.status).toBe(200);

    // Now the raw object is lost. A same-hash create must NOT short-circuit — it must reopen so the
    // collector can re-send the parts and repair R2 (large-file analog of the simple PUT body repair).
    await testEnv.RAW.delete(`raw/reopen-box/claude/${relpath}`);
    const reopened = await createMp('reopen-box', 'claude', relpath, bytes.length, hash);
    expect(reopened.status).toBe(201);
    expect((await reopened.json<any>()).status).toBe('created');
  });

  it('convergeMultipartRow realigns changed bytes without releasing a live cleanup reservation', async () => {
    // Simulate the interleaved end state of two changed-hash completes: the D1 row carries hash HA and
    // a stale size, but R2's object at the key is the OTHER writer's (native checksum HB, different size).
    const key = 'raw/converge-box/claude/c.bin';
    const HA = 'a'.repeat(64);
    const otherBytes = new Uint8Array(64).fill(9); // the surviving R2 object's bytes
    const HB = await sha256Hex(otherBytes);
    await testEnv.DB.prepare("INSERT INTO machines (machine_id, os) VALUES ('converge-box','linux') ON CONFLICT (machine_id) DO NOTHING").run();
    const row = await testEnv.DB.prepare(
      `INSERT INTO files (machine_id, store, relpath, r2_key, size, mtime, content_hash, parse_state)
       VALUES ('converge-box','claude','c.bin',?1, 10, '2026-07-01T00:00:00Z', ?2, 'parsed') RETURNING id`,
    )
      .bind(key, HA)
      .first<{ id: number }>();
    await testEnv.DB.prepare(
      "UPDATE files SET parse_state = 'reserved', reserved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), reserved_by = ?1, reserved_reason = 'recover' WHERE id = ?1",
    )
      .bind(row!.id)
      .run();
    await testEnv.DB.prepare(
      "INSERT INTO sessions (session_id, harness, machine_id, canonical_file_id, index_state) VALUES ('converge-owned-session', 'claude-export', 'converge-box', ?1, 'ready')",
    )
      .bind(row!.id)
      .run();
    // R2 holds the OTHER upload's object with a NATIVE checksum (put({sha256})), size 64, mtime differs.
    await testEnv.RAW.put(key, otherBytes, { sha256: HB, customMetadata: { mtime: '2026-07-02T00:00:00Z' } });

    const converged = await convergeMultipartRow(row!.id, key, HA, testEnv);
    expect(converged).toBe(true);
    const after = await testEnv.DB.prepare('SELECT content_hash, parse_state, mtime, size, reserved_at, reserved_by, reserved_reason FROM files WHERE id = ?1')
      .bind(row!.id)
      .first<{ content_hash: string; parse_state: string; mtime: string; size: number; reserved_at: string | null; reserved_by: number | null; reserved_reason: string | null }>();
    expect(after!.content_hash).toBe(HB); // row now describes what R2 actually holds
    expect(after!.parse_state).toBe('reserved'); // owner-tagged send-late retains cleanup ordering
    expect(after!.mtime).toBe('2026-07-02T00:00:00Z');
    expect(after!.size).toBe(otherBytes.length); // size realigned (chooseCanonical orders by size DESC)
    expect(after!.reserved_at).not.toBeNull();
    expect(after!.reserved_by).toBe(row!.id);
    expect(after!.reserved_reason).toBe('upload');
    const session = await testEnv.DB.prepare('SELECT index_state FROM sessions WHERE session_id = ?1')
      .bind('converge-owned-session')
      .first<{ index_state: string }>();
    expect(session?.index_state).toBe('parsing');

    // Positive control: when R2 already matches the row, convergence is a no-op.
    const noop = await convergeMultipartRow(row!.id, key, HB, testEnv);
    expect(noop).toBe(false);
  });

  // Capture every parse-queue message recordUploadedObject (and the convergence it calls) emits, so we
  // can assert exactly which content_hash gets enqueued — the ordering the round-5 fix is about.
  async function withSendSpy<T>(fn: (sends: Array<{ content_hash: string }>) => Promise<T>): Promise<T> {
    const q = testEnv.PARSE_QUEUE as any;
    const orig = q.send.bind(q);
    const sends: Array<{ content_hash: string }> = [];
    q.send = async (msg: any, o?: any) => { sends.push(msg); return orig(msg, o); };
    try {
      return await fn(sends);
    } finally {
      q.send = orig;
    }
  }

  function recordMultipartOpts(machineId: string, relpath: string, sha256: string, size: number) {
    return {
      machineId, store: 'claude', relpath, r2Key: `raw/${machineId}/claude/${relpath}`,
      size, mtime: '2026-07-01T00:00:00Z', sha256, existed: false,
      convergeBody: null, convergeObservedR2: true,
    };
  }

  async function ensureMachine(machineId: string): Promise<void> {
    await testEnv.DB.prepare(
      "INSERT INTO machines (machine_id, os) VALUES (?1, 'linux') ON CONFLICT (machine_id) DO NOTHING",
    ).bind(machineId).run();
  }

  it('ORDERING non-race: converge sees a matching R2 object, exactly one parse message with our sha', async () => {
    const bytes = new Uint8Array(32).fill(3);
    const sha = await sha256Hex(bytes);
    const relpath = 'order/11111111-1111-4111-8111-111111111111.jsonl';
    // R2 already holds OUR object (native checksum == sha): convergence must be a no-op.
    await ensureMachine('order-box');
    await testEnv.RAW.put(`raw/order-box/claude/${relpath}`, bytes, { sha256: sha });

    const sends = await withSendSpy(async (s) => {
      await recordUploadedObject(testEnv, recordMultipartOpts('order-box', relpath, sha, bytes.length));
      return s;
    });
    expect(sends).toHaveLength(1); // reorder didn't break the happy path
    expect(sends[0]!.content_hash).toBe(sha);
  });

  it('ORDERING race: R2 holds sha B while the row upsert carried sha A — never enqueue A, enqueue B', async () => {
    const bytesB = new Uint8Array(48).fill(7);
    const shaB = await sha256Hex(bytesB);
    const shaA = 'a'.repeat(64); // this upload's declared hash — but R2 holds B (the other racer's object)
    const relpath = 'order/22222222-2222-4222-8222-222222222222.jsonl';
    await ensureMachine('race2-box');
    await testEnv.RAW.put(`raw/race2-box/claude/${relpath}`, bytesB, { sha256: shaB });

    const sends = await withSendSpy(async (s) => {
      await recordUploadedObject(testEnv, recordMultipartOpts('race2-box', relpath, shaA, 10));
      return s;
    });
    // The stale-sha (A) message is NEVER emitted; the only parse enqueued carries the surviving R2 hash B.
    expect(sends.map((m) => m.content_hash)).not.toContain(shaA);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.content_hash).toBe(shaB);
    // Row was realigned to what R2 actually holds.
    const row = await testEnv.DB.prepare('SELECT content_hash FROM files WHERE machine_id = ?1 AND relpath = ?2')
      .bind('race2-box', relpath)
      .first<{ content_hash: string }>();
    expect(row!.content_hash).toBe(shaB);
  });

  it('ORDERING converge-throws: no parse message is enqueued (queue retry / next complete repairs)', async () => {
    const relpath = 'order/33333333-3333-4333-8333-333333333333.jsonl';
    const shaA = 'c'.repeat(64);
    await ensureMachine('throw-box');
    await testEnv.RAW.put(`raw/throw-box/claude/${relpath}`, new Uint8Array(16).fill(5)); // head() is stubbed to throw before any checksum read

    const realHead = testEnv.RAW.head.bind(testEnv.RAW);
    (testEnv.RAW as any).head = async () => { throw new Error('boom'); };
    try {
      const sends = await withSendSpy(async (s) => {
        await expect(recordUploadedObject(testEnv, recordMultipartOpts('throw-box', relpath, shaA, 16))).rejects.toThrow('boom');
        return s;
      });
      expect(sends).toHaveLength(0); // converge threw before the send — nothing enqueued
    } finally {
      (testEnv.RAW as any).head = realHead;
    }
  });

  it('prune sweeps stale staging objects but never touches canonical raw/ data', async () => {
    const stagingKey = 'mpu-staging/prune-box/claude/leaked.bin';
    const canonicalKey = 'raw/prune-box/claude/keep.bin';
    await testEnv.RAW.put(stagingKey, new Uint8Array(8).fill(1));
    await testEnv.RAW.put(canonicalKey, new Uint8Array(8).fill(2));

    // Run with "now" 8 days in the future so the just-written staging object counts as stale.
    await runPrune(testEnv, Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(await testEnv.RAW.head(stagingKey)).toBeNull(); // swept
    expect(await testEnv.RAW.head(canonicalKey)).not.toBeNull(); // raw/ data untouched

    // A fresh staging object survives a present-time prune.
    const fresh = 'mpu-staging/prune-box/claude/fresh.bin';
    await testEnv.RAW.put(fresh, new Uint8Array(8).fill(3));
    await runPrune(testEnv);
    expect(await testEnv.RAW.head(fresh)).not.toBeNull();
    await testEnv.RAW.delete(fresh);
  });
});
