import { SELF, env as testEnvRaw } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { EXPORT_CONVERSATIONS_PER_INVOCATION } from '../src/ingest/consumer';
import { claudeExportZip, type ClaudeConvOpts } from './web-fixtures';

const testEnv = testEnvRaw as unknown as Env;
const CHUNK = EXPORT_CONVERSATIONS_PER_INVOCATION;

// Capture continuation re-enqueues so we can deliver them one slice at a time and assert the file is
// never 'parsed' until the LAST slice lands.
const sent: ParseMessage[] = [];
beforeAll(() => {
  const real = testEnv.PARSE_QUEUE.send.bind(testEnv.PARSE_QUEUE);
  testEnv.PARSE_QUEUE.send = (async (msg: ParseMessage) => {
    sent.push(msg);
    return real(msg);
  }) as typeof testEnv.PARSE_QUEUE.send;
});

async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function conv(tag: string, i: number): ClaudeConvOpts {
  return {
    uuid: `bnd-${tag}-conv-${i}`,
    name: `Conversation ${i}`,
    messages: [
      { uuid: `${tag}-${i}h`, parent: '00000000-0000-4000-8000-000000000000', sender: 'human', text: `question ${i}` },
      { uuid: `${tag}-${i}a`, parent: `${tag}-${i}h`, sender: 'assistant', text: `answer ${i}` },
    ],
  };
}

async function deliver(body: ParseMessage): Promise<void> {
  await worker.queue(
    {
      queue: 'parse',
      messages: [{ id: String(body.file_id), timestamp: new Date(), attempts: 1, body, ack() {}, retry() {} }],
      ackAll() {},
      retryAll() {},
    } as unknown as MessageBatch<ParseMessage>,
    testEnv,
  );
}

async function fileState(id: number): Promise<string> {
  const r = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1').bind(id).first<{ parse_state: string }>();
  return r!.parse_state;
}

async function ownedSessions(fileId: number): Promise<number> {
  const r = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE canonical_file_id = ?1').bind(fileId).first<{ n: number }>();
  return r!.n;
}

async function uploadArchive(tag: string, convs: number): Promise<{ fileId: number; hash: string; r2Key: string }> {
  const zip = claudeExportZip(Array.from({ length: convs }, (_u, i) => conv(tag, i)));
  const hash = await sha256Hex(zip);
  const relpath = `claude-export-${tag}.zip`;
  const machine = `bnd-${tag}`;
  const res = await SELF.fetch(`https://api.sessions.vza.net/api/v1/files/${machine}/export-inbox/${encodeURIComponent(relpath)}`, {
    method: 'PUT',
    headers: {
      'x-dev-machine': machine,
      'x-content-hash': `sha256:${hash}`,
      'x-file-mtime': '2026-07-01T12:00:00Z',
      'content-length': String(zip.length),
    },
    body: zip,
  });
  expect(res.status).toBe(201);
  const row = await testEnv.DB.prepare('SELECT id, r2_key, content_hash FROM files WHERE machine_id = ?1 AND relpath = ?2')
    .bind(machine, relpath)
    .first<{ id: number; r2_key: string; content_hash: string }>();
  return { fileId: row!.id, hash: row!.content_hash, r2Key: row!.r2_key };
}

