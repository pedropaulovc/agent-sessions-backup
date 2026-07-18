import { SELF, env as testEnvRaw } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { __setExportBudgetsForTest } from '../src/ingest/consumer';
import { CLAUDE_WEB_ROOT, claudeExportZip, claudeWebConversation, type ClaudeConvOpts, type ClaudeWebMessage } from './web-fixtures';

const testEnv = testEnvRaw as unknown as Env;

// The prod slice/invocation budgets (~800 subrequests) leave far too much headroom to trigger slicing,
// cleanup-chunking or deferral with tiny synthetic fixtures. So each test dials the SUBREQUEST budgets down
// via __setExportBudgetsForTest — small enough that a handful of 2-block conversations (~5 subrequests
// each) span multiple slices. `budgets()` resets ALL four knobs every call (so tests are order-independent
// no matter what the previous one set), with a small default a test overrides per case. afterAll restores
// prod values. NOTE: the cost accounting is SUBREQUESTS (each db.batch/.first/.run is ONE), not statements —
// see the counting-model note on writeSession; a 180-block conversation costs ~5 subrequests, not ~180.
const PROD_BUDGETS = { slice: 800, invocation: 800, ceiling: 700, cap: 900, normalReserve: 128 };
function budgets(o: { slice?: number; invocation?: number; ceiling?: number; cap?: number; normalReserve?: number } = {}): void {
  __setExportBudgetsForTest({ slice: 20, invocation: 20, ceiling: 700, cap: 900, normalReserve: 8, ...o });
}
afterAll(() => __setExportBudgetsForTest(PROD_BUDGETS));

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

// A conversation with `msgs` messages → ~msgs blocks. writeSession fans the blocks into ceil(blocks/90)
// INSERT batches, so its SUBREQUEST cost is 3 + ceil(blocks/90) — a 200-block conversation is ~6
// subrequests, NOT ~200. Used to exercise the oversized-conversation ceiling/cap and to prove the slice
// budget counts subrequests, not statements.
function heavyConv(tag: string, i: number, msgs: number): ClaudeConvOpts {
  const messages: ClaudeWebMessage[] = [];
  let parent = '00000000-0000-4000-8000-000000000000';
  for (let m = 0; m < msgs; m++) {
    const uuid = `${tag}-${i}-m${m}`;
    messages.push({ uuid, parent, sender: m % 2 === 0 ? 'human' : 'assistant', text: `msg ${m} of conv ${i}` });
    parent = uuid;
  }
  return { uuid: `bnd-${tag}-conv-${i}`, name: `Heavy ${i}`, messages };
}

/** Make the Nth DB.batch call throw once (simulating a D1 error / cap hit mid-write-loop); returns a restore fn. */
function throwOnNthBatch(n: number): () => void {
  const real = testEnv.DB.batch.bind(testEnv.DB);
  let calls = 0;
  testEnv.DB.batch = (async (stmts: unknown[]) => {
    calls += 1;
    if (calls === n) throw new Error('injected D1 failure mid-slice');
    return real(stmts as never);
  }) as typeof testEnv.DB.batch;
  return () => {
    testEnv.DB.batch = real;
  };
}

