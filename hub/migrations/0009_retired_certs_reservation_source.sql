-- A retired row is either a certificate that previously occupied a machine slot (and whose
-- private key may still be held by that machine), or a newly minted cleanup orphan whose PEM was
-- never returned to the collector. Only the former may be reinstated after a rejected CA revoke.
--
-- Migration 0005 is already deployed, so this is additive. Existing rows and inserts from an older
-- Worker default to orphan_cleanup: their provenance cannot be reconstructed safely, and refusing a
-- rollback is safer than installing a fingerprint for which the machine cannot possess the key.
ALTER TABLE retired_certs
  ADD COLUMN reservation_source TEXT NOT NULL DEFAULT 'orphan_cleanup'
  CHECK (reservation_source IN ('prior_slot', 'orphan_cleanup'));
