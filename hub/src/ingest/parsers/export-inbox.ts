import { unzipSync } from 'fflate';
import type { Harness, NormalizedSession } from '../normalize';
import { parseChatgptWeb } from './chatgpt-web';
import { parseClaudeWeb } from './claude-web';

export interface ExportArchive {
  harness: Harness;
  sessions: NormalizedSession[];
  /** Conversations seen in the archive that produced no session id (skip-and-count, never fatal). */
  skipped: number;
}

/**
 * Official-export ZIP parser (one-time backfill dropped into `export-inbox/`).
 *
 * Both products ship a `conversations.json` array inside the ZIP: ChatGPT conversations carry a
 * `mapping` tree, claude.ai conversations carry `chat_messages` — the very same shapes the CDP
 * web parsers already handle, so each conversation is re-serialized and run through the matching
 * web parser, keyed by its own conversation id. Layout drift (missing file, wrong nesting, an
 * unparseable conversation) is tolerated with skip-and-count; a single bad conversation never
 * sinks the archive.
 */
export function parseExportArchive(bytes: Uint8Array): ExportArchive {
  const files = safeUnzip(bytes);
  const convsRaw = findConversationsJson(files);
  if (!convsRaw) return { harness: 'unknown', sessions: [], skipped: 0 };

  let list: unknown;
  try {
    list = JSON.parse(convsRaw);
  } catch {
    return { harness: 'unknown', sessions: [], skipped: 0 };
  }
  const conversations = Array.isArray(list) ? list : isObj(list) ? [list] : [];

  const harness = detectLayout(conversations);
  if (harness === 'unknown') return { harness, sessions: [], skipped: conversations.length };

  const sessions: NormalizedSession[] = [];
  let skipped = 0;
  for (const conv of conversations) {
    if (!isObj(conv)) {
      skipped++;
      continue;
    }
    const id = conversationId(conv, harness);
    if (!id) {
      skipped++;
      continue;
    }
    const text = JSON.stringify(conv);
    const session = harness === 'chatgpt-web' ? parseChatgptWeb(text, id) : parseClaudeWeb(text, id);
    sessions.push(session);
  }
  return { harness, sessions, skipped };
}

function safeUnzip(bytes: Uint8Array): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes);
  } catch {
    return {};
  }
}

/** The `conversations.json` entry (root or nested), or the first array-shaped *.json as a fallback. */
function findConversationsJson(files: Record<string, Uint8Array>): string | undefined {
  const decoder = new TextDecoder('utf-8');
  const named = Object.keys(files).find((p) => p.endsWith('conversations.json'));
  if (named) return decoder.decode(files[named]);
  for (const [path, data] of Object.entries(files)) {
    if (!path.endsWith('.json')) continue;
    const text = decoder.decode(data);
    if (text.trimStart().startsWith('[')) return text;
  }
  return undefined;
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