async function readyCount(fileId: number): Promise<number> {
  const r = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE canonical_file_id = ?1 AND index_state = 'ready'").bind(fileId).first<{ n: number }>();
  return r!.n;
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

async function uploadConvs(tag: string, convs: ClaudeConvOpts[]): Promise<{ fileId: number; hash: string; r2Key: string }> {
  const zip = claudeExportZip(convs);
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

async function uploadArchive(tag: string, convs: number): Promise<{ fileId: number; hash: string; r2Key: string }> {
  return uploadConvs(tag, Array.from({ length: convs }, (_u, i) => conv(tag, i)));
}

// A NON-export single claude-web session (goes through parseOne's normal write path, not the export
// slicer) — used to prove the invocation budget bounds normal writes too, not just export slices.
async function uploadClaudeWeb(tag: string, msgs: number): Promise<{ fileId: number; hash: string; r2Key: string }> {
  const uuid = `bnd-web-${tag}`;
  const messages: ClaudeWebMessage[] = [];
  let parent = CLAUDE_WEB_ROOT;
  for (let m = 0; m < msgs; m++) {
    const u = `${tag}-w${m}`;
    messages.push({ uuid: u, parent, sender: m % 2 === 0 ? 'human' : 'assistant', text: `web ${m}` });
    parent = u;
  }
  const json = claudeWebConversation({ uuid, name: `Web ${tag}`, messages });
  const bytes = new TextEncoder().encode(json);
  const hash = await sha256Hex(bytes);
  const machine = `bnd-web-${tag}`;
  const relpath = `${uuid}.json`;
  const res = await SELF.fetch(`https://api.sessions.vza.net/api/v1/files/${machine}/claude-web/${encodeURIComponent(relpath)}`, {
    method: 'PUT',
    headers: {
      'x-dev-machine': machine,
      'x-content-hash': `sha256:${hash}`,
      'x-file-mtime': '2026-07-01T12:00:00Z',
      'content-length': String(bytes.length),
    },
    body: json,
  });
  expect(res.status).toBe(201);
  const row = await testEnv.DB.prepare('SELECT id, r2_key, content_hash FROM files WHERE machine_id = ?1 AND relpath = ?2')
    .bind(machine, relpath)
    .first<{ id: number; r2_key: string; content_hash: string }>();
  return { fileId: row!.id, hash: row!.content_hash, r2Key: row!.r2_key };
}

// Build a batch message with ack/retry tracking into `flags[fileId]`.
function batchMsg(f: { fileId: number; hash: string; r2Key: string }, flags: Record<number, { acked: boolean; retried: boolean }>) {
  flags[f.fileId] = { acked: false, retried: false };
  return {
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
  };
}

async function sessionState(id: string): Promise<string | null> {
  const r = await testEnv.DB.prepare('SELECT index_state FROM sessions WHERE session_id = ?1').bind(id).first<{ index_state: string }>();
  return r?.index_state ?? null;
}

async function stateCount(fileId: number, state: string): Promise<number> {
  const r = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE canonical_file_id = ?1 AND index_state = ?2').bind(fileId, state).first<{ n: number }>();
  return r!.n;
}

// Deliver a parse message and keep delivering the continuation it enqueues (write- OR cleanup-phase)
// for THIS file until none is left — i.e. drive the whole bounded parse to its terminal state. Records
// the file's parse_state after each non-final invocation so callers can assert it stayed 'pending' the
// whole way. With `stopAtCleanup`, returns as soon as the first CLEANUP-phase continuation appears
// (offset === archive length, carries cleanup_cursor), leaving cleanup deliberately unfinished.
async function deliverChain(
  initial: ParseMessage,
  opts: { stopAtCleanup?: boolean } = {},
): Promise<{ deliveries: number; statesBeforeFinal: string[]; stoppedCont?: ParseMessage }> {
  let msg: ParseMessage = initial;
  let deliveries = 0;
  const statesBeforeFinal: string[] = [];
  for (;;) {
    sent.length = 0;
    await deliver(msg);
    deliveries += 1;
    const cont = sent.find((m) => m.file_id === initial.file_id && typeof m.offset === 'number');
    if (!cont) return { deliveries, statesBeforeFinal };
    statesBeforeFinal.push(await fileState(initial.file_id));
    if (opts.stopAtCleanup && cont.cleanup_cursor !== undefined) return { deliveries, statesBeforeFinal, stoppedCont: cont };
    msg = cont;
  }
}

describe('large export ingest is bounded and never marks parsed until every conversation is written', () => {
  it('writes the archive in bounded slices; the file stays pending until the FINAL slice (silent-gap guard)', async () => {
    // More than one subrequest-budget slice of small conversations (each ~5 subrequests, slice budget 20 →
    // ~4/slice), so the parse spans several invocations. The exact slice boundary depends on
    // per-conversation D1 cost, so we drive the whole continuation chain and assert the INVARIANT rather
    // than a fixed offset.
    budgets({ slice: 20, invocation: 20 });
    const total = 12;
    const { fileId, hash, r2Key } = await uploadArchive('a', total);

    // The upload enqueued the initial parse (offset 0). Follow every continuation to completion.
    const { deliveries, statesBeforeFinal } = await deliverChain({ file_id: fileId, r2_key: r2Key, reason: 'upload', content_hash: hash });

    // POSITIVE CONTROL for the silent-data-gap bug: the parse took MULTIPLE invocations, and after every
    // NON-final invocation the file was still 'pending'. If markParsed ran per-slice instead of only when
    // the whole archive is written and cleaned up, one of these would read 'parsed'.
    expect(deliveries).toBeGreaterThan(1);
    expect(statesBeforeFinal.every((s) => s === 'pending')).toBe(true);

    // Only now — after the final invocation — is the file 'parsed', with the WHOLE archive written.
    expect(await fileState(fileId)).toBe('parsed');
    expect(await ownedSessions(fileId)).toBe(total);

    // Every conversation is searchable — proving the fan-out completed, not just the file flag.
    const search = await SELF.fetch('https://api.sessions.vza.net/api/v1/search?q=answer', { headers: { 'x-dev-machine': 'bndbox' } });
    const hits = ((await search.json()) as { hits: unknown[] }).hits;
    expect(hits.length).toBeGreaterThan(0);
  });

  it('a run whose continuation never arrives leaves the file pending, never parsed (incomplete ≠ parsed)', async () => {
    budgets({ slice: 20, invocation: 20 });
    const total = 12; // more than one subrequest-budget slice, so slice 1 is non-final
    const { fileId, hash, r2Key } = await uploadArchive('b', total);

    sent.length = 0;
    await deliver({ file_id: fileId, r2_key: r2Key, reason: 'upload', content_hash: hash });

    // Simulate the continuation being dropped (crash / lost message): we simply never deliver cont.
    // The file must remain 'pending' — a partially-written archive is NOT 'parsed'.
    expect(await fileState(fileId)).toBe('pending');
    const written = await ownedSessions(fileId);
    expect(written).toBeGreaterThan(0); // slice 1 landed some conversations
    expect(written).toBeLessThan(total); // ...but not the whole archive
    // The system did try to continue (a continuation was enqueued) — it's the *completion* that's gated
    // on all slices + cleanup, not the attempt.
    expect(sent.some((m) => m.file_id === fileId && m.offset === written)).toBe(true);
  });

  it('processes at most ONE export slice per invocation; a second export is deferred by ACK + re-enqueue, not retry (round 1 finding 1 / round 3 finding 2)', async () => {
    // Two export files delivered in ONE batch (max_batch_size:5 in prod). Each export RESERVES the full
    // slice budget on attempt; with slice == invocation budget, the first export alone crosses the
    // invocation cap, so the second is DEFERRED — but a deferral is not a failure, so it must ACK +
    // re-enqueue a fresh copy (resetting the retry budget), never msg.retry() (which burns max_retries and
    // can DLQ a message that never failed).
    budgets({ slice: 20, invocation: 20 });
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
    sent.length = 0;
    await worker.queue(
      { queue: 'parse', messages: [mk(f1), mk(f2)], ackAll() {}, retryAll() {} } as unknown as MessageBatch<ParseMessage>,
      testEnv,
    );

    // First export ran to completion and acked. Second was deferred: ACKed (not retried) and a fresh copy
    // of ITS body was re-enqueued for a later invocation.
    expect(flags[f1.fileId]).toEqual({ acked: true, retried: false });
    expect(flags[f2.fileId]).toEqual({ acked: true, retried: false }); // POSITIVE CONTROL: retry() would burn attempts
    expect(sent.some((m) => m.file_id === f2.fileId && m.offset === undefined)).toBe(true); // fresh copy re-enqueued
    expect(await fileState(f1.fileId)).toBe('parsed');
    expect(await ownedSessions(f1.fileId)).toBe(3);
    expect(await fileState(f2.fileId)).toBe('pending'); // untouched — the re-enqueued copy will run later
    expect(await ownedSessions(f2.fileId)).toBe(0);
  });

  it('reverts a slice whose file bytes change mid-write; no continuation, not parsed (round 1 finding 2)', async () => {
    budgets({ slice: 20, invocation: 20 });
    const total = 12; // multi-slice so a continuation would normally follow slice 1
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
    expect(await stateCount(fileId, 'ready')).toBe(0);
    const parsing = await stateCount(fileId, 'parsing');
    expect(parsing).toBeGreaterThan(0); // the whole slice reverted
    expect(parsing).toBe(await ownedSessions(fileId)); // every session this slice touched, and only those
    expect(sent.some((m) => m.file_id === fileId && typeof m.offset === 'number')).toBe(false); // no continuation
  });

  it('a continuation-enqueue failure is retryable: the slice reverts and the file goes pending, not error (round 1 finding 3 / round 6)', async () => {
    budgets({ slice: 20, invocation: 20 });
    const total = 12;
    const { fileId, hash, r2Key } = await uploadArchive('cf', total);

    // Make the continuation send throw. A queue-send outage is TRANSIENT: parseExportInto must revert THIS
    // slice's writes and force the file back to 'pending' (retryable) — never terminal 'error' with partial
    // 'ready' rows (a session_id-NULL archive the generic catch can't reconcile).
    const realSend = testEnv.PARSE_QUEUE.send;
    testEnv.PARSE_QUEUE.send = (async () => {
      throw new Error('queue send failed');
    }) as typeof testEnv.PARSE_QUEUE.send;
    try {
      await deliver({ file_id: fileId, r2_key: r2Key, reason: 'upload', content_hash: hash });
    } finally {
      testEnv.PARSE_QUEUE.send = realSend;
    }

    // POSITIVE CONTROL: before round 6 this marked the file terminal 'error'; now a transient send failure
    // is retryable — the file rests 'pending' (re-enqueueable by files/check), with this offset-0 slice's
    // writes reverted so no partial 'ready' rows survive.
    expect(await fileState(fileId)).toBe('pending'); // retryable, NOT terminal 'error'
    expect(await readyCount(fileId)).toBe(0); // this slice's writes reverted
  });

  it('a retryable later-slice send failure PRESERVES earlier slices and retries at the same offset (round 6 finding 2)', async () => {
    // The write phase spans invocations. Deliver slice 1 (a prefix becomes 'ready'), then fail slice 2's
    // continuation send. The failure is RETRYABLE and the message retries at slice 2's OWN offset — which
    // never rewrites slice 1 — so reverting slice 1 would strand it 'parsing' forever. The correct behavior:
    // revert only slice 2's writes, keep slice 1 'ready', force the file 'pending', and let a same-offset
    // retry complete with every row 'ready'.
    budgets({ slice: 20, invocation: 20 });
    const total = 12;
    const { fileId, hash, r2Key } = await uploadArchive('r6rev', total);

    // Slice 1 (offset 0): writes a prefix and enqueues a continuation; the file stays pending.
    sent.length = 0;
    await deliver({ file_id: fileId, r2_key: r2Key, reason: 'upload', content_hash: hash });
    const cont = sent.find((m) => m.file_id === fileId && typeof m.offset === 'number' && m.offset! > 0);
    expect(cont).toBeDefined();
    const firstSliceReady = await readyCount(fileId);
    expect(firstSliceReady).toBeGreaterThan(0); // slice 1 published some 'ready' rows

    // Slice 2 (offset > 0): fail ITS continuation send (offset beyond slice 2). Toggle off after.
    const realSend = testEnv.PARSE_QUEUE.send;
    let failSend = true;
    testEnv.PARSE_QUEUE.send = (async (m: ParseMessage) => {
      if (failSend && typeof m.offset === 'number' && m.offset! > cont!.offset!) throw new Error('queue send failed on slice 2');
      return (realSend as (b: ParseMessage) => Promise<unknown>)(m);
    }) as typeof testEnv.PARSE_QUEUE.send;
    try {
      await deliver(cont!);

      // POSITIVE CONTROL: a whole-file revert here would flip slice 1's rows to 'parsing', and the
      // same-offset retry (which rewrites only slice 2) would never restore them. Reverting slice 2 ONLY
      // keeps slice 1 'ready' and the file 'pending' (retryable), not terminal 'error'.
      expect(await fileState(fileId)).toBe('pending');
      expect(await readyCount(fileId)).toBe(firstSliceReady); // slice 1 preserved; only slice 2 reverted

      // Retry at the SAME offset with the queue restored → drains to completion with every row 'ready'.
      failSend = false;
      await deliverChain(cont!);
      expect(await fileState(fileId)).toBe('parsed');
      expect(await ownedSessions(fileId)).toBe(total);
      expect(await readyCount(fileId)).toBe(total);
    } finally {
      testEnv.PARSE_QUEUE.send = realSend;
    }
  });

  it('budgets the slice by D1 SUBREQUESTS (batch calls), not statements: many-block conversations still fit one slice (round 3 finding 1, subrequest revert)', async () => {
    // Each conversation carries ~180 blocks. writeSession fans them into ceil(180/90)=2 INSERT batches, so
    // its SUBREQUEST cost is ~5 (delete batch + 2 insert batches + machine SELECT + session/FTS batch) —
    // NOT ~180. The slice budget is 150 subrequests, so all three conversations (~7 subrequests each incl.
    // the ownership lookup) land in ONE slice with room to spare. Under the pre-revert STATEMENT accounting
    // a single 180-block conversation "cost" ~180 and would blow a 150-unit slice by itself.
    budgets({ slice: 150, invocation: 150 });
    const total = 3;
    const { fileId, hash, r2Key } = await uploadConvs('sub', Array.from({ length: total }, (_u, i) => heavyConv('sub', i, 180)));

    sent.length = 0;
    await deliver({ file_id: fileId, r2_key: r2Key, reason: 'upload', content_hash: hash });

    // POSITIVE CONTROL for subrequest counting: revert writeSession/estimate to a per-STATEMENT count and a
    // single 180-block conversation exhausts the 150-unit slice, forcing a continuation at offset 1.
    // Counting subrequests, all three land in one slice → parsed, no continuation.
    expect(await fileState(fileId)).toBe('parsed');
    expect(await ownedSessions(fileId)).toBe(total);
    expect(sent.some((m) => m.file_id === fileId && typeof m.offset === 'number')).toBe(false);
  });

  it('reverts every session already written when writeSession throws mid-slice; the file goes pending, not error (round 2 finding 1b / round 6)', async () => {
    budgets({ slice: 20, invocation: 20 });
    const { fileId, hash, r2Key } = await uploadArchive('wf', 5);

    // Each small conversation issues 3 DB.batch calls in writeSession (block delete, block insert,
    // session+FTS). Throw on the 7th batch → conversation 3's first batch → conversations 1-2 are fully
    // written and tracked in `written`, conversation 3 fails before any of its rows land. A mid-write D1
    // throw is TRANSIENT: raiseExportRetry reverts this invocation's writes (1-2 and the half-written 3) and
    // forces the file 'pending' for a same-offset retry.
    const restore = throwOnNthBatch(7);
    sent.length = 0;
    try {
      await deliver({ file_id: fileId, r2_key: r2Key, reason: 'upload', content_hash: hash });
    } finally {
      restore();
    }

    // POSITIVE CONTROL: before round 6 this marked the file terminal 'error'; a transient write failure is
    // now retryable — the file rests 'pending' (re-enqueueable) with this offset-0 slice reverted (no
    // partial 'ready' rows) and NO continuation enqueued (the same message retries at offset 0).
    expect(await fileState(fileId)).toBe('pending'); // retryable, NOT terminal 'error'
    expect(await readyCount(fileId)).toBe(0); // this invocation's writes reverted
    expect(sent.some((m) => m.file_id === fileId && typeof m.offset === 'number')).toBe(false); // no continuation
  });

  it('a post-write hash-recheck D1 throw is retryable, not a terminal error with a stranded prefix (round 6 finding 5)', async () => {
    budgets({ slice: 20, invocation: 20 });
    const total = 3; // one slice → writes complete → the post-write recheck runs
    const { fileId, hash, r2Key } = await uploadConvs('r6f5', Array.from({ length: total }, (_u, i) => conv('r6f5', i)));

    // Make the POST-write hash recheck throw. It's the 2nd `SELECT content_hash` read (pre-write is 1st,
    // cleanup rechecks come later) and lives OUTSIDE the write-loop try — the site finding 5 flagged.
    const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
    let reads = 0;
    testEnv.DB.prepare = ((sql: string) => {
      const stmt = realPrepare(sql);
      if (sql !== 'SELECT content_hash FROM files WHERE id = ?1') return stmt;
      const realBind = stmt.bind.bind(stmt);
      stmt.bind = (...a: unknown[]) => {
        const bound = realBind(...a);
        const realFirst = bound.first.bind(bound);
        (bound as unknown as Record<string, unknown>).first = async (...x: unknown[]) => {
          reads++;
          if (reads === 2) throw new Error('D1 outage on post-write recheck');
          return (realFirst as (...y: unknown[]) => unknown)(...x);
        };
        return bound;
      };
      return stmt;
    }) as typeof testEnv.DB.prepare;
    try {
      await deliver({ file_id: fileId, r2_key: r2Key, reason: 'upload', content_hash: hash });
    } finally {
      testEnv.DB.prepare = realPrepare as typeof testEnv.DB.prepare;
    }

    // POSITIVE CONTROL: the post-write recheck runs outside the write-loop try, so before round 6's whole-
    // body wrapper a throw here reached the generic catch and marked the session_id-NULL archive terminal
    // 'error' with its just-written 'ready' prefix stranded. The wrapper makes it retryable: file 'pending',
    // this offset-0 slice reverted.
    expect(await fileState(fileId)).toBe('pending');
    expect(await readyCount(fileId)).toBe(0);
  });

  it('a mid-conversation throw reverts its prior ready row to parsing, never leaving it ready over a half-rewritten index (round 3 finding 4)', async () => {
    budgets({ slice: 20, invocation: 20 });
    const convId = 'bnd-f4-conv-0';
    const { fileId, hash, r2Key } = await uploadArchive('f4', 1); // single conversation

    // First parse → the conversation is a healthy 'ready' session owned by this file.
    await deliver({ file_id: fileId, r2_key: r2Key, reason: 'upload', content_hash: hash });
    expect(await sessionState(convId)).toBe('ready');

    // Reparse the SAME bytes (reason 'reindex', same hash → not stale-rejected). Throw on the 2nd DB.batch
    // of the invocation = the conversation's INSERT batch, AFTER its DELETE batch already dropped the old
    // blocks/FTS. Its prior sessions row is still 'ready' over a now half-rewritten index.
    const restore = throwOnNthBatch(2);
    try {
      await deliver({ file_id: fileId, r2_key: r2Key, reason: 'reindex', content_hash: hash });
    } finally {
      restore();
    }

    // POSITIVE CONTROL for the retryable revert: raiseExportRetry reverts this invocation's `written` (which
    // includes this conversation, added before the write) to 'parsing' and forces the file 'pending' for a
    // same-offset retry — never leaving the half-rewritten (blocks-deleted) session 'ready', never terminal.
    expect(await fileState(fileId)).toBe('pending');
    expect(await sessionState(convId)).toBe('parsing');
  });

  it('reserves the export budget before parsing, so a slice that throws does not free the budget for a second export in the same batch (round 2 finding 2)', async () => {
    budgets({ slice: 20, invocation: 20 });
    const f1 = await uploadArchive('rb1', 5); // throws mid-slice
    const f2 = await uploadArchive('rb2', 3); // must stay untouched

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

    // Throw during f1's slice (7th batch = its 3rd conversation). consumeParseBatch reserves the export
    // budget the moment it detects an export archive — BEFORE parseOne runs — so even though f1 throws,
    // the budget is already spent and f2 is deferred (ACK + re-enqueue) without running a slice.
    const restore = throwOnNthBatch(7);
    sent.length = 0;
    try {
      await worker.queue(
        { queue: 'parse', messages: [mk(f1), mk(f2)], ackAll() {}, retryAll() {} } as unknown as MessageBatch<ParseMessage>,
        testEnv,
      );
    } finally {
      restore();
    }

    // POSITIVE CONTROL for reserve-first vs. a success-only decrement: f1 threw, so a success-only
    // decrement would leave the budget available and f2 would run a full slice (3 sessions written).
    // Reserving on attempt keeps f2 untouched (deferred: ACKed + a fresh copy re-enqueued).
    expect(flags[f1.fileId]!.retried).toBe(true); // f1's transient throw → ExportRetry → consumer retries it
    expect(await fileState(f1.fileId)).toBe('pending'); // retryable, NOT terminal 'error'
    expect(await readyCount(f1.fileId)).toBe(0); // f1's partial writes reverted

    expect(flags[f2.fileId]).toEqual({ acked: true, retried: false }); // deferred by ACK + re-enqueue
    expect(sent.some((m) => m.file_id === f2.fileId && m.offset === undefined)).toBe(true);
    expect(await fileState(f2.fileId)).toBe('pending');
    expect(await ownedSessions(f2.fileId)).toBe(0); // NO slice ran for f2
  });

  // Runs LAST: its stale-session cleanup fan-out re-enqueues sibling export files (all share the
  // 'export-inbox' store), flipping them to 'pending' — harmless once earlier tests have asserted.
  it('bounds the final stale-session cleanup and marks parsed ONLY once it fully drains (round 3 finding 3)', async () => {
    // Parse a large archive (at a big budget so it lands in one fast slice) so the file owns many
    // sessions, then replace it with a much smaller valid archive that DROPS most conversations. At a small
    // reparse budget the dropped sessions must be cleaned in budgeted chunks (one delete SUBREQUEST each)
    // across several invocations — never one unbounded pass after markParsed.
    budgets({ slice: 800, invocation: 800 });
    const big = Array.from({ length: 30 }, (_u, i) => conv('cln', i));
    const first = await uploadConvs('cln', big);
    await deliverChain({ file_id: first.fileId, r2_key: first.r2Key, reason: 'upload', content_hash: first.hash });
    expect(await fileState(first.fileId)).toBe('parsed');
    expect(await ownedSessions(first.fileId)).toBe(30);

    // Replace the archive in place (same machine/relpath → same file id, new bytes) with 2 conversations,
    // and shrink the budget so cleanup of the ~28 stale sessions must span multiple invocations.
    const small = Array.from({ length: 2 }, (_u, i) => conv('cln', i));
    const replaced = await uploadConvs('cln', small);
    expect(replaced.fileId).toBe(first.fileId); // updated the same file row, not a new one
    budgets({ slice: 8, invocation: 8 });

    // Drive the reparse only until cleanup FIRST needs a continuation (stale rows still remain).
    const reparse: ParseMessage = { file_id: replaced.fileId, r2_key: replaced.r2Key, reason: 'upload', content_hash: replaced.hash };
    const stopped = await deliverChain(reparse, { stopAtCleanup: true });

    // POSITIVE CONTROL for cleanup-before-markParsed: with markParsed moved ahead of the cleanup loop the
    // file would already be 'parsed' here (and a huge cleanup would run unbounded). Because cleanup is a
    // budgeted phase that gates markParsed, the file is STILL 'pending' with stale rows outstanding.
    expect(stopped.stoppedCont).toBeDefined(); // cleanup needed more than one budgeted chunk
    expect(await fileState(replaced.fileId)).toBe('pending');
    expect(await ownedSessions(replaced.fileId)).toBeGreaterThan(2); // stale sessions not yet fully removed

    // Resume from the cleanup continuation and drain the rest.
    const rest = await deliverChain(stopped.stoppedCont!);
    expect(rest.deliveries).toBeGreaterThan(1); // cleanup itself spanned multiple invocations
    expect(await fileState(replaced.fileId)).toBe('parsed'); // parsed ONLY after cleanup fully drained
    expect(await ownedSessions(replaced.fileId)).toBe(2); // exactly the kept conversations; zero stale rows
    expect(await stateCount(replaced.fileId, 'ready')).toBe(2);
  });

  it('defers an oversized conversation to its own invocation instead of writing it mid-slice (round 4 finding 2)', async () => {
    // A conversation estimated above EXPORT_OVERSIZED_CEILING (dialed to 5 subrequests here) can't be
    // sliced (writeSession is atomic per conversation), so when it appears after other work in a slice it
    // must be cut to its OWN invocation — keeping its writeSession clear of the per-invocation cap. The
    // 200-block conversation estimates at ceil(200/90)+3 = 6 subrequests > 5; the small ones are ~4.
    // (Measured max real export conversation is 304 blocks ≈ 7 subrequests, so in prod this is defensive.)
    budgets({ slice: 20, invocation: 20, ceiling: 5 });
    const convs = [conv('ovz', 0), conv('ovz', 1), heavyConv('ovz', 2, 200), conv('ovz', 3)];
    const { fileId, hash, r2Key } = await uploadConvs('ovz', convs);

    sent.length = 0;
    await deliver({ file_id: fileId, r2_key: r2Key, reason: 'upload', content_hash: hash });

    // POSITIVE CONTROL: without the preflight cut, the oversized conversation writes in slice 1 alongside
    // the two small ones (continuation offset 3). The guard cuts BEFORE it, so slice 1 holds only the two
    // small conversations and the oversized one runs alone next invocation.
    expect(await fileState(fileId)).toBe('pending');
    const cont = sent.find((m) => m.file_id === fileId && typeof m.offset === 'number');
    expect(cont).toBeDefined();
    expect(cont!.offset!).toBe(2); // cut right before the oversized conversation at index 2
    expect(await ownedSessions(fileId)).toBe(2); // only the two small conversations written this slice
  });

  it('records an unwritable oversized conversation and skips it, keeping the rest of the slice (round 4 finding 2, cap path)', async () => {
    // A conversation whose estimate exceeds the hard SUBREQUEST CAP can't be written even alone under the
    // ~1000 cap (~90k blocks in prod). Here cap=5 makes the 200-block conversation (est 6) unwritable; it is
    // SKIPPED with a loud parse.export.oversized_conversation log (any existing row flipped to 'error')
    // while the small conversations before and after it still write. Nothing is silently dropped — the raw
    // ZIP stays in R2 for a later parser fix.
    budgets({ slice: 20, invocation: 20, ceiling: 5, cap: 5 });
    const { fileId, hash, r2Key } = await uploadConvs('cap', [conv('cap', 0), heavyConv('cap', 1, 200), conv('cap', 2)]);

    sent.length = 0;
    await deliver({ file_id: fileId, r2_key: r2Key, reason: 'upload', content_hash: hash });

    // POSITIVE CONTROL: raise the cap above the estimate and all three write to 'ready'. At cap 5 the
    // oversized conversation is never published, both small ones are, and the slice still completes (a skip
    // is not a failure), so the file parses.
    expect(await sessionState('bnd-cap-conv-1')).not.toBe('ready'); // oversized: never published
    expect(await sessionState('bnd-cap-conv-0')).toBe('ready');
    expect(await sessionState('bnd-cap-conv-2')).toBe('ready');
    expect(await fileState(fileId)).toBe('parsed');
  });

  it('writes a LEADING oversized conversation alone instead of looping on the same offset forever (round 5 finding 1)', async () => {
    // When a continuation STARTS on an oversized conversation (it is the FIRST in the slice), the ceiling
    // cut must NOT fire: nothing has been written yet, so cutting here would re-enqueue the SAME offset and
    // the archive would stay pending forever. The single 200-block conversation (est 6 > ceiling 5, but
    // ≤ cap) must be written ALONE, making progress.
    budgets({ slice: 20, invocation: 20, ceiling: 5, cap: 900 });
    const { fileId, hash, r2Key } = await uploadConvs('lead', [heavyConv('lead', 0, 200)]);

    sent.length = 0;
    await deliver({ file_id: fileId, r2_key: r2Key, reason: 'upload', content_hash: hash });

    // POSITIVE CONTROL: gate the ceiling cut on `spent > 0` (the pre-fix condition) and this conversation's
    // own ownership lookup already made spent > 0, so the loop breaks without advancing idx → a continuation
    // at the SAME offset 0, looping forever with nothing written. Gating on written.size writes it alone.
    expect(await fileState(fileId)).toBe('parsed');
    expect(await ownedSessions(fileId)).toBe(1);
    expect(sent.some((m) => m.file_id === fileId && m.offset === 0)).toBe(false); // no same-offset re-enqueue
  });

  it('holds a SINGLE invocation-wide budget: an export slice defers a normal transcript in the same batch (round 4 finding 4)', async () => {
    budgets({ slice: 20, invocation: 20 });
    const exp = await uploadArchive('inv1', 3);
    const web = await uploadClaudeWeb('inv1', 4); // a NON-export single session (normal write path)

    const flags: Record<number, { acked: boolean; retried: boolean }> = {};
    sent.length = 0;
    await worker.queue(
      { queue: 'parse', messages: [batchMsg(exp, flags), batchMsg(web, flags)], ackAll() {}, retryAll() {} } as unknown as MessageBatch<ParseMessage>,
      testEnv,
    );

    // POSITIVE CONTROL: the round-2/3 guard reserved only EXPORT messages, so a normal transcript after an
    // export slice still ran (its writeSession could push the invocation past the cap). The invocation-wide
    // budget reserves the export slice's cost and defers the normal transcript — ACK + re-enqueue, zero writes.
    expect(await fileState(exp.fileId)).toBe('parsed');
    expect(await ownedSessions(exp.fileId)).toBe(3);
    expect(flags[web.fileId]).toEqual({ acked: true, retried: false }); // deferred by ack, not retry
    expect(sent.some((m) => m.file_id === web.fileId && m.offset === undefined)).toBe(true); // re-enqueued fresh
    expect(await fileState(web.fileId)).toBe('pending');
    expect(await ownedSessions(web.fileId)).toBe(0);
  });

  it('processes a whole batch of cheap non-export transcripts without deferring (round 4 finding 4)', async () => {
    budgets({ slice: 100, invocation: 100, normalReserve: 16 });
    const a = await uploadClaudeWeb('inv2a', 2);
    const b = await uploadClaudeWeb('inv2b', 2);
    const c = await uploadClaudeWeb('inv2c', 2);

    const flags: Record<number, { acked: boolean; retried: boolean }> = {};
    await worker.queue(
      { queue: 'parse', messages: [batchMsg(a, flags), batchMsg(b, flags), batchMsg(c, flags)], ackAll() {}, retryAll() {} } as unknown as MessageBatch<ParseMessage>,
      testEnv,
    );

    // Their combined cost stays well under the budget, so none defer — the budget bounds heavy batches
    // without penalizing ordinary ones.
    for (const f of [a, b, c]) {
      expect(flags[f.fileId]).toEqual({ acked: true, retried: false });
      expect(await fileState(f.fileId)).toBe('parsed');
    }
  });

  it('defers the rest of the batch when a normal transcript throws mid-write, so its D1 work is not followed by more (round 5 finding 3)', async () => {
    // A non-export transcript reports its subrequest cost only on SUCCESS; if it throws after writeSession
    // has issued batches, we can't charge the invocation budget precisely — so the batch must DEFER every
    // later message rather than run more D1 work that could re-hit the ~1000-subrequest cap.
    budgets({ slice: 20, invocation: 20 });
    const w1 = await uploadClaudeWeb('r5a', 2); // its write throws
    const w2 = await uploadClaudeWeb('r5b', 2); // must be deferred, not run

    const flags: Record<number, { acked: boolean; retried: boolean }> = {};
    // Throw on the FIRST db.batch of the invocation = w1's writeSession delete batch. (parseOne's pre-write
    // work uses .first/.run, not .batch, so batch #1 is inside w1's writeSession.)
    const restore = throwOnNthBatch(1);
    sent.length = 0;
    try {
      await worker.queue(
        { queue: 'parse', messages: [batchMsg(w1, flags), batchMsg(w2, flags)], ackAll() {}, retryAll() {} } as unknown as MessageBatch<ParseMessage>,
        testEnv,
      );
    } finally {
      restore();
    }

    // POSITIVE CONTROL: without `deferRest = true` in the generic catch, w2 runs in the same invocation
    // right after w1's failed heavy write. The defer re-enqueues w2 fresh (ack, not retry) with zero writes.
    expect(flags[w1.fileId]!.retried).toBe(true); // w1 threw → consumer catch retries it
    expect(flags[w2.fileId]).toEqual({ acked: true, retried: false }); // deferred by ack + re-enqueue
    expect(sent.some((m) => m.file_id === w2.fileId && m.offset === undefined)).toBe(true);
    expect(await fileState(w2.fileId)).toBe('pending');
    expect(await ownedSessions(w2.fileId)).toBe(0); // NO write ran for w2
  });

  it('defers the CURRENT export when its reservation would overflow the invocation after prior work (round 6 finding 1)', async () => {
    // A cheap normal transcript earlier in the batch uses part of the budget WITHOUT crossing it, then the
    // export's worst-case reservation WOULD cross the cap. The export must be deferred — not run its slice
    // after the prior D1 work — while the normal transcript still runs. invocation=25, reserve(slice)=20:
    // the web spend (~15) doesn't self-trip deferRest, but 15 + 20 ≥ 25 overflows the reservation.
    budgets({ slice: 20, invocation: 25 });
    const web = await uploadClaudeWeb('r6f1', 2); // cheap normal transcript, runs first
    const exp = await uploadArchive('r6f1', 3); // its reservation overflows the invocation → deferred

    const flags: Record<number, { acked: boolean; retried: boolean }> = {};
    sent.length = 0;
    await worker.queue(
      { queue: 'parse', messages: [batchMsg(web, flags), batchMsg(exp, flags)], ackAll() {}, retryAll() {} } as unknown as MessageBatch<ParseMessage>,
      testEnv,
    );

    // POSITIVE CONTROL: before round 6 the reservation only set deferRest for LATER messages, so this export
    // still ran a slice after the normal transcript's D1 work (breaching the cap). Now the CURRENT export is
    // deferred (ACK + re-enqueue), zero writes, while the normal transcript ran. (The invocationSpent > 0
    // guard keeps a SOLE/first export always running — other tests deliver exports first and they run.)
    expect(await fileState(web.fileId)).toBe('parsed');
    expect(flags[exp.fileId]).toEqual({ acked: true, retried: false });
    expect(sent.some((m) => m.file_id === exp.fileId && m.offset === undefined)).toBe(true); // re-enqueued fresh
    expect(await fileState(exp.fileId)).toBe('pending');
    expect(await ownedSessions(exp.fileId)).toBe(0);
  });

  // Destructive cleanup fan-out (kicks sibling export-inbox files to 'pending') — kept near the end.
  it('a cleanup-continuation send failure leaves the file pending, not error, and retries the cleanup page (round 4 finding 1)', async () => {
    budgets({ slice: 800, invocation: 800 });
    const first = await uploadConvs('csf', Array.from({ length: 30 }, (_u, i) => conv('csf', i)));
    await deliverChain({ file_id: first.fileId, r2_key: first.r2Key, reason: 'upload', content_hash: first.hash });
    expect(await ownedSessions(first.fileId)).toBe(30);

    // Replace with 3 conversations → ~27 stale to clean; a small budget makes cleanup need a continuation.
    const replaced = await uploadConvs('csf', Array.from({ length: 3 }, (_u, i) => conv('csf', i)));
    budgets({ slice: 20, invocation: 20 });
    const flags: Record<number, { acked: boolean; retried: boolean }> = {};
    const msg = batchMsg(replaced, flags);

    // Make the cleanup continuation's send throw. The archive is FULLY written (its 'ready' sessions are
    // valid), so the file must NOT go 'error' with unreconciled stale rows — it's forced back to 'pending'
    // and retried instead.
    const realSend = testEnv.PARSE_QUEUE.send;
    testEnv.PARSE_QUEUE.send = (async (m: ParseMessage) => {
      if (m.cleanup_cursor !== undefined) throw new Error('queue send outage'); // only the cleanup continuation
      return (realSend as (b: ParseMessage) => Promise<unknown>)(m);
    }) as typeof testEnv.PARSE_QUEUE.send;
    try {
      await worker.queue({ queue: 'parse', messages: [msg], ackAll() {}, retryAll() {} } as unknown as MessageBatch<ParseMessage>, testEnv);
    } finally {
      testEnv.PARSE_QUEUE.send = realSend;
    }

    // POSITIVE CONTROL: without the sentinel, the generic catch marks the archive 'error' (it can't
    // reconcile stale sessions of a session_id-NULL row). The sentinel keeps it 'pending' and retries.
    expect(flags[replaced.fileId]).toEqual({ acked: false, retried: true });
    expect(await fileState(replaced.fileId)).toBe('pending'); // NOT 'error'
    expect(await ownedSessions(replaced.fileId)).toBeGreaterThan(3); // stale not fully cleaned yet

    // With the queue restored, redelivery drains cleanup to completion — parsed, zero stale.
    await deliverChain({ file_id: replaced.fileId, r2_key: replaced.r2Key, reason: 'upload', content_hash: replaced.hash });
    expect(await fileState(replaced.fileId)).toBe('parsed');
    expect(await ownedSessions(replaced.fileId)).toBe(3);
  });

  it('a cleanup-phase D1 throw is retryable and preserves the valid written sessions (round 6 finding 6)', async () => {
    // Parse a big archive (one fast slice), then replace with a smaller one so cleanup must delete stale
    // rows. Drive the reparse to a PURE cleanup invocation, then make its first DELETE batch throw. A
    // cleanup-phase D1 outage must be retryable (file 'pending', not terminal 'error') and — because a pure
    // cleanup pass wrote nothing — revert nothing, leaving every valid owned session 'ready'.
    budgets({ slice: 800, invocation: 800 });
    const first = await uploadConvs('r6f6', Array.from({ length: 10 }, (_u, i) => conv('r6f6', i)));
    await deliverChain({ file_id: first.fileId, r2_key: first.r2Key, reason: 'upload', content_hash: first.hash });
    expect(await ownedSessions(first.fileId)).toBe(10);

    const replaced = await uploadConvs('r6f6', Array.from({ length: 2 }, (_u, i) => conv('r6f6', i)));
    budgets({ slice: 8, invocation: 8 });

    // First reparse invocation writes the 2 kept convs then defers cleanup to a continuation (budget spent).
    // The re-upload flipped the file's prior sessions out of 'ready', so only the 2 just-rewritten convs are
    // 'ready' now; the 8 dropped ones are stale rows cleanup will delete.
    sent.length = 0;
    await deliver({ file_id: replaced.fileId, r2_key: replaced.r2Key, reason: 'upload', content_hash: replaced.hash });
    const cleanupCont = sent.find((m) => m.file_id === replaced.fileId && m.cleanup_cursor !== undefined);
    expect(cleanupCont).toBeDefined();
    const readyBefore = await readyCount(replaced.fileId); // the 2 rewritten convs
    expect(readyBefore).toBe(2);

    // Deliver the pure-cleanup continuation with its first DELETE batch throwing (page query is .all, the
    // per-page recheck is .first, so batch #1 of this invocation is the first stale delete).
    const restore = throwOnNthBatch(1);
    try {
      await deliver(cleanupCont!);
    } finally {
      restore();
    }

    // POSITIVE CONTROL: a cleanup-phase throw used to fall through to the generic catch → terminal 'error'
    // with stale rows stuck. Now it's retryable: file 'pending', and because this pure cleanup invocation
    // wrote nothing, revertSlice is a no-op — the 2 valid written sessions stay 'ready', nothing committed.
    expect(await fileState(replaced.fileId)).toBe('pending');
    expect(await readyCount(replaced.fileId)).toBe(readyBefore); // the 2 written sessions preserved (no revert)

    // Retry drains cleanup → parsed, exactly the 2 kept.
    await deliverChain(cleanupCont!);
    expect(await fileState(replaced.fileId)).toBe('parsed');
    expect(await ownedSessions(replaced.fileId)).toBe(2);
  });

  it('a recovery fan-out SELECT failure is retryable, not swallowed into a false parsed (round 6 finding 4)', async () => {
    // The sibling-recovery fan-out runs only when cleanup actually reconciled a stale session. A D1 outage
    // in its initial SELECT must NOT be swallowed (which would let THIS file reach 'parsed' with the
    // recovered session gone and no sibling kicked) — it propagates to the retryable wrapper → 'pending'.
    budgets({ slice: 800, invocation: 800 });
    const first = await uploadConvs('r6f4', Array.from({ length: 6 }, (_u, i) => conv('r6f4', i)));
    await deliverChain({ file_id: first.fileId, r2_key: first.r2Key, reason: 'upload', content_hash: first.hash });
    expect(await ownedSessions(first.fileId)).toBe(6);
    const replaced = await uploadConvs('r6f4', Array.from({ length: 2 }, (_u, i) => conv('r6f4', i)));
    budgets({ slice: 20, invocation: 20 });

    // Make the sibling-recovery SELECT throw (it fires only after cleanup reconciled ≥1 stale session).
    const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
    const SIBLING_SQL = `SELECT id, r2_key, content_hash FROM files WHERE store = ?1 AND id != ?2 AND parse_state = 'parsed'`;
    testEnv.DB.prepare = ((sql: string) => {
      if (sql === SIBLING_SQL) {
        return { bind: () => ({ all: async () => { throw new Error('D1 outage on sibling recovery SELECT'); } }) } as unknown as D1PreparedStatement;
      }
      return realPrepare(sql);
    }) as typeof testEnv.DB.prepare;
    try {
      await deliver({ file_id: replaced.fileId, r2_key: replaced.r2Key, reason: 'upload', content_hash: replaced.hash });
    } finally {
      testEnv.DB.prepare = realPrepare as typeof testEnv.DB.prepare;
    }

    // POSITIVE CONTROL: before round 6 the SELECT throw was swallowed and the file still reached 'parsed'.
    // Now it propagates to the wrapper → the file rests 'pending' (re-enqueueable), never falsely parsed.
    expect(await fileState(replaced.fileId)).toBe('pending');
  });

  it('kicks sibling archives BEFORE deleting stale sessions, so a flip failure deletes nothing and loses no sibling (round 6 finding 4, kick-before-delete)', async () => {
    budgets({ slice: 800, invocation: 800 });
    // A sibling export in the same 'export-inbox' store, so fileA's cleanup fan-out has a sibling to kick.
    const sib = await uploadConvs('r6kbd-sib', [conv('r6kbdsib', 0), conv('r6kbdsib', 1)]);
    await deliverChain({ file_id: sib.fileId, r2_key: sib.r2Key, reason: 'upload', content_hash: sib.hash });
    expect(await fileState(sib.fileId)).toBe('parsed');

    // fileA: big, then replaced small so its reparse cleanup deletes 4 stale sessions (fires the fan-out).
    const fileA = await uploadConvs('r6kbd', Array.from({ length: 6 }, (_u, i) => conv('r6kbd', i)));
    await deliverChain({ file_id: fileA.fileId, r2_key: fileA.r2Key, reason: 'upload', content_hash: fileA.hash });
    const replaced = await uploadConvs('r6kbd', Array.from({ length: 2 }, (_u, i) => conv('r6kbd', i)));

    // Make the flip of SIB SPECIFICALLY (markPendingAndEnqueue's `UPDATE ... WHERE id = ?1`, no
    // content_hash — distinct from forcePending's guarded UPDATE) throw ONCE. Targeting sib's id keeps the
    // test hermetic against the other export-inbox siblings the fan-out also kicks in the full-suite run.
    const FLIP_SQL = "UPDATE files SET parse_state = 'pending' WHERE id = ?1";
    const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
    let sibFlipThrown = false;
    testEnv.DB.prepare = ((sql: string) => {
      const stmt = realPrepare(sql);
      if (sql !== FLIP_SQL) return stmt;
      const realBind = stmt.bind.bind(stmt);
      stmt.bind = (...a: unknown[]) => {
        if (a[0] === sib.fileId && !sibFlipThrown) {
          return { run: async () => { sibFlipThrown = true; throw new Error('D1 outage on sibling flip'); } } as unknown as D1PreparedStatement;
        }
        return realBind(...a);
      };
      return stmt;
    }) as typeof testEnv.DB.prepare;
    try {
      // First cleanup delivery: the kick's flip throws BEFORE any stale delete → retryable, nothing deleted.
      await deliver({ file_id: replaced.fileId, r2_key: replaced.r2Key, reason: 'upload', content_hash: replaced.hash });

      // POSITIVE CONTROL for kick-BEFORE-delete: because the kick runs before the first delete, a flip
      // failure leaves every stale session intact (fileA still owns all 6). Under the old delete-then-kick
      // order the 4 stale rows would already be gone here, and the flip failure would strand the sibling
      // terminal — the exact silent-drop this reorder eliminates.
      expect(await fileState(replaced.fileId)).toBe('pending');
      expect(await ownedSessions(replaced.fileId)).toBe(6); // nothing deleted before the kick succeeded

      // Retry (flip works now): siblings flipped 'pending' FIRST, THEN stale deleted → fileA parsed.
      await deliverChain({ file_id: replaced.fileId, r2_key: replaced.r2Key, reason: 'upload', content_hash: replaced.hash });
    } finally {
      testEnv.DB.prepare = realPrepare as typeof testEnv.DB.prepare;
    }
    expect(await fileState(replaced.fileId)).toBe('parsed');
    expect(await ownedSessions(replaced.fileId)).toBe(2);
    expect(await fileState(sib.fileId)).toBe('pending'); // sibling kicked for reparse, never stranded terminal
  });

  it('a multi-page cleanup kicks each sibling exactly once, not once per continuation (round 7 finding 1)', async () => {
    budgets({ slice: 800, invocation: 800 });
    // A sibling export in the same 'export-inbox' store that fileA's cleanup fan-out will kick.
    const sib = await uploadConvs('r7f1-sib', [conv('r7f1sib', 0), conv('r7f1sib', 1)]);
    await deliverChain({ file_id: sib.fileId, r2_key: sib.r2Key, reason: 'upload', content_hash: sib.hash });
    expect(await fileState(sib.fileId)).toBe('parsed');

    // fileA: big, then replaced small so its reparse cleanup deletes ~10 stale sessions over MULTIPLE pages.
    const fileA = await uploadConvs('r7f1', Array.from({ length: 12 }, (_u, i) => conv('r7f1', i)));
    await deliverChain({ file_id: fileA.fileId, r2_key: fileA.r2Key, reason: 'upload', content_hash: fileA.hash });
    const replaced = await uploadConvs('r7f1', Array.from({ length: 2 }, (_u, i) => conv('r7f1', i)));

    // Count the recover fan-out sends aimed at THIS sibling specifically (hermetic against the other
    // export-inbox siblings the full-suite DB also carries — those don't touch sib.fileId).
    const sibRecoverSends = (): number => sent.filter((m) => m.file_id === sib.fileId && m.reason === 'recover').length;

    // Drive the WRITE phase to completion and stop at the first cleanup continuation: no delete or kick has
    // run yet, so the sibling is still 'parsed' and un-kicked (kickSiblings fires only in the cleanup loop).
    budgets({ slice: 8, invocation: 8 });
    const { stoppedCont } = await deliverChain(
      { file_id: replaced.fileId, r2_key: replaced.r2Key, reason: 'upload', content_hash: replaced.hash },
      { stopAtCleanup: true },
    );
    expect(stoppedCont).toBeDefined();
    expect(await fileState(sib.fileId)).toBe('parsed'); // not kicked during the write phase

    // Cleanup page 1: the first stale delete fires the fan-out ONCE, flipping the sibling 'parsed' → 'pending'.
    sent.length = 0;
    await deliver(stoppedCont!);
    expect(sibRecoverSends()).toBe(1); // POSITIVE CONTROL: page 1 kicks the sibling
    expect(await fileState(sib.fileId)).toBe('pending');
    const contB = sent.find((m) => m.file_id === replaced.fileId && typeof m.offset === 'number');
    expect(contB).toBeDefined(); // cleanup didn't drain in one page — there IS a second continuation

    // Cleanup page 2: kickSiblings runs again (the per-invocation `kicked` flag reset), but the query now
    // selects only parse_state='parsed' siblings, so the already-flipped 'pending' sibling is excluded and
    // issues ZERO further flip/send subrequests. Under the old `parse_state != 'error'` query it would be
    // re-kicked on every continuation — O(pages × siblings) duplicate recover work that could re-hit the cap.
    sent.length = 0;
    await deliver(contB!);
    expect(sibRecoverSends()).toBe(0); // finding 1 fix: no re-kick on the second page
  });

  it('a revertSlice failure during rollback still raises ExportRetry, never a terminal error (round 7 finding 2)', async () => {
    budgets({ slice: 20, invocation: 20 });
    const { fileId, hash, r2Key } = await uploadArchive('r7f2a', 5);

    // Reproduce the round-2-f1b write throw (7th batch = conversation 3's first batch; conversations 1-2 are
    // fully written and tracked in `written`), THEN make raiseExportRetry's revertSlice ALSO throw by failing
    // the prepare of its UPDATE. A second D1 failure DURING rollback must not escape as a non-sentinel error
    // (which the generic catch would turn into a terminal 'error' with stranded rows) — it's swallowed with a
    // structured log and ExportRetry is still raised.
    const REVERT_SQL = "UPDATE sessions SET index_state = 'parsing' WHERE session_id = ?1";
    const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
    testEnv.DB.prepare = ((sql: string) => {
      if (sql === REVERT_SQL) throw new Error('D1 outage during revertSlice');
      return realPrepare(sql);
    }) as typeof testEnv.DB.prepare;
    const restore = throwOnNthBatch(7);
    const flags = { acked: false, retried: false };
    const msg = {
      id: String(fileId),
      timestamp: new Date(),
      attempts: 1,
      body: { file_id: fileId, r2_key: r2Key, reason: 'upload' as const, content_hash: hash },
      ack() {
        flags.acked = true;
      },
      retry() {
        flags.retried = true;
      },
    };
    try {
      await worker.queue({ queue: 'parse', messages: [msg], ackAll() {}, retryAll() {} } as unknown as MessageBatch<ParseMessage>, testEnv);
    } finally {
      restore();
      testEnv.DB.prepare = realPrepare as typeof testEnv.DB.prepare;
    }

    // POSITIVE CONTROL: without the best-effort try/catch around revertSlice, its throw escapes
    // raiseExportRetry as a non-sentinel error → generic catch → markError → terminal 'error'. With it, the
    // failure is swallowed and ExportRetry is raised: the consumer retries and the file rests 'pending'.
    expect(flags.retried).toBe(true);
    expect(await fileState(fileId)).toBe('pending'); // NOT 'error'
    // revertSlice failed, so this slice's 2 written sessions stay 'ready'; the same-offset retry rewrites them.
    expect(await readyCount(fileId)).toBe(2);
  });

  it('a forcePending failure during rollback still raises ExportRetry, leaving the file non-terminal (round 7 finding 2)', async () => {
    budgets({ slice: 20, invocation: 20 });
    const { fileId, hash, r2Key } = await uploadArchive('r7f2b', 5);

    // Same write throw, but this time revertSlice succeeds and forcePending's UPDATE throws. A rollback that
    // can't re-assert 'pending' must still raise ExportRetry rather than fall through to a terminal 'error':
    // the file is already non-terminal ('pending' from upload), files/check re-enqueues it, and the sentinel
    // retries the same idempotent message — nothing is stranded.
    const FORCE_PENDING_SQL = "UPDATE files SET parse_state = 'pending' WHERE id = ?1 AND content_hash = ?2";
    const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
    testEnv.DB.prepare = ((sql: string) => {
      if (sql === FORCE_PENDING_SQL) throw new Error('D1 outage during forcePending');
      return realPrepare(sql);
    }) as typeof testEnv.DB.prepare;
    const restore = throwOnNthBatch(7);
    const flags = { acked: false, retried: false };
    const msg = {
      id: String(fileId),
      timestamp: new Date(),
      attempts: 1,
      body: { file_id: fileId, r2_key: r2Key, reason: 'upload' as const, content_hash: hash },
      ack() {
        flags.acked = true;
      },
      retry() {
        flags.retried = true;
      },
    };
    try {
      await worker.queue({ queue: 'parse', messages: [msg], ackAll() {}, retryAll() {} } as unknown as MessageBatch<ParseMessage>, testEnv);
    } finally {
      restore();
      testEnv.DB.prepare = realPrepare as typeof testEnv.DB.prepare;
    }

    // POSITIVE CONTROL: without the best-effort try/catch around forcePending, its throw escapes → generic
    // catch → markError → terminal 'error'. With it, ExportRetry is raised and the file stays 'pending'.
    expect(flags.retried).toBe(true);
    expect(await fileState(fileId)).toBe('pending'); // non-terminal, NOT 'error'
    // revertSlice ran fine, so this slice's writes were rolled back to 'parsing'.
    expect(await readyCount(fileId)).toBe(0);
  });

  it('reserves the invocation budget before a NORMAL parse, deferring the next when headroom is short (round 8)', async () => {
    // NORMAL_RESERVE (18) is nearly the whole invocation budget (20), so after the first transcript runs and
    // charges its actual cost, the reservation for a second normal parse crosses the cap → it must be
    // DEFERRED before ever entering parseOne (reserve-on-attempt), not started and caught post-hoc.
    budgets({ invocation: 20, normalReserve: 18 });
    const heavy = await uploadClaudeWeb('r8heavy', 12);
    const next = await uploadClaudeWeb('r8next', 2);

    const flags: Record<number, { acked: boolean; retried: boolean }> = {};
    sent.length = 0;
    await worker.queue(
      { queue: 'parse', messages: [batchMsg(heavy, flags), batchMsg(next, flags)], ackAll() {}, retryAll() {} } as unknown as MessageBatch<ParseMessage>,
      testEnv,
    );

    // The first (sole-eligible) message always runs — the livelock exception. `next` is deferred: ACKed and
    // re-enqueued as a fresh copy, with parseOne never invoked for it.
    expect(await fileState(heavy.fileId)).toBe('parsed');
    expect(flags[next.fileId]).toEqual({ acked: true, retried: false });
    // POSITIVE CONTROL: without reserve-on-attempt, `next` enters parseOne and writes its session before the
    // post-hoc budget check fires. Reserving first defers it untouched — no session, file still 'pending'.
    expect(await ownedSessions(next.fileId)).toBe(0);
    expect(await fileState(next.fileId)).toBe('pending');
    expect(sent.some((m) => m.file_id === next.fileId && m.offset === undefined)).toBe(true); // fresh re-enqueue
  });

  it('pins the file hash onto continuations of a legacy (no-hash) export message (round 8)', async () => {
    budgets({ slice: 8, invocation: 8 });
    const up = await uploadConvs('r8f2', Array.from({ length: 6 }, (_u, i) => conv('r8f2', i)));

    // Deliver the FIRST slice as a LEGACY message: content_hash undefined, as if enqueued before the field
    // existed. It writes a slice and enqueues a continuation.
    sent.length = 0;
    await deliver({ file_id: up.fileId, r2_key: up.r2Key, reason: 'upload' });
    const cont = sent.find((m) => m.file_id === up.fileId && typeof m.offset === 'number');
    expect(cont).toBeDefined();

    // POSITIVE CONTROL: without the pin, this continuation carries content_hash undefined, disabling every
    // per-slice recheck / cleanup guard for the rest of the parse. The pin stamps the file's parse-start hash.
    expect(cont!.content_hash).toBe(up.hash);

    // Re-upload DIFFERENT bytes to the SAME row between slices → its hash moves on. Delivering the pinned
    // continuation now trips the pre-write hash recheck (active ONLY because of the pin) and no-ops: the stale
    // slice does not resume against the new bytes and does not mark the file 'parsed' — the fresh upload owns it.
    const reup = await uploadConvs('r8f2', Array.from({ length: 3 }, (_u, i) => conv('r8f2', i)));
    expect(reup.fileId).toBe(up.fileId); // same machine+relpath → same row, new hash
    await deliver(cont!);
    expect(await fileState(up.fileId)).toBe('pending'); // guard fired; NOT falsely 'parsed'
  });

  it('skips the sibling kick when the hash changes just before it, sending no stale recover work (round 8)', async () => {
    budgets({ slice: 800, invocation: 800 });
    const sib = await uploadConvs('r8f1-sib', [conv('r8f1sib', 0), conv('r8f1sib', 1)]);
    await deliverChain({ file_id: sib.fileId, r2_key: sib.r2Key, reason: 'upload', content_hash: sib.hash });
    expect(await fileState(sib.fileId)).toBe('parsed');

    const fileA = await uploadConvs('r8f1', Array.from({ length: 8 }, (_u, i) => conv('r8f1', i)));
    await deliverChain({ file_id: fileA.fileId, r2_key: fileA.r2Key, reason: 'upload', content_hash: fileA.hash });
    const replaced = await uploadConvs('r8f1', Array.from({ length: 2 }, (_u, i) => conv('r8f1', i)));

    // Drive to the first cleanup continuation: writes done, nothing deleted or kicked yet.
    budgets({ slice: 8, invocation: 8 });
    const { stoppedCont } = await deliverChain(
      { file_id: replaced.fileId, r2_key: replaced.r2Key, reason: 'upload', content_hash: replaced.hash },
      { stopAtCleanup: true },
    );
    expect(stoppedCont).toBeDefined();

    // Simulate a changed-hash re-upload landing in the narrow window AFTER the per-page recheck passes but
    // BEFORE the kick: flip ONLY the kick-guard's own hash read (the last content_hash read of this cleanup
    // invocation) to a mismatch. Earlier reads (pre-write, post-write, per-page) still return the real hash.
    const HASH_SQL = 'SELECT content_hash FROM files WHERE id = ?1';
    const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
    let reads = 0;
    const FLIP_ON = 4;
    testEnv.DB.prepare = ((sql: string) => {
      const stmt = realPrepare(sql);
      if (sql !== HASH_SQL) return stmt;
      const realBind = stmt.bind.bind(stmt);
      stmt.bind = (...a: unknown[]) => {
        const bound = realBind(...a);
        const realFirst = bound.first.bind(bound);
        (bound as unknown as Record<string, unknown>).first = async (...x: unknown[]) => {
          reads++;
          if (reads === FLIP_ON) return { content_hash: 'sha256:changed-by-a-concurrent-reupload' };
          return (realFirst as (...y: unknown[]) => unknown)(...x);
        };
        return bound;
      };
      return stmt;
    }) as typeof testEnv.DB.prepare;

    sent.length = 0;
    try {
      await deliver(stoppedCont!);
    } finally {
      testEnv.DB.prepare = realPrepare as typeof testEnv.DB.prepare;
    }

    // POSITIVE CONTROL: the kick fires BEFORE the first delete, so without the pre-kick hash guard the
    // sibling recover message goes out even though the delete then no-ops on the changed hash — leaving the
    // sibling to re-claim and serve stale content. The guard skips the kick entirely (zero recover sends) and
    // reverts this file's owned rows, letting the fresh upload's message own the reparse.
    expect(sent.some((m) => m.file_id === sib.fileId && m.reason === 'recover')).toBe(false);
    expect(await fileState(sib.fileId)).toBe('parsed'); // sibling untouched, never kicked to 'pending'
  });

  it('cleanup deletes are atomic hash-guarded: a hash flip between the recheck and the delete batch no-ops them (round 4 finding 3)', async () => {
    budgets({ slice: 800, invocation: 800 });
    const first = await uploadConvs('atom', Array.from({ length: 5 }, (_u, i) => conv('atom', i)));
    await deliverChain({ file_id: first.fileId, r2_key: first.r2Key, reason: 'upload', content_hash: first.hash });
    expect(await ownedSessions(first.fileId)).toBe(5);

    // Replace with 1 conversation → 4 stale to delete; a small budget still writes it + reaches cleanup in
    // one invocation, so the per-page recheck (the 3rd content_hash read) is where we flip the hash.
    const replaced = await uploadConvs('atom', [conv('atom', 0)]);
    budgets({ slice: 20, invocation: 20 });

    // Let the pre-write and post-write and per-page rechecks all read the CURRENT (matching) hash, then flip
    // the stored hash right after the per-page recheck (the 3rd `SELECT content_hash` read) — i.e. a
    // changed-hash upload landing AFTER the recheck but BEFORE the delete batch. The batch's embedded
    // `EXISTS (content_hash = expected)` guard must make every delete no-op in that same transaction.
    const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
    let hashReads = 0;
    testEnv.DB.prepare = ((sql: string) => {
      const stmt = realPrepare(sql);
      if (sql !== 'SELECT content_hash FROM files WHERE id = ?1') return stmt;
      const realBind = stmt.bind.bind(stmt);
      stmt.bind = (...a: unknown[]) => {
        const bound = realBind(...a);
        const realFirst = bound.first.bind(bound);
        (bound as unknown as Record<string, unknown>).first = async (...x: unknown[]) => {
          hashReads++;
          const res = await (realFirst as (...y: unknown[]) => Promise<unknown>)(...x);
          if (hashReads === 3) {
            await realPrepare('UPDATE files SET content_hash = ?2 WHERE id = ?1').bind(replaced.fileId, 'sha256:flipped-mid-cleanup').run();
          }
          return res;
        };
        return bound;
      };
      return stmt;
    }) as typeof testEnv.DB.prepare;
    try {
      await deliver({ file_id: replaced.fileId, r2_key: replaced.r2Key, reason: 'upload', content_hash: replaced.hash });
    } finally {
      testEnv.DB.prepare = realPrepare as typeof testEnv.DB.prepare;
    }

    // POSITIVE CONTROL: without the per-statement `EXISTS (content_hash = expected)` guard, the deletes run
    // against the (now stale) recheck and remove the 4 dropped conversations. The atomic guard no-ops them,
    // so all 5 sessions survive and the file is not parsed (markParsed's own hash guard also fails).
    expect(await ownedSessions(replaced.fileId)).toBe(5); // nothing deleted
    expect(await fileState(replaced.fileId)).not.toBe('parsed');
  });
});
