import { SELF, env as testEnvRaw } from 'cloudflare:test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { __setExportBudgetsForTest, EXPORT_SEND_FAILURE_LIMIT } from '../src/ingest/consumer';
import { CLAUDE_WEB_ROOT, claudeExportZip, claudeWebConversation, type ClaudeConvOpts, type ClaudeWebMessage } from './web-fixtures';

const testEnv = testEnvRaw as unknown as Env;

// The prod slice/invocation budgets (~800 subrequests) leave far too much headroom to trigger slicing,
// cleanup-chunking or deferral with tiny synthetic fixtures. So each test dials the SUBREQUEST budgets down
// via __setExportBudgetsForTest — small enough that a handful of 2-block conversations (~5 subrequests
// each) span multiple slices. `budgets()` resets ALL four knobs every call (so tests are order-independent
// no matter what the previous one set), with a small default a test overrides per case. afterAll restores
// prod values. NOTE: the cost accounting is SUBREQUESTS (each db.batch/.first/.run is ONE), not statements —
// see the counting-model note on writeSession; a 180-block conversation costs ~5 subrequests, not ~180.
const PROD_BUDGETS = { slice: 800, invocation: 800, ceiling: 700, cap: 900, normalReserve: 128, kickPage: 50 };
function budgets(o: { slice?: number; invocation?: number; ceiling?: number; cap?: number; normalReserve?: number; kickPage?: number } = {}): void {
  __setExportBudgetsForTest({ slice: 20, invocation: 20, ceiling: 700, cap: 900, normalReserve: 8, kickPage: 50, ...o });
}
afterAll(() => __setExportBudgetsForTest(PROD_BUDGETS));

// Test hygiene for the round-14 per-store cleanup serialization: siblings a prior test RESERVED linger
// 'reserved' in the shared 'export-inbox' store (deliverChain never drains their recover messages), and
// because the whole suite runs in seconds their reserved_at stays < STALE_RESERVATION_MS — so without this,
// a later test's stale cleanup would treat that leftover as a live contending cleanup and defer forever
// (deliverChain follows the defer continuation endlessly). Clearing reserved_at before each test makes those
// leftovers look abandoned (they still heal normally); a test's OWN in-flight reservations are set fresh
// within the test, so real contention is still exercised. Production drains reservations promptly via
// send-late; only a crash leaves one, and staleness (not a test hook) reclaims it there.
beforeEach(async () => {
  await testEnv.DB.prepare("UPDATE files SET reserved_at = NULL, reserved_by = NULL WHERE reserved_at IS NOT NULL OR reserved_by IS NOT NULL").run();
});

// A reserved_by owner id no file under test can have (autoincrement ids start at 1). Stamped on manually-created
// reservations to stand in for "some OTHER live cleanup owns the store", so the contention probe's
// `reserved_by != file.id` matches them without wiring up a second real cleanup file.
const OTHER_OWNER = 2_000_000_000;

