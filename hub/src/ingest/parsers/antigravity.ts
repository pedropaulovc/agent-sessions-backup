import type { JsonlLine } from '../jsonl';
import { isoFromEpochMs } from './timestamps';
import {
  CAPS,
  cap,
  type NormalizedBlock,
  type NormalizedSession,
  type NormalizedTurn,
  type TurnUsage,
} from '../normalize';

export type AntigravityHarness = 'agy' | 'antigravity';

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PARENT_SENDER_RE = new RegExp(`\\[Message\\][^\\n]*?\\bsender=(${UUID_PATTERN})(?=\\s|$)`, 'i');
const SUBAGENT_OUTPUT_RE = new RegExp(
  `Created the following subagent:\\s*\\{[\\s\\S]*?"conversationId"\\s*:\\s*"(${UUID_PATTERN})"`,
  'i',
);
const USER_REQUEST_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/;
const SYSTEM_MESSAGE_CONTENT_RE = /\[Message\][^\n]*?\bcontent=([\s\S]*?)(?:\n<\/SYSTEM_MESSAGE>|$)/;
const CREATED_AT_RE = /^Created At:\s*(.+)$/m;
const COMPLETED_AT_RE = /^Completed At:\s*(.+)$/m;

/**
 * Antigravity CLI (`agy`) and Antigravity App (`antigravity`) transcript JSONL parser.
 *
 * Both surfaces write append-only step logs at:
 *   brain/<conversation-uuid>/.system_generated/logs/transcript_full.jsonl
 *
 * Each line is one step (`USER_INPUT`, `PLANNER_RESPONSE`, `GENERIC`, `RUN_COMMAND`, `SEARCH_WEB`,
 * `GENERATE_IMAGE`, `CODE_ACTION`, `LIST_DIRECTORY`, `VIEW_FILE`, `SYSTEM_MESSAGE`,
 * `EPHEMERAL_MESSAGE`, `CHECKPOINT`, `CONVERSATION_HISTORY`, ...). Tool calls live in
 * `PLANNER_RESPONSE.tool_calls` and their outputs arrive as the immediately following model tool
 * steps in FIFO order. Token counters report fresh `input_tokens` disjoint from
 * `cache_read_tokens`.
 */
