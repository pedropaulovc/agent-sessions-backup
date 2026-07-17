import type { Identity } from '../auth/identity';
import { detect } from '../ingest/detect';

const TERMINAL_PARSE_STATES = new Set(['parsed', 'skipped', 'superseded']);

/** PUT /api/v1/files/{machine_id}/{store}/{relpath...} */
export async function putFile(
  request: Request,
  env: Env,
  identity: Identity,
  machineId: string,
  store: string,
  relpath: string,
): Promise<Response> {
  if (identity.kind !== 'machine') return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (identity.machineId !== machineId && !identity.isAdmin) {
    return Response.json({ error: 'machine_mismatch' }, { status: 403 });
  }

  const hashHeader = request.headers.get('x-content-hash') ?? '';
  const m = hashHeader.match(/^sha256:([0-9a-f]{64})$/i);
  if (!m) return Response.json({ error: 'missing_or_bad_x_content_hash' }, { status: 400 });
  const sha256 = m[1]!.toLowerCase();
  const mtime = request.headers.get('x-file-mtime');
  const size = Number(request.headers.get('content-length') ?? request.headers.get('x-file-size'));
  if (!Number.isFinite(size) || size < 0) return Response.json({ error: 'missing_content_length' }, { status: 400 });
  if (!request.body) return Response.json({ error: 'missing_body' }, { status: 400 });

  const existing = await env.DB.prepare(
    'SELECT id, content_hash, parse_state, r2_key FROM files WHERE machine_id = ?1 AND store = ?2 AND relpath = ?3',
  )
    .bind(machineId, store, relpath)
    .first<{ id: number; content_hash: string; parse_state: string; r2_key: string }>();
  if (existing && existing.content_hash === sha256) {
    // A matching hash normally means nothing to do, but if the row never finished
    // indexing (a dropped/failed queue message), the file would otherwise sit
    // unindexed forever while files/check reports it as present. Re-enqueue.
    if (!TERMINAL_PARSE_STATES.has(existing.parse_state)) {
      await env.PARSE_QUEUE.send({ file_id: existing.id, r2_key: existing.r2_key, reason: 'upload' });
      return Response.json({ status: 'unchanged', file_id: existing.id, requeued: true });
    }
    return Response.json({ status: 'unchanged', file_id: existing.id });
  }

  const r2Key = `raw/${machineId}/${store}/${relpath}`;
  // R2 verifies the checksum server-side: a corrupt/truncated body never lands.
  try {
    await env.RAW.put(r2Key, request.body, { sha256 });
  } catch (e) {
    return Response.json({ error: 'checksum_or_write_failure', detail: String(e) }, { status: 400 });
  }

  const det = detect(store, relpath);
  const row = await env.DB.prepare(
    `INSERT INTO files (machine_id, store, relpath, r2_key, size, mtime, content_hash, harness, session_id, parse_state)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending')
     ON CONFLICT (machine_id, store, relpath) DO UPDATE SET
       size = excluded.size, mtime = excluded.mtime, content_hash = excluded.content_hash,
       parse_state = 'pending', parse_error = NULL,
       uploaded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     RETURNING id`,
  )
    .bind(machineId, store, relpath, r2Key, size, mtime, sha256, det.harness, det.sessionId ?? null)
    .first<{ id: number }>();

  await env.DB.prepare('UPDATE machines SET last_upload_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE machine_id = ?1')
    .bind(machineId)
    .run();
  await env.PARSE_QUEUE.send({ file_id: row!.id, r2_key: r2Key, reason: 'upload' });

  console.log(
    JSON.stringify({ event: 'access.upload', machine: machineId, key: r2Key, bytes: size, status: existing ? 'updated' : 'created' }),
  );
  return Response.json({ status: 'stored', file_id: row!.id }, { status: 201 });
}

/** POST /api/v1/files/check — batch resync: which of these does the hub NOT have? */
export async function checkFiles(request: Request, env: Env, identity: Identity): Promise<Response> {
  if (identity.kind !== 'machine') return Response.json({ error: 'unauthorized' }, { status: 401 });
  const body = (await request.json()) as { files?: Array<{ store: string; relpath: string; sha256: string }> };
  const items = body.files ?? [];
  if (items.length > 1000) return Response.json({ error: 'batch_too_large' }, { status: 400 });

  const missing: Array<{ store: string; relpath: string }> = [];
  for (const chunk of chunks(items, 50)) {
    const conditions = chunk.map((_, i) => `(store = ?${i * 3 + 2} AND relpath = ?${i * 3 + 3} AND content_hash = ?${i * 3 + 4})`);
    const binds: unknown[] = [identity.machineId];
    for (const it of chunk) binds.push(it.store, it.relpath, it.sha256.replace(/^sha256:/, '').toLowerCase());
    const rows = await env.DB.prepare(
      `SELECT store, relpath FROM files WHERE machine_id = ?1 AND (${conditions.join(' OR ')})`,
    )
      .bind(...binds)
      .all<{ store: string; relpath: string }>();
    const have = new Set(rows.results.map((r) => `${r.store}\n${r.relpath}`));
    for (const it of chunk) if (!have.has(`${it.store}\n${it.relpath}`)) missing.push({ store: it.store, relpath: it.relpath });
  }
  return Response.json({ missing });
}

function* chunks<T>(arr: T[], n: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += n) yield arr.slice(i, i + n);
}
