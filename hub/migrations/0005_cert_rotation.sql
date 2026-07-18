-- M4 cert-rotation grace window. POST /api/v1/certs/renew mints a successor cert at
-- the Cloudflare managed CA and swaps it in as the machine's current fingerprint, but
-- the PREVIOUS cert must keep authenticating for a grace period so an in-flight
-- collector isn't locked out mid-rotation. During that window a machine has TWO valid
-- fingerprints; machineIdentity() matches cert_fp_sha256 OR (prev_cert_fp_sha256 with
-- cert_revoke_at still in the future). The daily prune cron (30 4) revokes the previous
-- cert at the CA (DELETE by prev_cert_id) once cert_revoke_at passes, then clears these
-- columns — and ONLY after a successful revoke, so a failed CA call retries next run.
--
-- cert_id is the CA's client-certificate id for the CURRENT cert, captured on renewal so
-- a LATER renewal can move it into prev_cert_id and revoke it. Rows enrolled by
-- enroll-cert.sh (pre-M4) have cert_id NULL — their first renewal has no id to revoke,
-- which is fine: the hub stops honoring the old fingerprint at cert_revoke_at regardless,
-- and the software cert expires at the CA on its own.
ALTER TABLE machines ADD COLUMN cert_id TEXT;
ALTER TABLE machines ADD COLUMN prev_cert_fp_sha256 TEXT;
ALTER TABLE machines ADD COLUMN prev_cert_id TEXT;
ALTER TABLE machines ADD COLUMN cert_revoke_at TEXT;
