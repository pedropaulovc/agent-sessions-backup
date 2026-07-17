import { CAPS, cap, type NormalizedBlock, type NormalizedSession, type NormalizedTurn, type Role } from '../normalize';
import { locateValueOffsets } from './web-offsets';

/** Root sentinel parent used by claude.ai's tree mode for the first message. */
const ROOT_PARENT = '00000000-0000-4000-8000-000000000000';

/**
 * claude.ai web-capture parser (one conversation = one JSON document, as returned by
 * `chat_conversations/{id}?tree=True&rendering_mode=raw` and stored raw by the CDP collector).
 *
 * `chat_messages` is a flat list carrying `parent_message_uuid` tree links; `rendering_mode=raw`
 * gives each message a `content` array of Anthropic-style blocks (text/thinking/tool_use/
 * tool_result/image). Turns are emitted in FILE order (by the byte offset of each message's uuid)
 * so block offsets stay monotonic with turn_index; `on_main_path` is the parent chain walked back
 * from `current_leaf_message_uuid`, so an edited branch is dimmed like a rewind. Unknown block
 * types are skip-and-counted, never fatal.
 */
export function parseClaudeWeb(raw: string, sessionId: string): NormalizedSession {
  const session: NormalizedSession = {
    id: sessionId,
    harness: 'claude-web',
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

  session.title = str(conv.name) ?? str(conv.title);
  session.startedAt = str(conv.created_at);
  session.endedAt = str(conv.updated_at);
  const messages = Array.isArray(conv.chat_messages) ? conv.chat_messages.filter(isObj) : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const m of messages) {
    const id = str(m.uuid);
    if (id) byId.set(id, m);
  }
  const leaf = str(conv.current_leaf_message_uuid);
  const mainPath = ancestorChain(byId, leaf);
  const models = new Map<string, number>();
  const convModel = str(conv.model);

  const offsets = locateValueOffsets(raw, [...byId.keys()], 'uuid').sort((a, b) => a.offset - b.offset);

  for (let i = 0; i < offsets.length; i++) {
    const { key: uuid, offset } = offsets[i]!;
    const m = byId.get(uuid)!;
    const role = mapSender(str(m.sender));
    const at = { byteStart: offset, byteLen: (offsets[i + 1]?.offset ?? raw.length) - offset };
    const blocks = [...blocksFrom(m, role, at, session.stats)];
    if (blocks.length === 0) continue;

    const model = str(m.model) ?? convModel;
    if (model && role === 'assistant') models.set(model, (models.get(model) ?? 0) + 1);

    session.turns.push({
      index: session.turns.length,
      id: uuid,
      parentId: normalizeParent(str(m.parent_message_uuid)),
      onMainPath: mainPath.size === 0 ? true : mainPath.has(uuid),
      role,
      ts: str(m.created_at),
      model: role === 'assistant' ? model : undefined,
      blocks,
    });
  }

  session.models = [...models.keys()];
  session.primaryModel = mostFrequent(models) ?? convModel;
  if (!session.title) {
    const firstUser = session.turns.find((t) => t.role === 'user')?.blocks.find((b) => b.text)?.text;
    if (firstUser) session.title = firstUser.slice(0, 120);
  }
  return session;
}

function* blocksFrom(
  message: Record<string, unknown>,
  role: Role,
  at: { byteStart: number; byteLen: number },
  stats: NormalizedSession['stats'],
): Generator<NormalizedBlock> {
  const content = Array.isArray(message.content) ? message.content : undefined;
  // rendering_mode=raw gives the content array; fall back to the flat `text` for older captures.
  if (!content) {
    const text = str(message.text);
    if (text) yield block('text', text, CAPS.text, at);
    return;
  }

  let emitted = 0;
  for (const item of content) {
    if (!isObj(item)) continue;
    switch (item.type) {
      case 'text': {
        const text = str(item.text);
        if (text) {
          emitted++;
          yield block('text', text, CAPS.text, at);
        }
        break;
      }
      case 'thinking': {
        const text = str(item.thinking) ?? str(item.text);
        if (text) {
          emitted++;
          yield block('thinking', text, CAPS.thinking, at);
        }
        break;
      }
      case 'tool_use': {
        const name = str(item.name) ?? 'tool';
        emitted++;
        yield { ...block('tool_use', `${name} ${safeJson(item.input)}`, CAPS.tool_use, at), toolName: name, toolUseId: str(item.id) };
        break;
      }
      case 'tool_result': {
        emitted++;
        yield {
          ...block('tool_result', toolResultText(item.content), CAPS.tool_result, at),
          toolUseId: str(item.tool_use_id),
          isError: item.is_error === true || undefined,
        };
        break;
      }
      case 'image': {
        const source = isObj(item.source) ? item.source : undefined;
        emitted++;
        yield { type: 'image', mediaType: str(source?.media_type), ...at };
        break;
      }
      default: {
        stats.skippedLineTypes[`content:${String(item.type)}`] =
          (stats.skippedLineTypes[`content:${String(item.type)}`] ?? 0) + 1;
      }
    }
  }
  // A message whose content array held only unknown block types still carries a flat `text`
  // rendering on many captures — preserve it rather than dropping the whole turn.
  if (emitted === 0) {
    const text = str(message.text);
    if (text) yield block('text', text, CAPS.text, at);
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

function ancestorChain(byId: Map<string, Record<string, unknown>>, leaf: string | undefined): Set<string> {
  const chain = new Set<string>();
  let cursor = leaf;
  let guard = byId.size + 1;
  while (cursor && cursor !== ROOT_PARENT && guard-- > 0 && !chain.has(cursor)) {
    if (!byId.has(cursor)) break;
    chain.add(cursor);
    cursor = str(byId.get(cursor)!.parent_message_uuid);
  }
  return chain;
}

function normalizeParent(parent: string | undefined): string | undefined {
  return parent && parent !== ROOT_PARENT ? parent : undefined;
}

function mapSender(sender: string | undefined): Role {
  if (sender === 'assistant') return 'assistant';
  if (sender === 'system') return 'system';
  return 'user'; // 'human' and anything else
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isObj)
    .map((p) => str(p.text) ?? '')
    .filter(Boolean)
    .join('\n');
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
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}
