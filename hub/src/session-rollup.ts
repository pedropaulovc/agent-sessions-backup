import { UNKNOWN_MODEL_LABEL } from './usage-agg';
import { indexDbFor } from './index-shards';

export interface SessionRollupOptions {
  /** Hard bounds on source blocks and pages, including unfinished giant sessions. */
  maxBlocks?: number;
  maxPages?: number;
  pageSize?: number;
  now?: Date;
  /** Correlates page failures with the scheduled or manual bounded pass. */
  run?: { run_id: string; trigger: 'scheduled' | 'manual' };
}

export interface SessionRollupResult {
  examined: number;
  pages: number;
  completed: number;
  superseded: number;
  failed: number;
  pending: number;
  remaining: 'pending' | 'complete';
}

interface Checkpoint {
  session_id: string;
  generation: string;
  cursor_turn: number;
  cursor_block: number;
  cursor_id: number;
  turn_state: string | null;
  last_attempt: number;
  finishing: number;
  commit_token: string | null;
}
interface SourceBlock {
  id: number;
  turn_index: number;
  block_index: number;
  role: string | null;
  btype: string;
  comparable_call: number;
  call_key_id: number | null;
  tool_name: string | null;
  text: string | null;
  on_main_path: number;
  byte_len: number | null;
  ts: string | null;
}
interface TurnState {
  index: number;
  day: string;
  model: string;
  assistant: 'unseen' | 'seen';
  rewind: 'unseen' | 'seen';
}
interface Bucket {
  day: string;
  model: string;
  assistant_turns: number;
  rewound_assistant_turns: number;
  tool_calls: number;
  tool_result_source_bytes: number;
  repeated_tool_calls: number;
  comparable_tool_calls: number;
}

const METRICS = [
  'assistant_turns', 'rewound_assistant_turns', 'tool_calls', 'tool_result_source_bytes',
  'repeated_tool_calls', 'comparable_tool_calls',
] as const;
const COLUMNS = `session_id, day, model, ${METRICS.join(', ')}`;
const ELIGIBLE = `eligible = 1 AND status != 'ready'
  AND EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = session_rollup_state.session_id
    AND s.index_state = 'ready')`;
const COMMIT_GUARD = `EXISTS (SELECT 1 FROM session_rollup_state st JOIN sessions s USING (session_id)
  WHERE st.session_id = ?1 AND st.commit_token = ?2 AND st.eligible = 1 AND s.index_state = 'ready')`;

const COMPARABLE_CALL = `b.role = 'assistant' AND b.btype = 'tool_use' AND b.truncated = 0
  AND b.tool_name IS NOT NULL AND b.text IS NOT NULL`;

/** Bounded durable pass. A page, its dedup keys, and its cursor commit in one D1 transaction.
 * The first block of each turn supplies its timestamp to ALL that turn's metrics; absent or
 * invalid timestamps belong to ''. Model evidence comes only from the unique usage turn row.
 * A turn crossing pages carries its flags, so neither assistant nor rewound turns double-count.
 * Exact complete stored tool arguments are a diagnostic proxy, never proof of wasted work.
 */
export async function runSessionRollup(
  env: Env,
  options: SessionRollupOptions = {},
): Promise<SessionRollupResult> {
  const db = env.DB;
  const maxBlocks = positiveInteger(options.maxBlocks ?? 20_000, 'maxBlocks');
  const maxPages = positiveInteger(options.maxPages ?? 80, 'maxPages');
  const pageSize = Math.min(500, positiveInteger(options.pageSize ?? 250, 'pageSize'));
  const result: SessionRollupResult = {
    examined: 0, pages: 0, completed: 0, superseded: 0, failed: 0, pending: 0, remaining: 'complete',
  };
  const failedSessions: string[] = [];
  while (result.pages < maxPages && result.examined < maxBlocks) {
    // Least recently attempted, not lowest session id: unfinished sessions rotate fairly.
    const checkpoint = await db.prepare(`SELECT session_id, generation, cursor_turn, cursor_block,
      cursor_id, turn_state, last_attempt, finishing, commit_token FROM session_rollup_state
      WHERE ${ELIGIBLE} AND session_id NOT IN (SELECT value FROM json_each(?1))
      ORDER BY last_attempt, session_id LIMIT 1`)
      .bind(JSON.stringify(failedSessions)).first<Checkpoint>();
    if (!checkpoint) break;
    result.pages++;
    try {
      await rollupPage(env, checkpoint, Math.min(pageSize, maxBlocks - result.examined),
        pageSize, options.now ?? new Date(), result);
    } catch (error) {
      // Do not advance a failed checkpoint or overwrite a concurrent winner. If D1 itself is
      // unavailable this bookkeeping also throws, propagating the invocation-level failure.
      const deferred = await db.prepare(`UPDATE session_rollup_state SET last_attempt = MAX(last_attempt, ?7)
        WHERE session_id = ?1 AND generation = ?2 AND cursor_turn = ?3 AND cursor_block = ?4
          AND cursor_id = ?5 AND commit_token IS ?6 AND ${ELIGIBLE}`)
        .bind(checkpoint.session_id, checkpoint.generation, checkpoint.cursor_turn, checkpoint.cursor_block,
          checkpoint.cursor_id, checkpoint.commit_token,
          Math.max((options.now ?? new Date()).getTime(), checkpoint.last_attempt + 1)).run();
      if ((deferred.meta.changes ?? 0) === 0) result.superseded++;
      result.failed++;
      failedSessions.push(checkpoint.session_id);
      console.error(JSON.stringify({ event: 'hub.session_rollup.page_failed', ...options.run, session_id: checkpoint.session_id,
        error: error instanceof Error ? error.message : String(error) }));
    }
  }
  result.pending = (await db.prepare(`SELECT COUNT(*) AS n FROM session_rollup_state
    WHERE ${ELIGIBLE}`).first<{ n: number }>())?.n ?? 0;
  result.remaining = result.pending > 0 ? 'pending' : 'complete';
  return result;
}

