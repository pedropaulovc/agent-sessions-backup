import type { JsonlLine } from '../jsonl';
import {
  CAPS,
  cap,
  type NormalizedBlock,
  type NormalizedSession,
  type NormalizedTurn,
  type Role,
  type TurnUsage,
} from '../normalize';

/**
 * Claude Code session JSONL parser.
 *
 * One line = one envelope. Indexable turns come from `user`/`assistant`/`system`
 * lines; `ai-title`/`custom-title` feed session.title; every other type is
 * skip-and-count (the envelope zoo grows between CLI versions — never crash).
 */
export async function parseClaudeCode(
  lines: AsyncIterable<JsonlLine>,
  sessionId: string,
): Promise<NormalizedSession> {
  const session: NormalizedSession = {
    id: sessionId,
    harness: 'claude-code',
    models: [],
    isSidechain: false,
    turns: [],
    stats: { lines: 0, parseErrorLines: 0, skippedLineTypes: {} },
  };
  const models = new Set<string>();
  let aiTitle: string | undefined;
  let customTitle: string | undefined;
  let firstUserText: string | undefined;
  let lastMessageUuid: string | undefined;

  for await (const line of lines) {
    session.stats.lines++;
    if (line.text.trim() === '') continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line.text) as Record<string, unknown>;
    } catch {
      session.stats.parseErrorLines++;
      continue;
    }
    const type = typeof o.type === 'string' ? o.type : '?';

    if (type === 'ai-title') {
      aiTitle = str(o.title) ?? aiTitle;
      continue;
    }
    if (type === 'custom-title') {
      customTitle = str(o.title) ?? customTitle;
      continue;
    }
    if (type !== 'user' && type !== 'assistant' && type !== 'system') {
      session.stats.skippedLineTypes[type] = (session.stats.skippedLineTypes[type] ?? 0) + 1;
      continue;
    }

    session.cwd ??= str(o.cwd);
    session.gitBranch ??= str(o.gitBranch);
    session.harnessVersion ??= str(o.version);
    if (o.isSidechain === true) session.isSidechain = true;

    const ts = str(o.timestamp);
    if (ts) {
      if (!session.startedAt || ts < session.startedAt) session.startedAt = ts;
      if (!session.endedAt || ts > session.endedAt) session.endedAt = ts;
    }

    const msg = isObj(o.message) ? o.message : undefined;
    const role: Role = type === 'system' ? 'system' : (str(msg?.role) as Role) ?? (type as Role);

    const turn: NormalizedTurn = {
      index: session.turns.length,
      id: str(o.uuid),
      parentId: str(o.parentUuid) ?? undefined,
      onMainPath: false, // resolved after the full pass
      role,
      ts,
      blocks: [],
    };

    if (type === 'assistant' && msg) {
      const model = str(msg.model);
      if (model) {
        models.add(model);
        turn.model = model;
      }
      turn.usage = extractUsage(msg, str(o.requestId));
    }

    const content = msg?.content ?? o.content;
    for (const block of blocksFrom(content, o, line, session.stats)) turn.blocks.push(block);

    if (type === 'system' && turn.blocks.length === 0) {
      const text = str(o.content) ?? str(o.summary);
      if (text) {
        const c = cap(text, CAPS.text);
        turn.blocks.push({ type: 'text', text: c.text, truncated: c.truncated, byteStart: line.byteStart, byteLen: line.byteLen });
      }
    }

    if (!firstUserText && role === 'user') {
      const t = turn.blocks.find((b) => b.type === 'text' && b.text);
      if (t?.text && !t.text.startsWith('<')) firstUserText = t.text.slice(0, 120);
    }
    if (type === 'user' || type === 'assistant') lastMessageUuid = turn.id ?? lastMessageUuid;

    if (turn.blocks.length > 0 || turn.usage) session.turns.push(turn);
  }

  markMainPath(session.turns, lastMessageUuid);
  session.models = [...models];
  session.primaryModel = session.models[0];
  session.title = customTitle ?? aiTitle ?? firstUserText;
  return session;
}

