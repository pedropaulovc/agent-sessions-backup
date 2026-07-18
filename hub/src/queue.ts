/**
 * Invariant: a row with an outstanding parse message must be in a NON-TERMINAL parse_state
 * ('pending', 'error', or 'reserved') — never 'parsed'/'skipped'/'superseded'. That's what lets
 * `/api/v1/files/check` and the same-hash upload fast path self-heal a lost or dead-lettered
 * message: both treat a terminal row as "done, nothing to do" and only ever re-enqueue
 * non-terminal ones. Sending a parse message for a row still marked terminal breaks that
 * self-healing path if the message never arrives — use this at every site that enqueues a
 * parse for an EXISTING files row (fresh uploads are exempt: their INSERT already sets
 * parse_state = 'pending' as part of the same statement, before the send).
 */
export async function markPendingAndEnqueue(
  file: { id: number; r2_key: string; content_hash: string },
  reason: ParseMessage['reason'],
  env: Env,
): Promise<void> {
  // Clear reserved_at/reserved_by too: the only 'reserved' rows that reach here are STALE ones the heal paths
  // chose to reclaim (a fresh reservation is left to its owner). Dropping the markers as the row leaves
  // 'reserved' stops the abandoned owner id from lingering and being matched by a late send-late. No-op for the
  // common non-reserved row (both already NULL).
  await env.DB.prepare("UPDATE files SET parse_state = 'pending', reserved_at = NULL, reserved_by = NULL WHERE id = ?1").bind(file.id).run();
  await env.PARSE_QUEUE.send({ file_id: file.id, r2_key: file.r2_key, reason, content_hash: file.content_hash });
}

// A 'reserved' sibling belongs to exactly one in-flight export cleanup (the one that flipped it 'parsed' →
// 'reserved' before deleting its stale sessions). Export cleanups serialize per store on this marker: a
// cleanup with stale rows to delete defers if another store sibling carries a FRESH reservation, and the
// heal paths (files/check, same-hash upload) leave a fresh reservation alone — the reserving cleanup's
// send-late recover message is the intended trigger, and it fires only AFTER that cleanup's deletes drain.
// A reservation older than the threshold is treated as ABANDONED (its cleanup crashed): it stops blocking
// new cleanups and heals like any other non-terminal row. Generous by design — it only matters after a
// crash or a dropped recover send, and files/check runs every collector cycle. reserved_at is written in
// the same statement as the parse_state='reserved' flip and cleared when the row leaves 'reserved'.
export const STALE_RESERVATION_MS = 60 * 60 * 1000; // 1h

/** True when this row is a reservation still owned by a live cleanup (fresh) — the state both the
 * contention defer and the heal-path skip key off. A row NOT in 'reserved', with a null reserved_at, or
 * past the staleness threshold is not a live reservation. */
export function isFreshReservation(row: { parse_state: string; reserved_at: string | null }): boolean {
  if (row.parse_state !== 'reserved' || row.reserved_at == null) return false;
  const at = Date.parse(row.reserved_at);
  return Number.isFinite(at) && Date.now() - at < STALE_RESERVATION_MS;
}

/** ISO cutoff for the `reserved_at > ?` freshness filter in SQL. reserved_at is stored in the same
 * strftime ISO8601 shape toISOString() produces, so lexicographic comparison is chronological. */
export function reservationCutoffIso(): string {
  return new Date(Date.now() - STALE_RESERVATION_MS).toISOString();
}
