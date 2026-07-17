import { detect } from './detect';
import { readJsonlLines } from './jsonl';
import type { NormalizedSession } from './normalize';
import { parseClaudeCode } from './parsers/claude-code';
import { parseCodex } from './parsers/codex';

interface FileRow {
  id: number;
  machine_id: string;
  store: string;
  relpath: string;
  r2_key: string;
  size: number;
  mtime: string | null;
  harness: string | null;
  session_id: string | null;
}

export async function consumeParseBatch(batch: MessageBatch<ParseMessage>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await parseOne(msg.body, env);
      msg.ack();
    } catch (e) {
      console.log(JSON.stringify({ event: 'parse.error', file_id: msg.body.file_id, error: String(e) }));
      await env.DB.prepare("UPDATE files SET parse_state = 'error', parse_error = ?2 WHERE id = ?1")
        .bind(msg.body.file_id, String(e).slice(0, 2000))
        .run();
      // Otherwise a failed reparse leaves index_state='parsing' forever and /api/v1/status never
      // surfaces the error. No-op when the file has no session_id (nothing was ever indexed), and
      // — guarded — when a DIFFERENT file is already the session's canonical: that means some
      // other valid copy already indexed successfully and remains the source of truth, so this
      // failure (of a copy that was never canonical, or has since been superseded) must not
      // clobber a perfectly good session back to 'error'.
      await env.DB.prepare(
        `UPDATE sessions SET index_state = 'error'
         WHERE session_id = (SELECT session_id FROM files WHERE id = ?1 AND session_id IS NOT NULL)
           AND (canonical_file_id IS NULL OR canonical_file_id = ?1)`,
      )
        .bind(msg.body.file_id)
        .run();
      msg.retry();
    }
  }
}

