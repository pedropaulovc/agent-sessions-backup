import { env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runSessionRollup } from '../src/session-rollup';
import { parseChatgptWeb } from '../src/ingest/parsers/chatgpt-web';
import { assertIndexLayout, indexDbFor, indexDbs, reserveBlockIds } from '../src/index-shards';

const testEnv = env as unknown as Env;
const db = testEnv.DB;
const PREFIX = 'rollup-regression-';
const DAY = '2026-08-01T12:00:00Z';

async function seedSession(suffix: string): Promise<string> {
  const id = PREFIX + suffix;
  await db.batch([
    db.prepare(`INSERT INTO sessions (session_id, harness, index_state) VALUES (?1, 'omp', 'ready')`).bind(id),
    db.prepare('INSERT INTO session_rollup_state (session_id) VALUES (?1)').bind(id),
  ]);
  return id;
}

async function block(id: string, turn: number, index: number, options: {
  type?: string; role?: string; text?: string | null; truncated?: number; main?: number;
  ts?: string | null; bytes?: number;
} = {}): Promise<void> {
  const shard = indexDbFor(testEnv, id);
  const blockId = await reserveBlockIds(shard, 1);
  await shard.prepare(`INSERT INTO blocks (id, session_id, file_id, turn_index, block_index, role, btype,
    tool_name, ts, byte_len, truncated, text, on_main_path)
    VALUES (?11, ?1, 0, ?2, ?3, ?4, ?5, 'read', ?6, ?7, ?8, ?9, ?10)`)
    .bind(id, turn, index, options.role ?? 'assistant', options.type ?? 'tool_use',
      options.ts === undefined ? DAY : options.ts, options.bytes ?? 10, options.truncated ?? 0,
      options.text === undefined ? 'read {"path":"a"}' : options.text, options.main ?? 1, blockId).run();
}

async function published(id: string) {
  return (await db.prepare(`SELECT r.* FROM session_rollup r JOIN session_rollup_state st USING (session_id)
    JOIN sessions s USING (session_id) WHERE r.session_id = ?1 AND st.status = 'ready'
    AND s.index_state = 'ready' ORDER BY day, model`).bind(id).all()).results;
}

async function race(mutate: () => Promise<void>, body: () => Promise<unknown>): Promise<unknown> {
  const original = db.batch.bind(db);
  let fired = false;
  db.batch = (async (statements: D1PreparedStatement[]) => {
    if (!fired) { fired = true; await mutate(); }
    return original(statements);
  }) as typeof db.batch;
  try {
    const result = await body();
    expect(fired, 'race must occur between source read and checkpoint commit').toBe(true);
    return result;
  } finally { db.batch = original; }
}

/** Intercept the first routed block page without coupling the injection to its SQL. */
async function sourceRead(
  id: string, mutate: () => Promise<void>, body: () => Promise<unknown>, fail = false,
): Promise<unknown> {
  const shard = indexDbFor(testEnv, id);
  const originalPrepare = shard.prepare.bind(shard);
  let fired = false;
  shard.prepare = (sql: string) => {
    const statement = originalPrepare(sql);
    const originalBind = statement.bind.bind(statement);
    statement.bind = (...values: unknown[]) => {
      const bound = originalBind(...values);
      const originalAll = bound.all.bind(bound);
      bound.all = (async () => {
        if (fired) return originalAll();
        fired = true;
        if (fail) {
          await mutate();
          throw new Error('injected source read failure');
        }
        const result = await originalAll();
        await mutate();
        return result;
      }) as typeof bound.all;
      return bound;
    };
    return statement;
  };
  try {
    const result = await body();
    expect(fired, 'the routed block page must actually be read').toBe(true);
    return result;
  } finally { shard.prepare = originalPrepare; }
}

beforeAll(async () => {
  await assertIndexLayout(testEnv);
});

afterEach(async () => {
  for (const shard of indexDbs(testEnv)) {
    await shard.prepare('DELETE FROM blocks WHERE session_id LIKE ?1').bind(PREFIX + '%').run();
  }
  await db.batch([
    db.prepare('DELETE FROM usage WHERE session_id LIKE ?1').bind(PREFIX + '%'),
    db.prepare('DELETE FROM sessions WHERE session_id LIKE ?1').bind(PREFIX + '%'),
  ]);
});

