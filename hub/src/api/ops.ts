import type { Identity } from '../auth/identity';
import { detect } from '../ingest/detect';
import { normalizeToBound } from './sessions';

/** POST /api/v1/heartbeat */
export async function heartbeat(request: Request, env: Env, identity: Identity): Promise<Response> {
  if (identity.kind !== 'machine') return Response.json({ error: 'unauthorized' }, { status: 401 });
  const body = (await request.json()) as {
    collector_version?: string;
    stores?: Record<string, unknown>;
    events?: Array<{ level: string; code: string; message: string; count?: number; store?: string }>;
  };
  await env.DB.batch([
    env.DB.prepare('INSERT INTO heartbeats (machine_id, collector_version, stats) VALUES (?1, ?2, ?3)').bind(
      identity.machineId,
      body.collector_version ?? null,
      JSON.stringify({ stores: body.stores ?? {}, events: body.events ?? [] }),
    ),
    env.DB.prepare(
      `UPDATE machines SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), collector_version = ?2 WHERE machine_id = ?1`,
    ).bind(identity.machineId, body.collector_version ?? null),
  ]);
  console.log(JSON.stringify({ event: 'hub.heartbeat', machine: identity.machineId }));
  for (const e of body.events ?? []) {
    console.log(JSON.stringify({ event: 'collector.event', machine: identity.machineId, ...e }));
  }
  return Response.json({ ok: true });
}

/** GET /api/v1/machines */
export async function listMachines(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT machine_id, os, hostname, key_protection, priority, collector_version, last_seen_at, last_upload_at, created_at
     FROM machines ORDER BY machine_id`,
  ).all();
  return Response.json({ machines: rows.results });
}

/** GET /api/v1/status — index-completeness introspection for agents. */
export async function status(env: Env): Promise<Response> {
  const machines = await env.DB.prepare(
    `SELECT m.machine_id, m.os, m.last_seen_at, m.last_upload_at,
            SUM(CASE WHEN f.parse_state = 'pending' THEN 1 ELSE 0 END) AS files_pending,
            SUM(CASE WHEN f.parse_state = 'error' THEN 1 ELSE 0 END) AS files_error,
            COUNT(f.id) AS files_total
     FROM machines m LEFT JOIN files f ON f.machine_id = m.machine_id
     GROUP BY m.machine_id ORDER BY m.machine_id`,
  ).all();
  const sessions = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN index_state = 'ready' THEN 1 ELSE 0 END) AS ready,
            SUM(CASE WHEN index_state = 'error' THEN 1 ELSE 0 END) AS error
     FROM sessions`,
  ).first();
  return Response.json({
    machines: machines.results.map((m) => ({ ...m, indexed_through: m.last_seen_at })),
    sessions,
  });
}