async function parseOne(job: ParseMessage, env: Env): Promise<void> {
  const file = await env.DB.prepare(
    'SELECT id, machine_id, store, relpath, r2_key, size, mtime, harness, session_id FROM files WHERE id = ?1',
  )
    .bind(job.file_id)
    .first<FileRow>();
  if (!file) return;

  const det = detect(file.store, file.relpath);

  if (det.kind === 'subagent-meta') {
    await linkSubagentMeta(file, env);
    await markParsed(file.id, env, 'parsed');
    return;
  }
  if (!det.sessionId || (det.harness !== 'claude-code' && det.harness !== 'codex')) {
    await markParsed(file.id, env, 'skipped');
    return;
  }

  const canonical = await chooseCanonical(det.sessionId, env);
  // Only supersede this file in favor of an ALREADY-PARSED canonical. If the preferred copy is
  // still pending (or errored), superseding this valid duplicate now — before the preferred copy
  // has actually proven it can parse — would ack this message and, if the preferred copy then
  // fails permanently, leave the session unindexed with no valid copy left to recover it from.
  // Parse this file anyway; if a higher-priority copy parses successfully later, it supersedes
  // this one at that point (see the supersede-losers step below).
  if (canonical !== null && canonical.id !== file.id && canonical.parseState === 'parsed') {
    await env.DB.prepare("UPDATE files SET parse_state = 'superseded' WHERE id = ?1").bind(file.id).run();
    return;
  }

  const obj = await env.RAW.get(file.r2_key);
  if (!obj) throw new Error(`r2_object_missing:${file.r2_key}`);

  const lines = readJsonlLines(obj.body);
  const parsed =
    det.harness === 'claude-code' ? await parseClaudeCode(lines, det.sessionId) : await parseCodex(lines, det.sessionId);
  if (det.parentSessionId) parsed.parentSessionId = det.parentSessionId;

  if (parsed.turns.length === 0) {
    // Every line was malformed or an unsupported envelope shape — nothing indexable came out of
    // this parse. Marking it 'parsed' anyway would let it win canonical selection (by priority)
    // over a lower-priority duplicate that DID produce a real session, permanently losing that
    // session's content with no automatic recovery path. Neither 'error' nor 'skipped' is
    // canonical-eligible (chooseCanonical deprioritizes both below), so a valid duplicate — if
    // one exists — remains free to become or stay canonical.
    const state = parsed.stats.parseErrorLines > 0 ? 'error' : 'skipped';
    await env.DB.prepare(
      `UPDATE files SET parse_state = ?2, parsed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), parsed_size = ?3, parse_error = ?4
       WHERE id = ?1`,
    )
      .bind(file.id, state, file.size, state === 'error' ? `empty_parse:${parsed.stats.parseErrorLines}/${parsed.stats.lines} lines malformed` : null)
      .run();
    return;
  }

  // The sibling .meta.json may have already been parsed (and found no sessions row yet,
  // see linkSubagentMeta below) — read it directly so meta-before-transcript ordering
  // doesn't lose the link. Transcript-before-meta is covered by linkSubagentMeta below.
  if (det.kind === 'subagent') {
    const meta = await readSiblingMeta(file.r2_key, env);
    if (meta?.toolUseId) parsed.parentToolUseId = meta.toolUseId;
  }

  // With the queue's max_concurrency > 1, another copy of this same session can run through
  // parseOne concurrently and finish (winning canonical) in the gap between the pre-parse check
  // above and this point — the pre-parse check alone is stale by the time we're ready to write.
  // Recheck immediately before writeSession: if some other, already-parsed copy is now the
  // preferred candidate, drop this file's write entirely instead of clobbering the good session
  // with a worse duplicate. D1 gives no cross-statement transaction here, so the race window
  // shrinks but doesn't close completely; a reindex self-heals if it's ever actually hit.
  const postParseCanonical = await chooseCanonical(det.sessionId, env);
  if (postParseCanonical !== null && postParseCanonical.id !== file.id && postParseCanonical.parseState === 'parsed') {
    await env.DB.prepare("UPDATE files SET parse_state = 'superseded' WHERE id = ?1").bind(file.id).run();
    return;
  }

  await env.DB.prepare("UPDATE sessions SET index_state = 'parsing' WHERE session_id = ?1").bind(det.sessionId).run();
  await writeSession(parsed, file, env);
  await markParsed(file.id, env, 'parsed', file.size);
  // Only the file the recheck just confirmed as the preferred candidate gets to supersede other
  // parsed duplicates. A worse-priority file that wrote because the preferred copy was still
  // unparsed must not claim that role — the preferred copy supersedes this one itself once IT
  // completes and runs its own recheck.
  if (postParseCanonical === null || postParseCanonical.id === file.id) {
    await env.DB.prepare("UPDATE files SET parse_state = 'superseded' WHERE session_id = ?1 AND id != ?2 AND parse_state = 'parsed'")
      .bind(det.sessionId, file.id)
      .run();
  }

  console.log(
    JSON.stringify({
      event: 'parse.done',
      file_id: file.id,
      session: det.sessionId,
      harness: det.harness,
      turns: parsed.turns.length,
      lines: parsed.stats.lines,
      parse_error_lines: parsed.stats.parseErrorLines,
      skipped: parsed.stats.skippedLineTypes,
    }),
  );
}

/**
 * Prefer a real copy first — neither 'error' nor 'skipped' (a zero-turn parse: every line
 * malformed or unsupported) wins over an actual 'parsed'/'pending' candidate, only wins if
 * EVERY candidate is error/skipped — otherwise a permanently-failed or empty copy could win
 * canonical selection and get a good duplicate from another machine marked superseded before
 * it's ever parsed. Then lowest machine priority, then largest file, then newest mtime.
 * Returns the preferred file id and its current parse_state — callers must not treat
 * "preferred" as "supersede everyone else" until that file has actually proven it can parse
 * (parse_state = 'parsed').
 */
