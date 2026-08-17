CREATE TABLE credentials (
  credential_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'owner',
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT
) STRICT;

CREATE TABLE webauthn_challenges (
  challenge TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX webauthn_challenges_expires ON webauthn_challenges (expires_at);

CREATE TABLE passkey_freshness_challenges (
  challenge TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX passkey_freshness_expiry ON passkey_freshness_challenges (expires_at);

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
