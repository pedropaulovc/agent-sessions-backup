import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_PAGES_PER_INVOCATION, reindex } from '../src/api/ops';
import type { Identity } from '../src/auth/identity';

const testEnv = env as unknown as Env;
const admin: Identity = { kind: 'machine', machineId: 'reindexbox', isAdmin: true, certSlot: 'current' };

/** Spy on sendBatch that records calls but never enqueues — a full 100-message chunk equals the vitest
 * queue's maxBatchSize and would let the real local consumer auto-flush and race these assertions. */
function stubSendBatch() {
  return vi.spyOn(testEnv.PARSE_QUEUE, 'sendBatch').mockResolvedValue(undefined as never);
}

function reindexRequest(prefix?: string): Request {
  return new Request('https://api.sessions.vza.net/api/v1/admin/reindex', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(prefix ? { prefix } : {}),
  });
}

/** A minimal R2 object the reindex walker understands: it only reads key/size/checksums/customMetadata. */
function fakeObject(key: string): R2Object {
  return { key, size: 10, checksums: {}, customMetadata: {} } as unknown as R2Object;
}

/** A claude-code session object (detect() gives it a sessionId, exercising the parsing-flip batch). */
function sessionObject(machine: string): R2Object {
  return fakeObject(`raw/${machine}/claude/proj/${crypto.randomUUID()}.jsonl`);
}

/**
 * Replace RAW.list with a fake that serves pre-split pages and honors the opaque cursor (here just the
 * next page index as a string) exactly like R2 would — so both the fresh multi-page walk and the
 * resume-from-cursor path drive real code. Returns the vi mock so callers can inspect the cursors it saw.
 */
function stubList(pages: R2Object[][]) {
  return vi.spyOn(testEnv.RAW, 'list').mockImplementation(async (opts?: R2ListOptions) => {
    const idx = opts?.cursor ? Number(opts.cursor) : 0;
    const truncated = idx < pages.length - 1;
    return {
      objects: pages[idx] ?? [],
      truncated,
      cursor: truncated ? String(idx + 1) : undefined,
      delimitedPrefixes: [],
    } as unknown as R2Objects;
  });
}

async function seedCursor(cursor: string | null, prefix = 'raw/'): Promise<void> {
  await testEnv.DB.prepare("INSERT INTO meta (key, value) VALUES ('reindex_cursor', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1")
    .bind(JSON.stringify({ prefix, cursor }))
    .run();
}

async function readCursor(): Promise<{ prefix: string; cursor: string | null }> {
  const row = await testEnv.DB.prepare("SELECT value FROM meta WHERE key = 'reindex_cursor'").first<{ value: string }>();
  return JSON.parse(row!.value);
}

async function fileCount(machine: string): Promise<number> {
  const row = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM files WHERE machine_id = ?1 AND parse_state = 'pending'").bind(machine).first<{ n: number }>();
  return row!.n;
}

afterEach(() => vi.restoreAllMocks());