async function chooseCanonical(sessionId: string, env: Env): Promise<{ id: number; parseState: string } | null> {
  const row = await env.DB.prepare(
    `SELECT f.id, f.parse_state FROM files f JOIN machines m ON m.machine_id = f.machine_id
     WHERE f.session_id = ?1 AND f.parse_state != 'superseded'
     ORDER BY (f.parse_state IN ('error', 'skipped')) ASC, m.priority ASC, f.size DESC, f.mtime DESC, f.id ASC LIMIT 1`,
  )
    .bind(sessionId)
    .first<{ id: number; parse_state: string }>();
  return row ? { id: row.id, parseState: row.parse_state } : null;
}

async function linkSubagentMeta(file: FileRow, env: Env): Promise<void> {
  const obj = await env.RAW.get(file.r2_key);
  if (!obj) return;
  try {
    const meta = (await obj.json()) as { toolUseId?: string; agentType?: string };
    const agentId = file.relpath.split('/').pop()?.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
    if (agentId && meta.toolUseId) {
      // No-op (0 rows) if the subagent transcript hasn't been parsed into a sessions row
      // yet — that ordering is covered by the sibling-meta read in parseOne above instead.
      await env.DB.prepare('UPDATE sessions SET parent_tool_use_id = ?2 WHERE session_id = ?1')
        .bind(agentId, meta.toolUseId)
        .run();
    }
  } catch {
    // Malformed meta is non-fatal; the transcript itself still indexes.
  }
}

/** Read the .meta.json sibling of a subagent transcript's r2_key (agent-X.jsonl -> agent-X.meta.json), if present. */
async function readSiblingMeta(r2Key: string, env: Env): Promise<{ toolUseId?: string; agentType?: string } | null> {
  if (!r2Key.endsWith('.jsonl')) return null;
  const metaKey = `${r2Key.slice(0, -'.jsonl'.length)}.meta.json`;
  const obj = await env.RAW.get(metaKey);
  if (!obj) return null;
  try {
    return (await obj.json()) as { toolUseId?: string; agentType?: string };
  } catch {
    return null;
  }
}

