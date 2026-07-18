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
 * A row with a NULL prev_cert_id — a pre-M4 cert enrolled by enroll-cert.sh, whose CA id the hub
 * never recorded — cannot be revoked here and its underlying cert may still be CA-valid until its
 * natural expiry. So we do NOT free the fingerprint: we clear only cert_revoke_at and keep
 * prev_cert_fp_sha256 (with its NULL id) as a TOMBSTONE, so adminMachines' clash check keeps the fp
 * unclaimable while some holder might still authenticate with the old cert. Logged for manual
 * cleanup. Only a confirmed CA revoke (known id) frees the fingerprint for reuse. */
export async function runDailyPrune(env: Env): Promise<void> {
  const due = await env.DB.prepare(
    `SELECT machine_id, prev_cert_fp_sha256, prev_cert_id, cert_revoke_at FROM machines
      WHERE prev_cert_fp_sha256 IS NOT NULL
        AND cert_revoke_at IS NOT NULL
        AND cert_revoke_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).all<{ machine_id: string; prev_cert_fp_sha256: string; prev_cert_id: string | null; cert_revoke_at: string }>();

  for (const row of due.results) {
    // Each UPDATE below is conditional on the EXACT grace window we selected. A renew that landed
    // between the SELECT and here repopulated prev_cert_fp_sha256/cert_revoke_at with a FRESH window,
    // so cert_revoke_at = ?3 no longer matches and the UPDATE no-ops rather than wiping new state.
    if (!row.prev_cert_id) {
      // Unknown CA id → cannot revoke, cannot prove it's gone. Retire the grace window (identity
      // already stops honoring it) but keep the fp reserved as a tombstone so no other machine can
      // claim a fingerprint whose cert might still be live.
      await env.DB.prepare(
        `UPDATE machines SET cert_revoke_at = NULL
          WHERE machine_id = ?1 AND prev_cert_fp_sha256 = ?2 AND cert_revoke_at = ?3 AND prev_cert_id IS NULL`,
      )
        .bind(row.machine_id, row.prev_cert_fp_sha256, row.cert_revoke_at)
        .run();
      console.log(JSON.stringify({ event: 'hub.prune.tombstoned', machine: row.machine_id, prev_cert_fp_sha256: row.prev_cert_fp_sha256 }));
      continue;
    }

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
    // Revoke confirmed → the CA cert is gone, so the fingerprint is genuinely free. Clear all three.
    await env.DB.prepare(
      `UPDATE machines SET prev_cert_fp_sha256 = NULL, prev_cert_id = NULL, cert_revoke_at = NULL
        WHERE machine_id = ?1 AND prev_cert_fp_sha256 = ?2 AND cert_revoke_at = ?3`,
    )
      .bind(row.machine_id, row.prev_cert_fp_sha256, row.cert_revoke_at)
      .run();
    console.log(JSON.stringify({ event: 'hub.prune.revoked', machine: row.machine_id, cert_id: row.prev_cert_id }));
  }
}
