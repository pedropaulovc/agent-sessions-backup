-- A cleanup reserves both already-parsed sibling archives and pending uploads before deleting stale sessions.
-- Parsed siblings are gap-fill recoveries; a pending upload must retain full upload semantics so a genuinely
-- newer archive can replace still-healthy rows. Persist that intent until send-late drains the reservation.
ALTER TABLE files ADD COLUMN reserved_reason TEXT CHECK (reserved_reason IN ('upload', 'recover'));

-- reserved_at is a freshness timestamp, not an authorization token: SQLite timestamps have only millisecond
-- precision, so two reservations can legitimately share one. Keep a durable per-row integer generation and
-- increment it atomically whenever the reservation is created or refreshed. Queue deliveries must match it.
ALTER TABLE files ADD COLUMN reservation_generation INTEGER NOT NULL DEFAULT 0 CHECK (reservation_generation >= 0);
