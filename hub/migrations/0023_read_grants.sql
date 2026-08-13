-- Passkey-minted read grants: agents read the hub only through a short-lived bearer the
-- owner approved with a fresh passkey touch (PKCE loopback exchange, mirroring the debug
-- exchange). Codes and tokens are stored hashed only; raw secrets never touch the database.

CREATE TABLE read_grant_codes (
  code_hash TEXT PRIMARY KEY,
  pkce_challenge TEXT NOT NULL,
  label TEXT NOT NULL,
  ttl_seconds INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX read_grant_codes_expiry ON read_grant_codes (expires_at);

CREATE TABLE read_grants (
  grant_id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER
) STRICT;
CREATE INDEX read_grants_active ON read_grants (revoked_at, expires_at);
