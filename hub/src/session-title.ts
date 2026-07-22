/** First human/agent interaction title, derived from a session's blocks.
 *
 * This runs once at index time (the ingest writer stores the result in
 * sessions.first_interaction_title) instead of at query time. It used to be a giant generated
 * SQL expression inlined into every listing query, which pushed the statement past D1's length
 * limit; computing it in TypeScript removes that ceiling and keeps the read path a plain column
 * read. Existing rows are backfilled by re-parsing from R2 (POST /api/v1/admin/reindex), the same
 * convention on_main_path uses (see migrations/0002). */

// A turn is ineligible to title a session when its first eligible text block starts with one of
// these harness-injected wrappers (system/developer instructions, hook metadata, slash-command
// scaffolding). The turn is skipped entirely and a later turn is used.
const INJECTED_TURN_PREFIXES = [
  '# AGENTS.md instructions',
  '<local-command-',
  '<recommended_plugins>',
  '<command-name>',
  '<local-command-stdout>',
  '<codex_internal_context',
  '<system-reminder',
  '<environment_context',
  '<hook_prompt',
] as const;

// Claude Code preserves unsupported server tool metadata as a text block containing raw JSON.
// Such a block never represents a turn (a later real block in the same turn still can); ordinary
// user prompts that merely happen to be JSON stay eligible because the match is prefix-exact.
const NON_CONVERSATION_BLOCK_PREFIXES = [
  '{"type":"server_tool_use"',
] as const;

// Leading wrappers the harness injects ahead of the real prompt: an <image ...>...</image>
// attachment block, or the <fork-boilerplate>...</fork-boilerplate> context a forked session
// carries in. Each is stripped in place so the human prompt that follows becomes the title.
const LEADING_WRAPPERS = [
  { open: '<image name=[Image #', close: '</image>' },
  { open: '<fork-boilerplate>', close: '</fork-boilerplate>' },
] as const;

const TITLE_LIMIT = 120;
const LEADING_WHITESPACE = /^[\t\n\r ]+/;
const SURROUNDING_WHITESPACE = /^[\t\n\r ]+|[\t\n\r ]+$/g;

/** Minimal block shape the title derivation needs — satisfied by both normalized ingest turns and
 * rows read back from the blocks table during a backfill. */
export interface TitleBlock {
  turnIndex: number;
  blockIndex: number;
  role: string;
  btype: string;
  text: string | null;
  onMainPath: boolean;
}

/** Pick the first human/agent text exchange as the session title, or null when none qualifies.
 * A turn is represented by its first non-empty, non-server-tool text block; that representative is
 * skipped (dropping the whole turn) when it starts with an injected wrapper. Special harness
 * wrappers (teammate, scheduled-task, task/command messages) resolve to their embedded subject. */
export function computeFirstInteractionTitle(blocks: TitleBlock[]): string | null {
  const eligible = blocks
    .filter((b) =>
      (b.role === 'user' || b.role === 'assistant') &&
      (b.btype === 'text' || b.btype === 'prompt') &&
      b.onMainPath && b.text !== null)
    .sort((a, b) => a.turnIndex - b.turnIndex || a.blockIndex - b.blockIndex);

  let currentTurn: number | null = null;
  let representativeTaken = false;
  for (const block of eligible) {
    if (block.turnIndex !== currentTurn) {
      currentTurn = block.turnIndex;
      representativeTaken = false;
    }
    if (representativeTaken) continue;

    const stripped = stripLeadingWrappers(block.text!);
    // Empty-after-strip and server-tool metadata blocks don't represent the turn — keep scanning
    // this turn for its first real text block.
    if (stripped === '' || startsWithAny(stripped, NON_CONVERSATION_BLOCK_PREFIXES)) continue;

    representativeTaken = true;
    // This block represents the turn. An injected wrapper here drops the whole turn.
    if (startsWithAny(stripped, INJECTED_TURN_PREFIXES)) continue;
    return deriveTitle(stripped);
  }
  return null;
}

/** Resolve the display title: the derived first-interaction title, else the harness-stored title,
 * else the session id. */
export function sessionDisplayTitle(
  firstInteractionTitle: string | null,
  storedTitle: string | null,
  sessionId: string,
): string {
  return firstInteractionTitle || storedTitle || sessionId;
}

