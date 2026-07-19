import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { convergeMultipartRow, markKnownOtherSkipped } from '../src/api/upload';

const testEnv = env as unknown as Env;
const STORE = 'claude-backup-archives';
const PART_SIZE = 5 * 1024 * 1024;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fileUrl(machine: string, relpath: string): string {
  return `https://api.sessions.vza.net/api/v1/files/${machine}/${STORE}/${encodeURIComponent(relpath)}`;
}

async function put(machine: string, relpath: string, bytes: Uint8Array): Promise<Response> {
  return SELF.fetch(fileUrl(machine, relpath), {
    method: 'PUT',
    headers: {
      'x-dev-machine': machine,
      'x-content-hash': `sha256:${await sha256Hex(bytes)}`,
      'x-file-mtime': '2026-07-19T12:00:00Z',
      'content-length': String(bytes.length),
    },
    body: bytes as BufferSource,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("known 'other' files bypass the parse queue", () => {
  it('persists simple uploads in R2+D1 as skipped and keeps same-hash restore/change retries queue-free', async () => {
    const machine = 'other-simple-box';
    const relpath = 'archives/original.7z';
    const original = new TextEncoder().encode('preserved archive bytes v1');
    const changed = new TextEncoder().encode('preserved archive bytes v2');
    const sendSpy = vi.spyOn(testEnv.PARSE_QUEUE, 'send');

    const first = await put(machine, relpath, original);
    expect(first.status).toBe(201);
    const fileId = (await first.json<{ file_id: number }>()).file_id;
    const r2Key = `raw/${machine}/${STORE}/${relpath}`;

    expect(await (await testEnv.RAW.get(r2Key))?.text()).toBe('preserved archive bytes v1');
    expect(
      await testEnv.DB.prepare(
        'SELECT parse_state, harness, session_id, content_hash FROM files WHERE id = ?1',
      )
        .bind(fileId)
        .first(),
    ).toMatchObject({ parse_state: 'skipped', harness: 'unknown', session_id: null, content_hash: await sha256Hex(original) });
    expect(sendSpy).not.toHaveBeenCalled();

    const unchanged = await put(machine, relpath, original);
    expect(unchanged.status).toBe(200);
    expect(await unchanged.json()).toMatchObject({ status: 'unchanged', skipped: true, restored: false });
    expect(sendSpy).not.toHaveBeenCalled();

    await testEnv.RAW.delete(r2Key);
    const restored = await put(machine, relpath, original);
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ status: 'unchanged', skipped: true, restored: true });
    expect(await (await testEnv.RAW.get(r2Key))?.text()).toBe('preserved archive bytes v1');
    expect(sendSpy).not.toHaveBeenCalled();

    const updated = await put(machine, relpath, changed);
    expect(updated.status).toBe(201);
    expect(await (await testEnv.RAW.get(r2Key))?.text()).toBe('preserved archive bytes v2');
    expect(
      await testEnv.DB.prepare('SELECT parse_state, content_hash FROM files WHERE id = ?1').bind(fileId).first(),
    ).toMatchObject({ parse_state: 'skipped', content_hash: await sha256Hex(changed) });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('refreshes the owner-tagged delivery when changed other bytes land under a fresh export reservation', async () => {
    const machine = 'other-reserved-box';
    const relpath = 'archives/reserved.7z';
    const original = new TextEncoder().encode('reserved archive bytes v1');
    const changed = new TextEncoder().encode('reserved archive bytes v2');
    const changedHash = await sha256Hex(changed);
    const sendSpy = vi.spyOn(testEnv.PARSE_QUEUE, 'send');

    const first = await put(machine, relpath, original);
    const fileId = (await first.json<{ file_id: number }>()).file_id;
    const owner = await testEnv.DB.prepare(
      `INSERT INTO files (machine_id, store, relpath, r2_key, size, content_hash, harness, parse_state)
       VALUES (?1, 'export-inbox', 'claude-export-reservation-owner.zip', ?2, 1, ?3, 'claude-web', 'pending')
       RETURNING id`,
    )
      .bind(machine, `raw/${machine}/export-inbox/claude-export-reservation-owner.zip`, 'a'.repeat(64))
      .first<{ id: number }>();
    await testEnv.DB.prepare(
      `UPDATE files SET parse_state = 'reserved',
         reserved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), reserved_by = ?2,
         reserved_reason = 'recover', reservation_generation = 41
       WHERE id = ?1`,
    )
      .bind(fileId, owner!.id)
      .run();
    sendSpy.mockClear();

    const updated = await put(machine, relpath, changed);
    expect(updated.status).toBe(201);
    expect(sendSpy).toHaveBeenCalledOnce();
    expect(sendSpy).toHaveBeenCalledWith({
      file_id: fileId,
      r2_key: `raw/${machine}/${STORE}/${relpath}`,
      reason: 'upload',
      content_hash: changedHash,
      reservation_owner: owner!.id,
      reservation_generation: 41,
    });
    expect(
      await testEnv.DB.prepare(
        'SELECT parse_state, content_hash, reserved_by, reserved_reason, reservation_generation FROM files WHERE id = ?1',
      )
        .bind(fileId)
        .first(),
    ).toEqual({
      parse_state: 'reserved',
      content_hash: changedHash,
      reserved_by: owner!.id,
      reserved_reason: 'upload',
      reservation_generation: 41,
    });

    sendSpy.mockClear();
    const retried = await put(machine, relpath, changed);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ status: 'unchanged', requeued: true, restored: false });
    expect(sendSpy).toHaveBeenCalledOnce();
    expect(sendSpy).toHaveBeenCalledWith({
      file_id: fileId,
      r2_key: `raw/${machine}/${STORE}/${relpath}`,
      reason: 'upload',
      content_hash: changedHash,
      reservation_owner: owner!.id,
      reservation_generation: 41,
    });

    sendSpy.mockClear();
    const multipartRetried = await SELF.fetch(`${fileUrl(machine, relpath)}?uploads`, {
      method: 'POST',
      headers: {
        'x-dev-machine': machine,
        'x-content-hash': `sha256:${changedHash}`,
        'x-file-size': String(changed.length),
      },
    });
    expect(multipartRetried.status).toBe(200);
    expect(await multipartRetried.json()).toMatchObject({ status: 'unchanged', requeued: true });
    expect(sendSpy).toHaveBeenCalledOnce();
    expect(sendSpy).toHaveBeenCalledWith({
      file_id: fileId,
      r2_key: `raw/${machine}/${STORE}/${relpath}`,
      reason: 'upload',
      content_hash: changedHash,
      reservation_owner: owner!.id,
      reservation_generation: 41,
    });

    sendSpy.mockClear();
    const checked = await SELF.fetch('https://api.sessions.vza.net/api/v1/files/check', {
      method: 'POST',
      headers: { 'x-dev-machine': machine, 'content-type': 'application/json' },
      body: JSON.stringify({ files: [{ store: STORE, relpath, sha256: `sha256:${changedHash}` }] }),
    });
    expect(checked.status).toBe(200);
    expect(await checked.json()).toEqual({ missing: [] });
    expect(sendSpy).toHaveBeenCalledOnce();
    expect(sendSpy).toHaveBeenCalledWith({
      file_id: fileId,
      r2_key: `raw/${machine}/${STORE}/${relpath}`,
      reason: 'upload',
      content_hash: changedHash,
      reservation_owner: owner!.id,
      reservation_generation: 41,
    });
  });

  it('files/check heals a legacy non-terminal/stale-identity row directly to skipped without enqueueing', async () => {
    const machine = 'other-check-box';
    const relpath = 'archives/check.7z';
    const bytes = new TextEncoder().encode('checksum-verified archive');
    const hash = await sha256Hex(bytes);
    const first = await put(machine, relpath, bytes);
    const fileId = (await first.json<{ file_id: number }>()).file_id;

    await testEnv.DB.prepare(
      "UPDATE files SET parse_state = 'pending', harness = 'claude-code', session_id = 'stale-session', parse_error = 'old error' WHERE id = ?1",
    )
      .bind(fileId)
      .run();
    const sendSpy = vi.spyOn(testEnv.PARSE_QUEUE, 'send');

    const checked = await SELF.fetch('https://api.sessions.vza.net/api/v1/files/check', {
      method: 'POST',
      headers: { 'x-dev-machine': machine, 'content-type': 'application/json' },
      body: JSON.stringify({ files: [{ store: STORE, relpath, sha256: `sha256:${hash}` }] }),
    });
    expect(checked.status).toBe(200);
    expect(await checked.json()).toEqual({ missing: [] });
    expect(sendSpy).not.toHaveBeenCalled();
    expect(
      await testEnv.DB.prepare('SELECT parse_state, parse_error, harness, session_id FROM files WHERE id = ?1')
        .bind(fileId)
        .first(),
    ).toEqual({ parse_state: 'skipped', parse_error: null, harness: 'unknown', session_id: null });

    // A stale files/check/same-hash request must not terminalize a row after a concurrent upload
    // advanced it. The helper's hash guard makes the transition a no-op.
    const advancedHash = 'f'.repeat(64);
    await testEnv.DB.prepare("UPDATE files SET content_hash = ?2, parse_state = 'pending' WHERE id = ?1")
      .bind(fileId, advancedHash)
      .run();
    expect(await markKnownOtherSkipped(fileId, hash, testEnv)).toBe(false);
    expect(await testEnv.DB.prepare('SELECT parse_state, content_hash FROM files WHERE id = ?1').bind(fileId).first()).toEqual({
      parse_state: 'pending',
      content_hash: advancedHash,
    });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('multipart finalize and observed-R2 convergence remain skipped and queue-free', async () => {
    const machine = 'other-multipart-box';
    const relpath = 'archives/multipart.7z';
    const bytes = new TextEncoder().encode('small final multipart archive body');
    const hash = await sha256Hex(bytes);
    const sendSpy = vi.spyOn(testEnv.PARSE_QUEUE, 'send');

    const created = await SELF.fetch(`${fileUrl(machine, relpath)}?uploads`, {
      method: 'POST',
      headers: {
        'x-dev-machine': machine,
        'x-content-hash': `sha256:${hash}`,
        'x-file-size': String(bytes.length),
        'x-file-mtime': '2026-07-19T12:00:00Z',
      },
    });
    expect(created.status).toBe(201);
    const uploadId = (await created.json<{ upload_id: string }>()).upload_id;
    const part = await SELF.fetch(`${fileUrl(machine, relpath)}?uploadId=${encodeURIComponent(uploadId)}&partNumber=1`, {
      method: 'PUT',
      headers: {
        'x-dev-machine': machine,
        'x-part-size': String(PART_SIZE),
        'x-part-is-last': '1',
      },
      body: bytes as BufferSource,
    });
    expect(part.status).toBe(200);
    const partJson = await part.json<{ part_number: number; etag: string }>();
    const completed = await SELF.fetch(`${fileUrl(machine, relpath)}?uploadId=${encodeURIComponent(uploadId)}`, {
      method: 'POST',
      headers: {
        'x-dev-machine': machine,
        'content-type': 'application/json',
        'x-content-hash': `sha256:${hash}`,
        'x-file-size': String(bytes.length),
        'x-file-mtime': '2026-07-19T12:00:00Z',
      },
      body: JSON.stringify({ parts: [partJson] }),
    });
    expect(completed.status).toBe(201);
    const fileId = (await completed.json<{ file_id: number }>()).file_id;
    const r2Key = `raw/${machine}/${STORE}/${relpath}`;
    expect(await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1').bind(fileId).first()).toEqual({
      parse_state: 'skipped',
    });
    expect(sendSpy).not.toHaveBeenCalled();

    const again = await SELF.fetch(`${fileUrl(machine, relpath)}?uploads`, {
      method: 'POST',
      headers: {
        'x-dev-machine': machine,
        'x-content-hash': `sha256:${hash}`,
        'x-file-size': String(bytes.length),
      },
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ status: 'unchanged', skipped: true });
    expect(sendSpy).not.toHaveBeenCalled();

    const surviving = new TextEncoder().encode('different multipart writer survived');
    const survivingHash = await sha256Hex(surviving);
    await testEnv.RAW.put(r2Key, surviving, { sha256: survivingHash });
    expect(await convergeMultipartRow(fileId, r2Key, hash, testEnv, true)).toBe(true);
    expect(
      await testEnv.DB.prepare('SELECT parse_state, content_hash, size FROM files WHERE id = ?1').bind(fileId).first(),
    ).toMatchObject({ parse_state: 'skipped', content_hash: survivingHash, size: surviving.length });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('refreshes a reserved owner delivery when known-other multipart convergence changes the hash', async () => {
    const machine = 'other-multipart-reserved-box';
    const relpath = 'archives/multipart-reserved.7z';
    const original = new TextEncoder().encode('multipart reservation bytes v1');
    const surviving = new TextEncoder().encode('multipart reservation bytes v2');
    const originalHash = await sha256Hex(original);
    const survivingHash = await sha256Hex(surviving);
    const first = await put(machine, relpath, original);
    const fileId = (await first.json<{ file_id: number }>()).file_id;
    const r2Key = `raw/${machine}/${STORE}/${relpath}`;
    const owner = await testEnv.DB.prepare(
      `INSERT INTO files (machine_id, store, relpath, r2_key, size, content_hash, harness, parse_state)
       VALUES (?1, 'export-inbox', 'claude-export-multipart-owner.zip', ?2, 1, ?3, 'claude-web', 'pending')
       RETURNING id`,
    )
      .bind(machine, `raw/${machine}/export-inbox/claude-export-multipart-owner.zip`, 'b'.repeat(64))
      .first<{ id: number }>();
    await testEnv.DB.prepare(
      `UPDATE files SET parse_state = 'reserved',
         reserved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), reserved_by = ?2,
         reserved_reason = 'recover', reservation_generation = 17
       WHERE id = ?1`,
    )
      .bind(fileId, owner!.id)
      .run();
    await testEnv.RAW.put(r2Key, surviving, { sha256: survivingHash });
    const sendSpy = vi.spyOn(testEnv.PARSE_QUEUE, 'send');

    expect(await convergeMultipartRow(fileId, r2Key, originalHash, testEnv, true)).toBe(true);
    expect(sendSpy).toHaveBeenCalledOnce();
    expect(sendSpy).toHaveBeenCalledWith({
      file_id: fileId,
      r2_key: r2Key,
      reason: 'upload',
      content_hash: survivingHash,
      reservation_owner: owner!.id,
      reservation_generation: 17,
    });
    expect(
      await testEnv.DB.prepare(
        'SELECT parse_state, content_hash, reserved_by, reserved_reason, reservation_generation FROM files WHERE id = ?1',
      )
        .bind(fileId)
        .first(),
    ).toEqual({
      parse_state: 'reserved',
      content_hash: survivingHash,
      reserved_by: owner!.id,
      reserved_reason: 'upload',
      reservation_generation: 17,
    });
  });

  it('admin reindex recreates known-other rows as skipped and reports zero enqueued', async () => {
    const machine = 'other-reindex-box';
    const relpath = 'archives/reindex.7z';
    const r2Key = `raw/${machine}/${STORE}/${relpath}`;
    const bytes = new TextEncoder().encode('reindex archive bytes');
    const hash = await sha256Hex(bytes);
    await testEnv.RAW.put(r2Key, bytes, { sha256: hash, customMetadata: { mtime: '2026-07-19T12:00:00Z' } });
    const sendSpy = vi.spyOn(testEnv.PARSE_QUEUE, 'send');
    const sendBatchSpy = vi.spyOn(testEnv.PARSE_QUEUE, 'sendBatch');

    const response = await SELF.fetch('https://api.sessions.vza.net/api/v1/admin/reindex', {
      method: 'POST',
      headers: { 'x-dev-machine': machine, 'content-type': 'application/json' },
      body: JSON.stringify({ prefix: `raw/${machine}/${STORE}/` }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enqueued: 0, done: true });
    expect(sendSpy).not.toHaveBeenCalled();
    expect(sendBatchSpy).not.toHaveBeenCalled();
    expect(
      await testEnv.DB.prepare(
        'SELECT parse_state, harness, session_id, content_hash, size, mtime FROM files WHERE machine_id = ?1 AND store = ?2 AND relpath = ?3',
      )
        .bind(machine, STORE, relpath)
        .first(),
    ).toMatchObject({
      parse_state: 'skipped',
      harness: 'unknown',
      session_id: null,
      content_hash: hash,
      size: bytes.length,
      mtime: '2026-07-19T12:00:00Z',
    });
  });
});
