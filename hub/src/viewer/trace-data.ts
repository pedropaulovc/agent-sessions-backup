import type { NormalizedBlock, NormalizedTurn } from '../ingest/normalize';

export interface TraceEvent {
  id: string;
  kind: 'user' | 'model' | 'tool' | 'compaction';
  label: string;
  startMs?: number;
  endMs?: number;
  timing: 'recorded' | 'timestamp';
  turnIndex?: number;
  isError?: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

export interface TraceData {
  events: TraceEvent[];
}

type TraceTurn = { turn: NormalizedTurn; turnIndex?: number; onMainPath: boolean };
type ToolEvent = { event: TraceEvent; block: NormalizedBlock; owner: TraceTurn };

/** Project only the supplied page, preserving source order rather than sorting unreliable clocks. */
export function buildSessionTrace(turns: ReadonlyArray<TraceTurn>, view: 'chronological' | 'effective'): TraceData {
  const events: TraceEvent[] = [];
  const calls = new Map<string, ToolEvent | null>();
  const results: ToolEvent[] = [];
  for (let position = 0; position < turns.length; position++) {
    const owner = turns[position]!;
    if (view === 'effective' && !owner.onMainPath) continue;
    const { turn, turnIndex } = owner;
    const point = timestamp(turn.ts);
    const id = `trace-${position}`;
    const hasContent = turn.blocks.some((block) => block.type !== 'tool_result');
    if (turn.compaction) {
      events.push({ id, kind: 'compaction', label: 'Compaction', ...eventTiming(undefined, point), turnIndex });
    } else if (turn.role === 'user' && hasContent) {
      const text = turn.blocks.find((block) => block.type === 'text' && block.text)?.text;
      events.push({ id, kind: 'user', label: label(text, 'User message'), ...eventTiming(undefined, point), turnIndex });
    } else if (turn.role === 'assistant' && (hasContent || turn.usage || turn.isError)) {
      events.push({
        id, kind: 'model', label: label(turn.model, 'Model'), ...eventTiming(turn.timing, point), turnIndex,
        isError: turn.isError || undefined,
        inputTokens: nonnegative(turn.usage?.inputTokens),
        outputTokens: nonnegative(turn.usage?.outputTokens),
      });
    }
    // A tool result can contain several text/image blocks; it is still one completion.
    const turnResults = new Map<string, ToolEvent>();
    for (let blockIndex = 0; blockIndex < turn.blocks.length; blockIndex++) {
      const block = turn.blocks[blockIndex]!;
      if (block.type !== 'tool_use' && block.type !== 'tool_result') continue;
      const key = toolKey(block, owner.onMainPath ? 'main' : 'branch');
      if (block.type === 'tool_result') {
        const resultKey = key ?? block.toolUseId;
        const previous = resultKey ? turnResults.get(resultKey) : undefined;
        if (previous) {
          previous.event.isError = previous.event.isError || block.isError || undefined;
          continue;
        }
        const event: TraceEvent = {
          id: `${id}-tool-${blockIndex}`, kind: 'tool', label: label(block.toolName, 'Tool result'),
          ...eventTiming(block.timing, point), turnIndex, isError: block.isError || undefined,
        };
        const result = { event, block, owner };
        events.push(event);
        results.push(result);
        if (resultKey) turnResults.set(resultKey, result);
      } else {
        const event: TraceEvent = {
          id: `${id}-tool-${blockIndex}`, kind: 'tool', label: label(block.toolName, 'Tool'),
          ...eventTiming(block.timing, point), turnIndex,
        };
        const call = { event, block, owner };
        events.push(event);
        if (key) calls.set(key, calls.has(key) ? null : call);
      }
    }
  }
  const consumed = new Set<TraceEvent>();
  const completed = new Set<TraceEvent>();
  for (const result of results) {
    const key = toolKey(result.block, result.owner.onMainPath ? 'main' : 'branch');
    const call = key ? calls.get(key) : undefined;
    if (!call || completed.has(call.event)) continue;
    const timing = eventTiming(result.block.timing, timestamp(result.owner.turn.ts));
    call.event.startMs = timing.startMs;
    call.event.endMs = timing.endMs;
    call.event.timing = timing.timing;
    call.event.isError = result.event.isError;
    completed.add(call.event);
    consumed.add(result.event);
  }
  return { events: events.filter((event) => !consumed.has(event)) };
}

/** Explicit ancestry keys are branch-safe; raw IDs may pair only on the main path. */
export function toolKey(block: NormalizedBlock, path: 'main' | 'branch'): string | undefined {
  if (block.toolCallKey === null) return undefined;
  if (block.toolCallKey !== undefined) return `entry:${block.toolCallKey}`;
  return path === 'main' && block.toolUseId ? `id:${block.toolUseId}` : undefined;
}

function label(value: string | undefined, fallback: string): string {
  return value?.slice(0, 120).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim() || fallback;
}

function timestamp(value: string | undefined): number | undefined {
  return value === undefined ? undefined : finite(Date.parse(value));
}

function finite(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function nonnegative(value: number | undefined): number | undefined {
  const number = finite(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

function eventTiming(
  recorded: NormalizedTurn['timing'],
  point: number | undefined,
): Pick<TraceEvent, 'startMs' | 'endMs' | 'timing'> {
  let startMs = finite(recorded?.startMs);
  let endMs = finite(recorded?.endMs);
  const durationMs = nonnegative(recorded?.durationMs);
  // An explicit reversed pair is corrupt, not an invitation to reconstruct a nicer duration.
  if (startMs !== undefined && endMs !== undefined && endMs < startMs) {
    return { startMs: point, timing: 'timestamp' };
  }
  if (durationMs !== undefined) {
    if (startMs !== undefined && endMs === undefined) endMs = finite(startMs + durationMs);
    else if (startMs === undefined) {
      // OMP's envelope is written on completion. Only a recorded duration permits back-calculation.
      endMs ??= point;
      if (endMs !== undefined) startMs = finite(endMs - durationMs);
    }
  }
  if (startMs !== undefined && endMs !== undefined && endMs >= startMs && Number.isFinite(endMs - startMs)) {
    return { startMs, endMs, timing: 'recorded' };
  }
  return { startMs: startMs ?? endMs ?? point, timing: 'timestamp' };
}
