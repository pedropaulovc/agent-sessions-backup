-- WebAuthn ceremony challenges live in D1, not KV.
--
-- KV is eventually consistent with no atomic get-and-delete: a verify on one edge can
-- miss a challenge just written by the options endpoint on another edge (legit logins
-- fail intermittently), and two concurrent verifies can both read the same challenge
-- before either delete propagates (replay window). D1 serializes writes, so a single
-- `DELETE ... WHERE challenge=? AND kind=? AND expires_at>now` with changes===1 as the
-- pass signal makes consumption atomic and strongly consistent — the single enforcement
-- point for the single-use guarantee. Sessions stay in KV (long-lived, 30-day TTL, where
-- eventual consistency is acceptable). Timestamps are epoch milliseconds.
CREATE TABLE webauthn_challenges (
  challenge TEXT PRIMARY KEY,
  kind TEXT NOT NULL, -- register | auth
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX webauthn_challenges_expires ON webauthn_challenges (expires_at);
