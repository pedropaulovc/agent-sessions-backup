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

/** POST /api/v1/admin/reindex — walk R2, upsert files rows, re-enqueue everything. */
export async function reindex(request: Request, env: Env, identity: Identity): Promise<Response> {
  if (identity.kind !== 'machine' || !identity.isAdmin) return Response.json({ error: 'forbidden' }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { prefix?: string };
  const prefix = body.prefix ?? 'raw/';

  let cursor: string | undefined;
  let enqueued = 0;
  do {
    const page: R2Objects = await env.RAW.list({ prefix, cursor, limit: 500, include: ['customMetadata'] });
    for (const obj of page.objects) {
      const parts = obj.key.split('/'); // raw/{machine}/{store}/{relpath...}
      if (parts.length < 4 || parts[0] !== 'raw') continue;
      const machineId = parts[1]!;
      const store = parts[2]!;
      const relpath = parts.slice(3).join('/');
      await env.DB.prepare(
        `INSERT INTO machines (machine_id, os) VALUES (?1, 'unknown') ON CONFLICT (machine_id) DO NOTHING`,
      )
        .bind(machineId)
        .run();
      const det = detect(store, relpath, machineId);
      const contentHash = obj.checksums?.sha256 ? hex(obj.checksums.sha256) : 'unknown';
      // R2 doesn't carry files.mtime natively — it's the SOURCE file's mtime, recorded as
      // customMetadata on the object by upload.ts's PUT calls (see r2MtimeMetadata there). A
      // legacy object written before that existed simply has no customMetadata; fall back to
      // NULL rather than clobbering a row's already-known mtime with a wrong value on reindex.
      const mtime = obj.customMetadata?.mtime ?? null;
      const row = await env.DB.prepare(
        `INSERT INTO files (machine_id, store, relpath, r2_key, size, mtime, content_hash, harness, session_id, parse_state)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending')
         ON CONFLICT (machine_id, store, relpath) DO UPDATE SET
           parse_state = 'pending', size = excluded.size, mtime = COALESCE(excluded.mtime, files.mtime),
           harness = excluded.harness, session_id = excluded.session_id, content_hash = excluded.content_hash
         RETURNING id`,
      )
        .bind(machineId, store, relpath, obj.key, obj.size, mtime, contentHash, det.harness, det.sessionId ?? null)
        .first<{ id: number }>();
      if (det.sessionId) {
        // Mirrors upload.ts's canonical-reupload fix: this upsert just flipped the row back to
        // 'pending' (unconditionally, above) and is about to enqueue a fresh parse — if this file
        // is the session's CURRENT canonical, sessions.index_state (and the blocks/FTS it
        // advertises) would otherwise stay 'ready', describing whatever this file parsed to
        // BEFORE this reindex, until the queue consumer gets around to it. No-op for a brand-new
        // session (no sessions row yet) or a non-canonical duplicate.
        await env.DB.prepare("UPDATE sessions SET index_state = 'parsing' WHERE session_id = ?1 AND canonical_file_id = ?2")
          .bind(det.sessionId, row!.id)
          .run();
      }
      await env.PARSE_QUEUE.send({ file_id: row!.id, r2_key: obj.key, reason: 'reindex', content_hash: contentHash });
      enqueued++;
    }
    cursor = page.truncated ? page.cursor : undefined;
    await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('reindex_cursor', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1")
      .bind(cursor ?? 'done')
      .run();
  } while (cursor);

  console.log(JSON.stringify({ event: 'hub.reindex', enqueued }));
  return Response.json({ enqueued });
}

export function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
