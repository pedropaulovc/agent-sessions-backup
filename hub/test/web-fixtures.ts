/** Synthetic web-capture fixtures. No real conversation content — the repo is public; all invented. */

import { zipSync, strToU8 } from 'fflate';

// ---- ChatGPT web conversation (mapping tree) --------------------------------

export interface ChatgptTurn {
  node: string;
  parent: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text?: string;
  thinking?: string;
  /** Assistant `code` message addressed to a tool (recipient !== 'all'). */
  tool?: { recipient: string; code: string };
  /** multimodal_text parts: plain strings and/or image asset pointers. */
  multimodal?: Array<string | { image: string }>;
  model?: string;
  createTime?: number;
}

export interface ChatgptConvOpts {
  id: string;
  title?: string;
  turns: ChatgptTurn[];
  currentNode?: string;
  createTime?: number;
  updateTime?: number;
}

const CHATGPT_ROOT = 'root-node';

/** Build a ChatGPT conversation object (as returned by backend-api/conversation/{id}). */
export function chatgptWebConversationObj(opts: ChatgptConvOpts): Record<string, unknown> {
  const mapping: Record<string, unknown> = {};
  const childrenOf = new Map<string, string[]>();
  for (const t of opts.turns) (childrenOf.get(t.parent) ?? childrenOf.set(t.parent, []).get(t.parent)!).push(t.node);

  // Root node (message: null) inserted first, so it leads the file just like a real export.
  mapping[CHATGPT_ROOT] = { id: CHATGPT_ROOT, message: null, parent: null, children: childrenOf.get(CHATGPT_ROOT) ?? [] };

  for (const t of opts.turns) {
    mapping[t.node] = {
      id: t.node,
      message: chatgptMessage(t),
      parent: t.parent,
      children: childrenOf.get(t.node) ?? [],
    };
  }

  return {
    title: opts.title ?? null,
    create_time: opts.createTime ?? 1_700_000_000,
    update_time: opts.updateTime ?? 1_700_000_100,
    mapping,
    current_node: opts.currentNode ?? opts.turns[opts.turns.length - 1]?.node ?? CHATGPT_ROOT,
    conversation_id: opts.id,
  };
}

export function chatgptWebConversation(opts: ChatgptConvOpts): string {
  return JSON.stringify(chatgptWebConversationObj(opts));
}

function chatgptMessage(t: ChatgptTurn): Record<string, unknown> {
  const base = {
    id: `msg-${t.node}`,
    author: { role: t.role, name: null, metadata: {} },
    create_time: t.createTime ?? 1_700_000_050,
    status: 'finished_successfully',
    metadata: t.model ? { model_slug: t.model } : {},
    recipient: t.tool ? t.tool.recipient : 'all',
  };
  if (t.thinking) {
    return { ...base, content: { content_type: 'thoughts', thoughts: [{ summary: 'reasoning', content: t.thinking }] } };
  }
  if (t.tool) {
    return { ...base, content: { content_type: 'code', language: 'python', text: t.tool.code } };
  }
  if (t.multimodal) {
    const parts = t.multimodal.map((p) =>
      typeof p === 'string' ? p : { content_type: 'image_asset_pointer', asset_pointer: `file-service://${p.image}` },
    );
    return { ...base, content: { content_type: 'multimodal_text', parts } };
  }
  return { ...base, content: { content_type: 'text', parts: [t.text ?? ''] } };
}

// ---- claude.ai web conversation (chat_messages tree) ------------------------

export const CLAUDE_WEB_ROOT = '00000000-0000-4000-8000-000000000000';

export interface ClaudeWebMessage {
  uuid: string;
  parent: string;
  sender: 'human' | 'assistant';
  content?: Array<Record<string, unknown>>;
  text?: string;
  createdAt?: string;
  model?: string;
}

export interface ClaudeConvOpts {
  uuid: string;
  name?: string;
  model?: string;
  messages: ClaudeWebMessage[];
  currentLeaf?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function claudeWebConversationObj(opts: ClaudeConvOpts): Record<string, unknown> {
  return {
    uuid: opts.uuid,
    name: opts.name ?? '',
    created_at: opts.createdAt ?? '2026-07-01T10:00:00.000000Z',
    updated_at: opts.updatedAt ?? '2026-07-01T10:05:00.000000Z',
    model: opts.model,
    current_leaf_message_uuid: opts.currentLeaf ?? opts.messages[opts.messages.length - 1]?.uuid,
    chat_messages: opts.messages.map((m) => ({
      uuid: m.uuid,
      parent_message_uuid: m.parent,
      sender: m.sender,
      index: 0,
      created_at: m.createdAt ?? '2026-07-01T10:00:00.000000Z',
      updated_at: m.createdAt ?? '2026-07-01T10:00:00.000000Z',
      ...(m.model ? { model: m.model } : {}),
      content: m.content ?? [{ type: 'text', text: m.text ?? '' }],
      ...(m.text !== undefined ? { text: m.text } : {}),
      attachments: [],
      files: [],
    })),
  };
}

export function claudeWebConversation(opts: ClaudeConvOpts): string {
  return JSON.stringify(claudeWebConversationObj(opts));
}

// ---- history.jsonl prompt log -----------------------------------------------

export interface HistoryEntry {
  display?: string;
  prompt?: string;
  timestamp?: number | string;
  project?: string;
  raw?: string; // emit a literal line (for malformed-line coverage)
}

export function historyLines(entries: HistoryEntry[]): string[] {
  return entries.map((e) => {
    if (e.raw !== undefined) return e.raw;
    const o: Record<string, unknown> = {};
    if (e.display !== undefined) o.display = e.display;
    if (e.prompt !== undefined) o.prompt = e.prompt;
    if (e.timestamp !== undefined) o.timestamp = e.timestamp;
    if (e.project !== undefined) o.project = e.project;
    return JSON.stringify(o);
  });
}

// ---- official export ZIPs ---------------------------------------------------

export function chatgptExportZip(convs: ChatgptConvOpts[], extraFiles: Record<string, string> = {}): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'conversations.json': strToU8(JSON.stringify(convs.map(chatgptWebConversationObj))),
    'user.json': strToU8(JSON.stringify({ email: 'invented@example.com' })),
  };
  for (const [k, v] of Object.entries(extraFiles)) files[k] = strToU8(v);
  return zipSync(files);
}

export function claudeExportZip(convs: ClaudeConvOpts[]): Uint8Array {
  return zipSync({
    'conversations.json': strToU8(JSON.stringify(convs.map(claudeWebConversationObj))),
  });
}

/** A ZIP with no conversations.json (layout drift) — parser must skip, not crash. */
export function emptyExportZip(): Uint8Array {
  return zipSync({ 'readme.txt': strToU8('no conversations here') });
}

/**
 * A ZIP whose conversations.json is a NON-empty array of objects with no recognized layout (no
 * `mapping`, no `chat_messages`) — export format drift. Distinct from an empty array: it must be
 * treated as INVALID (so the consumer preserves the old sessions), never as an empty export.
 */
export function unrecognizedExportZip(): Uint8Array {
  return zipSync({
    'conversations.json': strToU8(JSON.stringify([{ foo: 'bar' }, { note: 'no mapping or chat_messages here' }])),
  });
}
