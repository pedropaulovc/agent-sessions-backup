import type { JsonlLine } from '../jsonl';
import { isoFromEpochMs } from './timestamps';
import {
  CAPS,
  cap,
  type NormalizedBlock,
  type NormalizedSession,
  type NormalizedTurn,
  type Role,
  type TurnUsage,
} from '../normalize';

const OMP_SYSTEM_PROMPT_TYPE = 'omp-system-prompt';

/**
 * Oh My Pi session JSONL parser.
 *
 * The first physical record may be a fixed-width title slot, followed by one session header and
 * an append-only tree of entries. The parser is deliberately tolerant of metadata added by newer
 * OMP versions: unknown entries are counted and skipped, while message content remains bounded and
 * byte-addressable for the index writer.
 */
export async function parseOmp(lines: AsyncIterable<JsonlLine>, sessionId: string): Promise<NormalizedSession> {
  const session: NormalizedSession = {
    id: sessionId,
    harness: 'omp',
    models: [],
    isSidechain: sessionId.startsWith('omp:'),
    turns: [],
    stats: { lines: 0, parseErrorLines: 0, skippedLineTypes: {} },
  };
  const models = new Set<string>();
  const parents = new Map<string, string | undefined>();
  let headerSeen = false;
  let firstRecord = true;
  let slotTitle: string | undefined;
  let firstUserText: string | undefined;
  let lastTurnId: string | undefined;
  let incompleteTree = false;

  for await (const line of lines) {
    session.stats.lines++;
    if (line.kind === 'oversized') {
      session.stats.skippedLineTypes['oversized-line'] = (session.stats.skippedLineTypes['oversized-line'] ?? 0) + 1;
      incompleteTree = true;
      continue;
    }
    if (line.text.trim() === '') continue;

    let o: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line.text) as unknown;
      if (!isObj(parsed)) throw new Error('record is not an object');
      o = parsed;
    } catch {
      session.stats.parseErrorLines++;
      incompleteTree = true;
      continue;
    }

    const type = str(o.type) ?? '?';
    if (firstRecord && type === 'title') {
      slotTitle = str(o.title) ?? slotTitle;
      session.stats.skippedLineTypes.title = (session.stats.skippedLineTypes.title ?? 0) + 1;
      firstRecord = false;
      continue;
    }
    firstRecord = false;

    if (!headerSeen) {
      if (type !== 'session') {
        session.stats.skippedLineTypes['invalid-header'] = (session.stats.skippedLineTypes['invalid-header'] ?? 0) + 1;
        incompleteTree = true;
        continue;
      }
      headerSeen = true;
      session.cwd = str(o.cwd);
      session.title = str(o.title);
      session.parentSessionId = str(o.parentSession);
      session.harnessVersion = num(o.version)?.toString() ?? str(o.version);
      const ts = isoTimestamp(o.timestamp);
      if (ts) updateRange(session, ts);
      continue;
    }

    const id = str(o.id);
    const parentId = str(o.parentId);
    if (id) parents.set(id, parentId);
    const ts = isoTimestamp(o.timestamp);
    if (ts) updateRange(session, ts);

    switch (type) {
      case 'message':
        parseMessage(o, line, ts);
        break;
      case 'custom_message':
        parseCustomMessage(o, line, ts);
        break;
      case 'custom':
        if (o.customType === OMP_SYSTEM_PROMPT_TYPE) parseSystemPrompt(o, line, ts);
        else skip(type);
        break;
      case 'compaction':
        parseSummary(o, line, ts, 'compaction');
        break;
      case 'branch_summary':
        parseSummary(o, line, ts, 'branch_summary');
        break;
      case 'model_change': {
        const model = str(o.model);
        if (model) models.add(model);
        skip(type);
        break;
      }
      case 'title_change':
        session.title = str(o.title) ?? session.title;
        skip(type);
        break;
      case 'session_init':
        // This contains the full system prompt. It remains metadata-only; the persistence extension
        // emits a bounded, explicit omp-system-prompt record when the effective prompt should be indexed.
        skip(type);
        break;
      default:
        skip(type);
    }
  }

  if (!session.title) session.title = slotTitle;
  else if (slotTitle) session.title = slotTitle;
  session.title ??= firstUserText;
  session.models = [...models];
  session.primaryModel = session.models[session.models.length - 1];
  markMainPath(session.turns, lastTurnId, parents, incompleteTree || !headerSeen);
  session.turns.forEach((turn, index) => (turn.index = index));
  return session;

  function parseMessage(entry: Record<string, unknown>, line: JsonlLine, envelopeTs?: string): void {
    const msg = isObj(entry.message) ? entry.message : entry;
    const rawRole = str(msg.role) ?? str(entry.role);
    if (rawRole !== 'user' && rawRole !== 'developer' && rawRole !== 'assistant' && rawRole !== 'toolResult') {
      skip(`message.${rawRole ?? '?'}`);
      return;
    }
    const role: Role = rawRole === 'toolResult' ? 'tool' : rawRole;
    const ts = envelopeTs ?? isoTimestamp(msg.timestamp);
    if (ts) updateRange(session, ts);
    const model = str(msg.model) ?? str(entry.model);
    if (model) models.add(model);
    const usage = extractUsage(msg, model, str(entry.requestId));
    const turn: NormalizedTurn = {
      index: session.turns.length,
      id: str(entry.id) ?? str(msg.id),
      parentId: str(entry.parentId),
      onMainPath: false,
      role,
      ts,
      model,
      usage,
      blocks: [],
    };
    for (const block of blocksFrom(msg.content, line, role, str(msg.toolCallId), msg.isError === true)) turn.blocks.push(block);
    if (turn.blocks.length === 0 && usage === undefined) return;
    session.turns.push(turn);
    if (turn.id) lastTurnId = turn.id;
    if (!firstUserText && role === 'user') {
      const text = turn.blocks.find((block) => block.type === 'text' && block.text)?.text;
      if (text && !text.trim().startsWith('<')) firstUserText = text.slice(0, 120);
    }
  }

  function parseCustomMessage(entry: Record<string, unknown>, line: JsonlLine, envelopeTs?: string): void {
    const role: Role = str(entry.attribution) === 'user' ? 'user' : 'developer';
    const ts = envelopeTs ?? isoTimestamp(entry.timestamp);
    const turn: NormalizedTurn = {
      index: session.turns.length,
      id: str(entry.id),
      parentId: str(entry.parentId),
      onMainPath: false,
      role,
      ts,
      blocks: [],
    };
    for (const block of blocksFrom(entry.content, line, role)) turn.blocks.push(block);
    if (turn.blocks.length === 0) {
      skip('custom_message.empty');
      return;
    }
    session.turns.push(turn);
    if (turn.id) lastTurnId = turn.id;
    if (!firstUserText && role === 'user') {
      const text = turn.blocks.find((block) => block.type === 'text' && block.text)?.text;
      if (text) firstUserText = text.slice(0, 120);
    }
  }

  function parseSystemPrompt(entry: Record<string, unknown>, line: JsonlLine, ts?: string): void {
    const data = isObj(entry.data) ? entry.data : undefined;
    if (!isStringArray(data?.systemPrompt)) {
      skip('custom.omp-system-prompt.invalid');
      return;
    }

    const blocks = promptBlocks(data.systemPrompt, line);
    if (blocks.length === 0) {
      skip('custom.omp-system-prompt.empty');
      return;
    }

    session.turns.push({
      index: session.turns.length,
      id: str(entry.id) ?? `${OMP_SYSTEM_PROMPT_TYPE}:${line.byteStart}`,
      parentId: str(entry.parentId),
      onMainPath: false,
      role: 'system',
      ts,
      blocks,
    });
  }


  function parseSummary(entry: Record<string, unknown>, line: JsonlLine, ts: string | undefined, kind: 'compaction' | 'branch_summary'): void {
    const summary = str(entry.summary) ?? str(entry.shortSummary);
    if (!summary) {
      skip(`${kind}.empty`);
      return;
    }
    const c = cap(summary, CAPS.text);
    const turn: NormalizedTurn = {
      index: session.turns.length,
      id: str(entry.id),
      parentId: str(entry.parentId),
      onMainPath: false,
      role: 'system',
      ts,
      compaction: kind === 'compaction' ? { kind: 'claude-compact' } : undefined,
      byteStart: line.byteStart,
      byteLen: line.byteLen,
      blocks: [{ type: 'text', text: c.text, truncated: c.truncated, byteStart: line.byteStart, byteLen: line.byteLen }],
    };
    session.turns.push(turn);
    if (turn.id) lastTurnId = turn.id;
  }

  function skip(key: string): void {
    session.stats.skippedLineTypes[key] = (session.stats.skippedLineTypes[key] ?? 0) + 1;
  }
}

