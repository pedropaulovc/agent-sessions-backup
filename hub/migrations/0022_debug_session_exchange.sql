-- Human-authorized, capability-scoped debug session export/import state.
-- Raw credentials, viewer sessions, machine/admin state and alert data are deliberately never represented here.

CREATE TABLE debug_export_devices (
  device_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  label TEXT NOT NULL,
  public_jwk TEXT NOT NULL,
  release_digest TEXT NOT NULL,
  key_protection TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope = 'local-destination-attest'),
  enrolled_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_counter INTEGER NOT NULL DEFAULT -1
) STRICT;
CREATE INDEX debug_export_devices_user ON debug_export_devices (user_id, revoked_at, expires_at);

CREATE TABLE debug_export_passkey_challenges (
  challenge TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX debug_export_passkey_expiry ON debug_export_passkey_challenges (expires_at);

CREATE TABLE debug_export_replays (
  jti TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX debug_export_replays_expiry ON debug_export_replays (expires_at);

CREATE TABLE debug_export_jobs (
  job_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  selected_session_ids TEXT NOT NULL,
  destination_json TEXT NOT NULL,
  destination_hash TEXT NOT NULL,
  pkce_challenge TEXT NOT NULL,
  prepare_code_hash TEXT UNIQUE NOT NULL,
  capability_hash TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL,
  inventory_digest TEXT,
  inventory_size INTEGER,
  inventory_count INTEGER,
  final_destination_json TEXT,
  final_destination_hash TEXT,
  grant_code_hash TEXT UNIQUE,
  grant_jti TEXT UNIQUE,
  grant_expires_at INTEGER,
  exchange_capability_hash TEXT UNIQUE,
  error TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  exchanged_at INTEGER,
  deleted_at INTEGER
) STRICT;
CREATE INDEX debug_export_jobs_user_active ON debug_export_jobs (user_id, status, expires_at);
CREATE INDEX debug_export_jobs_expiry ON debug_export_jobs (expires_at);

CREATE TABLE debug_export_objects (
  job_id TEXT NOT NULL REFERENCES debug_export_jobs (job_id) ON DELETE CASCADE,
  object_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('source', 'externalAsset')),
  store TEXT NOT NULL,
  relpath TEXT NOT NULL,
  snapshot_r2_key TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  session_ids TEXT NOT NULL,
  encrypted_r2_key TEXT UNIQUE,
  wrapped_key TEXT,
  nonce TEXT,
  ciphertext_sha256 TEXT,
  ciphertext_size INTEGER,
  downloaded_at INTEGER,
  PRIMARY KEY (job_id, object_id)
) STRICT;

CREATE TABLE debug_import_jobs (
  job_id TEXT PRIMARY KEY,
  capability_hash TEXT UNIQUE NOT NULL,
  assertion_jti TEXT UNIQUE NOT NULL,
  destination_json TEXT NOT NULL,
  selected_session_ids TEXT NOT NULL,
  inventory_digest TEXT NOT NULL,
  status TEXT NOT NULL,
  checkpoint INTEGER NOT NULL DEFAULT 0,
  object_count INTEGER NOT NULL,
  total_size INTEGER NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER
) STRICT;
CREATE INDEX debug_import_jobs_expiry ON debug_import_jobs (expires_at);

CREATE TABLE debug_import_objects (
  job_id TEXT NOT NULL REFERENCES debug_import_jobs (job_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  object_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('source', 'externalAsset')),
  store TEXT NOT NULL,
  relpath TEXT NOT NULL,
  staging_r2_key TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  expected_session_ids TEXT NOT NULL,
  promoted_file_id INTEGER,
  PRIMARY KEY (job_id, ordinal),
  UNIQUE (job_id, object_id)
) STRICT;

CREATE TABLE debug_exchange_audit (
  id INTEGER PRIMARY KEY,
  event TEXT NOT NULL,
  user_id TEXT,
  device_id TEXT,
  job_id TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX debug_exchange_audit_job ON debug_exchange_audit (job_id, created_at);
