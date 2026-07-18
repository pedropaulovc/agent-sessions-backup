import { SELF, env as testEnvRaw } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { EXPORT_OVERSIZED_CEILING, EXPORT_QUERY_BUDGET } from '../src/ingest/consumer';
import { CLAUDE_WEB_ROOT, claudeExportZip, claudeWebConversation, type ClaudeConvOpts, type ClaudeWebMessage } from './web-fixtures';

const testEnv = testEnvRaw as unknown as Env;

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

// A conversation with `msgs` messages → ~msgs blocks, so writeSession fans out to many insert batches
// and costs far more than the ~5-query mean — used to exercise the DYNAMIC (query-count) slice budget.
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
    // More than one statement-budget slice of small conversations, so the parse spans several
    // invocations. The exact slice boundary depends on per-conversation D1 statement counts, so we
    // drive the whole continuation chain and assert the INVARIANT rather than a fixed offset.
    const total = 130;
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
    const total = 130; // more than one statement-budget slice, so slice 1 is non-final
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
    // Two export files delivered in ONE batch (max_batch_size:5 in prod). Each slice is ~500 D1
    // statements; running both in one invocation would breach the ~1000/invocation cap. Only the first
    // runs; the second is DEFERRED — but a deferral is not a failure, so it must ACK + re-enqueue a fresh
    // copy (resetting the retry budget), never msg.retry() (which burns max_retries and can DLQ a message
    // that never failed).
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
    const total = 130; // multi-slice so a continuation would normally follow slice 1
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

  it('a continuation-enqueue failure reverts the slice and never leaves partial ready rows (round 1 finding 3)', async () => {
    const total = 130;
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
    expect(await readyCount(fileId)).toBe(0); // no partial 'ready' rows survived the failed slice
  });

  it('budgets the slice by D1 STATEMENTS, not batch calls: a few heavy conversations exhaust it (round 3 finding 1)', async () => {
    // Each conversation carries ~200 blocks, so writeSession issues ~200 INSERT statements (plus deletes
    // and the session write) — far past the ~5-statement mean. Under the OLD batch-call accounting a
    // 200-block conversation "cost" only ~6, so ~70+ of these would fit one 500 slice; counting real
    // statements, only a handful do. `total` is small but strictly greater than one slice, so a
    // statement-budgeted slice MUST stop short and enqueue a continuation.
    const total = 12;
    const { fileId, hash, r2Key } = await uploadConvs('heavy', Array.from({ length: total }, (_u, i) => heavyConv('heavy', i, 200)));

    sent.length = 0;
    await deliver({ file_id: fileId, r2_key: r2Key, reason: 'upload', content_hash: hash });

    // POSITIVE CONTROL for statement-counting: revert writeSession to returning batch-call count and all
    // 12 conversations write in one slice → 'parsed', no continuation. Counting statements cuts the slice
    // to a handful, so the file stays pending with a continuation at a small offset.
    expect(await fileState(fileId)).toBe('pending');
    const cont = sent.find((m) => m.file_id === fileId && typeof m.offset === 'number');
    expect(cont).toBeDefined();
    const offset = cont!.offset!;
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(10); // a handful — impossible under batch-call accounting (which fits all 12)
    expect(await ownedSessions(fileId)).toBe(offset); // only the budgeted prefix was written
    // The statements the budget actually counted are dominated by block inserts: written blocks reached
    // the budget (minus the fixed ~7/conversation overhead), which is exactly the statement-math gate.
    const blocks = await testEnv.DB.prepare(
      "SELECT COALESCE(SUM(block_count), 0) AS b FROM sessions WHERE canonical_file_id = ?1 AND index_state = 'ready'",
    ).bind(fileId).first<{ b: number }>();
    expect(blocks!.b).toBeGreaterThanOrEqual(EXPORT_QUERY_BUDGET - offset * 7);
  });

  it('reverts every session already written when writeSession throws mid-slice; the file is never parsed (round 2 finding 1b)', async () => {
    const { fileId, hash, r2Key } = await uploadArchive('wf', 5);

    // Each small conversation issues 3 DB.batch calls in writeSession (block delete, block insert,
    // session+FTS). Throw on the 7th batch → conversation 3's first batch → conversations 1-2 are fully
    // written and tracked in `written`, conversation 3 fails before any of its rows land. The slice's
    // try/catch must revert 1-2 and rethrow.
    const restore = throwOnNthBatch(7);
    sent.length = 0;
    try {
      await deliver({ file_id: fileId, r2_key: r2Key, reason: 'upload', content_hash: hash });
    } finally {
      restore();
    }

    // POSITIVE CONTROL for the revert-on-write-failure path: without the try/catch revert, conversations
    // 1-2 survive as 'ready' rows canonical to a file the generic catch can only mark 'error'.
    expect(await fileState(fileId)).toBe('error'); // generic consumer catch; NOT parsed
    expect(await readyCount(fileId)).toBe(0); // no partial 'ready' rows survived the failed slice
    expect(sent.some((m) => m.file_id === fileId && typeof m.offset === 'number')).toBe(false); // no continuation
  });

  it('adds the current conversation to the revert set BEFORE writing, so a mid-conversation throw clears its prior ready row (round 3 finding 4)', async () => {
    const convId = 'bnd-f4-conv-0';
    const { fileId, hash, r2Key } = await uploadArchive('f4', 1); // single conversation

    // First parse → the conversation is a healthy 'ready' session owned by this file.
    await deliver({ file_id: fileId, r2_key: r2Key, reason: 'upload', content_hash: hash });
    expect(await sessionState(convId)).toBe('ready');

    // Reparse the SAME bytes (reason 'reindex', same hash → not stale-rejected). Throw on the 2nd DB.batch
    // of the invocation = the conversation's INSERT batch, AFTER its DELETE batch already dropped the old
    // blocks/FTS. Its prior sessions row is still 'ready'. Only if the id was added to `written` BEFORE the
    // write does revertSlice flip it back to 'parsing'.
    const restore = throwOnNthBatch(2);
    try {
      await deliver({ file_id: fileId, r2_key: r2Key, reason: 'reindex', content_hash: hash });
    } finally {
      restore();
    }

    // POSITIVE CONTROL for written.add-before-write: with the add AFTER the await, the throw skips it and
    // the conversation keeps its stale 'ready' row over a half-rewritten (blocks-deleted) index.
    expect(await fileState(fileId)).toBe('error');
    expect(await sessionState(convId)).toBe('parsing');
  });

  it('reserves the export budget before parsing, so a slice that throws does not free the budget for a second export in the same batch (round 2 finding 2)', async () => {
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
    expect(flags[f1.fileId]!.retried).toBe(true); // f1 threw → consumer catch retries it
    expect(await fileState(f1.fileId)).toBe('error');
    expect(await readyCount(f1.fileId)).toBe(0); // f1's partial writes reverted

    expect(flags[f2.fileId]).toEqual({ acked: true, retried: false }); // deferred by ACK + re-enqueue
    expect(sent.some((m) => m.file_id === f2.fileId && m.offset === undefined)).toBe(true);
    expect(await fileState(f2.fileId)).toBe('pending');
    expect(await ownedSessions(f2.fileId)).toBe(0); // NO slice ran for f2
  });

  // Runs LAST: its stale-session cleanup fan-out re-enqueues sibling export files (all share the
  // 'export-inbox' store), flipping them to 'pending' — harmless once earlier tests have asserted.
  it('bounds the final stale-session cleanup and marks parsed ONLY once it fully drains (round 3 finding 3)', async () => {
    // Parse a large archive so the file owns many sessions, then replace it with a much smaller valid
    // archive that DROPS most conversations. The dropped sessions must be cleaned in budgeted chunks
    // (≤4 statements each) across several invocations — never one unbounded pass after markParsed.
    const big = Array.from({ length: 300 }, (_u, i) => conv('cln', i));
    const first = await uploadConvs('cln', big);
    await deliverChain({ file_id: first.fileId, r2_key: first.r2Key, reason: 'upload', content_hash: first.hash });
    expect(await fileState(first.fileId)).toBe('parsed');
    expect(await ownedSessions(first.fileId)).toBe(300);

    // Replace the archive in place (same machine/relpath → same file id, new bytes) with 5 conversations.
    const small = Array.from({ length: 5 }, (_u, i) => conv('cln', i));
    const replaced = await uploadConvs('cln', small);
    expect(replaced.fileId).toBe(first.fileId); // updated the same file row, not a new one

    // Drive the reparse only until cleanup FIRST needs a continuation (stale rows still remain).
    const reparse: ParseMessage = { file_id: replaced.fileId, r2_key: replaced.r2Key, reason: 'upload', content_hash: replaced.hash };
    const stopped = await deliverChain(reparse, { stopAtCleanup: true });

    // POSITIVE CONTROL for cleanup-before-markParsed: with markParsed moved ahead of the cleanup loop the
    // file would already be 'parsed' here (and a huge cleanup would run unbounded). Because cleanup is a
    // budgeted phase that gates markParsed, the file is STILL 'pending' with stale rows outstanding.
    expect(stopped.stoppedCont).toBeDefined(); // cleanup needed more than one budgeted chunk
    expect(await fileState(replaced.fileId)).toBe('pending');
    expect(await ownedSessions(replaced.fileId)).toBeGreaterThan(5); // stale sessions not yet fully removed

    // Resume from the cleanup continuation and drain the rest.
    const rest = await deliverChain(stopped.stoppedCont!);
    expect(rest.deliveries).toBeGreaterThan(1); // cleanup itself spanned multiple invocations
    expect(await fileState(replaced.fileId)).toBe('parsed'); // parsed ONLY after cleanup fully drained
    expect(await ownedSessions(replaced.fileId)).toBe(5); // exactly the kept conversations; zero stale rows
    expect(await stateCount(replaced.fileId, 'ready')).toBe(5);
  });

  it('defers an oversized conversation to its own invocation instead of writing it mid-slice (round 4 finding 2)', async () => {
    // A conversation estimated above EXPORT_OVERSIZED_CEILING can't be sliced (writeSession is atomic per
    // conversation), so when it appears after other work in a slice it must be cut to its OWN invocation —
    // keeping its writeSession clear of the per-invocation cap. (Measured max real export conversation is
    // 304 blocks, well under the ceiling, so this guard is defensive; here we force it with a big fixture.)
    const convs = [conv('ovz', 0), conv('ovz', 1), heavyConv('ovz', 2, EXPORT_OVERSIZED_CEILING + 50), conv('ovz', 3)];
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

  it('holds a SINGLE invocation-wide budget: an export slice defers a normal transcript in the same batch (round 4 finding 4)', async () => {
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

  // Destructive cleanup fan-out (kicks sibling export-inbox files to 'pending') — kept near the end.
  it('a cleanup-continuation send failure leaves the file pending, not error, and retries the cleanup page (round 4 finding 1)', async () => {
    const first = await uploadConvs('csf', Array.from({ length: 300 }, (_u, i) => conv('csf', i)));
    await deliverChain({ file_id: first.fileId, r2_key: first.r2Key, reason: 'upload', content_hash: first.hash });
    expect(await ownedSessions(first.fileId)).toBe(300);

    // Replace with 3 conversations → ~297 stale to clean across multiple budgeted chunks.
    const replaced = await uploadConvs('csf', Array.from({ length: 3 }, (_u, i) => conv('csf', i)));
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

  it('cleanup deletes are atomic hash-guarded: a hash flip between the recheck and the delete batch no-ops them (round 4 finding 3)', async () => {
    const first = await uploadConvs('atom', Array.from({ length: 5 }, (_u, i) => conv('atom', i)));
    await deliverChain({ file_id: first.fileId, r2_key: first.r2Key, reason: 'upload', content_hash: first.hash });
    expect(await ownedSessions(first.fileId)).toBe(5);

    // Replace with 1 conversation → 4 stale to delete.
    const replaced = await uploadConvs('atom', [conv('atom', 0)]);

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
