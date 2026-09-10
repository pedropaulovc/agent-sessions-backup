import type { StatsQuery, Window } from './stats';

/** Block diagnostics cover complete UTC days, not the rolling usage window. */
export interface RollupRange {
  from: string | null;
  /** Exclusive UTC day boundary; the current incomplete day is never included. */
  to: string;
  timestampScope: 'dated' | 'including-undated';
}

export interface RollupDiagnostics {
  assistantTurns: number;
  rewoundAssistantTurns: number;
  toolCalls: number;
  toolResultSourceBytes: number;
  repeatedToolCalls: number;
  comparableToolCalls: number;
  toolCallsPerTurn: number | null;
  rewindRate: number | null;
  repeatedToolCallRate: number | null;
}

export interface RollupCoverage {
  /** Metadata-present sessions in the filtered usage window, plus matching rollup sessions.
   * This is a known matching baseline, not a census of unbuilt block-only sessions. */
  eligibleSessions: number;
  /** Eligible sessions whose current ingestion generation is fully published. */
  readySessions: number;
  /** Sessions with at least one ready bucket in the displayed day/model scope. */
  coveredSessions: number;
  oldestCompletedAt: string | null;
  newestCompletedAt: string | null;
}

export interface SubagentSpend {
  /** Known subtotal only: calls and pricedCalls determine whether the cost is complete. */
  usd: number;
  calls: number;
  pricedCalls: number;
  sessions: number;
  parents: number;
}

export interface WasteStats {
  range: RollupRange;
  coverage: RollupCoverage;
  /** No matching published buckets means unavailable, not measured zero. */
  diagnostics: RollupDiagnostics | null;
  /** Direct linked-child usage, counted once in the usage window, independently of rollups. */
  subagentSpend: SubagentSpend;
}

interface RollupRow {
  session_id: string;
  model: string;
  assistant_turns: number;
  rewound_assistant_turns: number;
  tool_calls: number;
  tool_result_source_bytes: number;
  repeated_tool_calls: number;
  comparable_tool_calls: number;
}

export function completeDayRange(window: Window, now: Date): RollupRange {
  const to = (window.to ?? now.toISOString()).slice(0, 10);
  if (window.from === null) return { from: null, to, timestampScope: 'including-undated' };
  const start = new Date(window.from);
  const midnight = new Date(start);
  midnight.setUTCHours(0, 0, 0, 0);
  if (start.getTime() > midnight.getTime()) midnight.setUTCDate(midnight.getUTCDate() + 1);
  return { from: midnight.toISOString().slice(0, 10), to, timestampScope: 'dated' };
}

/** Reads only the published day index and session metadata. Never scans transcript blocks or
 * usage: the existing filtered main usage scan supplies the coverage baseline. */