describe('nightly session rollup', () => {
  it('carries turn flags and exact-call history across pages and attributes later repeats to their own day/model', async () => {
    const id = await seedSession('boundaries');
    await db.prepare(`INSERT INTO usage (session_id, turn_index, model) VALUES (?1, 0, 'm1')`).bind(id).run();
    await block(id, 0, 0);
    await block(id, 0, 1, { main: 0, ts: '2026-08-02T00:00:00Z' });
    await block(id, 0, 2, { type: 'tool_result', role: 'tool', bytes: 77, ts: null });
    await block(id, 1, 0, { ts: '2026-08-02T02:00:00+02:00' });
    await block(id, 1, 1, { truncated: 1 });
    await block(id, 1, 2, { text: null });
    await block(id, 2, 0, { type: 'tool_use', role: 'user', ts: 'invalid' });

    const first = await runSessionRollup(testEnv, { pageSize: 1, maxPages: 1 });
    expect(first).toMatchObject({ examined: 1, completed: 0, remaining: 'pending' });
    expect(await published(id)).toEqual([]);
    await runSessionRollup(testEnv, { pageSize: 1 });
    expect(await published(id)).toEqual([
      { session_id: id, day: '', model: '(unknown)', assistant_turns: 0, rewound_assistant_turns: 0,
        tool_calls: 0, tool_result_source_bytes: 0, repeated_tool_calls: 0, comparable_tool_calls: 0 },
      { session_id: id, day: '2026-08-01', model: 'm1', assistant_turns: 1, rewound_assistant_turns: 1,
        tool_calls: 2, tool_result_source_bytes: 77, repeated_tool_calls: 1, comparable_tool_calls: 2 },
      { session_id: id, day: '2026-08-02', model: '(unknown)', assistant_turns: 1, rewound_assistant_turns: 0,
        tool_calls: 3, tool_result_source_bytes: 0, repeated_tool_calls: 1, comparable_tool_calls: 1 },
    ]);
    expect(await runSessionRollup(testEnv)).toMatchObject({ examined: 0, completed: 0, pending: 0, remaining: 'complete' });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM session_rollup_seen_calls WHERE session_id = ?1')
      .bind(id).first()).toEqual({ n: 0 });
  });

  it('rotates bounded pages fairly and eventually publishes a session larger than one invocation', async () => {
    const large = await seedSession('a-large');
    const small = await seedSession('b-small');
    for (let i = 0; i < 3; i++) await block(large, i, 0);
    await block(small, 0, 0, { type: 'text' });
    const options = { pageSize: 1, maxPages: 1, maxBlocks: 1, now: new Date(DAY) };
    await runSessionRollup(testEnv, options);
    await runSessionRollup(testEnv, options);
    await runSessionRollup(testEnv, options);
    await runSessionRollup(testEnv, options);
    expect(await published(small)).toMatchObject([{ assistant_turns: 1 }]);
    expect(await published(large)).toEqual([]);
    await runSessionRollup(testEnv, options);
    await runSessionRollup(testEnv, options);
    expect(await published(large)).toMatchObject([{ assistant_turns: 3, tool_calls: 3, repeated_tool_calls: 2 }]);
  });

  it.each(['between source reads', 'before main commit'] as const)(
    'rejects a page after same-id reingestion changes its generation and usage model %s', async (boundary) => {
    const id = await seedSession(`generation-${boundary}`);
    await block(id, 0, 0);
    const mutate = async () => {
      await db.batch([
        db.prepare('DELETE FROM session_rollup_state WHERE session_id = ?1').bind(id),
        db.prepare('INSERT INTO session_rollup_state (session_id, eligible) VALUES (?1, 0)').bind(id),
        db.prepare(`INSERT INTO usage (session_id, turn_index, model) VALUES (?1, 0, 'new-model')`).bind(id),
      ]);
    };
    const body = () => runSessionRollup(testEnv, { maxPages: 1 });
    const result = await (boundary === 'between source reads' ? sourceRead(id, mutate, body) : race(mutate, body));
    expect(result).toMatchObject({ completed: 0, superseded: 1 });
    expect(await published(id)).toEqual([]);
    await db.prepare('UPDATE session_rollup_state SET eligible = 1 WHERE session_id = ?1').bind(id).run();
    await runSessionRollup(testEnv);
    expect(await published(id)).toMatchObject([{ model: 'new-model', assistant_turns: 1, tool_calls: 1 }]);
  });

  it('does not double-apply a page won by a concurrent runner', async () => {
    const id = await seedSession('concurrent');
    await block(id, 0, 0);
    await block(id, 0, 1);
    expect(await race(
      async () => { await runSessionRollup(testEnv, { pageSize: 1, maxPages: 1 }); },
      () => runSessionRollup(testEnv, { pageSize: 1, maxPages: 1 }),
    )).toMatchObject({ superseded: 1 });
    await runSessionRollup(testEnv);
    expect(await published(id)).toMatchObject([{ assistant_turns: 1, tool_calls: 2, repeated_tool_calls: 1 }]);
  });

  it('checkpoints unique-key cleanup and rejects concurrent cleanup on an unchanged source cursor', async () => {
    const id = await seedSession('finishing');
    for (let i = 0; i < 4; i++) await block(id, i, 0, { text: `read ${i}` });
    await runSessionRollup(testEnv, { pageSize: 1, maxPages: 5 });
    expect(await published(id)).toEqual([]);
    expect(await race(
      async () => { await runSessionRollup(testEnv, { pageSize: 1, maxPages: 1 }); },
      () => runSessionRollup(testEnv, { pageSize: 1, maxPages: 1 }),
    )).toMatchObject({ superseded: 1, completed: 0 });
    await runSessionRollup(testEnv, { pageSize: 1 });
    expect(await published(id)).toMatchObject([{ assistant_turns: 4, tool_calls: 4, repeated_tool_calls: 0 }]);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM session_rollup_seen_calls WHERE session_id = ?1')
      .bind(id).first()).toEqual({ n: 0 });
  });

  it('defers a poisoned checkpoint once per invocation while healthy sessions continue', async () => {
    const broken = await seedSession('a-poison');
    const healthy = await seedSession('b-healthy');
    await block(broken, 0, 0);
    await block(healthy, 0, 0);
    await db.prepare('UPDATE session_rollup_state SET turn_state = ?2 WHERE session_id = ?1')
      .bind(broken, '{invalid json').run();
    const result = await runSessionRollup(testEnv, { maxPages: 5, now: new Date(DAY) });
    expect(result).toMatchObject({ failed: 1, completed: 1, pages: 2, pending: 1, remaining: 'pending' });
    expect(await published(healthy)).toMatchObject([{ assistant_turns: 1, tool_calls: 1 }]);
    expect(await published(broken)).toEqual([]);
    expect(await db.prepare('SELECT cursor_id, last_attempt FROM session_rollup_state WHERE session_id = ?1')
      .bind(broken).first()).toEqual({ cursor_id: 0, last_attempt: new Date(DAY).getTime() });
  });

  it('counts a failed source read against the page budget without starving healthy work or losing retry progress', async () => {
    const broken = await seedSession('a-read-failure');
    const healthy = await seedSession('b-read-healthy');
    await block(broken, 0, 0);
    await block(healthy, 0, 0);
    expect(await sourceRead(broken, async () => {}, () => runSessionRollup(testEnv, { maxPages: 2 }), true))
      .toMatchObject({ failed: 1, pages: 2, completed: 1, pending: 1 });
    expect(await published(healthy)).toMatchObject([{ assistant_turns: 1 }]);
    expect(await published(broken)).toEqual([]);
    expect(await runSessionRollup(testEnv)).toMatchObject({ failed: 0, completed: 1, pending: 0 });
    expect(await published(broken)).toMatchObject([{ assistant_turns: 1, repeated_tool_calls: 0 }]);
  });

  it('does not overwrite a newer checkpoint when recording a source read failure', async () => {
    const id = await seedSession('read-race');
    await block(id, 0, 0);
    await block(id, 1, 0);
    const future = new Date('2026-08-02T12:00:00Z');
    expect(await sourceRead(id,
      async () => { await runSessionRollup(testEnv, { pageSize: 1, maxPages: 1, now: future }); },
      () => runSessionRollup(testEnv, { pageSize: 1, maxPages: 1, now: new Date(DAY) }),
      true,
    )).toMatchObject({ failed: 1, superseded: 1, pages: 1 });
    expect(await db.prepare('SELECT cursor_turn, last_attempt FROM session_rollup_state WHERE session_id = ?1')
      .bind(id).first()).toEqual({ cursor_turn: 0, last_attempt: future.getTime() });
    await runSessionRollup(testEnv);
    expect(await published(id)).toMatchObject([{ assistant_turns: 2, tool_calls: 2, repeated_tool_calls: 1 }]);
  });

  it('handles a maximum page of complete calls whose JSON escaping exceeds one D1 value', async () => {
    const id = await seedSession('escaped');
    const argument = '\u0001'.repeat(2040);
    const rows = Array.from({ length: 500 }, (_, index) => `${index % 250}:${argument}`);
    // This fixture crosses the 2 MiB value boundary despite each source text being below 2 KiB.
    expect(new TextEncoder().encode(JSON.stringify(rows.map((text) => ['read', text]))).byteLength)
      .toBeGreaterThan(2 * 1024 * 1024);
    const shard = indexDbFor(testEnv, id);
    const firstBlockId = await reserveBlockIds(shard, rows.length);
    for (let start = 0; start < rows.length; start += 50) {
      await shard.batch(rows.slice(start, start + 50).map((text, offset) =>
        shard.prepare(`INSERT INTO blocks (id, session_id, file_id, turn_index, block_index, role, btype,
          tool_name, ts, text) VALUES (?5, ?1, 0, ?2, 0, 'assistant', 'tool_use', 'read', ?3, ?4)`)
          .bind(id, start + offset, DAY, text, firstBlockId + start + offset)));
    }
    // A later page must look up the same escaped identity, not just deduplicate in memory.
    await block(id, 500, 0, { text: rows[0]! });
    expect(await runSessionRollup(testEnv, { pageSize: 500 })).toMatchObject({ completed: 1, failed: 0 });
    expect(await published(id)).toMatchObject([{
      assistant_turns: 501, tool_calls: 501, comparable_tool_calls: 501, repeated_tool_calls: 251,
    }]);
  });

  it('publishes exact complete ChatGPT-web calls with large recipients across pages', async () => {
    const id = await seedSession('large-recipient');
    await db.prepare(`UPDATE sessions SET harness = 'chatgpt-web' WHERE session_id = ?1`).bind(id).run();
    const recipient = 'tool_' + 'x'.repeat(300_000);
    const raw = JSON.stringify({
      current_node: 'c',
      mapping: {
        a: { parent: null, message: { author: { role: 'assistant' }, recipient,
          create_time: 1754049600, content: { content_type: 'code', text: 'print(1)' } } },
        b: { parent: 'a', message: { author: { role: 'assistant' }, recipient: recipient + '_other',
          create_time: 1754049601, content: { content_type: 'code', text: 'print(1)' } } },
        c: { parent: 'b', message: { author: { role: 'assistant' }, recipient,
          create_time: 1754049602, content: { content_type: 'code', text: 'print(1)' } } },
      },
    });
    const session = parseChatgptWeb(raw, id);
    const shard = indexDbFor(testEnv, id);
    for (const turn of session.turns) {
      const firstBlockId = await reserveBlockIds(shard, turn.blocks.length);
      await shard.batch(turn.blocks.map((parsed, index) =>
        shard.prepare(`INSERT INTO blocks (id, session_id, file_id, turn_index, block_index, role, btype,
          tool_name, ts, text, truncated, on_main_path)
          VALUES (?11, ?1, 0, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`)
          .bind(id, turn.index, index, turn.role, parsed.type, parsed.toolName ?? null,
            turn.ts ?? null, parsed.text ?? null, parsed.truncated ? 1 : 0, turn.onMainPath ? 1 : 0,
            firstBlockId + index)));
    }
    expect(await runSessionRollup(testEnv, { pageSize: 1 })).toMatchObject({
      completed: 1, failed: 0, pending: 0, remaining: 'complete',
    });
    expect(await published(id)).toMatchObject([{
      assistant_turns: 3, tool_calls: 3, comparable_tool_calls: 3, repeated_tool_calls: 1,
    }]);
  });

  it('cannot publish after deletion and clears ready eligibility when a session errors', async () => {
    const id = await seedSession('deletion');
    await block(id, 0, 0);
    expect(await race(
      async () => { await db.prepare('DELETE FROM sessions WHERE session_id = ?1').bind(id).run(); },
      () => runSessionRollup(testEnv, { maxPages: 1 }),
    )).toMatchObject({ completed: 0, superseded: 1 });
    expect(await published(id)).toEqual([]);
    await seedSession('deletion');
    await runSessionRollup(testEnv);
    expect(await published(id)).toMatchObject([{ assistant_turns: 1 }]);
    await db.prepare(`UPDATE sessions SET index_state = 'error' WHERE session_id = ?1`).bind(id).run();
    expect(await published(id)).toEqual([]);
    expect(await db.prepare('SELECT status, eligible, completed_at FROM session_rollup_state WHERE session_id = ?1')
      .bind(id).first()).toBeNull();
  });
});