function* blocksFrom(
  content: unknown,
  envelope: Record<string, unknown>,
  line: JsonlLine,
  stats: NormalizedSession['stats'],
): Generator<NormalizedBlock> {
  const at = { byteStart: line.byteStart, byteLen: line.byteLen };
  const list: unknown[] =
    typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];

  const toolResultBlocks = list.filter((b) => isObj(b) && b.type === 'tool_result').length;

  for (const raw of list) {
    if (!isObj(raw)) continue;
    switch (raw.type) {
      case 'text': {
        const text = str(raw.text);
        if (!text) break;
        const c = cap(text, CAPS.text);
        yield { type: 'text', text: c.text, truncated: c.truncated, ...at };
        break;
      }
      case 'thinking': {
        const text = str(raw.thinking);
        if (!text) break;
        const c = cap(text, CAPS.thinking);
        yield { type: 'thinking', text: c.text, truncated: c.truncated, ...at };
        break;
      }
      case 'tool_use': {
        const name = str(raw.name) ?? 'tool';
        const c = cap(`${name} ${safeJson(raw.input)}`, CAPS.tool_use);
        yield { type: 'tool_use', text: c.text, truncated: c.truncated, toolName: name, toolUseId: str(raw.id), ...at };
        break;
      }
      case 'tool_result': {
        let text = toolResultText(raw.content);
        // Prefer the envelope-level toolUseResult when it is the fuller form
        // (the in-message tool_result is often a truncated rendering).
        if (toolResultBlocks === 1) {
          const fuller = toolUseResultText(envelope.toolUseResult);
          if (fuller && fuller.length > text.length) text = fuller;
        }
        const c = cap(text, CAPS.tool_result);
        yield {
          type: 'tool_result',
          text: c.text,
          truncated: c.truncated,
          toolUseId: str(raw.tool_use_id),
          isError: raw.is_error === true || undefined,
          ...at,
        };
        break;
      }
      case 'image': {
        const source = isObj(raw.source) ? raw.source : undefined;
        yield { type: 'image', mediaType: str(source?.media_type), ...at };
        break;
      }
      case 'document': {
        const source = isObj(raw.source) ? raw.source : undefined;
        yield { type: 'document', mediaType: str(source?.media_type), ...at };
        break;
      }
      default: {
        // Unknown block types (server_tool_use, …): a message whose content is ONLY one of
        // these would otherwise yield no blocks, and the caller drops blockless/usage-less
        // turns entirely — silently disappearing that turn from sessions and FTS. Preserve
        // the raw shape cheaply instead of dropping it.
        const key = `content:${String(raw.type)}`;
        stats.skippedLineTypes[key] = (stats.skippedLineTypes[key] ?? 0) + 1;
        const c = cap(safeJson(raw), CAPS.tool_use);
        yield { type: 'text', text: c.text, truncated: c.truncated, ...at };
        break;
      }
    }
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p): p is Record<string, unknown> => isObj(p) && p.type === 'text')
    .map((p) => str(p.text) ?? '')
    .join('\n');
}

function toolUseResultText(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  if (isObj(v)) {
    const direct = str(v.stdout) ?? str(v.content) ?? str(v.file && isObj(v.file) ? v.file.content : undefined);
    if (direct) return direct;
    return safeJson(v);
  }
  return safeJson(v);
}

function extractUsage(msg: Record<string, unknown>, requestId?: string): TurnUsage | undefined {
  const u = isObj(msg.usage) ? msg.usage : undefined;
  if (!u) return undefined;
  const cc = isObj(u.cache_creation) ? u.cache_creation : undefined;
  return {
    model: str(msg.model),
    serviceTier: str(u.service_tier),
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheCreation5mTokens: num(cc?.ephemeral_5m_input_tokens) ?? num(u.cache_creation_input_tokens),
    cacheCreation1hTokens: num(cc?.ephemeral_1h_input_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    inferenceGeo: str(u.inference_geo),
    requestId,
  };
}

/** Walk the parentUuid chain back from the last message; everything on it is the main path. */
function markMainPath(turns: NormalizedTurn[], lastUuid: string | undefined): void {
  if (!lastUuid) return;
  const byId = new Map<string, NormalizedTurn>();
  for (const t of turns) if (t.id) byId.set(t.id, t);
  let cursor: string | undefined = lastUuid;
  let guard = turns.length + 1;
  while (cursor && guard-- > 0) {
    const turn = byId.get(cursor);
    if (!turn) break;
    turn.onMainPath = true;
    cursor = turn.parentId;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}