function deriveTitle(text: string): string {
  return (
    teammateSummaryTitle(text) ??
    teammateAssignmentTitle(text) ??
    attributeTitle(text, '<scheduled-task name="') ??
    nestedElementTitle(text, '<task-notification>', '<summary>', '</summary>') ??
    nestedElementTitle(text, '<command-message>', '<command-message>', '</command-message>') ??
    nestedElementTitle(text, '<task>', '<task>', '</task>') ??
    text.trim().slice(0, TITLE_LIMIT)
  );
}

/** Strip every leading injected wrapper (image, fork-boilerplate), re-trimming between strips so
 * interleaved wrappers and the whitespace separating them all come off. */
function stripLeadingWrappers(text: string): string {
  let remaining = text.replace(LEADING_WHITESPACE, '');
  for (;;) {
    const wrapper = LEADING_WRAPPERS.find(({ open, close }) =>
      remaining.startsWith(open) && remaining.includes(close));
    if (!wrapper) return remaining;
    const end = remaining.indexOf(wrapper.close) + wrapper.close.length;
    remaining = remaining.slice(end).replace(LEADING_WHITESPACE, '');
  }
}

/** <scheduled-task name="..."> — the quoted attribute value right after the prefix. */
function attributeTitle(text: string, prefix: string): string | null {
  if (!text.startsWith(prefix)) return null;
  const rest = text.slice(prefix.length);
  const end = rest.indexOf('"');
  if (end < 0) return null;
  return decodedTitle(rest.slice(0, end));
}

/** <wrapper ...><open>subject<close> — the subject between the first open/close pair. */
function nestedElementTitle(text: string, wrapperPrefix: string, openTag: string, closeTag: string): string | null {
  if (!text.startsWith(wrapperPrefix)) return null;
  const openStart = text.indexOf(openTag);
  if (openStart < 0) return null;
  const rest = text.slice(openStart + openTag.length);
  const end = rest.indexOf(closeTag);
  if (end < 0) return null;
  return decodedTitle(rest.slice(0, end).replace(SURROUNDING_WHITESPACE, ''));
}

/** <teammate-message ... summary="..."> — the summary attribute inside the opening tag. */
function teammateSummaryTitle(text: string): string | null {
  if (!startsElement(text, '<teammate-message')) return null;
  const tagEnd = text.indexOf('>');
  if (tagEnd < 0) return null;
  const openingTag = text.slice(0, tagEnd + 1);
  const marker = 'summary="';
  const start = openingTag.indexOf(marker);
  if (start < 1 || !' \t\n\r'.includes(openingTag[start - 1]!)) return null;
  const rest = openingTag.slice(start + marker.length);
  const end = rest.indexOf('"');
  if (end < 0) return null;
  return decodedTitle(rest.slice(0, end));
}

/** <teammate-message>{JSON task_assignment}</teammate-message> — the assignment's subject field. */
function teammateAssignmentTitle(text: string): string | null {
  if (!startsElement(text, '<teammate-message')) return null;
  const tagEnd = text.indexOf('>');
  const closeStart = text.indexOf('</teammate-message>');
  if (tagEnd < 0 || closeStart <= tagEnd) return null;
  const body = text.slice(tagEnd + 1, closeStart).replace(SURROUNDING_WHITESPACE, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as { type?: unknown; subject?: unknown };
  if (record.type !== 'task_assignment' || typeof record.subject !== 'string') return null;
  return record.subject.replace(SURROUNDING_WHITESPACE, '').slice(0, TITLE_LIMIT);
}

/** True when `text` opens an element with `prefix` (the tag name is followed by a boundary char,
 * so `<task>` does not match `<taskboard>`). */
function startsElement(text: string, prefix: string): boolean {
  if (!text.startsWith(prefix)) return false;
  const next = text[prefix.length];
  return next === undefined || ' >\t\n\r'.includes(next);
}

function startsWithAny(text: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => text.startsWith(prefix));
}

function decodedTitle(raw: string): string {
  return decodeXmlEntities(raw).replace(SURROUNDING_WHITESPACE, '').slice(0, TITLE_LIMIT);
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#(?:x[\da-f]+|\d+)|amp|apos|gt|lt|quot);/gi, (encoded, entity: string) => {
    const named: Record<string, string> = { amp: '&', apos: "'", gt: '>', lt: '<', quot: '"' };
    const replacement = named[entity.toLowerCase()];
    if (replacement !== undefined) return replacement;

    const hex = entity[1]?.toLowerCase() === 'x';
    const codePoint = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isSafeInteger(codePoint) || codePoint > 0x10ffff) return encoded;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return encoded;
    return String.fromCodePoint(codePoint);
  });
}