export async function parseAntigravity(
  lines: AsyncIterable<JsonlLine>,
  sessionId: string,
  harness: AntigravityHarness = 'agy',
): Promise<NormalizedSession> {
  const session: NormalizedSession = {
    id: sessionId,
    harness,
    models: [],
    isSidechain: false,
    turns: [],
    stats: { lines: 0, parseErrorLines: 0, skippedLineTypes: {} },
  };
  const models = new Set<string>();
  let lastModel: string | undefined;
  let firstUserTitle: string | undefined;
  let firstSubagentTitle: string | undefined;
  let pendingCalls: Array<{ toolUseId: string; toolCallKey: string; toolName: string }> = [];

  for await (const line of lines) {
    session.stats.lines++;
    if (line.kind === 'oversized') {
      session.stats.skippedLineTypes['oversized-line'] = (session.stats.skippedLineTypes['oversized-line'] ?? 0) + 1;
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
      continue;
    }

    const type = str(o.type) ?? '?';
    const source = str(o.source);
    const status = str(o.status);
    const stepIndex = num(o.step_index);
    const ts = isoTimestamp(o.created_at) ?? isoTimestamp(o.timestamp);
    if (ts) updateRange(session, ts);

    session.cwd ??= str(o.cwd) ?? str(o.workspace);
    const turnId = stepIndex !== undefined ? `step:${stepIndex}` : `offset:${line.byteStart}`;
    const at = { byteStart: line.byteStart, byteLen: line.byteLen };

    if (type === 'USER_INPUT') {
      pendingCalls = [];
      const content = str(o.content);
      if (!content) {
        skip('USER_INPUT.empty');
        continue;
      }
      const c = cap(content, CAPS.text);
      session.turns.push({
        index: session.turns.length,
        id: turnId,
        onMainPath: true,
        role: 'user',
        ts,
        blocks: [{ type: 'text', text: c.text, truncated: c.truncated, ...at }],
      });
      if (!firstUserTitle) firstUserTitle = extractUserRequestTitle(content);
      continue;
    }

    if (type === 'PLANNER_RESPONSE') {
      pendingCalls = [];
      const model = str(o.model);
      if (model) {
        models.add(model);
        lastModel = model;
      }
      const usage = extractUsage(o, model);
      const blocks: NormalizedBlock[] = [];
      const thinking = str(o.thinking);
      if (thinking) {
        const c = cap(thinking, CAPS.thinking);
        blocks.push({ type: 'thinking', text: c.text, truncated: c.truncated, ...at });
      }
      const content = str(o.content);
      if (content) {
        const c = cap(content, CAPS.text);
        blocks.push({ type: 'text', text: c.text, truncated: c.truncated, ...at });
      }
      if (Array.isArray(o.tool_calls)) {
        for (let i = 0; i < o.tool_calls.length; i++) {
          const rawCall = o.tool_calls[i];
          if (!isObj(rawCall)) continue;
          const name = str(rawCall.name) ?? 'tool';
          const toolUseId = str(rawCall.id) ?? `agy:${stepIndex ?? line.byteStart}:${i}`;
          const toolCallKey = `agy:${line.byteStart}:${i}`;
          const args = rawCall.args !== undefined ? rawCall.args : rawCall.arguments;
          const c = cap(args !== undefined ? `${name} ${safeJson(args)}` : name, CAPS.tool_use);
          blocks.push({
            type: 'tool_use',
            text: c.text,
            truncated: c.truncated,
            toolName: name,
            toolUseId,
            toolCallKey,
            ...at,
          });
          pendingCalls.push({ toolUseId, toolCallKey, toolName: name });
        }
      }
      const isError = status === 'ERROR' || !!str(o.error) || undefined;
      if (blocks.length === 0 && usage === undefined && !isError) {
        skip('PLANNER_RESPONSE.empty');
        continue;
      }
      session.turns.push({
        index: session.turns.length,
        id: turnId,
        onMainPath: true,
        role: 'assistant',
        ts,
        model,
        usage,
        isError,
        blocks,
      });
      continue;
    }

    if (type === 'CHECKPOINT') {
      pendingCalls = [];
      const explicitModel = str(o.model);
      if (explicitModel) {
        models.add(explicitModel);
        lastModel = explicitModel;
      }
      const model = explicitModel ?? lastModel;
      const usage = extractUsage(o, model);
      const content = str(o.content);
      const blocks: NormalizedBlock[] = [];
      if (content) {
        const c = cap(content, CAPS.text);
        blocks.push({ type: 'text', text: c.text, truncated: c.truncated, ...at });
      }
      session.turns.push({
        index: session.turns.length,
        id: turnId,
        onMainPath: true,
        role: 'system',
        ts,
        model,
        usage,
        compaction: { kind: 'claude-compact' },
        byteStart: line.byteStart,
        byteLen: line.byteLen,
        blocks,
      });
      continue;
    }

    if (type === 'CONVERSATION_HISTORY') {
      skip(type);
      continue;
    }

    if (type === 'SYSTEM_MESSAGE' || type === 'EPHEMERAL_MESSAGE') {
      const content = str(o.content);
      if (!content) {
        skip(`${type}.empty`);
        continue;
      }
      if (type === 'SYSTEM_MESSAGE' && (stepIndex === 0 || session.turns.length === 0)) {
        const parent = extractParentUuid(content, sessionId);
        if (parent) {
          session.parentSessionId = parent;
          session.parentSessionLink = 'linked';
          session.isSidechain = true;
          firstSubagentTitle ??= extractSystemMessageTitle(content);
        }
      }
      const c = cap(content, CAPS.text);
      session.turns.push({
        index: session.turns.length,
        id: turnId,
        onMainPath: true,
        role: 'system',
        ts,
        blocks: [{ type: 'text', text: c.text, truncated: c.truncated, ...at }],
      });
      continue;
    }

    if (source === 'MODEL') {
      const matchedCall = pendingCalls.shift();
      const rawContent = str(o.content);
      const errMsg = str(o.error);
      const mediaSummary = summarizeMedia(o.media);
      const bodyText = rawContent ?? errMsg ?? mediaSummary;
      if (!bodyText) {
        skip(`${type}.empty`);
        continue;
      }
      const c = cap(bodyText, CAPS.tool_result);
      const isError = status === 'ERROR' || !!errMsg || undefined;
      const toolName = matchedCall?.toolName ?? (type !== 'GENERIC' && type !== '?' ? type.toLowerCase() : undefined);
      const timing = rawContent ? extractStepTiming(rawContent) : undefined;
      const subagentSessionId = rawContent ? extractSubagentId(rawContent) : undefined;
      session.turns.push({
        index: session.turns.length,
        id: turnId,
        onMainPath: true,
        role: 'tool',
        ts,
        isError,
        blocks: [
          {
            type: 'tool_result',
            text: c.text,
            truncated: c.truncated,
            toolName,
            toolUseId: matchedCall?.toolUseId,
            toolCallKey: matchedCall?.toolCallKey,
            isError,
            timing,
            subagentSessionId,
            ...at,
          },
        ],
      });
      continue;
    }

    if ((source === 'USER_EXPLICIT' || source === 'USER') && str(o.content)) {
      pendingCalls = [];
      const content = str(o.content)!;
      const c = cap(content, CAPS.text);
      session.turns.push({
        index: session.turns.length,
        id: turnId,
        onMainPath: true,
        role: 'user',
        ts,
        blocks: [{ type: 'text', text: c.text, truncated: c.truncated, ...at }],
      });
      if (!firstUserTitle) firstUserTitle = extractUserRequestTitle(content);
      continue;
    }

    skip(type);
  }

  session.title = firstUserTitle ?? firstSubagentTitle;
  session.models = [...models];
  session.primaryModel = session.models[session.models.length - 1];
  session.turns.forEach((turn, index) => (turn.index = index));
  return session;

  function skip(key: string): void {
    session.stats.skippedLineTypes[key] = (session.stats.skippedLineTypes[key] ?? 0) + 1;
  }
}