describe('large export ingest is bounded and never marks parsed until every conversation is written', () => {
  it('writes the archive in bounded slices; the file stays pending until the FINAL slice (silent-gap guard)', async () => {
    // 2.5 chunks so there are two intermediate slices and one final slice.
    const total = CHUNK * 2 + Math.floor(CHUNK / 2);
    const { fileId, hash, r2Key } = await uploadArchive('a', total);

    // The upload enqueued the initial parse (offset 0). Deliver it: one slice only.
    sent.length = 0;
    await deliver({ file_id: fileId, r2_key: r2Key, reason: 'upload', content_hash: hash });

    // POSITIVE CONTROL for the silent-data-gap bug: after a NON-final slice the file must NOT be
    // 'parsed' (it is still 'pending'), and only one chunk of conversations has been written. If
    // markParsed ran per-slice instead of only on the final slice, this would read 'parsed'.
    expect(await fileState(fileId)).toBe('pending');
    expect(await ownedSessions(fileId)).toBe(CHUNK);
    // It re-enqueued a continuation advancing the offset, rather than finishing.
    const cont1 = sent.find((m) => m.file_id === fileId && m.offset === CHUNK);
    expect(cont1).toBeDefined();

    // Deliver the second (still non-final) slice.
    sent.length = 0;
    await deliver(cont1!);
    expect(await fileState(fileId)).toBe('pending'); // STILL not parsed with the archive partially written
    expect(await ownedSessions(fileId)).toBe(CHUNK * 2);
    const cont2 = sent.find((m) => m.file_id === fileId && m.offset === CHUNK * 2);
    expect(cont2).toBeDefined();

    // Deliver the final slice → now, and only now, the file is 'parsed' with the WHOLE archive written.
    sent.length = 0;
    await deliver(cont2!);
    expect(await fileState(fileId)).toBe('parsed');
    expect(await ownedSessions(fileId)).toBe(total);
    // No further continuation was enqueued.
    expect(sent.find((m) => m.file_id === fileId && typeof m.offset === 'number')).toBeUndefined();

    // Every conversation is searchable — proving the fan-out completed, not just the file flag.
    const search = await SELF.fetch('https://api.sessions.vza.net/api/v1/search?q=answer', { headers: { 'x-dev-machine': 'bndbox' } });
    const hits = ((await search.json()) as { hits: unknown[] }).hits;
    expect(hits.length).toBeGreaterThan(0);
  });

  it('a run whose continuation never arrives leaves the file pending, never parsed (incomplete ≠ parsed)', async () => {
    const total = CHUNK + 5; // one intermediate slice + a final slice
    const { fileId, hash, r2Key } = await uploadArchive('b', total);

    sent.length = 0;
    await deliver({ file_id: fileId, r2_key: r2Key, reason: 'upload', content_hash: hash });

    // Simulate the continuation being dropped (crash / lost message): we simply never deliver cont.
    // The file must remain 'pending' — a partially-written archive is NOT 'parsed'.
    expect(await fileState(fileId)).toBe('pending');
    expect(await ownedSessions(fileId)).toBe(CHUNK); // only the first slice landed
    // The system did try to continue (a continuation was enqueued) — it's the *completion* that's
    // gated on all slices, not the attempt.
    expect(sent.some((m) => m.file_id === fileId && m.offset === CHUNK)).toBe(true);
  });

  it('processes at most ONE export slice per invocation; a second export message is retried untouched (round 1 finding 1)', async () => {
    // Two export files delivered in ONE batch (max_batch_size:5 in prod). Each slice is ~500 D1
    // queries; running both in one invocation would breach the ~1000/invocation cap. Only the first
    // must run; the second must be retried without any writes.
    const f1 = await uploadArchive('one', 3);
    const f2 = await uploadArchive('two', 3);

    const flags: Record<number, { acked: boolean; retried: boolean }> = {
      [f1.fileId]: { acked: false, retried: false },
      [f2.fileId]: { acked: false, retried: false },
    };
    const mk = (f: { fileId: number; hash: string; r2Key: string }) => ({
      id: String(f.fileId),
      timestamp: new Date(),
      attempts: 1,
      body: { file_id: f.fileId, r2_key: f.r2Key, reason: 'upload' as const, content_hash: f.hash },
      ack() {
        flags[f.fileId]!.acked = true;
      },
      retry() {
        flags[f.fileId]!.retried = true;
      },
    });
    await worker.queue(
      { queue: 'parse', messages: [mk(f1), mk(f2)], ackAll() {}, retryAll() {} } as unknown as MessageBatch<ParseMessage>,
      testEnv,
    );

    // First export message ran to completion; second was deferred (retried) with zero writes.
    expect(flags[f1.fileId]).toEqual({ acked: true, retried: false });
    expect(flags[f2.fileId]).toEqual({ acked: false, retried: true });
    expect(await fileState(f1.fileId)).toBe('parsed');
    expect(await ownedSessions(f1.fileId)).toBe(3);
    expect(await fileState(f2.fileId)).toBe('pending'); // untouched — redelivers next invocation
    expect(await ownedSessions(f2.fileId)).toBe(0);
  });

  it('reverts a slice whose file bytes change mid-write; no continuation, not parsed (round 1 finding 2)', async () => {
    const total = CHUNK + 5; // multi-slice so a continuation would normally follow slice 1
    const { fileId, hash, r2Key } = await uploadArchive('hr', total);

    // Make the POST-write content_hash recheck observe a mismatch while the PRE-write check still
    // matched — i.e. a re-upload landed DURING the slice. The two rechecks are the only two uses of
    // this exact SQL; return the real (matching) hash on the 1st, a changed hash on the 2nd.
    const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
    let recheckCalls = 0;
    testEnv.DB.prepare = ((sql: string) => {
      const stmt = realPrepare(sql);
      if (sql !== 'SELECT content_hash FROM files WHERE id = ?1') return stmt;
      const realBind = stmt.bind.bind(stmt);
      stmt.bind = (...a: unknown[]) => {
        const bound = realBind(...a);
        const realFirst = bound.first.bind(bound);
        (bound as unknown as Record<string, unknown>).first = async (...x: unknown[]) => {
          recheckCalls++;
          if (recheckCalls >= 2) return { content_hash: 'sha256:changed-mid-slice' };
          return (realFirst as (...y: unknown[]) => unknown)(...x);
        };
        return bound;
      };
      return stmt;
    }) as typeof testEnv.DB.prepare;

    sent.length = 0;
    try {
      await deliver({ file_id: fileId, r2_key: r2Key, reason: 'upload', content_hash: hash });
    } finally {
      testEnv.DB.prepare = realPrepare as typeof testEnv.DB.prepare;
    }

    // Slice 1's sessions were reverted to 'parsing' (not left 'ready' over stale bytes); the file is
    // NOT parsed and NO continuation was enqueued — the fresh parse will own the whole archive.
    expect(await fileState(fileId)).toBe('pending');
    const ready = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE canonical_file_id = ?1 AND index_state = 'ready'").bind(fileId).first<{ n: number }>();
    expect(ready!.n).toBe(0);
    const parsing = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE canonical_file_id = ?1 AND index_state = 'parsing'").bind(fileId).first<{ n: number }>();
    expect(parsing!.n).toBe(CHUNK); // the whole slice reverted
    expect(sent.some((m) => m.file_id === fileId && typeof m.offset === 'number')).toBe(false); // no continuation
  });

  it('a continuation-enqueue failure reverts the slice and never leaves partial ready rows (round 1 finding 3)', async () => {
    const total = CHUNK + 5;
    const { fileId, hash, r2Key } = await uploadArchive('cf', total);

    // Make the continuation send throw. parseExportInto must revert this slice's writes and rethrow,
    // so the generic consumer catch marks the file 'error' — never terminal with partial 'ready' rows.
    const realSend = testEnv.PARSE_QUEUE.send;
    testEnv.PARSE_QUEUE.send = (async () => {
      throw new Error('queue send failed');
    }) as typeof testEnv.PARSE_QUEUE.send;
    try {
      await deliver({ file_id: fileId, r2_key: r2Key, reason: 'upload', content_hash: hash });
    } finally {
      testEnv.PARSE_QUEUE.send = realSend;
    }

    expect(await fileState(fileId)).toBe('error'); // generic catch marked it; NOT 'parsed'
    const ready = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE canonical_file_id = ?1 AND index_state = 'ready'").bind(fileId).first<{ n: number }>();
    expect(ready!.n).toBe(0); // no partial 'ready' rows survived the failed slice
  });
});
