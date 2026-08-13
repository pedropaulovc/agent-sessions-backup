/**
 * Whole-session export: `GET /s/{id}/export.zip` streams a zip in the raw collector
 * layout — one entry per backing file at `{machine}/{store}/{relpath}` holding the
 * session's canonical R2 bytes — plus a `manifest.json` describing the entries. The
 * zip is the hand-carry vehicle for moving a session into a preview environment: every
 * entry re-uploads through the standard `PUT /api/v1/files/{machine}/{store}/{relpath}`
 * ingest path unchanged (`hub/scripts/preview-upload-session.mjs`).
 *
 * Included entries: the session's canonical transcript, its own subagent `.meta.json`
 * sidecar (when it is itself a subagent), and — one level down — each child subagent's
 * transcript + sidecar, so a re-ingested parent keeps its subagent links working.
 *
 * An archive-backed session (export-inbox ZIP) is NARROWED: the canonical object is the
 * whole multi-conversation export, so streaming it verbatim would leak every other
 * conversation. Instead the one conversation is extracted and re-wrapped as a fresh
 * single-conversation archive (`conversations.json` = [conversation]) under a
 * session-suffixed relpath, which still detects as an export-archive on re-ingest and
 * cannot collide with a sibling session's export of the same source archive.
 */

import { Zip, ZipDeflate, ZipPassThrough, strToU8, zipSync } from 'fflate';
import { detect } from '../ingest/detect';
import { extractConversationById } from '../ingest/parsers/export-inbox';

interface FileRow {
  machine_id: string;
  store: string;
  relpath: string;
  r2_key: string;
  size: number;
  mtime: string | null;
  content_hash: string;
}

interface ManifestEntry {
  machine: string;
  store: string;
  relpath: string;
  role: 'canonical' | 'subagent' | 'subagent-meta';
  mtime: string | null;
  /** Verbatim entries only — a narrowed archive's bytes differ from the source object. */
  content_hash?: string;
  size?: number;
  /** Present (true) when the entry is a re-wrapped single-conversation archive. */
  narrowed?: boolean;
}

interface ZipEntrySource {
  name: string;
  mtime: string | null;
  body: Uint8Array | ReadableStream<Uint8Array>;
  /** Pre-compressed payloads (narrowed archives) are stored, not re-deflated. */
  mode: 'deflate' | 'store';
}

