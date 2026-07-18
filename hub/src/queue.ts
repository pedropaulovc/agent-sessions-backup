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
  await env.DB.prepare("UPDATE files SET parse_state = 'pending' WHERE id = ?1").bind(file.id).run();
  await env.PARSE_QUEUE.send({ file_id: file.id, r2_key: file.r2_key, reason, content_hash: file.content_hash });
}