describe('admin reindex batches D1 writes + queue sends to fit the whole corpus in one invocation', () => {
  it('re-enqueues a page via DB.batch + sendBatch (never a per-object send)', async () => {
    // One page of 100 objects (a slice fits one invocation). The bug fired ~4 subrequests/object; the
    // fix collapses the page's writes into DB.batch() calls and its sends into sendBatch() chunks of ≤100.
    const pages = [Array.from({ length: 100 }, () => sessionObject('reindexbox'))];
    const listSpy = stubList(pages);
    const batchSpy = vi.spyOn(testEnv.DB, 'batch'); // calls through — real rows are written
    const sendBatchSpy = stubSendBatch();
    const sendSpy = vi.spyOn(testEnv.PARSE_QUEUE, 'send');

    const res = await reindex(reindexRequest(), testEnv, admin);
    expect(res.status).toBe(200); // only page, so done:true → 200
    expect(await res.json()).toMatchObject({ enqueued: 100, done: true });

    // Fresh run (no live cursor) starts at page 0.
    expect(listSpy.mock.calls.length).toBe(1);
    expect(listSpy.mock.calls[0]![0]?.cursor).toBeUndefined();

    // Positive controls — both revert paths of the fix trip an assertion here:
    //  - revert sendBatch → per-object PARSE_QUEUE.send(): sendSpy fires 100× and the next line fails.
    //  - revert the files DB.batch → per-row .first(): the largest batch shrinks from the page's
    //    "1 machine + 100 files" (101) to just the 100-statement flips batch, tripping the >=101 below.
    expect(sendSpy).not.toHaveBeenCalled();
    // O(1) batches per page ({files batch, flips batch}), not O(objects).
    expect(batchSpy.mock.calls.length).toBeLessThanOrEqual(2);
    const biggestBatch = Math.max(...batchSpy.mock.calls.map((c) => (c[0] as unknown[]).length));
    expect(biggestBatch).toBeGreaterThanOrEqual(101); // the page's 100 files + their machine parent, one round trip

    // The sendBatch chunk is within the Queues 100-message cap and covers all 100.
    let sent = 0;
    for (const call of sendBatchSpy.mock.calls) {
      const chunk = call[0] as { body: { reason: string } }[];
      expect(chunk.length).toBeLessThanOrEqual(100);
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk[0]!.body.reason).toBe('reindex');
      sent += chunk.length;
    }
    expect(sent).toBe(100);

    expect(await fileCount('reindexbox')).toBe(100);
    expect(await readCursor()).toEqual({ prefix: 'raw/', cursor: null }); // completed run parks at null so the next call starts fresh
  });

  it('resumes from a persisted cursor, processing only the tail (crash-resume, not restart)', async () => {
    // A prior invocation crashed after page 0, leaving the cursor at page 1. Re-entry must skip the
    // head and process only the tail — the original bug re-walked from zero and died identically.
    const pages = [
      Array.from({ length: 100 }, () => sessionObject('headbox')), // page 0 — already done, must be skipped
      Array.from({ length: 40 }, () => sessionObject('tailbox')), // page 1 — the unfinished tail
    ];
    const listSpy = stubList(pages);
    await seedCursor('1', 'raw/');

    const res = await reindex(reindexRequest(), testEnv, admin);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enqueued: 40, done: true });

    // The first (and only) list call resumes at the saved cursor — the head page is never fetched.
    expect(listSpy.mock.calls.length).toBe(1);
    expect(listSpy.mock.calls[0]![0]?.cursor).toBe('1');

    expect(await fileCount('headbox')).toBe(0); // head never reprocessed
    expect(await fileCount('tailbox')).toBe(40); // only the tail
  });

  it('treats a completed run (cursor = null) as a fresh start from the beginning', async () => {
    await seedCursor(null);
    const pages = [Array.from({ length: 5 }, () => sessionObject('freshbox'))];
    const listSpy = stubList(pages);

    const res = await reindex(reindexRequest(), testEnv, admin);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enqueued: 5, done: true });
    expect(listSpy.mock.calls[0]![0]?.cursor).toBeUndefined(); // started over, not resumed from a completed run
    expect(await fileCount('freshbox')).toBe(5);
  });

  it('does NOT resume a saved cursor from a different prefix — a targeted reindex starts fresh (round 2 finding 1)', async () => {
    // A crashed full-corpus run left a live cursor scoped to prefix A. A later reindex of prefix B must
    // ignore it and start B from the beginning, not replay A's opaque, prefix-scoped R2 token.
    await seedCursor('deep-into-A', 'raw/machine-A/');
    const pages = [Array.from({ length: 7 }, () => sessionObject('bbox'))];
    const listSpy = stubList(pages);

    const res = await reindex(reindexRequest('raw/machine-B/'), testEnv, admin);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enqueued: 7, done: true });

    // Positive control: without the prefix guard, resumeCursor would hand back 'deep-into-A' and the
    // first list() would carry it — skipping B's start. It must be undefined (fresh) and prefix B.
    expect(listSpy.mock.calls[0]![0]?.cursor).toBeUndefined();
    expect(listSpy.mock.calls[0]![0]?.prefix).toBe('raw/machine-B/');
    expect(await fileCount('bbox')).toBe(7);
    expect(await readCursor()).toEqual({ prefix: 'raw/machine-B/', cursor: null }); // now tagged with B

    // Same-prefix resume still works: re-seed A's cursor and reindex A → the token IS replayed.
    await seedCursor('deep-into-A', 'raw/machine-A/');
    const listSpyA = stubList([Array.from({ length: 3 }, () => sessionObject('abox'))]);
    listSpyA.mockClear(); // spyOn reuses the underlying spy — drop the earlier prefix-B calls
    await reindex(reindexRequest('raw/machine-A/'), testEnv, admin);
    expect(listSpyA.mock.calls[0]![0]?.cursor).toBe('deep-into-A');
  });

  it('splits sendBatch chunks by serialized size, not just count, when R2 keys are long (round 2 finding 2)', async () => {
    // 100 objects whose keys are ~4KB each: by count alone they'd pack into one 100-message sendBatch
    // of ~400KB, over the Queues 256KB cap. The size budget must split them into multiple sub-cap chunks.
    const longSuffix = 'x'.repeat(4000);
    const pages = [Array.from({ length: 100 }, () => fakeObject(`raw/longbox/misc/${crypto.randomUUID()}-${longSuffix}.bin`))];
    stubList(pages);
    const sendBatchSpy = stubSendBatch();

    const res = await reindex(reindexRequest(), testEnv, admin);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enqueued: 100, done: true });

    // More than one chunk (count alone would have been exactly one), and every chunk's serialized
    // payload stays under the 256KB Queues hard cap.
    expect(sendBatchSpy.mock.calls.length).toBeGreaterThan(1);
    let sent = 0;
    for (const call of sendBatchSpy.mock.calls) {
      const chunk = call[0] as { body: unknown }[];
      expect(chunk.length).toBeLessThanOrEqual(100);
      expect(JSON.stringify(chunk).length).toBeLessThan(256_000);
      sent += chunk.length;
    }
    expect(sent).toBe(100);
    expect(await fileCount('longbox')).toBe(100);
  });

  it('measures the chunk budget in UTF-8 bytes, not UTF-16 code units, for multibyte keys (round 3 finding 2)', async () => {
    // '中' is one UTF-16 code unit but three UTF-8 bytes. With a ~3K-char suffix each key is ~3K by
    // .length but ~9KB serialized — the old .length budget packs ~64/chunk (~580KB of bytes, over the
    // 256KB cap); the byte-accurate budget must pack far fewer so every chunk stays under the cap.
    const mbSuffix = '中'.repeat(3000);
    const pages = [Array.from({ length: 100 }, () => fakeObject(`raw/mbbox/misc/${crypto.randomUUID()}-${mbSuffix}.bin`))];
    stubList(pages);
    const sendBatchSpy = stubSendBatch();

    const res = await reindex(reindexRequest(), testEnv, admin);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enqueued: 100, done: true });

    // Positive control: measuring .length instead of encoded bytes lets a chunk's real UTF-8 payload
    // exceed 256KB — this byte-accurate assertion fails under that revert.
    const encoder = new TextEncoder();
    let sent = 0;
    for (const call of sendBatchSpy.mock.calls) {
      const chunk = call[0] as { body: unknown }[];
      expect(encoder.encode(JSON.stringify(chunk)).length).toBeLessThan(256_000);
      sent += chunk.length;
    }
    expect(sent).toBe(100);
    expect(await fileCount('mbbox')).toBe(100);
  });

  it('processes a bounded number of pages per invocation and reports {done:false} for the caller to loop (round 3 finding 1)', async () => {
    // The whole corpus can't fit one invocation (each D1 statement counts against the ~1000/call cap),
    // so a call processes at most MAX_PAGES_PER_INVOCATION pages, persists the cursor, and returns
    // done:false; the caller re-invokes until done:true. Here: MAX_PAGES+1 pages of 4 objects each.
    const pageCount = MAX_PAGES_PER_INVOCATION + 1;
    const pages = Array.from({ length: pageCount }, () => Array.from({ length: 4 }, () => sessionObject('loopbox')));
    const listSpy = stubList(pages);
    stubSendBatch();

    const first = await reindex(reindexRequest(), testEnv, admin);
    expect(first.status).toBe(202); // partial progress — NOT 200, so a status-only caller can't stop early
    const firstBody = (await first.json()) as { enqueued: number; done: boolean; cursor: string | null };
    expect(firstBody.done).toBe(false); // more pages remain — caller must loop
    expect(firstBody.enqueued).toBe(MAX_PAGES_PER_INVOCATION * 4);
    expect(firstBody.cursor).toBe(String(MAX_PAGES_PER_INVOCATION)); // the next page's token, persisted
    expect(listSpy.mock.calls.length).toBe(MAX_PAGES_PER_INVOCATION); // stopped at the page bound, didn't drain
    expect(await readCursor()).toEqual({ prefix: 'raw/', cursor: String(MAX_PAGES_PER_INVOCATION) });

    // Second invocation resumes from the persisted cursor and finishes the tail.
    listSpy.mockClear();
    const second = await reindex(reindexRequest(), testEnv, admin);
    expect(second.status).toBe(200); // done → 200
    const secondBody = (await second.json()) as { enqueued: number; done: boolean; cursor: string | null };
    expect(secondBody.done).toBe(true);
    expect(secondBody.cursor).toBeNull();
    expect(listSpy.mock.calls[0]![0]?.cursor).toBe(String(MAX_PAGES_PER_INVOCATION)); // resumed, not restarted
    expect(await fileCount('loopbox')).toBe(pageCount * 4); // all pages processed across the two calls
  });

  it('keeps one page under the D1 statement budget even when every object is on a distinct machine (round 4 finding 1)', async () => {
    // Worst case for the per-invocation budget: a full page whose objects each carry a NEW machine id, so
    // the batch runs a machine upsert AND a files upsert AND a flip per object (~3×PAGE_SIZE statements).
    // Two such pages would breach the ~1000 D1-query cap, so exactly one page is taken per invocation.
    const heavyPage = (tag: string) => Array.from({ length: 200 }, (_unused, i) => sessionObject(`${tag}-m${i}`));
    // Three pages so page 1 is still truncated: a MAX_PAGES=2 regression stays done:false (202) and thus
    // fails on the budget assertion below rather than short-circuiting on status.
    const pages = [heavyPage('p0'), heavyPage('p1'), [sessionObject('tail')]];
    stubList(pages);
    const batchSpy = vi.spyOn(testEnv.DB, 'batch'); // calls through
    stubSendBatch();

    const res = await reindex(reindexRequest(), testEnv, admin);
    expect(res.status).toBe(202); // one heavy page done, more remain
    expect(await res.json()).toMatchObject({ enqueued: 200, done: false });

    // The invocation's batched D1 statements (200 distinct machines + 200 files + 200 flips = 600) stay
    // under a conservative 800 cap. Positive control: bumping MAX_PAGES_PER_INVOCATION back to 2 would
    // process BOTH heavy pages (~1200 statements) and breach this.
    const totalStatements = batchSpy.mock.calls.reduce((n, c) => n + (c[0] as unknown[]).length, 0);
    expect(totalStatements).toBeLessThanOrEqual(800);
    expect(totalStatements).toBeGreaterThanOrEqual(600); // proves the machine upserts ARE included, not skipped
  });
});
