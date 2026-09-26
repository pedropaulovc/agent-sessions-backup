import type { JsonlLine } from '../jsonl';
import {
  CAPS,
  cap,
  type NormalizedSession,
  type NormalizedTurn,
  type Role,
} from '../normalize';

const CODEX_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
export async function parseCodex(
  lines: AsyncIterable<JsonlLine>,
  sessionId: string,
  mode: 'index' | 'render' = 'index',
): Promise<NormalizedSession> {
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
    currentTurnId = undefined;
    // A representation pair (event_msg + response_item for one logical message) is always
    // adjacent within a single turn — so an unpaired occurrence left pending at a turn boundary
    // is never going to be paired and must not survive to wrongly consume an unrelated, later
    // genuine repeat of the same (role, text) in a different turn/exchange.
    pendingFromResponseItem.clear();
    pendingFromEventMsg.clear();
  };
  const sourceTurnIdentity = (
    role: Role,
    turnId: string,
    sourceItem: string,
  ): string => `${role}:${turnId}:${sourceItem}`;
  const openTurn = (
    role: Role,
    ts: string | undefined,
    turnId: string | undefined,
    sourceItem?: string,
  ) => {
    if (current && (current.role !== role || (turnId && currentTurnId && turnId !== currentTurnId))) flush();
    if (current && turnId && sourceItem && !currentTurnId && !current.id) {
      // A token_count may open a blockless turn before its response_item supplies the source ID.
      // Adopt that ID as the boundary so full and ranged parses split the following source turn
      // identically. A preceding event_msg already contributed a block; leave its boundary unset
      // until its representation twin is consumed, so the twin can still dedupe within this turn.
      const blockless = current.blocks.length === 0;
      current.id = sourceTurnIdentity(role, turnId, sourceItem);
      if (blockless) currentTurnId = turnId;
    }
    if (!current) {
      current = {
        index: session.turns.length,
        id: turnId && sourceItem ? sourceTurnIdentity(role, turnId, sourceItem) : undefined,
        onMainPath: true,
        role,
        ts,
        blocks: [],
      };
      currentTurnId = turnId;
      // A new user/developer/system turn means whatever assistant call preceded it is done; a
      // token_count that arrives after this (for a reply with no indexable block, e.g.
      // encrypted-reasoning-only) must open a fresh usage-only turn instead of overwriting this
      // now-stale prior usage. NOT 'tool': a token_count after a tool-result turn legitimately
      // reports the call that produced the tool_use, so lastAssistant must survive it.
      if (role === 'user' || role === 'developer' || role === 'system') lastAssistant = undefined;
      if (role === 'assistant') {
        current.model = currentModel;
        lastAssistant = current;
      }
    }
    return current;
  };
  const pushCompactionMarker = (ts: string | undefined, at: { byteStart: number; byteLen: number }) => {
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
      // Record the marker line's offsets so the index writer can persist a text-less block row for this
      // otherwise-blockless turn — pagination/byte-windows must account for the divider.
      byteStart: at.byteStart,
      byteLen: at.byteLen,
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
    if (line.kind === 'oversized') {
      session.stats.skippedLineTypes['oversized-line'] =
        (session.stats.skippedLineTypes['oversized-line'] ?? 0) + 1;
      // The skipped envelope could have changed roles, turn IDs, or carried either half of a
      // duplicate event_msg/response_item pair. Treat it as an unknown turn boundary so records
      // on opposite sides cannot merge or dedupe. It may also have started a new assistant call,
      // so usage after the gap must not overwrite the last visible pre-gap assistant turn.
      flush();
      lastAssistant = undefined;
      continue;
    }
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
        // Codex stores a forked rollout in its own file/UUID while retaining the root
        // thread in session_id. Keep the filename UUID as this session's identity so the
        // child transcript remains addressable, but link it to the root for the viewer's
        // existing subagent filtering and parent banner.
        // `forked_from_id` also appears on ordinary interactive `codex fork` rollouts. Only
        // Codex's explicit subagent provenance makes the relationship a sidechain.
        //
        // A fork rollout replays the ROOT thread's session_meta after its own, so this case
        // runs twice with two different identities. Only the record describing THIS file may
        // touch the fork fields — otherwise the inherited copy (`thread_source: 'user'`)
        // clears the link the child's own meta just established. A meta without `id` is
        // pre-fork-era Codex and still falls through to the clear below.
        const metaSessionId = codexSessionId(payload.id);
        if (metaSessionId && metaSessionId !== session.id.toLowerCase()) break;
        const threadSource = str(payload.thread_source);
        if (threadSource !== 'subagent') {
          // Absent provenance is not evidence of "no parent". Leaving parentSessionLink unset
          // means 'unknown' downstream, which COALESCEs the stored parent instead of clearing
          // it — so reparsing a linked rollout whose metadata predates thread_source keeps the
          // session grouped. Only an EXPLICIT non-subagent thread_source is a real unlink, which
          // is the interactive `codex fork` reindex case.
          if (threadSource !== undefined) {
            session.parentSessionId = undefined;
            session.parentSessionLink = 'none';
            session.isSidechain = false;
          }
          break;
        }
        const parentSessionId =
          codexSessionId(payload.forked_from_id) ??
          codexSessionId(payload.parent_thread_id) ??
          codexSessionId(payload.session_id);
        if (parentSessionId && parentSessionId !== session.id) {
          session.parentSessionId = parentSessionId;
          session.parentSessionLink = 'linked';
          session.isSidechain = true;
        } else {
          session.parentSessionId = undefined;
          session.parentSessionLink = 'none';
          session.isSidechain = false;
        }
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
        handleResponseItem(payload, ts, at, line.text);
        break;
      }
      case 'event_msg': {
        handleEventMsg(payload, ts, at);
        break;
      }
      case 'compacted':
      case 'world_state': {
        pushCompactionMarker(ts, at);
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

  function handleResponseItem(p: Record<string, unknown>, ts: string | undefined, at: { byteStart: number; byteLen: number }, rawText: string) {
    const meta = isObj(p.internal_chat_message_metadata_passthrough)
      ? p.internal_chat_message_metadata_passthrough
      : undefined;
    const turnId = str(meta?.turn_id);
    const itemId = str(p.id);
    const callId = str(p.call_id);
    const sourceItem = itemId
      ? `id:${itemId}`
      : callId
        ? `call:${callId}`
        : `at:${ts ?? 'unknown'}:payload:${messageKey(safeJson(p))}:offset:${at.byteStart}`;
    switch (p.type) {
      case 'message': {
        const role = (str(p.role) as Role) ?? 'assistant';
        const content = Array.isArray(p.content) ? p.content : [];
        const hasInputImages = content.some((item) => isObj(item) && item.type === 'input_image');
        const text = Array.isArray(p.content) ? codexMessageText(content, hasInputImages) : contentText(p.content);
        const imageRanges = hasInputImages ? codexImageRanges(rawText, at, content, mode) : undefined;
        const hasImages = (imageRanges?.size ?? 0) > 0;
        if (!text && !hasImages) break;
        // Opening the turn first clears pairing state at role/turn boundaries. An event_msg
        // copy can consume the text, but never the images, which exist only in response_item.
        const turn = openTurn(role === 'developer' ? 'developer' : role, ts, turnId, sourceItem);
        const indexText = text ? shouldIndexMessage('response_item', role, text) : false;
        if (hasImages) {
          // Response-first keeps its interleaved text/image order. Event-first keeps the event
          // text at its original byte anchor, then appends only the response item's images.
          // Adjacent response text items stay one capped block; media bytes remain in R2.
          let textItems: string[] = [];
          const flushText = () => {
            if (indexText && textItems.length > 0) {
              const c = cap(textItems.join('\n'), CAPS.text);
              turn.blocks.push({ type: 'text', text: c.text, truncated: c.truncated, ...at });
            }
            textItems = [];
          };
          for (let i = 0; i < content.length; i++) {
            const item = content[i];
            if (!isObj(item)) continue;
            const range = imageRanges?.get(i);
            if (range) {
              flushText();
              turn.blocks.push({ type: 'image', ...range, ...at });
            } else if (item.type !== 'input_image') {
              const part = str(item.text);
              const cleaned = part && hasInputImages && item.type === 'input_text' ? stripCodexImageWrappers(part) : part;
              if (cleaned) textItems.push(cleaned);
            }
          }
          flushText();
        } else if (indexText) {
          const c = cap(text, CAPS.text);
          turn.blocks.push({ type: 'text', text: c.text, truncated: c.truncated, ...at });
        }
        if (!firstUserText && role === 'user' && text) firstUserText = text.slice(0, 120);
        break;
      }
      case 'reasoning': {
        // Often only encrypted_content is present — index summary text when it exists.
        const text = contentText(p.summary) || contentText(p.content);
        if (!text) break;
        const turn = openTurn('assistant', ts, turnId, sourceItem);
        const c = cap(text, CAPS.thinking);
        turn.blocks.push({ type: 'thinking', text: c.text, truncated: c.truncated, ...at });
        break;
      }
      case 'function_call':
      case 'custom_tool_call': {
        const name = str(p.name) ?? 'tool';
        const args = str(p.arguments) ?? str(p.input) ?? '';
        const turn = openTurn('assistant', ts, turnId, sourceItem);
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
        const turn = openTurn('tool', ts, turnId, sourceItem);
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
        pushCompactionMarker(ts, at);
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

/** Image wrappers are Codex-generated input_text only when the same response message actually
 * contains an input_image. Keep literal quoted wrappers in text-only messages and event text. */
function stripCodexImageWrappers(text: string): string {
  if (/^<image name=\[Image #\d+\] path=(?:"[^"\r\n]*"|[^\s>\r\n]+)>$/.test(text) ||
      text === '</image>') return '';
  const cleaned = text.replace(
    /(^|\r?\n)<image name=\[Image #\d+\] path=(?:"[^"\r\n]*"|[^\s>\r\n]+)>\r?\n<\/image>(?=\r?\n|$)/g,
    '$1',
  );
  return cleaned === text ? text : cleaned.trim();
}

function codexMessageText(content: unknown[], hasInputImages: boolean): string {
  return content
    .filter(isObj)
    .map((part) => {
      const text = str(part.text);
      return text && hasInputImages && part.type === 'input_text' ? stripCodexImageWrappers(text) : text ?? '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Codex image_url data URIs are served by the blob endpoint only for browser-safe raster types. */
export function codexImageDataUri(imageUrl: unknown): { dataStart: number; mediaType: string } | undefined {
  if (typeof imageUrl !== 'string') return undefined;
  const prefix = /^data:(image\/(?:png|jpeg|gif|webp));base64,/i.exec(imageUrl);
  if (!prefix || imageUrl.length === prefix[0].length) return undefined;
  const start = prefix[0].length;
  if ((imageUrl.length - start) % 4 !== 0) return undefined;
  let padding = false;
  let paddingCount = 0;
  for (let i = start; i < imageUrl.length; i++) {
    const c = imageUrl.charCodeAt(i);
    if (c === 61) {
      padding = true;
      if (++paddingCount > 2) return undefined;
    } else if (padding || !(
      (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      (c >= 48 && c <= 57) || c === 43 || c === 47
    )) return undefined;
  }
  return { dataStart: start, mediaType: prefix[1]!.toLowerCase() };
}

/** Walk the JSON-validated source once, counting UTF-8 bytes only for indexing.
 * JSON.parse keeps the last duplicate key; mirror that rule at payload, content and image_url,
 * then match each last raw URL to the parsed (and base64-validated) value. In particular, a
 * previous same-length image_url must never be served in place of the parsed last value.
 * Rendering needs the same eligibility but resolves persisted media IDs, not byte ranges. */
function codexImageRanges(
  raw: string,
  at: { byteStart: number; byteLen: number },
  content: unknown[],
  mode: 'index' | 'render',
): Map<number, { mediaByteStart?: number; mediaByteLen?: number; mediaType: string }> {
  type Candidate = { charStart: number; byteStart: number; rawLen: number };
  const candidates = new Map<number, Candidate>();
  let i = 0;
  let byte = at.byteStart;
  const next = (): number => {
    const unit = raw.charCodeAt(i++);
    if (mode === 'render') return unit;
    if (unit < 0x80) byte++;
    else if (unit < 0x800) byte += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff &&
             raw.charCodeAt(i) >= 0xdc00 && raw.charCodeAt(i) <= 0xdfff) {
      i++;
      byte += 4;
    } else byte += 3;
    return unit;
  };
  const space = (): void => {
    while (raw[i] === ' ' || raw[i] === '\t' || raw[i] === '\r' || raw[i] === '\n') next();
  };
  const scanString = (): { start: number; end: number; escaped: boolean } => {
    const start = i;
    next(); // opening quote
    let escaped = false;
    while (i < raw.length) {
      const unit = next();
      if (unit === 34) break;
      if (unit === 92) {
        escaped = true;
        next(); // escaped character; JSON.parse already checked its syntax
      }
    }
    return { start, end: i, escaped };
  };
  const skipValue = (): void => {
    if (raw[i] === '"') {
      scanString();
    } else if (raw[i] === '{' || raw[i] === '[') {
      let depth = 0;
      do {
        if (raw[i] === '"') scanString();
        else {
          const unit = next();
          if (unit === 123 || unit === 91) depth++;
          else if (unit === 125 || unit === 93) depth--;
        }
      } while (depth > 0 && i < raw.length);
    } else {
      while (i < raw.length && raw[i] !== ',' && raw[i] !== '}' && raw[i] !== ']' &&
             raw[i] !== ' ' && raw[i] !== '\t' && raw[i] !== '\r' && raw[i] !== '\n') next();
    }
  };
  const scanObject = (visit: (key: string) => void): void => {
    next(); // opening brace
    space();
    while (raw[i] === '"') {
      const key = scanString();
      const name = key.escaped
        ? JSON.parse(raw.slice(key.start, key.end)) as string
        : raw.slice(key.start + 1, key.end - 1);
      space();
      next(); // colon
      space();
      visit(name); // must consume exactly this value
      space();
      if (raw[i] !== ',') break;
      next();
      space();
    }
    next(); // closing brace
  };
  const scanContent = (): void => {
    next(); // opening bracket
    space();
    let index = 0;
    while (raw[i] !== ']' && i < raw.length) {
      if (raw[i] === '{') {
        scanObject((key) => {
          if (key !== 'image_url') {
            skipValue();
            return;
          }
          // A duplicate key with a non-string last value invalidates the earlier candidate.
          candidates.delete(index);
          if (raw[i] !== '"') {
            skipValue();
            return;
          }
          const startByte = byte;
          const value = scanString();
          candidates.set(index, {
            charStart: value.start + 1,
            byteStart: startByte + 1,
            rawLen: value.end - value.start - 2,
          });
        });
      } else skipValue();
      index++;
      space();
      if (raw[i] !== ',') break;
      next();
      space();
    }
    next(); // closing bracket
  };
  space();
  if (raw[i] === '{') scanObject((key) => {
    if (key !== 'payload') {
      skipValue();
      return;
    }
    candidates.clear();
    if (raw[i] !== '{') {
      skipValue();
      return;
    }
    scanObject((field) => {
      if (field !== 'content') {
        skipValue();
        return;
      }
      candidates.clear();
      if (raw[i] === '[') scanContent();
      else skipValue();
    });
  });

  const ranges = new Map<number, { mediaByteStart?: number; mediaByteLen?: number; mediaType: string }>();
  for (const [index, candidate] of candidates) {
    const item = content[index];
    if (!isObj(item) || item.type !== 'input_image') continue;
    const parsed = codexImageDataUri(item.image_url);
    if (!parsed) continue;
    const url = item.image_url as string;
    // Any JSON escape increases raw character length. Equal lengths plus the exact prefix
    // guarantee the raw base64 span is the last parsed, validated ASCII URL.
    if (candidate.rawLen !== url.length ||
        raw.slice(candidate.charStart, candidate.charStart + parsed.dataStart) !== url.slice(0, parsed.dataStart)) continue;
    const len = candidate.rawLen - parsed.dataStart;
    if (len <= 0) continue;
    if (mode === 'render') {
      ranges.set(index, { mediaType: parsed.mediaType });
      continue;
    }
    const offset = candidate.byteStart + parsed.dataStart;
    if (offset >= at.byteStart && offset + len <= at.byteStart + at.byteLen) {
      ranges.set(index, { mediaByteStart: offset, mediaByteLen: len, mediaType: parsed.mediaType });
    }
  }
  return ranges;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function codexSessionId(v: unknown): string | undefined {
  const id = str(v);
  return id && CODEX_SESSION_ID_RE.test(id) ? id.toLowerCase() : undefined;
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
