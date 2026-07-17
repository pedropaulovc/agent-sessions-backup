import { CAPS, cap, type NormalizedBlock, type NormalizedSession, type NormalizedTurn, type Role } from '../normalize';
import { locateKeyOffsets } from './web-offsets';
import { isoFromEpochSeconds } from './timestamps';

/**
 * ChatGPT web-capture parser (one conversation = one JSON document, as returned by
 * `backend-api/conversation/{id}` and stored raw by the CDP collector).
 *
 * The conversation is a `mapping` tree of nodes keyed by uuid; each node with a non-null
 * `message` is a turn. Turns are emitted in FILE order (by the byte offset of their node key
 * in the raw document) so block byte offsets stay monotonic with turn_index — the same
 * invariant the JSONL parsers rely on for the viewer's paged byte windows. `on_main_path` is
 * resolved separately by walking parent links from `current_node` back to the root, so an
 * edited/regenerated branch is dimmed exactly like a Claude Code rewind. Layout drift never
 * throws: unknown content types are skip-and-counted.
 */
export function parseChatgptWeb(raw: string, sessionId: string): NormalizedSession {
  const session: NormalizedSession = {
    id: sessionId,
    harness: 'chatgpt-web',
    models: [],
    isSidechain: false,
    turns: [],
    stats: { lines: 1, parseErrorLines: 0, skippedLineTypes: {} },
  };

  let conv: Record<string, unknown>;
  try {
    conv = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    session.stats.parseErrorLines = 1;
    return session;
  }

  session.title = str(conv.title);
  const mapping = isObj(conv.mapping) ? conv.mapping : {};
  const currentNode = str(conv.current_node);
  const models = new Map<string, number>();

  // File-order node ids (by the byte offset of each `"<id>":` mapping key in the raw document).
  const offsets = locateKeyOffsets(raw, Object.keys(mapping));
  const ordered = [...offsets].sort((a, b) => a.offset - b.offset);
  const mainPath = ancestorChain(mapping, currentNode);

  for (let i = 0; i < ordered.length; i++) {
    const { key: nodeId, offset } = ordered[i]!;
    const node = mapping[nodeId];
    if (!isObj(node)) continue;
    const message = isObj(node.message) ? node.message : undefined;
    if (!message) continue;

    const author = isObj(message.author) ? message.author : undefined;
    const role = mapRole(str(author?.role));
    const at = { byteStart: offset, byteLen: (ordered[i + 1]?.offset ?? raw.length) - offset };
    const blocks = [...blocksFrom(message, at, session.stats)];
    if (blocks.length === 0) continue;

    const meta = isObj(message.metadata) ? message.metadata : undefined;
    const model = str(meta?.model_slug) ?? str(meta?.default_model_slug);
    if (model && role === 'assistant') models.set(model, (models.get(model) ?? 0) + 1);

    const ts = isoFromEpochSeconds(message.create_time);
    if (ts) {
      if (!session.startedAt || ts < session.startedAt) session.startedAt = ts;
      if (!session.endedAt || ts > session.endedAt) session.endedAt = ts;
    }

    session.turns.push({
      index: session.turns.length,
      id: nodeId,
      parentId: str(node.parent) ?? undefined,
      onMainPath: mainPath.size === 0 ? true : mainPath.has(nodeId),
      role,
      ts,
      model: role === 'assistant' ? model : undefined,
      blocks,
    });
  }

  session.models = [...models.keys()];
  session.primaryModel = mostFrequent(models);
  session.startedAt ??= isoFromEpochSeconds(conv.create_time);
  session.endedAt ??= isoFromEpochSeconds(conv.update_time);
  if (!session.title) {
    const firstUser = session.turns.find((t) => t.role === 'user')?.blocks.find((b) => b.text)?.text;
    if (firstUser) session.title = firstUser.slice(0, 120);
  }
  return session;
}