export async function collectRollupStats(
  db: D1Database,
  q: StatsQuery,
  window: Window,
  now: Date,
  usageSessionIds: ReadonlySet<string>,
): Promise<{
  range: RollupRange;
  coverage: RollupCoverage;
  diagnostics: RollupDiagnostics | null;
  modelToolCallsPerTurn: Map<string, number | null>;
}> {
  const range = completeDayRange(window, now);
  const sessionTerms = ["COALESCE(s.harness, '') != 'prompt-log'"];
  const sessionBinds: unknown[] = [];
  for (const [column, value] of [
    ['s.harness', q.harness],
    ['s.project_name', q.project],
    ['s.machine_id', q.machine],
  ] as const) {
    if (!value) continue;
    sessionBinds.push(value);
    sessionTerms.push(`${column} = ?${sessionBinds.length}`);
  }
  const terms = [...sessionTerms, "s.index_state = 'ready'", "st.status = 'ready'"];
  const binds = [...sessionBinds];
  if (range.from !== null) {
    binds.push(range.from);
    terms.push(`r.day >= ?${binds.length}`);
  }
  binds.push(range.to);
  terms.push(`r.day < ?${binds.length}`);
  if (q.model) {
    binds.push(q.model);
    terms.push(`r.model = ?${binds.length}`);
  }
  // D1 batches run in one transaction: a publication/invalidation cannot split the bucket
  // snapshot from readiness and completion timestamps.
  const [buckets, states] = await db.batch([
    db.prepare(`SELECT r.session_id, r.model,
                       SUM(r.assistant_turns) AS assistant_turns,
                       SUM(r.rewound_assistant_turns) AS rewound_assistant_turns,
                       SUM(r.tool_calls) AS tool_calls,
                       SUM(r.tool_result_source_bytes) AS tool_result_source_bytes,
                       SUM(r.repeated_tool_calls) AS repeated_tool_calls,
                       SUM(r.comparable_tool_calls) AS comparable_tool_calls
                FROM session_rollup r INDEXED BY session_rollup_day
                JOIN sessions s ON s.session_id = r.session_id
                JOIN session_rollup_state st ON st.session_id = r.session_id
                WHERE ${terms.join(' AND ')}
                GROUP BY r.session_id, r.model`)
      .bind(...binds),
    db.prepare(`SELECT s.session_id, st.completed_at
                FROM sessions s JOIN session_rollup_state st ON st.session_id = s.session_id
                WHERE ${sessionTerms.join(' AND ')}
                  AND s.index_state = 'ready' AND st.status = 'ready'`)
      .bind(...sessionBinds),
  ]) as [D1Result<RollupRow>, D1Result<{ session_id: string; completed_at: string | null }>];

  const eligible = new Set(usageSessionIds);
  const covered = new Set<string>();
  const models = new Map<string, { turns: number; tools: number }>();
  let assistantTurns = 0;
  let rewoundAssistantTurns = 0;
  let toolCalls = 0;
  let toolResultSourceBytes = 0;
  let repeatedToolCalls = 0;
  let comparableToolCalls = 0;
  for (const row of buckets.results ?? []) {
    eligible.add(row.session_id);
    covered.add(row.session_id);
    assistantTurns += row.assistant_turns;
    rewoundAssistantTurns += row.rewound_assistant_turns;
    toolCalls += row.tool_calls;
    toolResultSourceBytes += row.tool_result_source_bytes;
    repeatedToolCalls += row.repeated_tool_calls;
    comparableToolCalls += row.comparable_tool_calls;
    const model = models.get(row.model) ?? { turns: 0, tools: 0 };
    model.turns += row.assistant_turns;
    model.tools += row.tool_calls;
    models.set(row.model, model);
  }
  let readySessions = 0;
  let oldestCompletedAt: string | null = null;
  let newestCompletedAt: string | null = null;
  for (const state of states.results ?? []) {
    if (!eligible.has(state.session_id)) continue;
    readySessions++;
    if (!covered.has(state.session_id) || state.completed_at === null) continue;
    if (oldestCompletedAt === null || state.completed_at < oldestCompletedAt) oldestCompletedAt = state.completed_at;
    if (newestCompletedAt === null || state.completed_at > newestCompletedAt) newestCompletedAt = state.completed_at;
  }
  return {
    range,
    coverage: {
      eligibleSessions: eligible.size,
      readySessions,
      coveredSessions: covered.size,
      oldestCompletedAt,
      newestCompletedAt,
    },
    diagnostics: covered.size === 0 ? null : {
      assistantTurns,
      rewoundAssistantTurns,
      toolCalls,
      toolResultSourceBytes,
      repeatedToolCalls,
      comparableToolCalls,
      toolCallsPerTurn: assistantTurns > 0 ? toolCalls / assistantTurns : null,
      rewindRate: assistantTurns > 0 ? rewoundAssistantTurns / assistantTurns : null,
      repeatedToolCallRate: comparableToolCalls > 0 ? repeatedToolCalls / comparableToolCalls : null,
    },
    modelToolCallsPerTurn: new Map([...models].map(([model, counts]) => [
      model, counts.turns > 0 ? counts.tools / counts.turns : null,
    ])),
  };
}