// Capture continuation re-enqueues so we can deliver them one slice at a time and assert the file is
// never 'parsed' until the LAST slice lands.
const sent: ParseMessage[] = [];
beforeAll(() => {
  // Record every enqueue into `sent`, but do NOT forward to the real miniflare queue. This suite drives
  // delivery EXPLICITLY (deliver / deliverChain call worker.queue with the exact message), so forwarding
  // would enqueue continuation / recover / defer messages that miniflare's consumer then auto-drains in the
  // BACKGROUND during LATER tests — a prior test's cleanup would run mid-way through an unrelated test and
  // reserve its freshly-created siblings under a foreign reserved_by, which the round-14 owner-scoped
  // send-late then can't see (order-dependent flakes). Not forwarding makes delivery fully deterministic.
  testEnv.PARSE_QUEUE.send = (async (msg: ParseMessage) => {
    sent.push(msg);
  }) as unknown as typeof testEnv.PARSE_QUEUE.send;
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

async function uploadConvs(tag: string, convs: ClaudeConvOpts[], mtime = '2026-07-01T12:00:00Z'): Promise<{ fileId: number; hash: string; r2Key: string }> {
  const zip = claudeExportZip(convs);
  const hash = await sha256Hex(zip);
  const relpath = `claude-export-${tag}.zip`;
  const machine = `bnd-${tag}`;
  const res = await SELF.fetch(`https://api.sessions.vza.net/api/v1/files/${machine}/export-inbox/${encodeURIComponent(relpath)}`, {
    method: 'PUT',
    headers: {
      'x-dev-machine': machine,
      'x-content-hash': `sha256:${hash}`,
      'x-file-mtime': mtime,
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

async function canonicalOwner(sessionId: string): Promise<number | null> {
  const r = await testEnv.DB.prepare('SELECT canonical_file_id FROM sessions WHERE session_id = ?1').bind(sessionId).first<{ canonical_file_id: number | null }>();
  return r?.canonical_file_id ?? null;
}

// Re-PUT arbitrary bytes to an existing export row's machine+relpath — a corrupt re-upload (new hash, SAME
// row) that parses to `valid: false` and drives failExportFile. Returns the row's stored content hash.
async function reuploadRawExport(tag: string, bytes: Uint8Array): Promise<string> {
  const hash = await sha256Hex(bytes);
  const relpath = `claude-export-${tag}.zip`;
  const machine = `bnd-${tag}`;
  const res = await SELF.fetch(`https://api.sessions.vza.net/api/v1/files/${machine}/export-inbox/${encodeURIComponent(relpath)}`, {
    method: 'PUT',
    headers: { 'x-dev-machine': machine, 'x-content-hash': `sha256:${hash}`, 'x-file-mtime': '2026-07-02T12:00:00Z', 'content-length': String(bytes.length) },
    body: bytes,
  });
  expect(res.status).toBe(201);
  const row = await testEnv.DB.prepare('SELECT content_hash FROM files WHERE machine_id = ?1 AND relpath = ?2').bind(machine, relpath).first<{ content_hash: string }>();
  return row!.content_hash;
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

    // The reparse writes the 2 kept convs across bounded slices, then defers a PURE cleanup continuation.
    // Drive the write continuations to reach that first cleanup continuation (writes done, nothing deleted yet).
    // The re-upload flipped the file's prior sessions out of 'ready', so only the 2 just-rewritten convs are
    // 'ready' now; the 8 dropped ones are stale rows cleanup will delete.
    sent.length = 0;
    const { stoppedCont: cleanupCont } = await deliverChain(
      { file_id: replaced.fileId, r2_key: replaced.r2Key, reason: 'upload', content_hash: replaced.hash },
      { stopAtCleanup: true },
    );
    expect(cleanupCont).toBeDefined();
    const readyBefore = await readyCount(replaced.fileId); // the 2 rewritten convs
    expect(readyBefore).toBe(2);

    // Deliver the cleanup continuation and make the first stale-DELETE batch throw — specifically the DELETE,
    // AFTER the reserve flip commits. The store may hold sibling archives this cleanup reserves first (their
    // flip batches precede the deletes), so we can't just trip batch #1; tag the guarded stale-delete statement
    // and trip db.batch only when it carries that statement. Landing the throw past a COMMITTED reservation is
    // what makes this a positive control for reserved_by: the retry must proceed through its OWN fresh
    // reservations, not deadlock on them. Budget 800 so the reserve pass (over any sibling pollution) clears
    // before the delete the throw targets.
    budgets({ slice: 800, invocation: 800 });
    const DELETE_SQL = 'DELETE FROM sessions WHERE session_id = ?1 AND EXISTS (SELECT 1 FROM files WHERE id = ?2 AND content_hash = ?3)';
    const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
    const realBatch = testEnv.DB.batch.bind(testEnv.DB);
    const deleteStmts = new WeakSet<object>();
    let deleteThrown = false;
    testEnv.DB.prepare = ((sql: string) => {
      const stmt = realPrepare(sql);
      if (sql !== DELETE_SQL) return stmt;
      const realBind = stmt.bind.bind(stmt);
      stmt.bind = (...a: unknown[]) => {
        const bound = realBind(...a);
        deleteStmts.add(bound as object);
        return bound;
      };
      return stmt;
    }) as typeof testEnv.DB.prepare;
    testEnv.DB.batch = ((stmts: unknown[]) => {
      if (!deleteThrown && Array.isArray(stmts) && stmts.some((s) => deleteStmts.has(s as object))) {
        deleteThrown = true;
        throw new Error('D1 outage on stale-delete batch');
      }
      return realBatch(stmts as never);
    }) as typeof testEnv.DB.batch;
    try {
      await deliver(cleanupCont!);
    } finally {
      testEnv.DB.prepare = realPrepare as typeof testEnv.DB.prepare;
      testEnv.DB.batch = realBatch as typeof testEnv.DB.batch;
    }
    expect(deleteThrown).toBe(true); // the throw actually landed on a stale-delete batch

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

  it('a reservation SELECT failure is retryable, not swallowed into a false parsed (round 6 finding 4)', async () => {
    // The sibling RESERVE pass runs only after the scan finds a stale session. A D1 outage in its sibling
    // SELECT must NOT be swallowed (which would let THIS file reach 'parsed' with the stale session deleted
    // and no sibling reserved) — it propagates to the retryable wrapper → 'pending'.
    budgets({ slice: 800, invocation: 800 });
    const first = await uploadConvs('r6f4', Array.from({ length: 6 }, (_u, i) => conv('r6f4', i)));
    await deliverChain({ file_id: first.fileId, r2_key: first.r2Key, reason: 'upload', content_hash: first.hash });
    expect(await ownedSessions(first.fileId)).toBe(6);
    const replaced = await uploadConvs('r6f4', Array.from({ length: 2 }, (_u, i) => conv('r6f4', i)));

    // Make the RESERVE-phase sibling SELECT throw (it fires only after the scan hits the first stale session).
    const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
    const RESERVE_SQL = "SELECT id, content_hash FROM files WHERE store = ?1 AND id != ?2 AND id > ?3 AND parse_state = 'parsed' ORDER BY id ASC LIMIT ?4";
    testEnv.DB.prepare = ((sql: string) => {
      if (sql === RESERVE_SQL) {
        return { bind: () => ({ all: async () => { throw new Error('D1 outage on reservation SELECT'); } }) } as unknown as D1PreparedStatement;
      }
      return realPrepare(sql);
    }) as typeof testEnv.DB.prepare;
    try {
      await deliver({ file_id: replaced.fileId, r2_key: replaced.r2Key, reason: 'upload', content_hash: replaced.hash });
    } finally {
      testEnv.DB.prepare = realPrepare as typeof testEnv.DB.prepare;
    }

    // POSITIVE CONTROL: a swallowed reservation SELECT throw would let the file reach 'parsed' with stale
    // rows deleted and no sibling reserved. It propagates to the wrapper → the file rests 'pending', never
    // falsely parsed — and because the throw is in the RESERVE pass (before any delete), nothing was deleted.
    expect(await fileState(replaced.fileId)).toBe('pending');
    expect(await ownedSessions(replaced.fileId)).toBe(6); // reservation failed before any delete
  });

  it('reserves sibling archives BEFORE deleting stale sessions, so a reservation-flip failure deletes nothing and loses no sibling (round 6 finding 4, reserve-before-delete)', async () => {
    budgets({ slice: 800, invocation: 800 });
    // A sibling export in the same 'export-inbox' store, so fileA's reservation has a sibling to flip.
    const sib = await uploadConvs('r6kbd-sib', [conv('r6kbdsib', 0), conv('r6kbdsib', 1)]);
    await deliverChain({ file_id: sib.fileId, r2_key: sib.r2Key, reason: 'upload', content_hash: sib.hash });
    expect(await fileState(sib.fileId)).toBe('parsed');

    // fileA: big, then replaced small so its reparse cleanup deletes 4 stale sessions (fires the reservation).
    const fileA = await uploadConvs('r6kbd', Array.from({ length: 6 }, (_u, i) => conv('r6kbd', i)));
    await deliverChain({ file_id: fileA.fileId, r2_key: fileA.r2Key, reason: 'upload', content_hash: fileA.hash });
    const replaced = await uploadConvs('r6kbd', Array.from({ length: 2 }, (_u, i) => conv('r6kbd', i)));

    // Make the db.batch that reserves SIB (the hash-pinned reserve flip, bound to sib.fileId) throw ONCE.
    // Tag sib's flip statement in a WeakSet and trip the batch only when it carries that statement — keeps the
    // test hermetic against the other export-inbox siblings the same reservation also flips in a full-suite run.
    const FLIP_SQL = "UPDATE files SET parse_state = 'reserved', reserved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), reserved_by = ?3 WHERE id = ?1 AND parse_state = 'parsed' AND content_hash = ?2";
    const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
    const realBatch = testEnv.DB.batch.bind(testEnv.DB);
    const sibFlip = new WeakSet<object>();
    let sibFlipThrown = false;
    testEnv.DB.prepare = ((sql: string) => {
      const stmt = realPrepare(sql);
      if (sql !== FLIP_SQL) return stmt;
      const realBind = stmt.bind.bind(stmt);
      stmt.bind = (...a: unknown[]) => {
        const bound = realBind(...a);
        if (a[0] === sib.fileId) sibFlip.add(bound as object);
        return bound;
      };
      return stmt;
    }) as typeof testEnv.DB.prepare;
    testEnv.DB.batch = ((stmts: unknown[]) => {
      if (!sibFlipThrown && Array.isArray(stmts) && stmts.some((s) => sibFlip.has(s as object))) {
        sibFlipThrown = true;
        throw new Error('D1 outage on sibling reservation flip');
      }
      return realBatch(stmts as never);
    }) as typeof testEnv.DB.batch;
    try {
      // First cleanup delivery: the reservation flip throws BEFORE any stale delete → retryable, nothing deleted.
      await deliver({ file_id: replaced.fileId, r2_key: replaced.r2Key, reason: 'upload', content_hash: replaced.hash });

      // POSITIVE CONTROL for reserve-BEFORE-delete: because the reservation runs (and must fully commit)
      // before the first delete, a flip failure leaves every stale session intact (fileA still owns all 6).
      // "Delete a stale session before its sibling is at least 'pending'" is exactly what this ordering kills.
      expect(await fileState(replaced.fileId)).toBe('pending');
      expect(await ownedSessions(replaced.fileId)).toBe(6); // nothing deleted before the reservation committed

      // Retry (flip works now): siblings reserved 'pending' FIRST, THEN stale deleted → fileA parsed.
      await deliverChain({ file_id: replaced.fileId, r2_key: replaced.r2Key, reason: 'upload', content_hash: replaced.hash });
    } finally {
      testEnv.DB.prepare = realPrepare as typeof testEnv.DB.prepare;
      testEnv.DB.batch = realBatch as typeof testEnv.DB.batch;
    }
    expect(await fileState(replaced.fileId)).toBe('parsed');
    expect(await ownedSessions(replaced.fileId)).toBe(2);
    expect(await fileState(sib.fileId)).toBe('reserved'); // sibling reserved (recover queued), never stranded terminal
  });

  it('enqueues NO recover message until cleanup fully drains; siblings sit reserved as pending meanwhile (round 11, flip-early/send-late ordering)', async () => {
    budgets({ slice: 800, invocation: 800 });
    // A sibling export in the same 'export-inbox' store that fileA's reservation will flip to 'pending'.
    const sib = await uploadConvs('r11ord-sib', [conv('r11ordsib', 0)]);
    await deliverChain({ file_id: sib.fileId, r2_key: sib.r2Key, reason: 'upload', content_hash: sib.hash });
    expect(await fileState(sib.fileId)).toBe('parsed');

    // fileA: big, then replaced small so its reparse deletes ~10 stale sessions across MANY invocations.
    const fileA = await uploadConvs('r11ord', Array.from({ length: 12 }, (_u, i) => conv('r11ord', i)));
    await deliverChain({ file_id: fileA.fileId, r2_key: fileA.r2Key, reason: 'upload', content_hash: fileA.hash });
    const replaced = await uploadConvs('r11ord', Array.from({ length: 2 }, (_u, i) => conv('r11ord', i)));

    // Tight budget so cleanup (reserve + ~10 deletes) spans MANY invocations. Drive every continuation,
    // asserting on each pre-completion invocation that the sibling is RESERVED but NO recover message
    // (to any sibling) has gone out yet.
    budgets({ slice: 6, invocation: 6, kickPage: 50 });
    let msg: ParseMessage = { file_id: replaced.fileId, r2_key: replaced.r2Key, reason: 'upload', content_hash: replaced.hash };
    let sawReserved = false;
    let recoverBeforeParsed = 0;
    for (let i = 0; i < 80; i++) {
      sent.length = 0;
      await deliver(msg);
      if ((await fileState(replaced.fileId)) !== 'parsed') {
        recoverBeforeParsed += sent.filter((m) => m.reason === 'recover').length; // must stay 0 until cleanup completes
        if ((await fileState(sib.fileId)) === 'reserved') sawReserved = true; // reserved, not yet messaged
      }
      const cont = sent.find((m) => m.file_id === replaced.fileId && typeof m.offset === 'number');
      if (!cont) break;
      msg = cont;
    }
    // ORDERING (round 11/12): the sibling is RESERVED (durable 'reserved' state) during cleanup, but NO recover
    // message is enqueued until cleanup fully drains and the file is 'parsed'. POSITIVE CONTROL — under the old
    // flip+send-together kick, page-1 recover messages went out mid-cleanup (recoverBeforeParsed > 0), racing
    // ahead of the cleanup continuation so a recover parse could skip a still-owned stale row and never re-claim
    // it. (That send-late DOES fire after markParsed is covered by the round-9-finding-4 and send-late tests.)
    expect(await fileState(replaced.fileId)).toBe('parsed');
    expect(sawReserved).toBe(true); // sibling reserved during cleanup
    expect(recoverBeforeParsed).toBe(0); // zero recover sends before cleanupComplete
    expect(await fileState(sib.fileId)).toBe('reserved'); // left reserved for send-late / files-check recovery
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

    // A changed-hash re-upload of OUR file lands just as cleanup begins — BEFORE the first stale reserves any
    // sibling. A re-upload DURABLY changes files.content_hash, so model it by returning the changed hash for
    // OUR file's content_hash reads, gated to fire ONLY once the cleanup SCAN has begun. The gate is a stable
    // SEMANTIC marker — the cleanup page SELECT (which opens the scan loop) — not an Nth read that shifts with
    // reserve/kick recheck counts. The scan's superseded recheck runs immediately after that page SELECT and
    // BEFORE the per-session loop that reserves, so it bails to superseded first: the sibling is never flipped
    // to 'reserved' and no recover is sent. Writes (which run before the cleanup page SELECT) still read the
    // real hash and complete normally. (The post-markParsed send-late hash guard is a separate window, covered
    // by the 3608692134 test below.)
    budgets({ slice: 8, invocation: 8 });
    const HASH_SQL = 'SELECT content_hash FROM files WHERE id = ?1';
    const CLEANUP_PAGE_SQL = 'SELECT session_id FROM sessions WHERE canonical_file_id = ?1 AND session_id > ?2 ORDER BY session_id ASC LIMIT ?3';
    const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
    let inCleanupScan = false;
    testEnv.DB.prepare = ((sql: string) => {
      const stmt = realPrepare(sql);
      if (sql === CLEANUP_PAGE_SQL) {
        const realBind = stmt.bind.bind(stmt);
        stmt.bind = (...a: unknown[]) => {
          if (a[0] === replaced.fileId) inCleanupScan = true; // entered OUR cleanup scan loop
          return realBind(...a);
        };
        return stmt;
      }
      if (sql !== HASH_SQL) return stmt;
      const realBind = stmt.bind.bind(stmt);
      stmt.bind = (...a: unknown[]) => {
        const bound = realBind(...a);
        if (a[0] !== replaced.fileId) return bound; // only OUR file's hash moved; siblings read real
        const realFirst = bound.first.bind(bound);
        (bound as unknown as Record<string, unknown>).first = async (...x: unknown[]) =>
          inCleanupScan ? { content_hash: 'sha256:changed-by-a-concurrent-reupload' } : (realFirst as (...y: unknown[]) => unknown)(...x);
        return bound;
      };
      return stmt;
    }) as typeof testEnv.DB.prepare;

    // Drive the whole chain with the injection active. Writes complete across bounded slices; the invocation
    // that enters cleanup trips the gate and bails to superseded (reverting our rows, no continuation).
    const allSent: ParseMessage[] = [];
    let msg: ParseMessage = { file_id: replaced.fileId, r2_key: replaced.r2Key, reason: 'upload', content_hash: replaced.hash };
    try {
      for (;;) {
        sent.length = 0;
        await deliver(msg);
        allSent.push(...sent);
        const cont = sent.find((m) => m.file_id === replaced.fileId && typeof m.offset === 'number');
        if (!cont) break;
        msg = cont;
      }
    } finally {
      testEnv.DB.prepare = realPrepare as typeof testEnv.DB.prepare;
    }

    // POSITIVE CONTROL: the scan superseded recheck runs BEFORE the reserve flip. Without it, the cleanup would
    // flip the sibling to 'reserved' (kicking it) and send-late/delete against bytes this file no longer owns.
    // The guard bails to superseded first — reverting this file's owned rows and leaving the fresh upload's
    // message to own the reparse — so the sibling is NEVER reserved (stays 'parsed') and NO recover goes out.
    expect(allSent.some((m) => m.file_id === sib.fileId && m.reason === 'recover')).toBe(false);
    expect(await fileState(sib.fileId)).toBe('parsed'); // sibling untouched, never kicked to 'reserved'/'pending'
  });

  it('does not error an oversized conversation owned by another archive (round 9 finding 1)', async () => {
    budgets({ slice: 800, invocation: 800, ceiling: 4, cap: 5 });
    const convTag = 'r9f1x';
    const a = await uploadConvs('r9f1-a', [conv(convTag, 0)]);
    await deliverChain({ file_id: a.fileId, r2_key: a.r2Key, reason: 'upload', content_hash: a.hash });
    const xId = `bnd-${convTag}-conv-0`;
    expect(await canonicalOwner(xId)).toBe(a.fileId);
    // Make X non-healthy-ready so B's healthy-owner skip (finding 3a) doesn't fire and B reaches the
    // oversized branch for it (simulating A mid-reparse — still A's row).
    await testEnv.DB.prepare("UPDATE sessions SET index_state = 'parsing' WHERE session_id = ?1").bind(xId).run();

    // B carries an OVERSIZED (> cap) version of the SAME conversation; B has never written or owned it.
    const b = await uploadConvs('r9f1-b', [heavyConv(convTag, 0, 200)]);
    await deliver({ file_id: b.fileId, r2_key: b.r2Key, reason: 'upload', content_hash: b.hash });

    // POSITIVE CONTROL: the unqualified UPDATE flipped ANY row for this session id to 'error', reporting A's
    // good data broken. Qualified by canonical_file_id, B leaves A's row untouched and still completes.
    expect(await canonicalOwner(xId)).toBe(a.fileId); // still owned by A
    expect(await sessionState(xId)).toBe('parsing'); // NOT flipped to 'error'
    expect(await fileState(b.fileId)).toBe('parsed'); // B still finishes
  });

  it('cuts before an oversized conversation that only follows skipped lookups (round 9 finding 2)', async () => {
    budgets({ slice: 800, invocation: 800, ceiling: 4, cap: 900 });
    // Owner archive owns S0, S1 healthy, so B SKIPS them (spending a lookup each, writing nothing).
    const owner = await uploadConvs('r9f2-own', [conv('r9f2s', 0), conv('r9f2s', 1)]);
    await deliverChain({ file_id: owner.fileId, r2_key: owner.r2Key, reason: 'upload', content_hash: owner.hash });
    // B: [S0(skipped), S1(skipped), Big(oversized-ceiling)].
    const b = await uploadConvs('r9f2-b', [conv('r9f2s', 0), conv('r9f2s', 1), heavyConv('r9f2big', 0, 100)]);
    const bigId = 'bnd-r9f2big-conv-0';
    sent.length = 0;
    await deliver({ file_id: b.fileId, r2_key: b.r2Key, reason: 'upload', content_hash: b.hash });

    // POSITIVE CONTROL: gating on written.size (0 here — S0/S1 were skipped) let Big write in this slice
    // after the two lookups. spentBefore counts those lookups, so Big is CUT to its own invocation.
    expect(await sessionState(bigId)).toBe(null); // not written this slice
    const cont = sent.find((m) => m.file_id === b.fileId && typeof m.offset === 'number');
    expect(cont?.offset).toBe(2); // resumes AT Big (index 2), after the two skipped convs
    await deliverChain({ file_id: b.fileId, r2_key: b.r2Key, reason: 'upload', content_hash: b.hash });
    expect(await sessionState(bigId)).toBe('ready'); // written alone next invocation
  });

  it('writes a LEADING oversized conversation alone rather than livelocking (round 9 finding 2 livelock)', async () => {
    budgets({ slice: 800, invocation: 800, ceiling: 4, cap: 900 });
    const b = await uploadConvs('r9f2lead', [heavyConv('r9f2lead', 0, 100)]);
    const bigId = 'bnd-r9f2lead-conv-0';
    await deliver({ file_id: b.fileId, r2_key: b.r2Key, reason: 'upload', content_hash: b.hash });
    // spentBefore is 0 for the FIRST conversation (its own lookup excluded), so it is written ALONE instead
    // of cutting into an infinite same-offset loop (the livelock a bare `spent > 0` gate would cause).
    expect(await sessionState(bigId)).toBe('ready');
    expect(await fileState(b.fileId)).toBe('parsed');
  });

  it('a recover send failure after cleanup leaves the sibling reserved as pending; the file stays parsed, no compensation (round 11, send-late best-effort)', async () => {
    budgets({ slice: 800, invocation: 800, kickPage: 500 });
    const sib = await uploadConvs('r11sl-sib', [conv('r11slsib', 0), conv('r11slsib', 1)]);
    await deliverChain({ file_id: sib.fileId, r2_key: sib.r2Key, reason: 'upload', content_hash: sib.hash });
    expect(await fileState(sib.fileId)).toBe('parsed');

    const fileA = await uploadConvs('r11sl', Array.from({ length: 4 }, (_u, i) => conv('r11sl', i)));
    await deliverChain({ file_id: fileA.fileId, r2_key: fileA.r2Key, reason: 'upload', content_hash: fileA.hash });
    const replaced = await uploadConvs('r11sl', [conv('r11sl', 0)]);

    // Make the SEND-LATE recover message to sib throw. Unlike the deleted flip+send compensation, this runs
    // AFTER markParsed: sib is already reserved 'pending', so a lost send just leaves it 'pending' for
    // files/check to heal — nothing to compensate, and the file must stay terminally 'parsed'.
    const realSend = testEnv.PARSE_QUEUE.send;
    let sibRecoverSends = 0;
    testEnv.PARSE_QUEUE.send = (async (m: ParseMessage) => {
      if (m.file_id === sib.fileId && m.reason === 'recover') {
        sibRecoverSends += 1;
        throw new Error('queue send outage on recover');
      }
      return (realSend as (b: ParseMessage) => Promise<unknown>)(m);
    }) as typeof testEnv.PARSE_QUEUE.send;
    try {
      await deliver({ file_id: replaced.fileId, r2_key: replaced.r2Key, reason: 'upload', content_hash: replaced.hash });
    } finally {
      testEnv.PARSE_QUEUE.send = realSend;
    }
    // POSITIVE CONTROL: the old flip+send-together kick raised ExportRetry on a recover send failure (file →
    // 'pending', re-kick + compensation). Send-late is best-effort: the send was attempted and failed, but the
    // file rests terminally 'parsed' (cleanup already committed) and the sibling stays a durable 'pending'
    // reservation files/check heals — never reverted, never stranded terminal.
    expect(sibRecoverSends).toBeGreaterThan(0); // the send was attempted
    expect(await fileState(replaced.fileId)).toBe('parsed'); // terminal, NOT reverted to pending
    expect(await fileState(sib.fileId)).toBe('reserved'); // reserved + healable (files/check re-enqueues it)
  });

  it('the reservation flip is hash-pinned: a sibling re-uploaded (new hash) since the reserve SELECT is never flipped (round 10 hash pin, on the reserve flip)', async () => {
    budgets({ slice: 800, invocation: 800, kickPage: 500 });
    // sib parsed at hashV1, then re-uploaded + reparsed to hashV2 (fresh content, still 'parsed').
    const sib = await uploadConvs('r10hp-sib', [conv('r10hpsib', 0)]);
    await deliverChain({ file_id: sib.fileId, r2_key: sib.r2Key, reason: 'upload', content_hash: sib.hash });
    const hashV1 = sib.hash;
    const hashV2 = await reuploadRawExport('r10hp-sib', claudeExportZip([conv('r10hpsib', 0), conv('r10hpsib', 1)]));
    await deliverChain({ file_id: sib.fileId, r2_key: sib.r2Key, reason: 'upload', content_hash: hashV2 });
    expect(await fileState(sib.fileId)).toBe('parsed');
    expect(hashV2).not.toBe(hashV1);

    const fileA = await uploadConvs('r10hp', Array.from({ length: 4 }, (_u, i) => conv('r10hp', i)));
    await deliverChain({ file_id: fileA.fileId, r2_key: fileA.r2Key, reason: 'upload', content_hash: fileA.hash });
    const replaced = await uploadConvs('r10hp', [conv('r10hp', 0)]);

    // Hook the reserve SELECT to hand back sib's STALE hashV1 (simulating a SELECT that read sib before its
    // re-upload) while the live DB has sib parsed at hashV2. The hash-pinned flip must then no-op on sib.
    const RESERVE_SQL = "SELECT id, content_hash FROM files WHERE store = ?1 AND id != ?2 AND id > ?3 AND parse_state = 'parsed' ORDER BY id ASC LIMIT ?4";
    const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
    testEnv.DB.prepare = ((sql: string) => {
      const stmt = realPrepare(sql);
      if (sql !== RESERVE_SQL) return stmt;
      const realBind = stmt.bind.bind(stmt);
      stmt.bind = (...a: unknown[]) => {
        const bound = realBind(...a);
        const realAll = bound.all.bind(bound);
        (bound as unknown as Record<string, unknown>).all = async (...x: unknown[]) => {
          const res = await (realAll as (...y: unknown[]) => Promise<{ results: { id: number; content_hash: string }[] }>)(...x);
          return { ...res, results: res.results.map((r) => (r.id === sib.fileId ? { ...r, content_hash: hashV1 } : r)) };
        };
        return bound;
      };
      return stmt;
    }) as typeof testEnv.DB.prepare;
    try {
      await deliverChain({ file_id: replaced.fileId, r2_key: replaced.r2Key, reason: 'upload', content_hash: replaced.hash });
    } finally {
      testEnv.DB.prepare = realPrepare as typeof testEnv.DB.prepare;
    }

    // POSITIVE CONTROL: without `AND content_hash = ?` on the reserve flip, sib (parsed at hashV2) would flip
    // to 'pending' — burying its fresh content as a stale reservation. Hash-pinned to the stale hashV1, the
    // flip no-ops: sib stays 'parsed' at hashV2, untouched.
    const row = await testEnv.DB.prepare('SELECT parse_state, content_hash FROM files WHERE id = ?1').bind(sib.fileId).first<{ parse_state: string; content_hash: string }>();
    expect(row?.parse_state).toBe('parsed');
    expect(row?.content_hash).toBe(hashV2);
  });

  it('bounds the sibling reservation to a budgeted page span, never flipping all siblings in one invocation (round 9 finding 4)', async () => {
    budgets({ slice: 800, invocation: 800 });
    // main owns 4 sessions, then re-uploaded small so its reparse cleanup reconciles 3 stale (fires reservation).
    const main = await uploadConvs('r9f4-main', Array.from({ length: 4 }, (_u, i) => conv('r9f4main', i)));
    await deliverChain({ file_id: main.fileId, r2_key: main.r2Key, reason: 'upload', content_hash: main.hash });
    const replaced = await uploadConvs('r9f4-main', [conv('r9f4main', 0)]); // enqueues reparse; delivered below

    // Six sibling archives with DISTINCT conversations. Every export UPLOAD reservation flips PARSED siblings
    // to 'pending', so upload them ALL first (none parsed yet → no cross-flipping), THEN parse them — leaving
    // all six 'parsed' when we drive replaced's cleanup (a delivery, not an upload, so it won't churn them).
    const SIB_COUNT = 6;
    const sibUploads = [];
    for (let i = 0; i < SIB_COUNT; i++) sibUploads.push(await uploadConvs(`r9f4-sib${i}`, [conv(`r9f4sib${i}`, 0)]));
    for (const s of sibUploads) await deliverChain({ file_id: s.fileId, r2_key: s.r2Key, reason: 'upload', content_hash: s.hash });
    const sibs = sibUploads.map((s) => s.fileId);
    for (const id of sibs) expect(await fileState(id)).toBe('parsed'); // all six parsed at reservation time

    const reservedSibs = async (): Promise<Set<number>> => {
      const s = new Set<number>();
      for (const id of sibs) if ((await fileState(id)) === 'reserved') s.add(id);
      return s;
    };

    // Tight budget + tiny reserve page so the RESERVE pass cannot flip all six siblings in one invocation;
    // drive every continuation, tracking the MOST of OUR siblings newly reserved in any single invocation.
    budgets({ slice: 6, invocation: 6, kickPage: 2 });
    let msg: ParseMessage = { file_id: replaced.fileId, r2_key: replaced.r2Key, reason: 'upload', content_hash: replaced.hash };
    let prev = await reservedSibs();
    let maxNewlyReservedInOneInvocation = 0;
    let totalNewlyReserved = 0;
    for (let i = 0; i < 200; i++) {
      sent.length = 0;
      await deliver(msg);
      const now = await reservedSibs();
      let newly = 0;
      for (const id of now) if (!prev.has(id)) newly += 1;
      maxNewlyReservedInOneInvocation = Math.max(maxNewlyReservedInOneInvocation, newly);
      totalNewlyReserved += newly;
      prev = now;
      const cont = sent.find((m) => m.file_id === replaced.fileId && typeof m.offset === 'number');
      if (!cont) break;
      msg = cont;
    }
    // POSITIVE CONTROL: an unbounded reservation flips ALL six siblings in ONE invocation (max 6). Paged at
    // kickPage=2 and budget-cut, no single invocation reserves all of them — the reservation spans
    // continuations, and every sibling is reserved exactly once (total 6) and ends 'pending'.
    expect(await fileState(replaced.fileId)).toBe('parsed');
    expect(maxNewlyReservedInOneInvocation).toBeLessThan(SIB_COUNT);
    expect(totalNewlyReserved).toBe(SIB_COUNT);
    for (const id of sibs) expect(await fileState(id)).toBe('reserved');
  });

  it('a corrupt re-upload with a transient failExportFile throw still converges to terminal error (round 9 finding 5)', async () => {
    budgets({ slice: 800, invocation: 800 });
    // A valid archive that owns sessions, then re-uploaded corrupt (same row, new hash) → failExportFile.
    const up = await uploadConvs('r9f5', [conv('r9f5', 0), conv('r9f5', 1)]);
    await deliverChain({ file_id: up.fileId, r2_key: up.r2Key, reason: 'upload', content_hash: up.hash });
    expect(await ownedSessions(up.fileId)).toBe(2);
    const corruptHash = await reuploadRawExport('r9f5', new TextEncoder().encode('not a zip at all'));

    // Make one D1 read inside failExportFile (its owned-sessions SELECT) throw ONCE — a transient outage.
    const OWNED_SQL = 'SELECT session_id FROM sessions WHERE canonical_file_id = ?1';
    const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
    let thrown = false;
    testEnv.DB.prepare = ((sql: string) => {
      const stmt = realPrepare(sql);
      if (sql !== OWNED_SQL) return stmt;
      const realBind = stmt.bind.bind(stmt);
      stmt.bind = (...a: unknown[]) => {
        const bound = realBind(...a);
        const realAll = bound.all.bind(bound);
        (bound as unknown as Record<string, unknown>).all = async (...x: unknown[]) => {
          if (!thrown) {
            thrown = true;
            throw new Error('D1 outage inside failExportFile');
          }
          return (realAll as (...y: unknown[]) => unknown)(...x);
        };
        return bound;
      };
      return stmt;
    }) as typeof testEnv.DB.prepare;
    try {
      // First delivery of the corrupt reparse: failExportFile throws (transient) → ExportRetry → 'pending'.
      await deliver({ file_id: up.fileId, r2_key: up.r2Key, reason: 'upload', content_hash: corruptHash });
      expect(await fileState(up.fileId)).toBe('pending'); // retryable, not yet terminal
      // Retry: failExportFile runs cleanly → terminal 'error'.
      await deliver({ file_id: up.fileId, r2_key: up.r2Key, reason: 'upload', content_hash: corruptHash });
    } finally {
      testEnv.DB.prepare = realPrepare as typeof testEnv.DB.prepare;
    }
    // POSITIVE CONTROL: a corrupt archive whose reconciliation throws must not oscillate pending forever — a
    // transient throw converges. The retry's failExportFile succeeds and the file rests terminal 'error'.
    expect(await fileState(up.fileId)).toBe('error');
  });

  it('flips owned sessions to error in bounded db.batch chunks, never one subrequest per row (round 9 finding 5, batching)', async () => {
    budgets({ slice: 800, invocation: 800 });
    // N spans two chunks of 90, so the flip is 2 subrequests batched but would be 100 unbatched — the
    // O(N)-subrequest tail that, running AFTER markParsed('error') commits, throws past the ~1000 cap for a
    // corrupt re-upload of an archive owning ~950+ conversations and then never re-runs (the file is already
    // 'error', so markParsed returns updated=false and failExportFile early-returns): the owned rows strand.
    const N = 100;
    const up = await uploadConvs('r9f5b', Array.from({ length: N }, (_u, i) => conv('r9f5b', i)));
    await deliverChain({ file_id: up.fileId, r2_key: up.r2Key, reason: 'upload', content_hash: up.hash });
    expect(await ownedSessions(up.fileId)).toBe(N);
    const corruptHash = await reuploadRawExport('r9f5b', new TextEncoder().encode('not a zip at all'));

    // Tag every prepared owned-session flip statement; count how many execute via db.batch (chunked) vs a
    // direct per-row .run(). The batched code path uses ONLY db.batch; the reverted per-row loop uses .run().
    const FLIP_SQL = "UPDATE sessions SET index_state = 'error' WHERE session_id = ?1";
    const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
    const realBatch = testEnv.DB.batch.bind(testEnv.DB);
    let flipRunCalls = 0;
    let flipBatchCalls = 0;
    const tagged = new WeakSet<object>();
    testEnv.DB.prepare = ((sql: string) => {
      const stmt = realPrepare(sql);
      if (sql !== FLIP_SQL) return stmt;
      const realBind = stmt.bind.bind(stmt);
      stmt.bind = (...a: unknown[]) => {
        const bound = realBind(...a);
        tagged.add(bound as object);
        const realRun = bound.run.bind(bound);
        (bound as unknown as Record<string, unknown>).run = (...x: unknown[]) => {
          flipRunCalls++;
          return (realRun as (...y: unknown[]) => unknown)(...x);
        };
        return bound;
      };
      return stmt;
    }) as typeof testEnv.DB.prepare;
    testEnv.DB.batch = ((stmts: unknown[]) => {
      if (Array.isArray(stmts) && stmts.some((s) => tagged.has(s as object))) flipBatchCalls++;
      return realBatch(stmts as never);
    }) as typeof testEnv.DB.batch;
    try {
      await deliver({ file_id: up.fileId, r2_key: up.r2Key, reason: 'upload', content_hash: corruptHash });
    } finally {
      testEnv.DB.prepare = realPrepare as typeof testEnv.DB.prepare;
      testEnv.DB.batch = realBatch as typeof testEnv.DB.batch;
    }

    // Reconciliation ran: the file rests terminal 'error' and all N owned rows were flipped.
    expect(await fileState(up.fileId)).toBe('error');
    expect(await stateCount(up.fileId, 'error')).toBe(N);
    // POSITIVE CONTROL: the flip went out in ceil(N/90) db.batch chunks (each ONE subrequest) and NEVER via a
    // per-row .run(). Reverting to the per-row loop makes flipRunCalls === N and flipBatchCalls === 0, failing
    // both — that unbatched loop is the O(N)-subrequest deterministic throw path finding 5 flagged.
    expect(flipRunCalls).toBe(0);
    expect(flipBatchCalls).toBe(Math.ceil(N / 90));
  });

  it('send-late targets only reserved siblings, never an unrelated pending upload (round 12 finding 3608692125)', async () => {
    budgets({ slice: 800, invocation: 800, kickPage: 500 });
    // A PARSED sibling our cleanup will reserve.
    const parsedSib = await uploadConvs('r12t-res', [conv('r12tres', 0)]);
    await deliverChain({ file_id: parsedSib.fileId, r2_key: parsedSib.r2Key, reason: 'upload', content_hash: parsedSib.hash });
    expect(await fileState(parsedSib.fileId)).toBe('parsed');
    // An UNRELATED sibling left 'pending' (a fresh upload whose parse hasn't run) — NOT reserved by us.
    const pendingSib = await uploadConvs('r12t-pend', [conv('r12tpend', 0)]);
    expect(await fileState(pendingSib.fileId)).toBe('pending');

    const fileA = await uploadConvs('r12t', Array.from({ length: 4 }, (_u, i) => conv('r12t', i)));
    await deliverChain({ file_id: fileA.fileId, r2_key: fileA.r2Key, reason: 'upload', content_hash: fileA.hash });
    const replaced = await uploadConvs('r12t', [conv('r12t', 0)]);

    await deliverChain({ file_id: replaced.fileId, r2_key: replaced.r2Key, reason: 'upload', content_hash: replaced.hash });

    // POSITIVE CONTROL: the old pass SELECTed every 'pending' store row, so it would send a recover to the
    // unrelated fresh upload — hijacking its heal path (a dropped upload message would then never re-run).
    // Now it SELECTs only 'reserved': the pending upload gets NO recover; the reserved sibling does.
    expect(sent.some((m) => m.file_id === pendingSib.fileId && m.reason === 'recover')).toBe(false);
    expect(sent.some((m) => m.file_id === parsedSib.fileId && m.reason === 'recover')).toBe(true);
    expect(await fileState(pendingSib.fileId)).toBe('pending'); // untouched, still awaiting its own upload parse
  });

  it('runs the late recover fan-out even when the completing invocation reconciled nothing locally (round 12 finding 3608692127)', async () => {
    budgets({ slice: 800, invocation: 800, kickPage: 500 });
    // A sibling manually put in 'reserved' — as if an EARLIER delete continuation reserved it. The completing
    // invocation below reconciles no stale session of its own (recovered.size === 0), yet must still fan out.
    const sib = await uploadConvs('r12u-sib', [conv('r12usib', 0)]);
    await deliverChain({ file_id: sib.fileId, r2_key: sib.r2Key, reason: 'upload', content_hash: sib.hash });

    // fileA owns exactly its archive's conversations (nothing stale). Deliver a DELETE-phase continuation
    // directly (reserved already, cursor at start): the scan finds only kept rows → recovered.size 0 →
    // cleanupComplete → markParsed → send-late must STILL run (no recovered.size gate).
    const fileA = await uploadConvs('r12u', [conv('r12u', 0)]);
    await deliverChain({ file_id: fileA.fileId, r2_key: fileA.r2Key, reason: 'upload', content_hash: fileA.hash });

    // Reserve sib as if an EARLIER continuation of fileA's OWN cleanup did it: reserved_by = fileA.fileId, so
    // the owner-scoped send-late below (reserved_by = fileA.fileId) still targets it.
    await testEnv.DB.prepare("UPDATE files SET parse_state = 'reserved', reserved_by = ?2 WHERE id = ?1").bind(sib.fileId, fileA.fileId).run();

    sent.length = 0;
    await deliver({ file_id: fileA.fileId, r2_key: fileA.r2Key, reason: 'upload', content_hash: fileA.hash, offset: 1, cleanup_phase: 'delete', cleanup_cursor: '' });

    // POSITIVE CONTROL: under the old `if (recovered.size > 0)` gate this completing invocation (which deleted
    // nothing) skipped the fan-out, stranding the already-reserved sibling until an external files/check.
    // Unconditional send-late messages it regardless.
    expect(await fileState(fileA.fileId)).toBe('parsed');
    expect(sent.some((m) => m.file_id === sib.fileId && m.reason === 'recover')).toBe(true);
  });

  it('a corrupt re-upload whose sibling fan-out exceeds one invocation reserves EVERY sibling across continuations, stamping error only after (round 13, corrupt-export flip-early)', async () => {
    budgets({ slice: 800, invocation: 800 });
    // main owns 2 sessions, so failExportFile's fan-out fires (owned > 0). Then re-uploaded corrupt (same
    // row, new hash) → failExportFile routes recovery through the round-12 flip-early/send-late machinery.
    const main = await uploadConvs('r13-main', [conv('r13main', 0), conv('r13main', 1)]);
    await deliverChain({ file_id: main.fileId, r2_key: main.r2Key, reason: 'upload', content_hash: main.hash });
    expect(await ownedSessions(main.fileId)).toBe(2);

    // Six PARSED sibling archives (distinct conversations). Upload them all first (export uploads no longer
    // reserve — reservation is delivery-driven — but keep them un-cross-flipped), then parse them all.
    const SIB_COUNT = 6;
    const sibUploads = [];
    for (let i = 0; i < SIB_COUNT; i++) sibUploads.push(await uploadConvs(`r13-sib${i}`, [conv(`r13sib${i}`, 0)]));
    for (const s of sibUploads) await deliverChain({ file_id: s.fileId, r2_key: s.r2Key, reason: 'upload', content_hash: s.hash });
    const sibs = sibUploads.map((s) => s.fileId);
    for (const id of sibs) expect(await fileState(id)).toBe('parsed');

    const reservedSibs = async (): Promise<Set<number>> => {
      const s = new Set<number>();
      for (const id of sibs) if ((await fileState(id)) === 'reserved') s.add(id);
      return s;
    };

    // Corrupt re-upload → failExportFile. Tight budget + tiny reserve page so the RESERVE pass cannot flip all
    // six siblings in one invocation; the fan-out must span continuations carried by kick_cursor.
    const corruptHash = await reuploadRawExport('r13-main', new TextEncoder().encode('not a zip at all'));
    budgets({ slice: 6, invocation: 6, kickPage: 2 });
    let msg: ParseMessage = { file_id: main.fileId, r2_key: main.r2Key, reason: 'upload', content_hash: corruptHash };
    let prev = await reservedSibs();
    let maxNewlyReservedInOneInvocation = 0;
    let totalNewlyReserved = 0;
    let invocations = 0;
    const statesBeforeFinal: string[] = [];
    for (let i = 0; i < 200; i++) {
      sent.length = 0;
      await deliver(msg);
      invocations += 1;
      const now = await reservedSibs();
      let newly = 0;
      for (const id of now) if (!prev.has(id)) newly += 1;
      maxNewlyReservedInOneInvocation = Math.max(maxNewlyReservedInOneInvocation, newly);
      totalNewlyReserved += newly;
      prev = now;
      const cont = sent.find((m) => m.file_id === main.fileId && typeof m.kick_cursor === 'number');
      if (!cont) break;
      statesBeforeFinal.push(await fileState(main.fileId)); // state AFTER a NON-final (reserve-continuation) invocation
      msg = cont;
    }

    // POSITIVE CONTROL (reverting the flip-early ordering — mark 'error' FIRST — makes ALL of these fail):
    // 1. The fan-out spanned ≥2 continuations and no single invocation reserved all six (paged, budget-cut).
    expect(invocations).toBeGreaterThan(1);
    expect(maxNewlyReservedInOneInvocation).toBeLessThan(SIB_COUNT);
    // 2. Every sibling was reserved EXACTLY once and ends 'reserved' — none stranded 'parsed'. Under error-first
    //    ordering the retry finds the file already 'error' (markParsed updated=false → early return) and the
    //    reservation never completes, stranding the un-reached siblings.
    expect(totalNewlyReserved).toBe(SIB_COUNT);
    for (const id of sibs) expect(await fileState(id)).toBe('reserved');
    // 3. The corrupt file is stamped 'error' ONLY after reservation completes — never during the spanning
    //    continuations. Error-first ordering would show 'error' in statesBeforeFinal (and strand siblings).
    expect(statesBeforeFinal.length).toBeGreaterThan(0);
    expect(statesBeforeFinal.every((s) => s !== 'error')).toBe(true);
    expect(await fileState(main.fileId)).toBe('error');
    // (The send-late recover fan-out runs only on the completing invocation and is best-effort/budget-cut —
    // the durable 'reserved' state above is the exactly-once safety net; recover delivery is proven separately
    // in the generous-budget test below.)
  });

  it('a corrupt re-upload reserves every parsed sibling and sends it exactly one recover via the round-12 send-late helper (round 13, corrupt-export send-late)', async () => {
    budgets({ slice: 800, invocation: 800, kickPage: 500 });
    // main owns sessions → fan-out fires; four parsed siblings hold conversations it may have owned.
    const main = await uploadConvs('r13s-main', [conv('r13smain', 0), conv('r13smain', 1)]);
    await deliverChain({ file_id: main.fileId, r2_key: main.r2Key, reason: 'upload', content_hash: main.hash });
    const SIB_COUNT = 4;
    const sibUploads = [];
    for (let i = 0; i < SIB_COUNT; i++) sibUploads.push(await uploadConvs(`r13s-sib${i}`, [conv(`r13ssib${i}`, 0)]));
    for (const s of sibUploads) await deliverChain({ file_id: s.fileId, r2_key: s.r2Key, reason: 'upload', content_hash: s.hash });
    const sibs = sibUploads.map((s) => s.fileId);
    for (const id of sibs) expect(await fileState(id)).toBe('parsed');

    const corruptHash = await reuploadRawExport('r13s-main', new TextEncoder().encode('not a zip at all'));
    sent.length = 0;
    await deliver({ file_id: main.fileId, r2_key: main.r2Key, reason: 'upload', content_hash: corruptHash });

    // The corrupt file rests terminal 'error'; every parsed sibling was reserved and received EXACTLY one
    // recover — the fan-out routes through the SAME sendRecoverToReservedSiblings the cleanup success path
    // uses, no dedicated send loop in the corrupt path. (Count per-sibling to prove exactly-once, not just ≥1.)
    expect(await fileState(main.fileId)).toBe('error');
    for (const id of sibs) {
      expect(await fileState(id)).toBe('reserved');
      expect(sent.filter((m) => m.file_id === id && m.reason === 'recover').length).toBe(1);
    }
  });

  it('a queue outage during the late recover fan-out is bounded and exits, not a spin of failing sends (round 12 finding 3608692129)', async () => {
    budgets({ slice: 800, invocation: 800, kickPage: 500 });
    // More than EXPORT_SEND_FAILURE_LIMIT parsed siblings so the abort is observable (it stops well before
    // attempting them all). Upload all first (none parsed → no cross-reserving), then parse them.
    const COUNT = EXPORT_SEND_FAILURE_LIMIT + 4;
    const sibUploads = [];
    for (let i = 0; i < COUNT; i++) sibUploads.push(await uploadConvs(`r12o-sib${i}`, [conv(`r12osib${i}`, 0)]));
    for (const s of sibUploads) await deliverChain({ file_id: s.fileId, r2_key: s.r2Key, reason: 'upload', content_hash: s.hash });

    const fileA = await uploadConvs('r12o', Array.from({ length: 4 }, (_u, i) => conv('r12o', i)));
    await deliverChain({ file_id: fileA.fileId, r2_key: fileA.r2Key, reason: 'upload', content_hash: fileA.hash });
    const replaced = await uploadConvs('r12o', [conv('r12o', 0)]);

    // Every recover send throws (queue outage). Count attempts.
    const realSend = testEnv.PARSE_QUEUE.send;
    let recoverAttempts = 0;
    testEnv.PARSE_QUEUE.send = (async (m: ParseMessage) => {
      if (m.reason === 'recover') {
        recoverAttempts += 1;
        throw new Error('queue outage');
      }
      return (realSend as (b: ParseMessage) => Promise<unknown>)(m);
    }) as typeof testEnv.PARSE_QUEUE.send;
    try {
      await deliver({ file_id: replaced.fileId, r2_key: replaced.r2Key, reason: 'upload', content_hash: replaced.hash });
    } finally {
      testEnv.PARSE_QUEUE.send = realSend;
    }

    // POSITIVE CONTROL: without the consecutive-failure cut (and charging failed sends to the budget), the
    // pager would attempt EVERY reserved sibling in the store (COUNT + any full-suite pollution) after the
    // file is already terminal. The cut stops it after EXPORT_SEND_FAILURE_LIMIT consecutive failures.
    expect(recoverAttempts).toBe(EXPORT_SEND_FAILURE_LIMIT);
    expect(await fileState(replaced.fileId)).toBe('parsed'); // terminal; the reserved siblings heal via files/check
  });

  it('skips the late recover sends when the archive hash changed after markParsed (round 12 finding 3608692134)', async () => {
    budgets({ slice: 800, invocation: 800, kickPage: 500 });
    const sib = await uploadConvs('r12h-sib', [conv('r12hsib', 0)]);
    await deliverChain({ file_id: sib.fileId, r2_key: sib.r2Key, reason: 'upload', content_hash: sib.hash });
    expect(await fileState(sib.fileId)).toBe('parsed');

    const fileA = await uploadConvs('r12h', Array.from({ length: 4 }, (_u, i) => conv('r12h', i)));
    await deliverChain({ file_id: fileA.fileId, r2_key: fileA.r2Key, reason: 'upload', content_hash: fileA.hash });
    const replaced = await uploadConvs('r12h', [conv('r12h', 0)]);

    // Right after markParsed succeeds (its own hash guard passed), change replaced's stored content_hash — a
    // re-upload landing in the post-mark window. The send-late's pre-send recheck must then see a mismatch and
    // skip the fan-out entirely. Hook the markParsed UPDATE (multi-line, .run()) and mutate the hash after it runs.
    const MARK_SQL = `UPDATE files SET parse_state = ?2, parsed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), parsed_size = ?3, parse_error = ?4, reserved_at = NULL, reserved_by = NULL
     WHERE id = ?1 AND content_hash = ?5`;
    const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
    let mutated = false;
    testEnv.DB.prepare = ((sql: string) => {
      const stmt = realPrepare(sql);
      if (sql !== MARK_SQL) return stmt;
      const realBind = stmt.bind.bind(stmt);
      stmt.bind = (...a: unknown[]) => {
        const bound = realBind(...a);
        const realRun = bound.run.bind(bound);
        (bound as unknown as Record<string, unknown>).run = async (...x: unknown[]) => {
          const res = await (realRun as (...y: unknown[]) => Promise<unknown>)(...x);
          if (!mutated && a[0] === replaced.fileId && a[1] === 'parsed') {
            mutated = true;
            await realPrepare('UPDATE files SET content_hash = ?2 WHERE id = ?1').bind(replaced.fileId, 'sha256:changed-post-mark').run();
          }
          return res;
        };
        return bound;
      };
      return stmt;
    }) as typeof testEnv.DB.prepare;
    sent.length = 0; // isolate THIS delivery's sends from prior deliverChains' send-late fan-outs (shared DB)
    try {
      await deliver({ file_id: replaced.fileId, r2_key: replaced.r2Key, reason: 'upload', content_hash: replaced.hash });
    } finally {
      testEnv.DB.prepare = realPrepare as typeof testEnv.DB.prepare;
    }

    // POSITIVE CONTROL: without the pre-send hash recheck, a stale recover could republish a just-deleted
    // session before the fresh parse runs. The recheck sees the changed hash and sends NOTHING — the fresh
    // message owns the file and will run its own cleanup + reserve + fan-out.
    expect(mutated).toBe(true);
    expect(sent.some((m) => m.reason === 'recover')).toBe(false);
  });

  it('an older healed archive cannot steal a conversation owned by a newer archive; last-write-wins holds on equal mtime (round 9 finding 3a, mtime guard)', async () => {
    budgets({ slice: 800, invocation: 800 });
    const convTag = 'mtx';
    // A = the NEWER archive (later file mtime): uploads and owns X healthily.
    const a = await uploadConvs('mt-a', [conv(convTag, 0)], '2026-07-02T12:00:00Z');
    await deliverChain({ file_id: a.fileId, r2_key: a.r2Key, reason: 'upload', content_hash: a.hash });
    const xId = `bnd-${convTag}-conv-0`;
    expect(await canonicalOwner(xId)).toBe(a.fileId);
    expect(await sessionState(xId)).toBe('ready');

    // B = an OLDER archive (earlier file mtime) that also contains X. This is the files/check heal path:
    // everything this PR forces to 'pending' is re-parsed as reason 'upload'. Delivered AFTER A, B would win
    // on execution order under plain last-write-wins — the mtime guard must stop it stealing the newer copy.
    const b = await uploadConvs('mt-b', [conv(convTag, 0)], '2026-07-01T12:00:00Z');
    await deliver({ file_id: b.fileId, r2_key: b.r2Key, reason: 'upload', content_hash: b.hash });

    // POSITIVE CONTROL: without the guard, B's 'upload' parse claims X (execution order wins). The guard skips
    // it because A is STRICTLY newer, so X keeps A's ownership; B still completes, just owning nothing.
    expect(await canonicalOwner(xId)).toBe(a.fileId);
    expect(await sessionState(xId)).toBe('ready');
    expect(await fileState(b.fileId)).toBe('parsed');
  });

  it('skips an older archive claiming a conversation whose NEWER owner is still parsing, not just ready (round 11 finding 3608613136)', async () => {
    budgets({ slice: 800, invocation: 800 });
    const convTag = 'r11mtp';
    // A = the NEWER archive (later mtime): owns X, then X forced to 'parsing' (A mid-reparse, not yet ready).
    const a = await uploadConvs('r11mtp-a', [conv(convTag, 0)], '2026-07-02T12:00:00Z');
    await deliverChain({ file_id: a.fileId, r2_key: a.r2Key, reason: 'upload', content_hash: a.hash });
    const xId = `bnd-${convTag}-conv-0`;
    expect(await canonicalOwner(xId)).toBe(a.fileId);
    await testEnv.DB.prepare("UPDATE sessions SET index_state = 'parsing' WHERE session_id = ?1").bind(xId).run();

    // B = an OLDER archive (earlier mtime) containing X, healed as reason 'upload'. It must NOT steal X even
    // though A's row is 'parsing' (mid-reparse) rather than 'ready'.
    const b = await uploadConvs('r11mtp-b', [conv(convTag, 0)], '2026-07-01T12:00:00Z');
    await deliver({ file_id: b.fileId, r2_key: b.r2Key, reason: 'upload', content_hash: b.hash });

    // POSITIVE CONTROL: gating the mtime skip on healthyOtherOwner (index_state='ready') let B claim X while
    // A was 'parsing'. Gated on otherOwner (any non-error state), the strictly-newer-owner skip fires — X
    // keeps A's ownership. Revert the guard from `otherOwner` to `healthyOtherOwner` → B claims X → fails.
    expect(await canonicalOwner(xId)).toBe(a.fileId);
    expect(await fileState(b.fileId)).toBe('parsed'); // B completes, owning nothing
  });

  it('a NEWER archive still claims a conversation whose OLDER owner is parsing (round 11 finding 3608613136, directional positive control)', async () => {
    budgets({ slice: 800, invocation: 800 });
    const convTag = 'r11mtn';
    // A = the OLDER archive (earlier mtime): owns X, then X forced to 'parsing'.
    const a = await uploadConvs('r11mtn-a', [conv(convTag, 0)], '2026-07-01T12:00:00Z');
    await deliverChain({ file_id: a.fileId, r2_key: a.r2Key, reason: 'upload', content_hash: a.hash });
    const xId = `bnd-${convTag}-conv-0`;
    expect(await canonicalOwner(xId)).toBe(a.fileId);
    await testEnv.DB.prepare("UPDATE sessions SET index_state = 'parsing' WHERE session_id = ?1").bind(xId).run();

    // B = a NEWER archive: it MUST claim X (newer wins) despite A's row being 'parsing' — the guard is
    // directional, only blocking strictly-OLDER archives, never a genuinely newer upload.
    const b = await uploadConvs('r11mtn-b', [conv(convTag, 0)], '2026-07-02T12:00:00Z');
    await deliverChain({ file_id: b.fileId, r2_key: b.r2Key, reason: 'upload', content_hash: b.hash });

    expect(await canonicalOwner(xId)).toBe(b.fileId); // newer archive claimed it
    expect(await sessionState(xId)).toBe('ready');
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

describe('per-store cleanup serialization (round 14): a cleanup defers while another holds a fresh reservation', () => {
  it('a stale cleanup defers before mutating while a sibling is reserved-fresh, then completes once it drains', async () => {
    budgets({ slice: 800, invocation: 800, kickPage: 500 });

    // C: a parsed sibling. A reserves it, completes, and fires a recover for C we DON'T deliver — so C stays
    // 'reserved' with a fresh reserved_at: a live cleanup (A) still owns the store's reserve→drain window.
    const c = await uploadConvs('r14s-c', [conv('r14sc', 0)]);
    await deliverChain({ file_id: c.fileId, r2_key: c.r2Key, reason: 'upload', content_hash: c.hash });
    const a = await uploadConvs('r14s-a', [conv('r14sa', 0), conv('r14sa', 1)]);
    await deliverChain({ file_id: a.fileId, r2_key: a.r2Key, reason: 'upload', content_hash: a.hash });
    const aRepl = await uploadConvs('r14s-a', [conv('r14sa', 0)]); // drops conv1 → stale → reserves C
    sent.length = 0;
    await deliverChain({ file_id: aRepl.fileId, r2_key: aRepl.r2Key, reason: 'upload', content_hash: aRepl.hash });
    expect(await fileState(aRepl.fileId)).toBe('parsed');
    expect(await fileState(c.fileId)).toBe('reserved'); // A reserved C; its recover is queued but undelivered
    expect(sent.some((m) => m.file_id === c.fileId && m.reason === 'recover')).toBe(true);

    // B: a second archive that also drops a conversation → its cleanup has a stale row to delete. Delivering
    // its reparse ONCE must DEFER at first-stale (C reserved-fresh) BEFORE deleting or reserving anything.
    const b = await uploadConvs('r14s-b', [conv('r14sb', 0), conv('r14sb', 1)]);
    await deliverChain({ file_id: b.fileId, r2_key: b.r2Key, reason: 'upload', content_hash: b.hash });
    const bRepl = await uploadConvs('r14s-b', [conv('r14sb', 0)]);
    sent.length = 0;
    await deliver({ file_id: bRepl.fileId, r2_key: bRepl.r2Key, reason: 'upload', content_hash: bRepl.hash });

    // POSITIVE CONTROL: B DEFERRED — it stayed 'pending', did NOT delete its stale session (still owns 2), and
    // re-enqueued a 'scan' continuation with NO recover sent. Without the contention check B would reserve +
    // delete conv1 + send-late early against C's still-owned rows (the 3608748301 gap).
    expect(await fileState(bRepl.fileId)).toBe('pending');
    expect(await ownedSessions(bRepl.fileId)).toBe(2); // conv1 NOT deleted — nothing mutated
    expect(sent.some((m) => m.file_id === bRepl.fileId && m.offset === undefined && m.cleanup_phase === undefined)).toBe(true); // re-enqueued a plain re-parse
    expect(sent.some((m) => m.reason === 'recover')).toBe(false);

    // Capture B's deferred scan continuation. Delivering C's recover shows a real drain clears C's reservation;
    // then clear reserved_at on the rest (A's cleanup also reserved every OTHER parsed sibling in the shared
    // store — in production each drains via its own recover send, which deliverChain doesn't deliver here).
    const bDefer = sent.find((m) => m.file_id === bRepl.fileId && m.offset === undefined)!;
    await deliver({ file_id: c.fileId, r2_key: c.r2Key, reason: 'recover', content_hash: c.hash });
    expect(await fileState(c.fileId)).toBe('parsed'); // C drained via its recover parse (reserved_at cleared)
    await testEnv.DB.prepare("UPDATE files SET reserved_at = NULL WHERE reserved_at IS NOT NULL").run();

    // B's deferred re-parse now proceeds: no fresh reservation → write (idempotent) + reserve + delete + done.
    await deliverChain(bDefer);
    expect(await fileState(bRepl.fileId)).toBe('parsed');
    expect(await ownedSessions(bRepl.fileId)).toBe(1); // conv1 deleted now that B ran its cleanup
  });

  it('a recover parse with an empty delete set never defers on a reserved sibling; it proceeds and drains (livelock gate)', async () => {
    budgets({ slice: 800, invocation: 800, kickPage: 500 });
    // A sibling reserved-fresh, as if a live cleanup owns the store.
    const resv = await uploadConvs('r14g-resv', [conv('r14gresv', 0)]);
    await deliverChain({ file_id: resv.fileId, r2_key: resv.r2Key, reason: 'upload', content_hash: resv.hash });
    // reserved_by = OTHER_OWNER (an id no file under test has) so it reads as another cleanup's live reservation
    // — the contention probe's `reserved_by != file.id` matches it. (Here d never reaches the probe anyway.)
    await testEnv.DB.prepare("UPDATE files SET parse_state = 'reserved', reserved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), reserved_by = ?2 WHERE id = ?1").bind(resv.fileId, OTHER_OWNER).run();
    expect(await fileState(resv.fileId)).toBe('reserved');

    // An UNCHANGED archive D delivered as RECOVER: keep-set == its own sessions → EMPTY delete set → the scan
    // finds no stale → it NEVER reaches the contention check → proceeds to 'parsed', not deferred.
    const d = await uploadConvs('r14g-d', [conv('r14gd', 0), conv('r14gd', 1)]);
    await deliverChain({ file_id: d.fileId, r2_key: d.r2Key, reason: 'upload', content_hash: d.hash });
    expect(await fileState(d.fileId)).toBe('parsed');
    sent.length = 0;
    await deliver({ file_id: d.fileId, r2_key: d.r2Key, reason: 'recover', content_hash: d.hash });

    // POSITIVE CONTROL: a defer placed BEFORE the has-stale scan (ungated) would re-enqueue D forever while
    // resv stays reserved — every recover parse waiting on every other, the store livelocked. Gated inside the
    // first-stale branch, D (empty delete set) proceeds and drains, so the store never wedges.
    expect(await fileState(d.fileId)).toBe('parsed');
    expect(sent.some((m) => m.file_id === d.fileId)).toBe(false); // D never re-enqueued itself → NOT deferred
  });

  it('a corrupt re-upload defers its fan-out while another cleanup holds a fresh reservation, then errors once the store drains', async () => {
    budgets({ slice: 800, invocation: 800, kickPage: 500 });
    const c = await uploadConvs('r14x-c', [conv('r14xc', 0)]);
    await deliverChain({ file_id: c.fileId, r2_key: c.r2Key, reason: 'upload', content_hash: c.hash });
    // reserved_by = OTHER_OWNER: C is owned by another cleanup, so E's corrupt fan-out defers (reserved_by != E).
    await testEnv.DB.prepare("UPDATE files SET parse_state = 'reserved', reserved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), reserved_by = ?2 WHERE id = ?1").bind(c.fileId, OTHER_OWNER).run();

    // E owns sessions; corrupt re-upload → failExportFile. It must DEFER (owned > 0, initial entry, contention).
    const e = await uploadConvs('r14x-e', [conv('r14xe', 0), conv('r14xe', 1)]);
    await deliverChain({ file_id: e.fileId, r2_key: e.r2Key, reason: 'upload', content_hash: e.hash });
    expect(await ownedSessions(e.fileId)).toBe(2);
    const corruptHash = await reuploadRawExport('r14x-e', new TextEncoder().encode('not a zip at all'));
    sent.length = 0;
    await deliver({ file_id: e.fileId, r2_key: e.r2Key, reason: 'upload', content_hash: corruptHash });

    // POSITIVE CONTROL: E DEFERRED — NOT stamped 'error', and it re-enqueued its INITIAL message (no offset,
    // no kick_cursor), nothing mutated. Without the corrupt-path contention check E would reserve + error now.
    expect(await fileState(e.fileId)).toBe('pending');
    expect(sent.some((m) => m.file_id === e.fileId && m.content_hash === corruptHash && m.offset === undefined && m.kick_cursor === undefined)).toBe(true);

    // Drain C, then redeliver E's corrupt parse → now the store is free, so E errors terminally.
    await deliver({ file_id: c.fileId, r2_key: c.r2Key, reason: 'recover', content_hash: c.hash });
    await deliver({ file_id: e.fileId, r2_key: e.r2Key, reason: 'upload', content_hash: corruptHash });
    expect(await fileState(e.fileId)).toBe('error');
  });

  it('a same-relpath re-upload mid-cleanup keeps the owner id, so the fresh parse still owns and recovers the prior reservation (round 14 ownership coherence)', async () => {
    budgets({ slice: 800, invocation: 800, kickPage: 500 });
    // A parsed sibling S for fileA's cleanup to reserve.
    const s = await uploadConvs('r14own-s', [conv('r14owns', 0)]);
    await deliverChain({ file_id: s.fileId, r2_key: s.r2Key, reason: 'upload', content_hash: s.hash });
    expect(await fileState(s.fileId)).toBe('parsed');

    // fileA: big, then replaced small so its reparse cleanup reserves S and has stale to delete.
    const fileA = await uploadConvs('r14own', Array.from({ length: 4 }, (_u, i) => conv('r14own', i)));
    await deliverChain({ file_id: fileA.fileId, r2_key: fileA.r2Key, reason: 'upload', content_hash: fileA.hash });
    const replaced = await uploadConvs('r14own', [conv('r14own', 0)]);
    expect(replaced.fileId).toBe(fileA.fileId); // same machine+relpath → same row id (the owner id is stable)

    // Drive replaced's cleanup to a delete-phase continuation: S is reserved BY fileA's id, some stale deleted.
    budgets({ slice: 8, invocation: 8 });
    const { stoppedCont } = await deliverChain(
      { file_id: replaced.fileId, r2_key: replaced.r2Key, reason: 'upload', content_hash: replaced.hash },
      { stopAtCleanup: true },
    );
    expect(stoppedCont).toBeDefined();
    const ownerAfterReserve = await testEnv.DB.prepare('SELECT reserved_by FROM files WHERE id = ?1').bind(s.fileId).first<{ reserved_by: number }>();
    expect(ownerAfterReserve!.reserved_by).toBe(fileA.fileId); // S owned by the cleanup that reserved it

    // Re-upload 'r14own' AGAIN with new bytes → SAME row id, new content_hash → the in-flight delete
    // continuation is now superseded. Because the id is unchanged, S's reserved_by still names THIS row.
    budgets({ slice: 800, invocation: 800, kickPage: 500 });
    const reup = await uploadConvs('r14own', [conv('r14own', 0), conv('r14own', 9)]);
    expect(reup.fileId).toBe(fileA.fileId);

    // The superseded delete continuation bails (reverts our rows), and leaves S reserved — still owned by the
    // stable id, NOT stranded under a dead owner.
    sent.length = 0;
    await deliver(stoppedCont!);
    const ownerAfterSupersede = await testEnv.DB.prepare("SELECT parse_state, reserved_by FROM files WHERE id = ?1").bind(s.fileId).first<{ parse_state: string; reserved_by: number }>();
    expect(ownerAfterSupersede!.parse_state).toBe('reserved');
    expect(ownerAfterSupersede!.reserved_by).toBe(fileA.fileId); // ownership survived the re-upload (id stable)

    // The fresh upload's own parse drains: it reserves siblings (S already 'reserved' by the SAME owner id →
    // left as-is), completes, and its owner-scoped send-late (reserved_by = fileA.id) recovers S. Coherence:
    // the reservation the SUPERSEDED cleanup made is reclaimed by the FRESH parse precisely because they share
    // the stable id.
    sent.length = 0;
    await deliverChain({ file_id: reup.fileId, r2_key: reup.r2Key, reason: 'upload', content_hash: reup.hash });
    expect(await fileState(reup.fileId)).toBe('parsed');
    expect(sent.some((m) => m.file_id === s.fileId && m.reason === 'recover')).toBe(true); // send-late reclaimed S

    // Delivering that recover drains S to terminal and clears the ownership markers — no orphaned reservation.
    await deliver({ file_id: s.fileId, r2_key: s.r2Key, reason: 'recover', content_hash: s.hash });
    const sFinal = await testEnv.DB.prepare('SELECT parse_state, reserved_by, reserved_at FROM files WHERE id = ?1').bind(s.fileId).first<{ parse_state: string; reserved_by: number | null; reserved_at: string | null }>();
    expect(sFinal!.parse_state).toBe('parsed');
    expect(sFinal!.reserved_by).toBeNull();
    expect(sFinal!.reserved_at).toBeNull();
  });
});