export async function exportZipEndpoint(sessionId: string, env: Env): Promise<Response> {
  const canonical = await env.DB.prepare(
    `SELECT f.machine_id, f.store, f.relpath, f.r2_key, f.size, f.mtime, f.content_hash
     FROM sessions s JOIN files f ON f.id = s.canonical_file_id
     WHERE s.session_id = ?1`,
  )
    .bind(sessionId)
    .first<FileRow>();
  if (!canonical) return new Response('not found', { status: 404 });

  const entries: Array<{ manifest: ManifestEntry; row: FileRow; narrowed?: Uint8Array }> = [];

  const det = detect(canonical.store, canonical.relpath);
  if (det.kind === 'export-archive') {
    const obj = await env.RAW.get(canonical.r2_key);
    if (!obj) return new Response('canonical object missing', { status: 404 });
    const conv = extractConversationById(new Uint8Array(await obj.arrayBuffer()), sessionId);
    if (conv === undefined) return new Response('not found', { status: 404 });
    const narrowed = zipSync({ 'conversations.json': strToU8(`[${conv}]`) }, { mtime: parseDate(canonical.mtime) });
    const relpath = narrowedRelpath(canonical.relpath, sessionId);
    entries.push({
      manifest: {
        machine: canonical.machine_id,
        store: canonical.store,
        relpath,
        role: 'canonical',
        mtime: canonical.mtime,
        narrowed: true,
      },
      row: { ...canonical, relpath },
      narrowed,
    });
  } else {
    entries.push({ manifest: verbatimManifestEntry(canonical, 'canonical'), row: canonical });
    const ownMeta = await metaSidecarOf(canonical, env);
    if (ownMeta) entries.push({ manifest: verbatimManifestEntry(ownMeta, 'subagent-meta'), row: ownMeta });

    const children = (
      await env.DB.prepare(
        `SELECT f.machine_id, f.store, f.relpath, f.r2_key, f.size, f.mtime, f.content_hash
         FROM sessions s JOIN files f ON f.id = s.canonical_file_id
         WHERE s.parent_session_id = ?1
         ORDER BY f.relpath`,
      )
        .bind(sessionId)
        .all<FileRow>()
    ).results;
    for (const child of children) {
      // A child whose R2 object has gone missing is dropped rather than breaking the
      // whole export — the manifest only ever lists entries the zip actually carries.
      if (!(await env.RAW.head(child.r2_key))) continue;
      entries.push({ manifest: verbatimManifestEntry(child, 'subagent'), row: child });
      const childMeta = await metaSidecarOf(child, env);
      if (childMeta) entries.push({ manifest: verbatimManifestEntry(childMeta, 'subagent-meta'), row: childMeta });
    }
  }

  const manifest = {
    format: 'agent-sessions-export/v1',
    session_id: sessionId,
    exported_at: new Date().toISOString(),
    entries: entries.map((e) => e.manifest),
  };

  const stream = streamZip(async function* () {
    yield {
      name: 'manifest.json',
      mtime: null,
      body: strToU8(JSON.stringify(manifest, null, 2)),
      mode: 'deflate',
    } satisfies ZipEntrySource;
    for (const entry of entries) {
      const name = `${entry.row.machine_id}/${entry.row.store}/${entry.row.relpath}`;
      if (entry.narrowed) {
        yield { name, mtime: entry.row.mtime, body: entry.narrowed, mode: 'store' } satisfies ZipEntrySource;
        continue;
      }
      const obj = await env.RAW.get(entry.row.r2_key);
      // The canonical was head-checked implicitly by the D1 row; a between-read delete
      // aborts the stream (truncated download) rather than shipping a lying manifest.
      if (!obj) throw new Error(`r2 object missing mid-export: ${entry.row.r2_key}`);
      yield { name, mtime: entry.row.mtime, body: obj.body, mode: 'deflate' } satisfies ZipEntrySource;
    }
  });

  console.log(JSON.stringify({ event: 'access.export', session: sessionId, entries: entries.length }));
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="session-${safeFilenamePart(sessionId)}.zip"`,
      'cache-control': 'no-store',
    },
  });
}

/** `export-2026.zip` → `export-2026.<sessionId>.zip` — still an export-archive on re-ingest. */
function narrowedRelpath(relpath: string, sessionId: string): string {
  const safe = safeFilenamePart(sessionId);
  return relpath.toLowerCase().endsWith('.zip')
    ? `${relpath.slice(0, -'.zip'.length)}.${safe}.zip`
    : `${relpath}.${safe}.zip`;
}

function safeFilenamePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-');
}

function parseDate(value: string | null): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function verbatimManifestEntry(row: FileRow, role: ManifestEntry['role']): ManifestEntry {
  return {
    machine: row.machine_id,
    store: row.store,
    relpath: row.relpath,
    role,
    mtime: row.mtime,
    // D1 stores bare hex; the manifest carries the self-describing form the upload
    // header (`x-content-hash`) expects.
    content_hash: `sha256:${row.content_hash}`,
    size: row.size,
  };
}

/** The `.meta.json` sibling of a subagent transcript (`agent-X.jsonl` → `agent-X.meta.json`). */
async function metaSidecarOf(row: FileRow, env: Env): Promise<FileRow | null> {
  if (!row.relpath.endsWith('.jsonl')) return null;
  const metaRelpath = `${row.relpath.slice(0, -'.jsonl'.length)}.meta.json`;
  if (detect(row.store, metaRelpath).kind !== 'subagent-meta') return null;
  const meta = await env.DB.prepare(
    `SELECT machine_id, store, relpath, r2_key, size, mtime, content_hash
     FROM files WHERE machine_id = ?1 AND store = ?2 AND relpath = ?3`,
  )
    .bind(row.machine_id, row.store, metaRelpath)
    .first<FileRow>();
  if (!meta) return null;
  if (!(await env.RAW.head(meta.r2_key))) return null;
  return meta;
}

/**
 * Sequentially zip entries into a byte stream. Entries deflate (or pass through) as
 * their bodies arrive, so a large transcript never has to be buffered whole alongside
 * its compressed copy. An error mid-entry aborts the stream — the client sees a
 * truncated/failed download, never a silently incomplete archive presented as complete.
 */
function streamZip(entries: () => AsyncGenerator<ZipEntrySource>): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  // fflate's callback is synchronous; chain writes so output order is preserved without
  // blocking the compressor.
  let pending: Promise<unknown> = Promise.resolve();
  const zip = new Zip((err, chunk, final) => {
    if (err) {
      pending = pending.then(() => writer.abort(err));
      return;
    }
    pending = pending.then(() => writer.write(chunk));
    if (final) pending = pending.then(() => writer.close());
  });
  void (async () => {
    for await (const entry of entries()) {
      const file = entry.mode === 'store' ? new ZipPassThrough(entry.name) : new ZipDeflate(entry.name, { level: 6 });
      const mtime = parseDate(entry.mtime);
      if (mtime) file.mtime = mtime;
      zip.add(file);
      if (entry.body instanceof Uint8Array) {
        file.push(entry.body, true);
        continue;
      }
      const reader = entry.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        file.push(value, false);
        // Coarse backpressure: don't let the compressor race unboundedly ahead of the client.
        await writer.ready;
      }
      file.push(new Uint8Array(0), true);
    }
    zip.end();
    await pending;
  })().catch(async (err: unknown) => {
    zip.terminate();
    await writer.abort(err).catch(() => {});
  });
  return readable;
}