/** Convert a `file://` workspace URI from Antigravity metadata into a local filesystem path. */
export function workspaceUriToPath(uri: string): string | undefined {
  const trimmed = uri.trim();
  if (!trimmed) return undefined;
  if (!trimmed.toLowerCase().startsWith('file://')) return trimmed;
  let rest = trimmed.slice('file://'.length);
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // Keep the raw path if percent-encoding is malformed.
  }
  // Windows file URIs look like file:///C:/src/repo -> C:/src/repo.
  if (/^\/[A-Za-z]:\//.test(rest)) return rest.slice(1);
  return rest || undefined;
}

function extractUsage(record: Record<string, unknown>, model?: string): TurnUsage | undefined {
  const metrics = {
    inputTokens: num(record.input_tokens),
    outputTokens: num(record.output_tokens),
    reasoningTokens: num(record.reasoning_tokens) ?? num(record.thinking_tokens),
    cacheReadTokens: num(record.cache_read_tokens),
    cacheCreation5mTokens: num(record.cache_creation_tokens) ?? num(record.cache_creation_input_tokens),
  };
  if (!Object.values(metrics).some((value) => value !== undefined)) return undefined;
  return { model, ...metrics };
}

function extractUserRequestTitle(content: string): string | undefined {
  const match = content.match(USER_REQUEST_RE);
  const raw = (match ? match[1] : content)?.trim();
  return raw ? raw.slice(0, 120) : undefined;
}

function extractSystemMessageTitle(content: string): string | undefined {
  const match = content.match(SYSTEM_MESSAGE_CONTENT_RE);
  const raw = match?.[1]?.trim();
  return raw ? raw.slice(0, 120) : undefined;
}

function extractParentUuid(content: string, selfId: string): string | undefined {
  const match = content.match(PARENT_SENDER_RE);
  const candidate = match?.[1]?.toLowerCase();
  if (!candidate || candidate === selfId.toLowerCase()) return undefined;
  return candidate;
}

function extractSubagentId(content: string): string | undefined {
  const match = content.match(SUBAGENT_OUTPUT_RE);
  return match?.[1]?.toLowerCase();
}

function extractStepTiming(content: string): { startMs?: number; endMs?: number } | undefined {
  const header = content.slice(0, 256);
  const startRaw = header.match(CREATED_AT_RE)?.[1]?.trim();
  const endRaw = header.match(COMPLETED_AT_RE)?.[1]?.trim();
  const startMs = startRaw ? Date.parse(startRaw) : Number.NaN;
  const endMs = endRaw ? Date.parse(endRaw) : Number.NaN;
  const hasStart = Number.isFinite(startMs);
  const hasEnd = Number.isFinite(endMs);
  if (!hasStart && !hasEnd) return undefined;
  if (hasStart && hasEnd && endMs < startMs) return undefined;
  return {
    ...(hasStart ? { startMs } : {}),
    ...(hasEnd ? { endMs } : {}),
  };
}

function summarizeMedia(media: unknown): string | undefined {
  if (!Array.isArray(media) || media.length === 0) return undefined;
  const parts: string[] = [];
  for (const item of media) {
    if (!isObj(item)) continue;
    const mime = str(item.mime_type) ?? str(item.mimeType) ?? 'media';
    const uri = str(item.uri);
    parts.push(uri ? `[${mime}: ${uri}]` : `[${mime}]`);
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
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
