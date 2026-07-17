/**
 * Offset location for single-document web-capture formats (ChatGPT `mapping`, Claude
 * `chat_messages`).
 *
 * A conversation is one JSON object, not line-oriented, so there is no per-turn byte offset to
 * read off a stream the way the JSONL parsers get one for free. Instead each turn is anchored at
 * the character offset where its node appears in the raw document. Those offsets are used purely
 * as a monotonic pagination key (viewer byte windows) and to disambiguate media blocks — the web
 * paths never do a partial byte-range read of the raw object (a slice of one JSON object doesn't
 * parse), so a character offset into the decoded document is the honest, self-consistent unit:
 * ingest and every reparse decode the same bytes to the same string and locate identically.
 */
export interface KeyOffset {
  key: string;
  offset: number;
}

/** Offset of each object KEY (`"<key>":`) in the raw document. Keys not found are dropped. */
export function locateKeyOffsets(raw: string, keys: string[]): KeyOffset[] {
  const out: KeyOffset[] = [];
  for (const key of keys) {
    const offset = raw.indexOf(`"${key}":`);
    if (offset >= 0) out.push({ key, offset });
  }
  return out;
}

/**
 * Offset of each id where it appears as a specific field VALUE (`"<field>":"<id>"`), falling back
 * to the id's bare first occurrence. Field-qualified first so a top-level pointer to the id
 * (e.g. `current_leaf_message_uuid`) doesn't mis-anchor the message body that carries it.
 */
export function locateValueOffsets(raw: string, ids: string[], field: string): KeyOffset[] {
  const out: KeyOffset[] = [];
  for (const id of ids) {
    let offset = raw.indexOf(`"${field}":"${id}"`);
    if (offset < 0) offset = raw.indexOf(`"${field}": "${id}"`);
    if (offset < 0) offset = raw.indexOf(`"${id}"`);
    if (offset >= 0) out.push({ key: id, offset });
  }
  return out;
}
