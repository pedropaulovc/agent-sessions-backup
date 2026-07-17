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

  const canonicalId = await chooseCanonical(det.sessionId, env);
  if (canonicalId !== null && canonicalId !== file.id) {
    await env.DB.prepare("UPDATE files SET parse_state = 'superseded' WHERE id = ?1").bind(file.id).run();
    return;
  }

  const obj = await env.RAW.get(file.r2_key);
  if (!obj) throw new Error(`r2_object_missing:${file.r2_key}`);

  await env.DB.prepare("UPDATE sessions SET index_state = 'parsing' WHERE session_id = ?1").bind(det.sessionId).run();

  const lines = readJsonlLines(obj.body);
  const parsed =
    det.harness === 'claude-code' ? await parseClaudeCode(lines, det.sessionId) : await parseCodex(lines, det.sessionId);
  if (det.parentSessionId) parsed.parentSessionId = det.parentSessionId;

  await writeSession(parsed, file, env);
  await markParsed(file.id, env, 'parsed', file.size);

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

/** Prefer lowest machine priority, then largest file, then newest mtime. Returns canonical file id. */
async function chooseCanonical(sessionId: string, env: Env): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT f.id FROM files f JOIN machines m ON m.machine_id = f.machine_id
     WHERE f.session_id = ?1 AND f.parse_state != 'superseded'
     ORDER BY m.priority ASC, f.size DESC, f.mtime DESC, f.id ASC LIMIT 1`,
  )
    .bind(sessionId)
    .first<{ id: number }>();
  return row?.id ?? null;
}

async function linkSubagentMeta(file: FileRow, env: Env): Promise<void> {
  const obj = await env.RAW.get(file.r2_key);
  if (!obj) return;
  try {
    const meta = (await obj.json()) as { toolUseId?: string; agentType?: string };
    const agentId = file.relpath.split('/').pop()?.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
    if (agentId && meta.toolUseId) {
      await env.DB.prepare('UPDATE sessions SET parent_tool_use_id = ?2 WHERE session_id = ?1')
        .bind(agentId, meta.toolUseId)
        .run();
    }
  } catch {
    // Malformed meta is non-fatal; the transcript itself still indexes.
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
