// Daily prune (runs on the `30 4 * * *` cron — see wrangler.jsonc triggers).
//
// Multipart uploads assemble onto a staging key (mpu-staging/...) and complete copies staging ->
// canonical then deletes staging. Two leaks are possible and both are swept here:
//   - an INCOMPLETE multipart upload (collector died before complete): R2 auto-aborts it after 7
//     days on its own, but the staging OBJECT below is the completed-but-uncopied case;
//   - a COMPLETED staging object orphaned by a Worker crash between complete() and the staging
//     delete. Unlike incomplete uploads, a completed object is a normal listable object, so we can
//     find and delete it here.
//
// We list the mpu-staging/ prefix and delete any object older than 7 days — well past the lifetime
// of any in-flight upload, so a live upload is never touched.

const STAGING_PREFIX = 'mpu-staging/';
const STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function runPrune(env: Env, nowMs: number = Date.now()): Promise<void> {
  const cutoff = nowMs - STALE_MS;
  let deleted = 0;
  let scanned = 0;
  let cursor: string | undefined;
  do {
    const page: R2Objects = await env.RAW.list({ prefix: STAGING_PREFIX, cursor, limit: 1000 });
    scanned += page.objects.length;
    const stale = page.objects.filter((o) => o.uploaded.getTime() < cutoff).map((o) => o.key);
    for (const key of stale) {
      await env.RAW.delete(key);
      deleted++;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  console.log(JSON.stringify({ event: 'hub.prune.staging', scanned, deleted }));
}

import { revokeClientCert } from '../api/certs';

/** Daily prune (cron `30 4`). For each machine whose cert-rotation grace window has elapsed,
 * revoke the previous cert at the managed CA, then clear the rotation columns.
 *
 * The clear happens ONLY after a successful CA revoke — a transient Cloudflare failure leaves
 * the row intact so the next run retries. This is CA-side cleanup, not a security boundary: the
 * identity guard already stops honoring the previous fingerprint the instant cert_revoke_at
 * passes (see auth/identity.ts), so a stuck revoke never re-admits the old cert.
 *
 * A row with a NULL prev_cert_id — a pre-M4 cert enrolled by enroll-cert.sh, whose CA id the
 * hub never recorded — has nothing to revoke, so we just clear the columns. */
export async function runDailyPrune(env: Env): Promise<void> {
  const due = await env.DB.prepare(
    `SELECT machine_id, prev_cert_id FROM machines
      WHERE prev_cert_fp_sha256 IS NOT NULL
        AND cert_revoke_at IS NOT NULL
        AND cert_revoke_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).all<{ machine_id: string; prev_cert_id: string | null }>();

  for (const row of due.results) {
    if (row.prev_cert_id) {
      let revoked = false;
      try {
        revoked = await revokeClientCert(env, row.prev_cert_id);
      } catch (e) {
        console.log(JSON.stringify({ event: 'hub.prune.revoke_error', machine: row.machine_id, cert_id: row.prev_cert_id, error: String(e) }));
      }
      if (!revoked) {
        console.log(JSON.stringify({ event: 'hub.prune.revoke_failed', machine: row.machine_id, cert_id: row.prev_cert_id }));
        continue; // keep the row; retry next run
      }
    }
    await env.DB.prepare(
      `UPDATE machines SET prev_cert_fp_sha256 = NULL, prev_cert_id = NULL, cert_revoke_at = NULL WHERE machine_id = ?1`,
    ).bind(row.machine_id).run();
    console.log(JSON.stringify({ event: 'hub.prune.revoked', machine: row.machine_id, cert_id: row.prev_cert_id ?? null }));
  }
}