function blocksFrom(content: unknown, line: JsonlLine, role: Role, toolCallId?: string, isError = false): NormalizedBlock[] {
  const at = { byteStart: line.byteStart, byteLen: line.byteLen };
  const list: unknown[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  const out: NormalizedBlock[] = [];
  for (const raw of list) {
    if (!isObj(raw)) continue;
    switch (raw.type) {
      case 'text': {
        const text = str(raw.text);
        if (!text) break;
        const type = role === 'tool' ? 'tool_result' : 'text';
        const limit = role === 'tool' ? CAPS.tool_result : CAPS.text;
        const c = cap(text, limit);
        out.push({ type, text: c.text, truncated: c.truncated, toolUseId: role === 'tool' ? toolCallId : undefined, isError: role === 'tool' ? isError || undefined : undefined, ...at });
        break;
      }
      case 'thinking': {
        const text = str(raw.thinking);
        if (!text) break;
        const c = cap(text, CAPS.thinking);
        out.push({ type: 'thinking', text: c.text, truncated: c.truncated, ...at });
        break;
      }
      case 'toolCall': {
        const name = str(raw.name) ?? 'tool';
        const c = cap(`${name} ${safeJson(raw.arguments)}`, CAPS.tool_use);
        out.push({ type: 'tool_use', text: c.text, truncated: c.truncated, toolName: name, toolUseId: str(raw.id), ...at });
        break;
      }
      case 'toolResult': {
        const text = contentText(raw.content) || safeJson(raw.content);
        if (!text) break;
        const c = cap(text, CAPS.tool_result);
        out.push({ type: 'tool_result', text: c.text, truncated: c.truncated, toolUseId: str(raw.toolCallId) ?? str(raw.tool_call_id), isError: raw.isError === true || undefined, ...at });
        break;
      }
      case 'image':
        out.push({ type: 'image', mediaType: str(raw.mimeType) ?? str(raw.mediaType), ...at });
        break;
      default: {
        const c = cap(safeJson(raw), CAPS.text);
        if (c.text) out.push({ type: 'text', text: c.text, truncated: c.truncated, ...at });
      }
    }
  }
  // A toolResult message's content is already a list of text/image blocks. Some old OMP versions
  // use plain objects with `text`; preserve those as searchable tool output rather than dropping it.
  if (role === 'tool' && out.length === 0) {
    const text = contentText(content);
    if (text) {
      const c = cap(text, CAPS.tool_result);
      out.push({ type: 'tool_result', text: c.text, truncated: c.truncated, ...at });
    }
  }
  return out;
}
function promptBlocks(parts: readonly string[], line: JsonlLine): NormalizedBlock[] {
  const at = { byteStart: line.byteStart, byteLen: line.byteLen };
  const out: NormalizedBlock[] = [];
  for (const part of parts) {
    for (let offset = 0; offset < part.length; offset += CAPS.prompt) {
      out.push({
        type: 'prompt',
        text: part.slice(offset, offset + CAPS.prompt),
        truncated: false,
        ...at,
      });
    }
  }
  return out;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (isObj(content)) return str(content.text) ?? str(content.output) ?? '';
  if (!Array.isArray(content)) return '';
  return content.map((part) => (isObj(part) ? str(part.text) ?? '' : '')).filter(Boolean).join('\n');
}

function extractUsage(msg: Record<string, unknown>, model?: string, requestId?: string): TurnUsage | undefined {
  const u = isObj(msg.usage) ? msg.usage : undefined;
  if (!u) return undefined;
  const cc = isObj(u.cacheCreation) ? u.cacheCreation : isObj(u.cache_creation) ? u.cache_creation : undefined;
  const metrics = {
    inputTokens: num(u.input) ?? num(u.inputTokens) ?? num(u.input_tokens),
    outputTokens: num(u.output) ?? num(u.outputTokens) ?? num(u.output_tokens),
    reasoningTokens: num(u.reasoning) ?? num(u.reasoningTokens) ?? num(u.reasoning_tokens),
    cacheReadTokens: num(u.cacheRead) ?? num(u.cache_read) ?? num(u.cacheReadTokens),
    cacheCreation5mTokens: num(u.cacheWrite) ?? num(u.cache_write) ?? num(cc?.ephemeral_5m_input_tokens),
    cacheCreation1hTokens: num(cc?.ephemeral_1h_input_tokens),
    serviceTier: str(u.serviceTier) ?? str(u.service_tier),
  };
  if (!Object.values(metrics).some((value) => value !== undefined)) return undefined;
  return { model, requestId, ...metrics };
}

function markMainPath(
  turns: NormalizedTurn[],
  leafId: string | undefined,
  parents: Map<string, string | undefined>,
  incomplete: boolean,
): void {
  if (incomplete) {
    turns.forEach((turn) => (turn.onMainPath = true));
    return;
  }
  const chain = new Set<string>();
  let cursor = leafId;
  let guard = parents.size + 1;
  while (cursor && guard-- > 0) {
    chain.add(cursor);
    cursor = parents.get(cursor);
  }
  for (const turn of turns) {
    const branchCandidate = turn.id !== undefined && (turn.role === 'user' || turn.role === 'assistant' || turn.role === 'developer' || turn.role === 'tool');
    turn.onMainPath = !branchCandidate || chain.has(turn.id!);
  }
}

function updateRange(session: NormalizedSession, ts: string): void {
  if (!session.startedAt || ts < session.startedAt) session.startedAt = ts;
  if (!session.endedAt || ts > session.endedAt) session.endedAt = ts;
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value === 'number') return isoFromEpochMs(value);
  if (typeof value !== 'string' || !value) return undefined;
  const ms = Date.parse(value);
  return isoFromEpochMs(ms);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((part) => typeof part === 'string');
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
