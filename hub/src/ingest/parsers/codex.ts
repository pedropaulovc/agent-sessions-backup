import type { JsonlLine } from '../jsonl';
import {
  CAPS,
  cap,
  type NormalizedBlock,
  type NormalizedSession,
  type NormalizedTurn,
  type Role,
} from '../normalize';

/**
 * Codex rollout JSONL parser.
 *
 * Envelope: {timestamp, type, payload}. Response items are grouped into turns by
 * `internal_chat_message_metadata_passthrough.turn_id` when present, else by
 * effective-role transitions. `event_msg/token_count` events fold into the current
 * turn's usage (last wins — they carry cumulative + last-call token counts).
 * Compaction (`compacted`/`world_state`) becomes marker turns; shapes vary across
 * CLI versions, so nothing beyond their presence is assumed.
 */
export async function parseCodex(lines: AsyncIterable<JsonlLine>, sessionId: string): Promise<NormalizedSession> {
  const session: NormalizedSession = {
    id: sessionId,
    harness: 'codex',
    models: [],
    isSidechain: false,
    turns: [],
    stats: { lines: 0, parseErrorLines: 0, skippedLineTypes: {} },
  };
  const models = new Set<string>();
  let currentModel: string | undefined;
  let current: NormalizedTurn | undefined;
  let currentTurnId: string | undefined;
  let lastAssistant: NormalizedTurn | undefined;
  let firstUserText: string | undefined;
  const seenMessageHashes = new Set<string>();

  const flush = () => {
    // A turn can be usage-only: token_count is the only billable event before EOF/role change
    // (e.g. every response item in it was skipped — encrypted-reasoning-only, unsupported
    // subtype). The later filter explicitly keeps t.usage turns, so flush must not drop them.
    if (current && (current.blocks.length > 0 || current.usage)) session.turns.push(current);
    current = undefined;
  };
  const openTurn = (role: Role, ts: string | undefined, turnId: string | undefined) => {
    if (current && (current.role !== role || (turnId && currentTurnId && turnId !== currentTurnId))) flush();
    if (!current) {
      current = { index: session.turns.length, onMainPath: true, role, ts, blocks: [] };
      currentTurnId = turnId;
      if (role === 'assistant') {
        current.model = currentModel;
        lastAssistant = current;
      }
    }
    return current;
  };

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
    const ts = str(o.timestamp);
    if (ts) {
      if (!session.startedAt || ts < session.startedAt) session.startedAt = ts;
      if (!session.endedAt || ts > session.endedAt) session.endedAt = ts;
    }
    const payload = isObj(o.payload) ? o.payload : {};
    const at = { byteStart: line.byteStart, byteLen: line.byteLen };

    switch (o.type) {
      case 'session_meta': {
        session.cwd ??= str(payload.cwd);
        session.harnessVersion ??= str(payload.cli_version);
        const git = isObj(payload.git) ? payload.git : undefined;
        session.repoUrl ??= str(git?.repository_url);
        session.gitBranch ??= str(git?.branch);
        break;
      }
      case 'turn_context': {
        const model = str(payload.model);
        if (model) {
          currentModel = model;
          models.add(model);
        }
        session.cwd ??= str(payload.cwd);
        break;
      }
      case 'response_item': {
        handleResponseItem(payload, ts, at);
        break;
      }
      case 'event_msg': {
        handleEventMsg(payload, ts, at);
        break;
      }
      case 'compacted':
      case 'world_state': {
        flush();
        session.turns.push({
          index: session.turns.length,
          onMainPath: true,
          role: 'system',
          ts,
          compaction: { kind: 'codex-window' },
          blocks: [],
        });
        break;
      }
      default:
        session.stats.skippedLineTypes[String(o.type)] =
          (session.stats.skippedLineTypes[String(o.type)] ?? 0) + 1;
    }
  }
  flush();

  session.models = [...models];
  session.primaryModel = session.models[session.models.length - 1];
  session.title = firstUserText;
  // Compaction markers with no blocks were pushed directly; keep only real turns + markers.
  session.turns = session.turns.filter((t) => t.blocks.length > 0 || t.compaction || t.usage);
  session.turns.forEach((t, i) => (t.index = i));
  return session;

  function handleResponseItem(p: Record<string, unknown>, ts: string | undefined, at: { byteStart: number; byteLen: number }) {
    const meta = isObj(p.internal_chat_message_metadata_passthrough)
      ? p.internal_chat_message_metadata_passthrough
      : undefined;
    const turnId = str(meta?.turn_id);
    switch (p.type) {
      case 'message': {
        const role = (str(p.role) as Role) ?? 'assistant';
        const text = contentText(p.content);
        if (!text) break;
        rememberMessage(text);
        const turn = openTurn(role === 'developer' ? 'developer' : role, ts, turnId);
        const c = cap(text, CAPS.text);
        turn.blocks.push({ type: 'text', text: c.text, truncated: c.truncated, ...at });
        if (!firstUserText && role === 'user') firstUserText = text.slice(0, 120);
        break;
      }
      case 'reasoning': {
        // Often only encrypted_content is present — index summary text when it exists.
        const text = contentText(p.summary) || contentText(p.content);
        if (!text) break;
        const turn = openTurn('assistant', ts, turnId);
        const c = cap(text, CAPS.thinking);
        turn.blocks.push({ type: 'thinking', text: c.text, truncated: c.truncated, ...at });
        break;
      }
      case 'function_call':
      case 'custom_tool_call': {
        const name = str(p.name) ?? 'tool';
        const args = str(p.arguments) ?? str(p.input) ?? '';
        const turn = openTurn('assistant', ts, turnId);
        const c = cap(`${name} ${args}`, CAPS.tool_use);
        turn.blocks.push({
          type: 'tool_use',
          text: c.text,
          truncated: c.truncated,
          toolName: name,
          toolUseId: str(p.call_id),
          ...at,
        });
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const out = p.output;
        const text = typeof out === 'string' ? out : contentText(out) || safeJson(out);
        const turn = openTurn('tool', ts, turnId);
        const c = cap(text, CAPS.tool_result);
        turn.blocks.push({
          type: 'tool_result',
          text: c.text,
          truncated: c.truncated,
          toolUseId: str(p.call_id),
          ...at,
        });
        break;
      }
      default:
        session.stats.skippedLineTypes[`response_item.${String(p.type)}`] =
          (session.stats.skippedLineTypes[`response_item.${String(p.type)}`] ?? 0) + 1;
    }
  }

  function handleEventMsg(p: Record<string, unknown>, ts: string | undefined, at: { byteStart: number; byteLen: number }) {
    switch (p.type) {
      case 'token_count': {
        const info = isObj(p.info) ? p.info : undefined;
        const last = isObj(info?.last_token_usage) ? info.last_token_usage : undefined;
        if (!last) break;
        const target = lastAssistant ?? openTurn('assistant', ts, undefined);
        target.usage = {
          model: currentModel,
          inputTokens: num(last.input_tokens),
          outputTokens: num(last.output_tokens),
          reasoningTokens: num(last.reasoning_output_tokens),
          cacheReadTokens: num(last.cached_input_tokens),
        };
        break;
      }
      case 'user_message':
      case 'agent_message': {
        const text = str(p.message) ?? contentText(p.message);
        if (!text || seenMessageHashes.has(messageKey(text))) break;
        rememberMessage(text);
        const role: Role = p.type === 'user_message' ? 'user' : 'assistant';
        const turn = openTurn(role, ts, undefined);
        const c = cap(text, CAPS.text);
        turn.blocks.push({ type: 'text', text: c.text, truncated: c.truncated, ...at });
        if (!firstUserText && role === 'user') firstUserText = text.slice(0, 120);
        break;
      }
      case 'context_compacted': {
        flush();
        session.turns.push({
          index: session.turns.length,
          onMainPath: true,
          role: 'system',
          ts,
          compaction: { kind: 'codex-window' },
          blocks: [],
        });
        break;
      }
      default:
        // task_started/task_complete/patch_apply_end/…: presence only.
        break;
    }
  }

  function rememberMessage(text: string) {
    seenMessageHashes.add(messageKey(text));
  }
}

// Dedupe key over the FULL text, not just a prefix — two distinct messages sharing a long
// common prefix (e.g. pasted logs with the same header) must both be indexed. Length + a 32-bit
// FNV-1a digest keeps memory flat per message while making an accidental collision between two
// genuinely different messages astronomically unlikely.
function messageKey(text: string): string {
  return `${text.length}:${fnv1a32(text)}`;
}

function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isObj)
    .map((p) => str(p.text) ?? '')
    .filter(Boolean)
    .join('\n');
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
