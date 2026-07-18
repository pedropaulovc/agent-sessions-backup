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
  opts: { force?: boolean } = {},
): Promise<boolean> {
  // CENTRALIZED reservation gate (round 15, 3608955878). Every requeue path for an existing row funnels
  // through here, so the fresh-reservation skip lives HERE by construction instead of being re-derived in each
  // caller (files/check, same-hash PUT, multipart same-hash shortcut, admin reindex). A row that is a FRESH
  // reservation belongs to a live export cleanup that will recover it after its deletes drain — so leave it
  // alone: the requeue would clear reserved_by and let the sibling escape the send-late set. The guard is one
  // atomic UPDATE ... WHERE NOT (fresh reservation) RETURNING id — no extra read — and clears the ownership
  // markers as the row leaves 'reserved' (a STALE reservation, a crashed owner, heals normally). RETURNING
  // tells us whether the requeue fired; skip the enqueue (and log) when it was gated.
  //
  // `force` breaks even a fresh reservation — for callers that are the recovery MECHANISM, not a redundant
  // heal (the web-session recover chain: it deliberately re-parses a chosen candidate).
  const guard = opts.force ? '' : " AND NOT (parse_state = 'reserved' AND reserved_at IS NOT NULL AND reserved_at > ?2)";
  const stmt = env.DB.prepare(`UPDATE files SET parse_state = 'pending', reserved_at = NULL, reserved_by = NULL WHERE id = ?1${guard} RETURNING id`);
  const updated = await (opts.force ? stmt.bind(file.id) : stmt.bind(file.id, reservationCutoffIso())).first<{ id: number }>();
  if (!updated) {
    console.log(JSON.stringify({ event: 'requeue.skipped_fresh_reservation', file_id: file.id, reason }));
    return false;
  }
  await env.PARSE_QUEUE.send({ file_id: file.id, r2_key: file.r2_key, reason, content_hash: file.content_hash });
  return true;
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
