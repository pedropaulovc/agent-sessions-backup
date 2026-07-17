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
  // Codex represents one logical message TWICE on the wire: once as event_msg/user_message|
  // agent_message, once as response_item/message. These two maps pair up that duplicate
  // representation (by source, so a genuine same-text repeat within the SAME source — e.g. the
  // user typing "continue" twice, both as response_item — is never mistaken for a pairing and
  // both instances get indexed). See shouldIndexMessage below.
  const pendingFromResponseItem = new Map<string, number>();
  const pendingFromEventMsg = new Map<string, number>();

  const flush = () => {
    // A turn can be usage-only: token_count is the only billable event before EOF/role change
    // (e.g. every response item in it was skipped — encrypted-reasoning-only, unsupported
    // subtype). The later filter explicitly keeps t.usage turns, so flush must not drop them.
    if (current && (current.blocks.length > 0 || current.usage)) session.turns.push(current);
    current = undefined;
    // A representation pair (event_msg + response_item for one logical message) is always
    // adjacent within a single turn — so an unpaired occurrence left pending at a turn boundary
    // is never going to be paired and must not survive to wrongly consume an unrelated, later
    // genuine repeat of the same (role, text) in a different turn/exchange.
    pendingFromResponseItem.clear();
    pendingFromEventMsg.clear();
  };
  const openTurn = (role: Role, ts: string | undefined, turnId: string | undefined) => {
    if (current && (current.role !== role || (turnId && currentTurnId && turnId !== currentTurnId))) flush();
    if (!current) {
      current = { index: session.turns.length, onMainPath: true, role, ts, blocks: [] };
      currentTurnId = turnId;
      // A new user turn means whatever assistant call preceded it is done; a token_count that
      // arrives after this (for a reply with no indexable block, e.g. encrypted-reasoning-only)
      // must open a fresh usage-only turn instead of overwriting this now-stale prior usage.
      if (role === 'user') lastAssistant = undefined;
      if (role === 'assistant') {
        current.model = currentModel;
        lastAssistant = current;
      }
    }
    return current;
  };
  const pushCompactionMarker = (ts: string | undefined) => {
    flush();
    // Otherwise a token_count arriving after this marker (the compaction request's own usage)
    // would reuse the pre-compaction reply as its target — silently overwriting that turn's real
    // usage instead of landing on a fresh usage-only turn. Same reset flush() already does for a
    // new user turn (see openTurn above). Shared by both marker shapes (top-level
    // compacted/world_state and event_msg/context_compacted) — they carry the same reset need.
    lastAssistant = undefined;
    session.turns.push({
      index: session.turns.length,
      onMainPath: true,
      role: 'system',
      ts,
      compaction: { kind: 'codex-window' },
      blocks: [],
    });
  };

  /**
   * A message text arriving from `source` is indexed unless the OTHER source already has an
   * unconsumed occurrence of the same (role, text) waiting to be paired — in which case this
   * is presumed to be that occurrence's duplicate wire representation, and it's consumed
   * (skipped) instead of indexed again. Consecutive occurrences from the SAME source always
   * index (they're genuine repeats, not representation pairs).
   */
  function shouldIndexMessage(source: 'response_item' | 'event_msg', role: Role, text: string): boolean {
    const key = `${role}:${messageKey(text)}`;
    const mine = source === 'response_item' ? pendingFromResponseItem : pendingFromEventMsg;
    const other = source === 'response_item' ? pendingFromEventMsg : pendingFromResponseItem;
    const otherPending = other.get(key) ?? 0;
    if (otherPending > 0) {
      other.set(key, otherPending - 1);
      return false;
    }
    mine.set(key, (mine.get(key) ?? 0) + 1);
    return true;
  }

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
        pushCompactionMarker(ts);
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
        // Resolve/open the turn BEFORE the dedupe check: if this message starts a new turn,
        // opening it flushes and clears the pending-pairing maps for the turn being left. Doing
        // that first means a message that itself opens a new turn gets to register its own
        // pending count in the FRESH map, instead of registering then immediately having its own
        // turn-opening flush wipe it out.
        const turn = openTurn(role === 'developer' ? 'developer' : role, ts, turnId);
        if (!shouldIndexMessage('response_item', role, text)) break;
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
        const role: Role = p.type === 'user_message' ? 'user' : 'assistant';
        if (!text) break;
        // Open the turn before the dedupe check — see the matching comment in the
        // response_item/message case above.
        const turn = openTurn(role, ts, undefined);
        if (!shouldIndexMessage('event_msg', role, text)) break;
        const c = cap(text, CAPS.text);
        turn.blocks.push({ type: 'text', text: c.text, truncated: c.truncated, ...at });
        if (!firstUserText && role === 'user') firstUserText = text.slice(0, 120);
        break;
      }
      case 'context_compacted': {
        pushCompactionMarker(ts);
        break;
      }
      default:
        // task_started/task_complete/patch_apply_end/…: presence only.
        break;
    }
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
