-- M4 cert-rotation grace window. POST /api/v1/certs/renew mints a successor cert at
-- the Cloudflare managed CA and swaps it in as the machine's current fingerprint, but
-- the PREVIOUS cert must keep authenticating for a grace period so an in-flight
-- collector isn't locked out mid-rotation. During that window a machine has TWO valid
-- fingerprints; machineIdentity() matches cert_fp_sha256 OR (prev_cert_fp_sha256 with
-- cert_revoke_at still in the future). The daily prune cron (30 4) revokes the previous
-- cert at the CA (DELETE by prev_cert_id) once cert_revoke_at passes, then clears these
-- columns — and ONLY after a successful revoke, so a failed CA call retries next run.
--
-- cert_id is the CA's client-certificate id for the CURRENT cert — the handle renew/prune use to
-- revoke it. It is recorded by every write path that mints a cert: POST /certs/renew, the admin
-- endpoint, AND enroll-cert.sh (which now stores result.id and retires any displaced cert on
-- re-enroll). Only pre-M4 LEGACY rows enrolled before this migration have cert_id NULL — they have
-- no id to revoke.
-- The hub stops honoring the old fingerprint at cert_revoke_at regardless, but because a
-- NULL id means "id unknown" (the cert may still be CA-valid until its ~1yr expiry), NOT
-- "revoked", the prune does NOT free such a fingerprint: it clears only cert_revoke_at and
-- keeps prev_cert_fp_sha256 (with its NULL id) as a TOMBSTONE so no other machine can claim
-- a fingerprint whose cert might still authenticate. Only a confirmed CA revoke (known id)
-- clears prev_cert_fp_sha256 and returns the fingerprint to the reusable pool.
ALTER TABLE machines ADD COLUMN cert_id TEXT;
ALTER TABLE machines ADD COLUMN prev_cert_fp_sha256 TEXT;
ALTER TABLE machines ADD COLUMN prev_cert_id TEXT;
ALTER TABLE machines ADD COLUMN cert_revoke_at TEXT;

-- Durable reservation/revocation queue. The machines-row current+prev slots can hold at most two
-- fingerprints, so ANY path that displaces a third (a renew overwriting an in-grace prev, a recovery
-- replacing the orphaned successor, an admin cert swap clearing current/prev, the post-signing
-- D1-failure cleanup, and the daily grace-expiry prune) records the displaced cert HERE instead of
-- dropping it. That keeps a still-CA-valid fingerprint reserved so no other machine can claim it and
-- have the old cert impersonate them.
--
--   revoked_at NULL  = still reserved: the cert may still be valid at the CA; the fingerprint is
--                      unclaimable (adminMachines' clash check consults this table) and the daily
--                      prune keeps trying to revoke it.
--   revoked_at set   = confirmed revoked at the CA; the row is kept as an audit trail and the
--                      fingerprint returns to the reusable pool.
--   cert_id NULL     = the CA id was never recorded (pre-M4/enroll rows) — it can't be revoked here,
--                      so the row stays reserved (logged for manual cleanup) until the cert expires.
--
-- retired certs NEVER authenticate — machineIdentity still matches only the current or in-grace prev
-- fingerprint. This table is reservation + revoke bookkeeping only.
CREATE TABLE retired_certs (
  fingerprint TEXT NOT NULL,
  cert_id     TEXT,
  machine_id  TEXT NOT NULL,
  retired_at  TEXT NOT NULL,
  revoked_at  TEXT
) STRICT;

-- The hot lookup is "is this fingerprint still reserved?" — a partial index over the pending rows.
CREATE INDEX retired_certs_reserved ON retired_certs (fingerprint) WHERE revoked_at IS NULL;