async function markParsed(fileId: number, env: Env, state: string, parsedSize?: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE files SET parse_state = ?2, parsed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), parsed_size = ?3, parse_error = NULL
     WHERE id = ?1`,
  )
    .bind(fileId, state, parsedSize ?? null)
    .run();
}

/** Replace a session's index rows atomically-enough: FTS delete → blocks delete → reinsert → FTS rebuild from blocks. */
async function writeSession(s: NormalizedSession, file: FileRow, env: Env): Promise<void> {
  const db = env.DB;

  await db.batch([
    db
      .prepare(
        `INSERT INTO blocks_fts (blocks_fts, rowid, text)
         SELECT 'delete', id, text FROM blocks WHERE session_id = ?1 AND text IS NOT NULL`,
      )
      .bind(s.id),
    db.prepare('DELETE FROM blocks WHERE session_id = ?1').bind(s.id),
    db.prepare('DELETE FROM usage WHERE session_id = ?1').bind(s.id),
  ]);

  const insertBlock = db.prepare(
    `INSERT INTO blocks (session_id, file_id, turn_index, block_index, role, btype, tool_name, ts, byte_start, byte_len, truncated, text)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
  );
  const insertUsage = db.prepare(
    `INSERT INTO usage (session_id, turn_index, ts, model, service_tier, input_tokens, output_tokens, reasoning_tokens,
                        cache_creation_5m_tokens, cache_creation_1h_tokens, cache_read_tokens, inference_geo, request_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
     ON CONFLICT (session_id, turn_index) DO UPDATE SET
       input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
       reasoning_tokens = excluded.reasoning_tokens, cache_read_tokens = excluded.cache_read_tokens`,
  );

  const stmts: D1PreparedStatement[] = [];
  let blockCount = 0;
  const totals = { in: 0, out: 0, reasoning: 0, cached: 0 };
  for (const turn of s.turns) {
    for (let bi = 0; bi < turn.blocks.length; bi++) {
      const b = turn.blocks[bi]!;
      blockCount++;
      stmts.push(
        insertBlock.bind(
          s.id,
          file.id,
          turn.index,
          bi,
          turn.role,
          b.type,
          b.toolName ?? null,
          turn.ts ?? null,
          b.byteStart,
          b.byteLen,
          b.truncated ? 1 : 0,
          b.text ?? null,
        ),
      );
    }
    const u = turn.usage;
    if (u) {
      totals.in += u.inputTokens ?? 0;
      totals.out += u.outputTokens ?? 0;
      totals.reasoning += u.reasoningTokens ?? 0;
      totals.cached += u.cacheReadTokens ?? 0;
      stmts.push(
        insertUsage.bind(
          s.id,
          turn.index,
          turn.ts ?? null,
          u.model ?? null,
          u.serviceTier ?? null,
          u.inputTokens ?? null,
          u.outputTokens ?? null,
          u.reasoningTokens ?? null,
          u.cacheCreation5mTokens ?? null,
          u.cacheCreation1hTokens ?? null,
          u.cacheReadTokens ?? null,
          u.inferenceGeo ?? null,
          u.requestId ?? null,
        ),
      );
    }
  }

  for (const chunk of chunkArr(stmts, 90)) await db.batch(chunk);

  const machine = await db
    .prepare('SELECT os FROM machines WHERE machine_id = ?1')
    .bind(file.machine_id)
    .first<{ os: string }>();

  await db.batch([
    db
      .prepare(
        `INSERT INTO sessions (session_id, harness, machine_id, os, canonical_file_id, cwd, repo_url, git_branch, models,
                               primary_model, title, started_at, ended_at, parent_session_id, parent_tool_use_id, is_sidechain,
                               turn_count, block_count, tokens_in, tokens_out, tokens_reasoning, tokens_cached, index_state, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, 'ready',
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT (session_id) DO UPDATE SET
           harness = excluded.harness, machine_id = excluded.machine_id, os = excluded.os,
           canonical_file_id = excluded.canonical_file_id, cwd = excluded.cwd, repo_url = excluded.repo_url,
           git_branch = excluded.git_branch, models = excluded.models, primary_model = excluded.primary_model,
           title = COALESCE(excluded.title, sessions.title), started_at = excluded.started_at, ended_at = excluded.ended_at,
           parent_session_id = COALESCE(excluded.parent_session_id, sessions.parent_session_id),
           parent_tool_use_id = COALESCE(sessions.parent_tool_use_id, excluded.parent_tool_use_id),
           is_sidechain = excluded.is_sidechain, turn_count = excluded.turn_count, block_count = excluded.block_count,
           tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out,
           tokens_reasoning = excluded.tokens_reasoning, tokens_cached = excluded.tokens_cached,
           index_state = 'ready', updated_at = excluded.updated_at`,
      )
      .bind(
        s.id,
        s.harness,
        file.machine_id,
        machine?.os ?? null,
        file.id,
        s.cwd ?? null,
        s.repoUrl ?? null,
        s.gitBranch ?? null,
        JSON.stringify(s.models),
        s.primaryModel ?? null,
        s.title ?? null,
        s.startedAt ?? null,
        s.endedAt ?? null,
        s.parentSessionId ?? null,
        s.parentToolUseId ?? null,
        s.isSidechain ? 1 : 0,
        s.turns.length,
        blockCount,
        totals.in,
        totals.out,
        totals.reasoning,
        totals.cached,
      ),
    db
      .prepare(
        `INSERT INTO blocks_fts (rowid, text)
         SELECT id, text FROM blocks WHERE session_id = ?1 AND text IS NOT NULL`,
      )
      .bind(s.id),
  ]);
}

function chunkArr<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
