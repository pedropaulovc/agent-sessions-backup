import { unzipSync } from 'fflate';
import type { Harness, NormalizedSession } from '../normalize';
import { parseChatgptWeb } from './chatgpt-web';
import { parseClaudeWeb } from './claude-web';

export interface ExportArchive {
  /**
   * True iff a `conversations.json` was found and parsed as a JSON array — an EMPTY array is a
   * legitimately empty export (valid), distinct from a corrupt/missing archive (invalid). The
   * consumer runs stale-session cleanup only for valid archives and marks invalid ones 'error'
   * with `error`, so an unreadable replacement never silently reports as parsed.
   */
  valid: boolean;
  harness: Harness;
  sessions: NormalizedSession[];
  /** Conversations skipped (no id, or an unrecognized layout) — counted, never fatal. */
  skipped: number;
  /** Why the archive is invalid (present iff !valid) — surfaced as files.parse_error. */
  error?: string;
}

/** `conversations.json` at the archive root or any nested path (case-insensitive). */
const CONVERSATIONS_RE = /(^|\/)conversations\.json$/i;

/** Exported for tests: the unzip filter predicate — only matching entries are ever inflated. */
export function isConversationsEntry(name: string): boolean {
  return CONVERSATIONS_RE.test(name);
}

/**
 * Official-export ZIP parser (one-time backfill dropped into `export-inbox/`).
 *
 * Both products ship a `conversations.json` array inside the ZIP: ChatGPT conversations carry a
 * `mapping` tree, claude.ai conversations carry `chat_messages` — the same shapes the CDP web
 * parsers already handle, so each conversation is re-serialized and run through the matching web
 * parser, keyed by its own conversation id. Only `conversations.json` is inflated (fflate
 * `filter`), so an attachment-heavy export never decompresses gigabytes of image blobs just to
 * read one JSON file. Layout drift is tolerated with skip-and-count; a single bad conversation
 * never sinks the archive.
 */
export function parseExportArchive(bytes: Uint8Array): ExportArchive {
  const convsRaw = extractConversationsJson(bytes);
  if (convsRaw === undefined) {
    return invalid('no conversations.json found in export archive (unreadable ZIP or missing file)');
  }
  let list: unknown;
  try {
    list = JSON.parse(convsRaw);
  } catch {
    return invalid('conversations.json is not valid JSON');
  }
  if (!Array.isArray(list)) {
    return invalid('conversations.json is not a JSON array');
  }

  // Valid from here — an empty array is a well-formed, empty export (the consumer clears whatever
  // this file used to own). Layout is inferred from the conversations that exist.
  const harness = detectLayout(list);
  const sessions: NormalizedSession[] = [];
  let skipped = 0;
  for (const conv of list) {
    const id = isObj(conv) ? conversationId(conv, harness) : undefined;
    if (harness === 'unknown' || !isObj(conv) || !id) {
      skipped++;
      continue;
    }
    const text = JSON.stringify(conv);
    sessions.push(harness === 'chatgpt-web' ? parseChatgptWeb(text, id) : parseClaudeWeb(text, id));
  }
  return { valid: true, harness, sessions, skipped };
}

function invalid(error: string): ExportArchive {
  return { valid: false, harness: 'unknown', sessions: [], skipped: 0, error };
}

/** Inflate ONLY conversations.json (fflate filter runs before decompression), then decode it. */
function extractConversationsJson(bytes: Uint8Array): string | undefined {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (file) => isConversationsEntry(file.name) });
  } catch {
    return undefined; // not a readable ZIP
  }
  const names = Object.keys(files);
  if (names.length === 0) return undefined;
  // Prefer the least-nested match (a root conversations.json over one inside a subdir).
  names.sort((a, b) => a.length - b.length);
  return new TextDecoder('utf-8').decode(files[names[0]!]);
}

function detectLayout(conversations: unknown[]): Harness {
  for (const conv of conversations) {
    if (!isObj(conv)) continue;
    if (isObj(conv.mapping)) return 'chatgpt-web';
    if (Array.isArray(conv.chat_messages)) return 'claude-web';
  }
  return 'unknown';
}

function conversationId(conv: Record<string, unknown>, harness: Harness): string | undefined {
  if (harness === 'chatgpt-web') return str(conv.conversation_id) ?? str(conv.id);
  return str(conv.uuid) ?? str(conv.id);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
