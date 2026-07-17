import type { JsonlLine } from '../jsonl';
import { CAPS, cap, type NormalizedSession, type NormalizedTurn } from '../normalize';

/**
 * Claude Code / Codex `history.jsonl` prompt-log parser.
 *
 * The file is a global, append-only log of the prompts the human typed (one JSON object per
 * line), not a conversation transcript — there are no assistant turns, no tree. Each line
 * becomes a single `prompt` block on a user turn, in file order (its own byte offsets, exactly
 * like the other JSONL parsers). Field names drift across CLI versions (`display`, `prompt`,
 * `text`; `project`, `cwd`; `timestamp` as epoch-ms or ISO), so every field is read
 * defensively and unknown/blank lines are skip-and-counted, never fatal.
 */
export async function parsePromptLog(
  lines: AsyncIterable<JsonlLine>,
  sessionId: string,
): Promise<NormalizedSession> {
  const session: NormalizedSession = {
    id: sessionId,
    harness: 'prompt-log',
    models: [],
    isSidechain: false,
    turns: [],
    stats: { lines: 0, parseErrorLines: 0, skippedLineTypes: {} },
  };
  let firstText: string | undefined;

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
    const text = str(o.display) ?? str(o.prompt) ?? str(o.text) ?? str(o.command);
    if (!text) {
      // A well-formed line that simply carries no prompt text (an unknown log shape). Count it so
      // an operator can see the log format drifted, but don't error the whole file over it.
      session.stats.skippedLineTypes['no-prompt-text'] =
        (session.stats.skippedLineTypes['no-prompt-text'] ?? 0) + 1;
      continue;
    }

    session.cwd ??= str(o.project) ?? str(o.cwd);
    const ts = normalizeTs(o.timestamp) ?? normalizeTs(o.time) ?? normalizeTs(o.created_at);
    if (ts) {
      if (!session.startedAt || ts < session.startedAt) session.startedAt = ts;
      if (!session.endedAt || ts > session.endedAt) session.endedAt = ts;
    }
    if (!firstText) firstText = text.slice(0, 120);

    const c = cap(text, CAPS.prompt);
    const turn: NormalizedTurn = {
      index: session.turns.length,
      onMainPath: true,
      role: 'user',
      ts,
      blocks: [{ type: 'prompt', text: c.text, truncated: c.truncated, byteStart: line.byteStart, byteLen: line.byteLen }],
    };
    session.turns.push(turn);
  }

  session.title = firstText;
  return session;
}

/** Accept an epoch-ms number (or numeric string) or an already-ISO string; return ISO or undefined. */
function normalizeTs(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return isoOrUndefined(v);
  if (typeof v === 'string' && v.length > 0) {
    if (/^\d+$/.test(v)) return isoOrUndefined(Number(v));
    return v;
  }
  return undefined;
}

/** ISO string for an epoch-ms value, or undefined if it's out of the representable Date range. */
function isoOrUndefined(ms: number): string | undefined {
  const d = new Date(ms);
  // An epoch beyond ±8.64e15 ms (e.g. a bogus 1e20) yields an Invalid Date, and calling
  // toISOString() on it throws RangeError — which would abort parsing the WHOLE file. Treat it as
  // simply having no usable timestamp: the row still indexes (via its prompt text), just without
  // contributing to started/ended bounds.
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
