-- Authoritative content hashes for migrations deployed after the reproducibility cutover.
--
-- This table intentionally starts empty. In particular, it does not claim that the bytes now in
-- 0019 were the bytes applied to any persistent database. The trusted deployment wrapper records
-- a row only after Wrangler has applied that exact, manifest-bound artifact.
CREATE TABLE migration_checksum_ledger (
  sequence INTEGER PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (
    length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  artifact_sha256 TEXT NOT NULL CHECK (
    length(artifact_sha256) = 64 AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  deployment_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL
) STRICT;