async function rollupPage(
  env: Env,
  checkpoint: Checkpoint,
  limit: number,
  pageSize: number,
  now: Date,
  result: SessionRollupResult,
): Promise<void> {
    const db = env.DB;
    // Window the exact tuple page on its shard. Carry full comparable identities only once per
    // page; repeated blocks refer to that representative rather than copying large tool arguments.
    const blocks: SourceBlock[] = checkpoint.finishing ? [] : (await indexDbFor(env, checkpoint.session_id)
      .prepare(`WITH page AS MATERIALIZED (
        SELECT b.id, b.turn_index, b.block_index, b.role, b.btype,
          b.tool_name, b.text, b.truncated, b.on_main_path, b.byte_len, b.ts
        FROM blocks b
        WHERE b.session_id = ?1 AND (b.turn_index, b.block_index, b.id) > (?2, ?3, ?4)
        ORDER BY b.turn_index, b.block_index, b.id LIMIT ?5
      ), comparable_calls AS (
        SELECT b.id, FIRST_VALUE(b.id) OVER (
          PARTITION BY b.tool_name, b.text ORDER BY b.turn_index, b.block_index, b.id
        ) AS call_key_id
        FROM page b WHERE ${COMPARABLE_CALL}
      )
      SELECT p.id, p.turn_index, p.block_index, p.role, p.btype, p.on_main_path, p.byte_len, p.ts,
        CASE WHEN c.id IS NULL THEN 0 ELSE 1 END AS comparable_call, c.call_key_id,
        CASE WHEN p.id = c.call_key_id THEN p.tool_name END AS tool_name,
        CASE WHEN p.id = c.call_key_id THEN p.text END AS text
      FROM page p LEFT JOIN comparable_calls c ON c.id = p.id
      ORDER BY p.turn_index, p.block_index, p.id`)
      .bind(checkpoint.session_id, checkpoint.cursor_turn, checkpoint.cursor_block,
        checkpoint.cursor_id, limit).all<SourceBlock>()).results;
    result.examined += blocks.length;

    const models = new Map<number, string | null>();
    if (blocks.length > 0) {
      const turns = [...new Set(blocks.map((block) => block.turn_index))];
      const usage = await db.prepare(`SELECT turn_index, model FROM usage
        WHERE session_id = ?1 AND turn_index IN (SELECT value FROM json_each(?2))`)
        .bind(checkpoint.session_id, JSON.stringify(turns)).all<{ turn_index: number; model: string | null }>();
      for (const row of usage.results) models.set(row.turn_index, row.model);
    }
    const calls = blocks.filter((block) => block.id === block.call_key_id);
    const seen = new Set<number>();
    // Separate bound values, not one JSON array: JSON escaping of a maximum page can exceed
    // D1's value limit even when every complete stored identity is individually valid.
    for (let start = 0; start < calls.length; start += 90) {
      const chunk = calls.slice(start, start + 90);
      const prior = await db.batch<{ seen: number }>(chunk.map((call) =>
        db.prepare(`SELECT EXISTS (SELECT 1 FROM session_rollup_seen_calls
          WHERE session_id = ?1 AND tool_name = ?2 AND text = ?3) AS seen`)
          .bind(checkpoint.session_id, call.tool_name, call.text)));
      for (let i = 0; i < chunk.length; i++) {
        if (prior[i]?.results[0]?.seen) seen.add(chunk[i]!.id);
      }
    }

    let turn: TurnState | null = checkpoint.turn_state ? JSON.parse(checkpoint.turn_state) : null;
    const buckets = new Map<string, Bucket>();
    for (const block of blocks) {
      if (!turn || turn.index !== block.turn_index) {
        turn = { index: block.turn_index, day: utcDay(block.ts), model: models.get(block.turn_index) ?? UNKNOWN_MODEL_LABEL,
          assistant: 'unseen', rewind: 'unseen' };
      }
      const key = JSON.stringify([turn.day, turn.model]);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { day: turn.day, model: turn.model, assistant_turns: 0, rewound_assistant_turns: 0,
          tool_calls: 0, tool_result_source_bytes: 0, repeated_tool_calls: 0, comparable_tool_calls: 0 };
        buckets.set(key, bucket);
      }
      if (block.role === 'assistant') {
        if (turn.assistant === 'unseen') { bucket.assistant_turns++; turn.assistant = 'seen'; }
        if (block.on_main_path === 0 && turn.rewind === 'unseen') {
          bucket.rewound_assistant_turns++;
          turn.rewind = 'seen';
        }
        if (block.btype === 'tool_use') bucket.tool_calls++;
      }
      if (block.btype === 'tool_result') {
        // Source-span proxy: multiple blocks can share one JSONL line's byte_len.
        bucket.tool_result_source_bytes += Math.max(0, block.byte_len ?? 0);
      }
      bucket.comparable_tool_calls += block.comparable_call;
      if (block.call_key_id !== null && (block.id !== block.call_key_id || seen.has(block.call_key_id))) {
        bucket.repeated_tool_calls++;
      }
    }

    const last = blocks.at(-1);
    // An exactly full page may have a successor; an empty next page safely finishes it.
    const complete = blocks.length < limit;
    const token = crypto.randomUUID();
    const statements = [db.prepare(`UPDATE session_rollup_state SET status = 'building',
        cursor_turn = ?6, cursor_block = ?7, cursor_id = ?8, turn_state = ?9,
        last_attempt = ?10, commit_token = ?11, finishing = ?13
      WHERE session_id = ?1 AND generation = ?2 AND cursor_turn = ?3 AND cursor_block = ?4
        AND cursor_id = ?5 AND commit_token IS ?12 AND ${ELIGIBLE}`)
      .bind(checkpoint.session_id, checkpoint.generation, checkpoint.cursor_turn, checkpoint.cursor_block,
        checkpoint.cursor_id, last?.turn_index ?? checkpoint.cursor_turn,
        last?.block_index ?? checkpoint.cursor_block, last?.id ?? checkpoint.cursor_id,
        turn ? JSON.stringify(turn) : null, Math.max(now.getTime(), checkpoint.last_attempt + 1), token,
        checkpoint.commit_token, complete ? 1 : 0),
    // Accumulate invisibly while status=building. The final ready flip publishes all buckets at
    // once without an unbounded INSERT SELECT for sessions spanning arbitrarily many days/models.
    db.prepare(`INSERT INTO session_rollup (${COLUMNS})
      SELECT ?1, json_extract(j.value, '$.day'), json_extract(j.value, '$.model'),
        ${METRICS.map((m) => `json_extract(j.value, '$.${m}')`).join(', ')}
      FROM json_each(?3) j WHERE ${COMMIT_GUARD}
      ON CONFLICT (session_id, day, model) DO UPDATE SET
        ${METRICS.map((m) => `${m} = session_rollup.${m} + excluded.${m}`).join(', ')}`)
      .bind(checkpoint.session_id, token, JSON.stringify([...buckets.values()])),
    ...calls.map((call) => db.prepare(`INSERT OR IGNORE INTO session_rollup_seen_calls (session_id, tool_name, text)
      SELECT ?1, ?3, ?4 WHERE ${COMMIT_GUARD}`)
      .bind(checkpoint.session_id, token, call.tool_name, call.text))];
    if (complete) {
      statements.push(
        // Cleanup is checkpointed too: a giant unique-call history must not become one huge DELETE.
        db.prepare(`DELETE FROM session_rollup_seen_calls WHERE rowid IN (
          SELECT rowid FROM session_rollup_seen_calls WHERE session_id = ?1 LIMIT ?3
        ) AND ${COMMIT_GUARD}`).bind(checkpoint.session_id, token, pageSize),
        db.prepare(`UPDATE session_rollup_state SET status = 'ready', completed_at = ?3,
          turn_state = NULL, commit_token = NULL WHERE session_id = ?1 AND ${COMMIT_GUARD}
          AND NOT EXISTS (SELECT 1 FROM session_rollup_seen_calls WHERE session_id = ?1)`)
          .bind(checkpoint.session_id, token, now.toISOString()),
      );
    }
    const committed = await db.batch(statements);
    if ((committed[0]?.meta.changes ?? 0) === 0) result.superseded++;
    else if (complete && (committed.at(-1)?.meta.changes ?? 0) > 0) result.completed++;
}


function utcDay(timestamp: string | null): string {
  if (!timestamp) return '';
  const date = /^\d{4}-\d{2}-\d{2}(?=$|T)/.exec(timestamp)?.[0];
  if (!date) return '';
  const midnight = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date) return '';
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return '';
  const iso = new Date(time).toISOString();
  return /^\d{4}-/.test(iso) ? iso.slice(0, 10) : '';
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}
