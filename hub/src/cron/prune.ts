import { pollRetired } from '../api/certs';

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

/** Daily prune (cron `30 4`), two phases over the cert-rotation state.
 *
 * Phase 1 — retire expired grace windows: for each machine whose prev-cert grace window has elapsed,
 * move the prev entry into the durable retired_certs queue and clear the prev columns (which now mean
 * ONLY the grace window). The move + clear co-commit in one db.batch, guarded on the exact window we
 * selected, so a renew that repopulated a FRESH window between the SELECT and here is left intact.
 *
 * Phase 2 — drain the queue: poll every still-reserved entry (revoked_at IS NULL) with a known
 * cert_id. Cloudflare's revoke is ASYNCHRONOUS (DELETE → 'pending_revocation' → 'revoked'), so we
 * stamp revoked_at — freeing the fingerprint for reuse — ONLY once the CA reports the cert actually
 * 'revoked' (or 404). A cert still pending stays reserved and is re-polled next run; one that never
 * got revoked gets a fresh revoke attempt. An unknown-id entry (pre-M4/enroll cert, CA id never
 * recorded) can't be revoked here — it stays reserved and is logged for manual cleanup. This is
 * CA-side cleanup, not a security boundary: machineIdentity already stops honoring a fingerprint the
 * instant it leaves the current/in-grace-prev slots, so a reserved-but-unrevoked cert never authns. */
export async function runDailyPrune(env: Env): Promise<void> {
  const due = await env.DB.prepare(
    `SELECT machine_id, prev_cert_fp_sha256, prev_cert_id, cert_revoke_at FROM machines
      WHERE prev_cert_fp_sha256 IS NOT NULL
        AND cert_revoke_at IS NOT NULL
        AND cert_revoke_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).all<{ machine_id: string; prev_cert_fp_sha256: string; prev_cert_id: string | null; cert_revoke_at: string }>();

  for (const row of due.results) {
    const now = new Date().toISOString();
    // INSERT the reservation first (guarded on the window still being present), THEN clear it — both
    // conditional on the EXACT prev fp + revoke_at we selected, so a fresh window from a concurrent
    // renew (new revoke_at) matches neither statement and survives untouched.
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO retired_certs (fingerprint, cert_id, machine_id, retired_at)
         SELECT ?2, ?3, ?1, ?5
          WHERE EXISTS (SELECT 1 FROM machines WHERE machine_id = ?1 AND prev_cert_fp_sha256 = ?2 AND cert_revoke_at = ?4)`,
      ).bind(row.machine_id, row.prev_cert_fp_sha256, row.prev_cert_id, row.cert_revoke_at, now),
      env.DB.prepare(
        `UPDATE machines SET prev_cert_fp_sha256 = NULL, prev_cert_id = NULL, cert_revoke_at = NULL
          WHERE machine_id = ?1 AND prev_cert_fp_sha256 = ?2 AND cert_revoke_at = ?3`,
      ).bind(row.machine_id, row.prev_cert_fp_sha256, row.cert_revoke_at),
    ]);
    if ((results[1]!.meta.changes ?? 0) === 0) continue; // fresh window landed; leave it for next run
    console.log(JSON.stringify({ event: 'hub.prune.retired', machine: row.machine_id, fingerprint: row.prev_cert_fp_sha256, cert_id: row.prev_cert_id ?? null }));
  }

  const reserved = await env.DB.prepare(
    `SELECT fingerprint, cert_id, machine_id FROM retired_certs WHERE revoked_at IS NULL`,
  ).all<{ fingerprint: string; cert_id: string | null; machine_id: string }>();

  // Two-phase claim so an admin rollback can't un-queue + reinstate a fingerprint in the window between
  // this SELECT materializing a row and the loop reaching its CA revoke. Before ANY CA call we stamp
  // claimed_at; if that UPDATE changes nothing the row was un-queued (or claimed by another run) and we
  // skip it — never revoking a cert an admin may have just made current. adminMachines' un-queue
  // requires claimed_at IS NULL and its rollback CAS 409s against a claimed reservation, so the two
  // sides serialize in D1. A claim older than an hour (longer than any run) is stale — from a prior or
  // crashed run — and is re-claimable, so a revoke that failed last time is retried, not wedged.
  const claimStaleBefore = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  for (const r of reserved.results) {
    if (!r.cert_id) {
      // Unknown CA id — can't revoke, and NULL id ≠ revoked, so keep it reserved. Logged each run so
      // the fingerprint can be manually released once the underlying cert is confirmed gone.
      console.log(JSON.stringify({ event: 'hub.prune.unknown_id_reservation', machine: r.machine_id, fingerprint: r.fingerprint }));
      continue;
    }
    const claim = await env.DB.prepare(
      `UPDATE retired_certs SET claimed_at = ?4
         WHERE fingerprint = ?1 AND machine_id = ?2 AND revoked_at IS NULL
           AND (claimed_at IS NULL OR claimed_at <= ?3)`,
    )
      .bind(r.fingerprint, r.machine_id, claimStaleBefore, new Date().toISOString())
      .run();
    if ((claim.meta.changes ?? 0) === 0) {
      // Un-queued/reinstated by an admin, or already claimed this run — don't touch the CA.
      console.log(JSON.stringify({ event: 'hub.prune.claim_skipped', machine: r.machine_id, fingerprint: r.fingerprint }));
      continue;
    }
    const outcome = await pollRetired(env, r.cert_id);
    if (outcome !== 'revoked') {
      // Not settled this run (still pending, or the poll failed). Release the claim so the NEXT run
      // re-attempts — otherwise a held claim would skip it forever. A 'revoked' outcome leaves
      // revoked_at stamped (terminal), so it's already out of the reserved set.
      await env.DB.prepare('UPDATE retired_certs SET claimed_at = NULL WHERE fingerprint = ?1 AND machine_id = ?2 AND revoked_at IS NULL')
        .bind(r.fingerprint, r.machine_id)
        .run();
    }
    if (outcome === 'pending') console.log(JSON.stringify({ event: 'hub.prune.revoke_pending', machine: r.machine_id, cert_id: r.cert_id }));
    else if (outcome === 'failed') console.log(JSON.stringify({ event: 'hub.prune.revoke_failed', machine: r.machine_id, cert_id: r.cert_id }));
  }
}