/** GET /api/v1/usage?group_by=day|model|machine|repo&from&to */
export async function usage(url: URL, env: Env): Promise<Response> {
  const groupBy = url.searchParams.get('group_by') ?? 'day';
  const groupExpr: Record<string, string> = {
    day: "substr(u.ts, 1, 10)",
    model: 'u.model',
    machine: 's.machine_id',
    repo: 's.repo_url',
  };
  const expr = groupExpr[groupBy];
  if (!expr) return Response.json({ error: 'bad_group_by' }, { status: 400 });
  const binds: unknown[] = [];
  const filters: string[] = [];
  if (url.searchParams.get('from')) {
    binds.push(url.searchParams.get('from'));
    filters.push(`u.ts >= ?${binds.length}`);
  }
  if (url.searchParams.get('to')) {
    binds.push(normalizeToBound(url.searchParams.get('to')!));
    filters.push(`u.ts <= ?${binds.length}`);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = await env.DB.prepare(
    `SELECT ${expr} AS bucket,
            COUNT(*) AS calls,
            SUM(COALESCE(u.input_tokens,0)) AS input_tokens,
            SUM(COALESCE(u.output_tokens,0)) AS output_tokens,
            SUM(COALESCE(u.reasoning_tokens,0)) AS reasoning_tokens,
            SUM(COALESCE(u.cache_read_tokens,0)) AS cache_read_tokens,
            SUM(COALESCE(u.cache_creation_5m_tokens,0)) AS cache_creation_5m_tokens,
            SUM(COALESCE(u.cache_creation_1h_tokens,0)) AS cache_creation_1h_tokens
     FROM usage u JOIN sessions s ON s.session_id = u.session_id
     ${where} GROUP BY bucket ORDER BY bucket DESC LIMIT 400`,
  )
    .bind(...binds)
    .all();
  return Response.json({ group_by: groupBy, rows: rows.results });
}

/** POST /api/v1/admin/reindex — walk R2, upsert files rows, re-enqueue everything.
 *
 * Per-object subrequests are the constraint here: a Worker invocation gets ~1000 subrequests, and the
 * 34.7K-object corpus used to spend ~4 per object (machines upsert + files upsert + parsing-flip +
 * queue send), so the do/while blew the limit and 1101'd on the first page. Everything below is
 * structured so one page costs a FIXED handful of subrequests regardless of page size:
 *   - all the D1 writes for a page collapse into two env.DB.batch() calls (each batch is a single
 *     round trip to D1 — one subrequest — not one per statement);
 *   - the re-enqueues go through PARSE_QUEUE.sendBatch() in chunks of 100 (the Queues per-call cap).
 * At R2's max page size of 1000 that is ~14 subrequests/page × ~35 pages ≈ 490 for the whole corpus,
 * so it now completes in ONE invocation. The reindex_cursor is read on entry (not just written) so a
 * run that does outgrow one invocation — or one that crashes — resumes from its last persisted page
 * instead of restarting from zero and failing identically. */
export async function reindex(request: Request, env: Env, identity: Identity): Promise<Response> {
  if (identity.kind !== 'machine' || !identity.isAdmin) return Response.json({ error: 'forbidden' }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { prefix?: string };
  const prefix = body.prefix ?? 'raw/';

  // Resume: a crashed/paused run leaves reindex_cursor at the last R2 page it finished. Re-entering
  // with a live (non-'done') cursor picks up there; a fresh run — or one after a completed 'done' —
  // starts from the beginning. The cursor is R2's own opaque, prefix-scoped list token.
  const saved = await env.DB.prepare("SELECT value FROM meta WHERE key = 'reindex_cursor'").first<{ value: string }>();
  let cursor: string | undefined = saved && saved.value !== 'done' ? saved.value : undefined;

  let enqueued = 0;
  do {
    const page: R2Objects = await env.RAW.list({ prefix, cursor, limit: 1000, include: ['customMetadata'] });

    type Item = { key: string; machineId: string; store: string; relpath: string; det: ReturnType<typeof detect>; contentHash: string; mtime: string | null; size: number };
    const items: Item[] = [];
    for (const obj of page.objects) {
      const parts = obj.key.split('/'); // raw/{machine}/{store}/{relpath...}
      if (parts.length < 4 || parts[0] !== 'raw') continue;
      const machineId = parts[1]!;
      const store = parts[2]!;
      const relpath = parts.slice(3).join('/');
      // R2 doesn't carry files.mtime natively — it's the SOURCE file's mtime, recorded as
      // customMetadata on the object by upload.ts's PUT calls (see r2MtimeMetadata there). A
      // legacy object written before that existed simply has no customMetadata; fall back to
      // NULL rather than clobbering a row's already-known mtime with a wrong value on reindex.
      items.push({
        key: obj.key,
        machineId,
        store,
        relpath,
        det: detect(store, relpath, machineId),
        contentHash: obj.checksums?.sha256 ? hex(obj.checksums.sha256) : 'unknown',
        mtime: obj.customMetadata?.mtime ?? null,
        size: obj.size,
      });
    }

    if (items.length > 0) {
      // One batch, executed sequentially in a transaction: distinct machine parents first (files.machine_id
      // is a FK), then every files upsert RETURNING id. We read the ids straight back out of the batch
      // results to drive the flips and the queue sends — no per-row round trip.
      const machineIds = [...new Set(items.map((i) => i.machineId))];
      const machineStmts = machineIds.map((m) =>
        env.DB.prepare(`INSERT INTO machines (machine_id, os) VALUES (?1, 'unknown') ON CONFLICT (machine_id) DO NOTHING`).bind(m),
      );
      const fileStmts = items.map((i) =>
        env.DB.prepare(
          `INSERT INTO files (machine_id, store, relpath, r2_key, size, mtime, content_hash, harness, session_id, parse_state)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending')
           ON CONFLICT (machine_id, store, relpath) DO UPDATE SET
             parse_state = 'pending', size = excluded.size, mtime = COALESCE(excluded.mtime, files.mtime),
             harness = excluded.harness, session_id = excluded.session_id, content_hash = excluded.content_hash
           RETURNING id`,
        ).bind(i.machineId, i.store, i.relpath, i.key, i.size, i.mtime, i.contentHash, i.det.harness, i.det.sessionId ?? null),
      );
      const results = await env.DB.batch<{ id: number }>([...machineStmts, ...fileStmts]);
      const ids = results.slice(machineStmts.length).map((r) => r.results[0]!.id);

      // Mirror upload.ts's canonical-reupload fix in a second batch, now that we hold each row id: the
      // upserts above flipped every file back to 'pending', so any session those files are CURRENTLY
      // canonical for must leave 'ready' (it otherwise keeps advertising blocks/FTS from the pre-reindex
      // parse until the consumer catches up). A session id matches its own canonical; an export ZIP has
      // no det.sessionId (it fans out to many sessions) so it flips every session it owns. Brand-new
      // sessions and non-canonical duplicates simply match nothing.
      const flipStmts = [];
      for (let k = 0; k < items.length; k++) {
        const { det } = items[k]!;
        if (det.sessionId) {
          flipStmts.push(
            env.DB.prepare("UPDATE sessions SET index_state = 'parsing' WHERE session_id = ?1 AND canonical_file_id = ?2").bind(det.sessionId, ids[k]!),
          );
        } else if (det.kind === 'export-archive') {
          flipStmts.push(env.DB.prepare("UPDATE sessions SET index_state = 'parsing' WHERE canonical_file_id = ?1").bind(ids[k]!));
        }
      }
      if (flipStmts.length > 0) await env.DB.batch(flipStmts);

      // Re-enqueue via sendBatch (≤100 messages/call) instead of one send per file.
      const messages = items.map((i, k) => ({
        body: { file_id: ids[k]!, r2_key: i.key, reason: 'reindex' as const, content_hash: i.contentHash },
      }));
      for (let start = 0; start < messages.length; start += 100) {
        await env.PARSE_QUEUE.sendBatch(messages.slice(start, start + 100));
      }
      enqueued += items.length;
    }

    cursor = page.truncated ? page.cursor : undefined;
    // Persist AFTER this page's sends so a crash re-processes at most one page — and reindexing a page
    // is idempotent (upserts + re-enqueue), so the overlap is harmless.
    await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('reindex_cursor', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1")
      .bind(cursor ?? 'done')
      .run();
  } while (cursor);

  console.log(JSON.stringify({ event: 'hub.reindex', enqueued }));
  return Response.json({ enqueued, done: true });
}

export function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
