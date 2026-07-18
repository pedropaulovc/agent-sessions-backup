// Daily prune (runs on the `30 4 * * *` cron — see wrangler.jsonc triggers).
//
// R2 keeps (and bills for) the parts of a multipart upload that was opened but never completed or
// aborted — a collector that died mid-upload leaves one dangling. The R2 Workers binding has no
// "list incomplete multipart uploads" call (only the S3 API does), so the create endpoint records
// every uploadId in D1 (multipart_uploads); complete/abort delete their row. Anything still in the
// table past the age cutoff is dangling: abort it at R2 to release the parts and drop the row.
//
// The abort is best-effort — an uploadId R2 already reaped (or that a late abort/complete finished)
// throws, and we still delete the D1 row so it isn't reconsidered every day.

const PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function runPrune(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - PRUNE_AGE_MS).toISOString();
  // multipart_uploads.created_at uses strftime('%Y-%m-%dT%H:%M:%fZ') — same lexical order as an ISO
  // string, so a string comparison against the cutoff is a correct age filter.
  const rows = await env.DB.prepare(
    'SELECT upload_id, r2_key FROM multipart_uploads WHERE created_at < ?1',
  )
    .bind(cutoff)
    .all<{ upload_id: string; r2_key: string }>();

  let aborted = 0;
  let failed = 0;
  for (const r of rows.results) {
    try {
      await env.RAW.resumeMultipartUpload(r.r2_key, r.upload_id).abort();
      aborted++;
    } catch (e) {
      failed++;
      console.log(JSON.stringify({ event: 'hub.prune.abort_warn', key: r.r2_key, upload_id: r.upload_id, error: String(e) }));
    }
    await env.DB.prepare('DELETE FROM multipart_uploads WHERE upload_id = ?1').bind(r.upload_id).run();
  }
  console.log(JSON.stringify({ event: 'hub.prune.multipart', considered: rows.results.length, aborted, failed }));
}
