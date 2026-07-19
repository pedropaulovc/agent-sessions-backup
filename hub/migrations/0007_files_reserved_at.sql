-- Export cleanups reserve overlapping sibling archives ('parsed' → 'reserved') before deleting their stale
-- sessions, then send-late recover messages keyed off that 'reserved' state (migration 0006). With two
-- cleanups interleaved in the SAME store, that state had no owner and no age: a second cleanup could reserve
-- concurrently and its store-wide send-late could fire the first cleanup's reservations before the first
-- cleanup's deletes drained (recreating the very gap send-late ordering prevents), and files/check or a
-- same-hash upload could heal a just-reserved row into an 'upload' parse mid-window, letting it escape the
-- reserved set so its sessions are never recovered after the deletes.
--
-- reserved_at timestamps each reservation so cleanups can SERIALIZE per store: it is set in the same
-- statement as the 'parsed' → 'reserved' flip and cleared when the row leaves 'reserved' (markParsed). A
-- cleanup with stale rows to delete defers before any mutation if another store sibling carries a FRESH
-- reserved_at (< STALE_RESERVATION_MS, 1h); the heal paths leave a fresh reservation to its owner's recover
-- send. A reservation older than the threshold is treated as abandoned (owner crashed): it no longer blocks
-- new cleanups and heals normally. NULL for every row that is not a live reservation.
--
-- Numbered 0007: 0004/0005 remain reserved by the cert-rotation branch (PR #20). A numbering gap is harmless.
ALTER TABLE files ADD COLUMN reserved_at TEXT;

-- reserved_by = the id of the cleanup file that flipped this row to 'reserved'. Stamped WITH reserved_at in
-- the reserve CAS, cleared WITH it (markParsed / stale heal). It makes the reservation OWNED, which the
-- store-wide state could not express: the contention defer excludes a cleanup's OWN reservations
-- (reserved_by != file.id) so a retry of a cleanup that already reserved does not deadlock on itself, and
-- send-late targets only reserved_by = file.id so an interleaved cleanup can never fire another cleanup's
-- reservations early (the precise fix for the cross-cleanup send-late race). The owner id is a files.id, which
-- is stable across a same-relpath re-upload, so a superseded-mid-cleanup archive's fresh parse still owns its
-- prior reservations.
ALTER TABLE files ADD COLUMN reserved_by INTEGER;

-- Index the per-store sibling pagers. The reserve pass, the send-late pass, and the round-14 contention probe
-- all filter files by (store, parse_state) and then page/seek by id — but the only prior files indexes are
-- files_state(parse_state) and the unique (machine_id, store, relpath), neither of which lets D1 seek this
-- store's parsed/reserved siblings directly. Without this, each reservation page scans/filters the global
-- parsed-file population: subrequest-bounded but CPU/latency-unbounded on a large corpus. (store, parse_state,
-- id) serves all three: equality on the two leading columns, range + order on id. The contention probe's
-- reserved_at range still filters within the seeked (store,'reserved') slice, which is tiny (live reservations).
CREATE INDEX IF NOT EXISTS idx_files_store_state_id ON files (store, parse_state, id);