function* blocksFrom(
  message: Record<string, unknown>,
  at: { byteStart: number; byteLen: number },
  stats: NormalizedSession['stats'],
): Generator<NormalizedBlock> {
  const content = isObj(message.content) ? message.content : undefined;
  const ctype = str(content?.content_type) ?? 'text';
  const author = isObj(message.author) ? message.author : undefined;
  const role = str(author?.role);
  // An assistant `code` message addressed to a tool (recipient !== 'all') is a tool call.
  const recipient = str(message.recipient);

  switch (ctype) {
    case 'text': {
      const text = partsText(content?.parts);
      if (!text) return;
      if (role === 'tool') {
        yield block('tool_result', text, CAPS.tool_result, at);
        return;
      }
      yield block('text', text, CAPS.text, at);
      return;
    }
    case 'code': {
      const codeText = str(content?.text) ?? partsText(content?.parts);
      if (!codeText) return;
      if (role === 'assistant' && recipient && recipient !== 'all') {
        yield { ...block('tool_use', codeText, CAPS.tool_use, at), toolName: recipient };
        return;
      }
      yield block(role === 'tool' ? 'tool_result' : 'text', codeText, CAPS.text, at);
      return;
    }
    case 'thoughts': {
      const thoughts = Array.isArray(content?.thoughts) ? content.thoughts : [];
      const text = thoughts
        .filter(isObj)
        .map((t) => [str(t.summary), str(t.content)].filter(Boolean).join('\n'))
        .filter(Boolean)
        .join('\n\n');
      if (text) yield block('thinking', text, CAPS.thinking, at);
      return;
    }
    case 'reasoning_recap': {
      const text = str(content?.content);
      if (text) yield block('thinking', text, CAPS.thinking, at);
      return;
    }
    case 'multimodal_text': {
      const parts = Array.isArray(content?.parts) ? content.parts : [];
      for (const part of parts) {
        if (typeof part === 'string') {
          if (part.trim()) yield block('text', part, CAPS.text, at);
          continue;
        }
        if (!isObj(part)) continue;
        const pt = str(part.content_type);
        if (pt === 'image_asset_pointer' || pt === 'audio_asset_pointer' || pt === 'video_container_asset_pointer') {
          // Web-capture media is an asset-pointer REFERENCE (file-service://…), not inline base64 —
          // there are no bytes in this document to serve, so emit an inert text placeholder rather
          // than a blob-backed media block that the blob endpoint (which byte-range reads JSONL)
          // could only 404 on. See web-offsets.ts on why web offsets aren't byte-sliceable.
          yield block('text', `[${pt.replace('_asset_pointer', '')}]`, CAPS.text, at);
          continue;
        }
        const ptext = str(part.text);
        if (ptext) yield block('text', ptext, CAPS.text, at);
      }
      return;
    }
    case 'tether_quote':
    case 'tether_browsing_display': {
      const text = str(content?.result) ?? str(content?.text);
      if (text) yield block('tool_result', text, CAPS.tool_result, at);
      return;
    }
    default: {
      stats.skippedLineTypes[`content:${ctype}`] = (stats.skippedLineTypes[`content:${ctype}`] ?? 0) + 1;
      const text = partsText(content?.parts) || str(content?.text);
      if (text) yield block('text', text, CAPS.text, at);
    }
  }
}

function block(
  type: NormalizedBlock['type'],
  text: string,
  limit: number,
  at: { byteStart: number; byteLen: number },
): NormalizedBlock {
  const c = cap(text, limit);
  return { type, text: c.text, truncated: c.truncated, ...at };
}

/** Set of node ids on the active path: `current_node` and every parent up to the root. */
function ancestorChain(mapping: Record<string, unknown>, current: string | undefined): Set<string> {
  const chain = new Set<string>();
  let cursor = current;
  let guard = Object.keys(mapping).length + 1;
  while (cursor && guard-- > 0 && !chain.has(cursor)) {
    chain.add(cursor);
    const node = mapping[cursor];
    cursor = isObj(node) ? str(node.parent) : undefined;
  }
  return chain;
}

function mapRole(role: string | undefined): Role {
  switch (role) {
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    case 'system':
      return 'system';
    case 'tool':
      return 'tool';
    default:
      return 'user';
  }
}

function partsText(parts: unknown): string {
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => (typeof p === 'string' ? p : isObj(p) ? str(p.text) ?? '' : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function mostFrequent(counts: Map<string, number>): string | undefined {
  let best: string | undefined;
  let bestN = -1;
  for (const [k, n] of counts) if (n > bestN) ((best = k), (bestN = n));
  return best;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
