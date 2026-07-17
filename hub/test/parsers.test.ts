import { describe, expect, it } from 'vitest';
import { readJsonlLines } from '../src/ingest/jsonl';
import { parseClaudeCode } from '../src/ingest/parsers/claude-code';
import { parseCodex } from '../src/ingest/parsers/codex';
import {
  CC_SESSION_ID,
  CODEX_SESSION_ID,
  ccAssistantLine,
  ccNoiseLines,
  ccUserLine,
  codexLines,
  toStream,
} from './fixtures';

describe('readJsonlLines', () => {
  it('reports exact byte offsets across chunk boundaries', async () => {
    const lines = ['{"a":1}', '{"b":"ü"}', '{"c":3}'];
    const encoder = new TextEncoder();
    const raw = encoder.encode(lines.join('\n') + '\n');
    const out: Array<{ text: string; byteStart: number; byteLen: number }> = [];
    for await (const l of readJsonlLines(toStream(lines))) out.push(l);
    expect(out.map((l) => l.text)).toEqual(lines);
    // Re-slicing the original buffer at reported offsets must reproduce each line.
    for (const l of out) {
      const slice = raw.subarray(l.byteStart, l.byteStart + l.byteLen);
      expect(new TextDecoder().decode(slice)).toBe(l.text + '\n');
    }
    const total = out.reduce((s, l) => s + l.byteLen, 0);
    expect(total).toBe(raw.length);
  });

  it('handles a final line without trailing newline and lines >1MB', async () => {
    const big = '{"big":"' + 'x'.repeat(1_200_000) + '"}';
    const body = new TextEncoder().encode('{"s":1}\n' + big);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < body.length; i += 65536) c.enqueue(body.subarray(i, Math.min(i + 65536, body.length)));
        c.close();
      },
    });
    const out = [];
    for await (const l of readJsonlLines(stream)) out.push(l);
    expect(out).toHaveLength(2);
    expect(out[1]!.text.length).toBe(big.length);
    expect(out[1]!.byteStart).toBe(8);
  });
});

describe('parseClaudeCode', () => {
  it('parses turns, skips noise, extracts usage/title, survives malformed lines', async () => {
    const lines = [
      ...ccNoiseLines(),
      ccUserLine({ uuid: 'u1', text: 'hello agent, please summarize the flurbo report' }),
      ccAssistantLine({
        uuid: 'a1',
        parentUuid: 'u1',
        thinking: 'pondering flurbos',
        toolUse: { id: 'toolu_1', name: 'Bash', input: { command: 'cat flurbo.txt' } },
      }),
      ccUserLine({
        uuid: 'u2',
        parentUuid: 'a1',
        toolResult: {
          toolUseId: 'toolu_1',
          content: 'short rendering',
          toolUseResult: { stdout: 'the FULL flurbo contents, much longer than the rendering shown inline' },
        },
      }),
      ccAssistantLine({ uuid: 'a2', parentUuid: 'u2', text: 'The flurbo report says: all good.' }),
    ];
    const s = await parseClaudeCode(readJsonlLines(toStream(lines)), CC_SESSION_ID);

    expect(s.title).toBe('Demo session about parsing');
    expect(s.cwd).toBe('/home/tester/src/demo');
    expect(s.gitBranch).toBe('main');
    expect(s.models).toEqual(['claude-test-1']);
    expect(s.stats.parseErrorLines).toBe(1);
    expect(s.stats.skippedLineTypes['brand-new-unknown-type']).toBe(1);
    expect(s.stats.skippedLineTypes['progress']).toBe(1);

    expect(s.turns).toHaveLength(4);
    expect(s.turns.every((t) => t.onMainPath)).toBe(true);

    const a1 = s.turns[1]!;
    expect(a1.usage?.inputTokens).toBe(11);
    expect(a1.usage?.cacheCreation5mTokens).toBe(30);
    expect(a1.usage?.cacheCreation1hTokens).toBe(3);
    expect(a1.blocks.map((b) => b.type)).toEqual(['thinking', 'tool_use']);
    expect(a1.blocks[1]!.toolName).toBe('Bash');

    // toolUseResult (fuller) beats the truncated in-message rendering.
    const toolResult = s.turns[2]!.blocks.find((b) => b.type === 'tool_result')!;
    expect(toolResult.text).toContain('FULL flurbo contents');
  });

  it('marks abandoned branches off the main path', async () => {
    const lines = [
      ccUserLine({ uuid: 'u1', text: 'first question' }),
      ccAssistantLine({ uuid: 'a1', parentUuid: 'u1', text: 'answer one (abandoned)' }),
      ccAssistantLine({ uuid: 'a2', parentUuid: 'u1', text: 'answer two (rewind winner)' }),
    ];
    const s = await parseClaudeCode(readJsonlLines(toStream(lines)), CC_SESSION_ID);
    const byText = (t: string) => s.turns.find((x) => x.blocks.some((b) => b.text?.includes(t)))!;
    expect(byText('abandoned').onMainPath).toBe(false);
    expect(byText('rewind winner').onMainPath).toBe(true);
    expect(byText('first question').onMainPath).toBe(true);
  });

  it('caps oversized blocks and flags truncation', async () => {
    const huge = 'z'.repeat(40_000);
    const lines = [ccUserLine({ uuid: 'u1', text: huge })];
    const s = await parseClaudeCode(readJsonlLines(toStream(lines)), CC_SESSION_ID);
    const block = s.turns[0]!.blocks[0]!;
    expect(block.text!.length).toBe(16 * 1024);
    expect(block.truncated).toBe(true);
  });

  it('preserves a message whose content is ONLY an unrecognized block type instead of dropping the turn (regression: server_tool_use etc. yielded nothing, so the blockless turn vanished from sessions + FTS)', async () => {
    const line = JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      cwd: '/home/tester/src/demo',
      sessionId: CC_SESSION_ID,
      version: '2.1.99',
      gitBranch: 'main',
      type: 'assistant',
      requestId: 'req_unknown_block',
      message: {
        id: 'msg_unknown_block',
        role: 'assistant',
        model: 'claude-test-1',
        content: [{ type: 'server_tool_use', id: 'stu_1', name: 'web_search', input: { query: 'flurbo' } }],
      },
      uuid: 'unknown-block-a1',
      timestamp: '2026-07-01T10:00:05.000Z',
    });

    const s = await parseClaudeCode(readJsonlLines(toStream([line])), CC_SESSION_ID);
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]!.blocks).toHaveLength(1);
    expect(s.turns[0]!.blocks[0]!.type).toBe('text');
    expect(s.turns[0]!.blocks[0]!.text).toContain('server_tool_use');
    expect(s.turns[0]!.blocks[0]!.text).toContain('web_search');
    expect(s.stats.skippedLineTypes['content:server_tool_use']).toBe(1);
  });
});

describe('parseCodex', () => {
  it('groups turns, folds token_count into usage, dedupes agent_message, marks compaction', async () => {
    const s = await parseCodex(readJsonlLines(toStream(codexLines())), CODEX_SESSION_ID);

    expect(s.cwd).toBe('/home/tester/src/demo');
    expect(s.repoUrl).toBe('https://github.com/tester/demo');
    expect(s.gitBranch).toBe('main');
    expect(s.models).toEqual(['gpt-test-2']);
    expect(s.title).toBe('please fix the flaky widget test');
    expect(s.stats.skippedLineTypes['inter_agent_communication_metadata']).toBe(1);

    const roles = s.turns.map((t) => t.role);
    // user → assistant (thinking+tool_use) → tool (result) → assistant (text) → compaction marker
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant', 'system']);

    const assistant = s.turns[1]!;
    expect(assistant.blocks.map((b) => b.type)).toEqual(['thinking', 'tool_use']);
    expect(assistant.blocks[0]!.text).toContain('Considering the widget');

    // token_count landed on the last assistant turn; reasoning tokens split out.
    const finalAssistant = s.turns[3]!;
    expect(finalAssistant.usage?.inputTokens).toBe(900);
    expect(finalAssistant.usage?.reasoningTokens).toBe(20);
    expect(finalAssistant.usage?.cacheReadTokens).toBe(500);

    // response_item-derived turns carry the envelope's own timestamp (regression: these used
    // to always land as undefined, so consumer.ts wrote NULL into usage.ts / blocks.ts and
    // usage day-grouping broke for every codex session).
    expect(s.turns.map((t) => t.ts)).toEqual([
      '2026-07-02T09:00:02.000Z', // user message
      '2026-07-02T09:00:03.000Z', // reasoning opens the assistant turn
      '2026-07-02T09:00:05.000Z', // function_call_output opens the tool turn
      '2026-07-02T09:00:06.000Z', // assistant message opens the final assistant turn
      '2026-07-02T09:00:09.000Z', // compaction marker
    ]);
    // The usage row consumer.ts writes for this turn uses turn.ts — now non-null.
    expect(finalAssistant.ts).toBe('2026-07-02T09:00:06.000Z');

    // The duplicate event_msg/agent_message must NOT create a second text block.
    const assistantTexts = s.turns.filter((t) => t.role === 'assistant').flatMap((t) => t.blocks.filter((b) => b.type === 'text'));
    expect(assistantTexts).toHaveLength(1);

    expect(s.turns[4]!.compaction?.kind).toBe('codex-window');
  });

  it('keeps a usage-only turn when token_count is the only billable event before EOF (regression: flush dropped 0-block turns even with usage set)', async () => {
    const lines = [
      { timestamp: '2026-07-03T10:00:00.000Z', type: 'session_meta', payload: { session_id: CODEX_SESSION_ID, cwd: '/x' } },
      { timestamp: '2026-07-03T10:00:01.000Z', type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-test-3' } },
      {
        timestamp: '2026-07-03T10:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 42, output_tokens: 7, reasoning_output_tokens: 3, cached_input_tokens: 1 },
          },
        },
      },
    ].map((o) => JSON.stringify(o));

    const s = await parseCodex(readJsonlLines(toStream(lines)), CODEX_SESSION_ID);
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]!.blocks).toHaveLength(0);
    expect(s.turns[0]!.usage?.inputTokens).toBe(42);
    expect(s.turns[0]!.usage?.reasoningTokens).toBe(3);
    expect(s.turns[0]!.usage?.cacheReadTokens).toBe(1);
  });

  it('indexes distinct event_msg messages sharing a long prefix, not just their prefix (regression: prefix-only key dropped distinct pasted-log messages)', async () => {
    const sharedPrefix = 'A'.repeat(300); // longer than the old 256-char prefix key
    const firstText = `${sharedPrefix} first-tail`;
    const secondText = `${sharedPrefix} second-tail-DIFFERENT`;
    const lines = [
      { timestamp: '2026-07-04T10:00:00.000Z', type: 'session_meta', payload: { session_id: CODEX_SESSION_ID, cwd: '/x' } },
      { timestamp: '2026-07-04T10:00:01.000Z', type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-test-4' } },
      { timestamp: '2026-07-04T10:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: firstText } },
      { timestamp: '2026-07-04T10:00:03.000Z', type: 'event_msg', payload: { type: 'agent_message', message: secondText } },
    ].map((o) => JSON.stringify(o));

    const s = await parseCodex(readJsonlLines(toStream(lines)), CODEX_SESSION_ID);
    const texts = s.turns.flatMap((t) => t.blocks.filter((b) => b.type === 'text').map((b) => b.text));
    expect(texts).toHaveLength(2);
    expect(texts).toContain(firstText);
    expect(texts).toContain(secondText);
  });

  it('does NOT dedupe a genuine same-text repeat within the SAME wire representation (regression: session-global dedupe dropped repeated user/assistant text like "continue" or "ok")', async () => {
    const text = 'continue';
    const lines = [
      { timestamp: '2026-07-06T10:00:00.000Z', type: 'session_meta', payload: { session_id: CODEX_SESSION_ID, cwd: '/x' } },
      { timestamp: '2026-07-06T10:00:01.000Z', type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-test-6' } },
      {
        timestamp: '2026-07-06T10:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }],
          internal_chat_message_metadata_passthrough: { turn_id: 't1' },
        },
      },
      {
        timestamp: '2026-07-06T10:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'on it' }],
          internal_chat_message_metadata_passthrough: { turn_id: 't1' },
        },
      },
      {
        timestamp: '2026-07-06T10:00:04.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }],
          internal_chat_message_metadata_passthrough: { turn_id: 't2' },
        },
      },
    ].map((o) => JSON.stringify(o));

    const s = await parseCodex(readJsonlLines(toStream(lines)), CODEX_SESSION_ID);
    const userTexts = s.turns.filter((t) => t.role === 'user').flatMap((t) => t.blocks.map((b) => b.text));
    expect(userTexts).toEqual([text, text]);
  });

  it('an unpaired message does not survive past its own turn to wrongly consume a later, unrelated repeat (regression: session-wide pending counters let a later event_msg "continue" get silently eaten by an unpaired response_item "continue" from an earlier turn)', async () => {
    const text = 'continue';
    const lines = [
      { timestamp: '2026-07-09T10:00:00.000Z', type: 'session_meta', payload: { session_id: CODEX_SESSION_ID, cwd: '/x' } },
      { timestamp: '2026-07-09T10:00:01.000Z', type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-test-9' } },
      // Turn 1: response_item 'continue' with NO event_msg pair — this occurrence is left
      // permanently unpaired.
      {
        timestamp: '2026-07-09T10:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }],
          internal_chat_message_metadata_passthrough: { turn_id: 't1' },
        },
      },
      // The assistant's reply closes turn 1 (role change flushes it).
      {
        timestamp: '2026-07-09T10:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'on it' }],
          internal_chat_message_metadata_passthrough: { turn_id: 't1' },
        },
      },
      // A later, unrelated turn: the user says "continue" again, this time only as event_msg —
      // it must be indexed, not silently consumed by the stale unpaired occurrence from turn 1.
      { timestamp: '2026-07-09T10:00:04.000Z', type: 'event_msg', payload: { type: 'user_message', message: text } },
    ].map((o) => JSON.stringify(o));

    const s = await parseCodex(readJsonlLines(toStream(lines)), CODEX_SESSION_ID);
    const userTexts = s.turns.filter((t) => t.role === 'user').flatMap((t) => t.blocks.map((b) => b.text));
    expect(userTexts).toEqual([text, text]);
  });

  it('dedupes an event_msg/response_item representation pair but still indexes a genuine third repeat (regression: pairing must consume exactly the duplicate wire form, not every subsequent equal string)', async () => {
    const text = 'the widget test passes now';
    const lines = [
      { timestamp: '2026-07-07T10:00:00.000Z', type: 'session_meta', payload: { session_id: CODEX_SESSION_ID, cwd: '/x' } },
      { timestamp: '2026-07-07T10:00:01.000Z', type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-test-7' } },
      // Pair 1: event_msg then the equivalent response_item — must collapse to one block.
      { timestamp: '2026-07-07T10:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: text } },
      {
        timestamp: '2026-07-07T10:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
          internal_chat_message_metadata_passthrough: { turn_id: 't1' },
        },
      },
      // A genuine third occurrence of the exact same text (e.g. the assistant says it again
      // later) must still be indexed, and its own event_msg twin still gets paired off it.
      { timestamp: '2026-07-07T10:00:04.000Z', type: 'event_msg', payload: { type: 'agent_message', message: text } },
      {
        timestamp: '2026-07-07T10:00:05.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
          internal_chat_message_metadata_passthrough: { turn_id: 't2' },
        },
      },
    ].map((o) => JSON.stringify(o));

    const s = await parseCodex(readJsonlLines(toStream(lines)), CODEX_SESSION_ID);
    const texts = s.turns.flatMap((t) => t.blocks.filter((b) => b.type === 'text').map((b) => b.text));
    expect(texts).toEqual([text, text]);
  });

  it('dedupes when event_msg arrives before the equivalent response_item/message (regression: response_item path recorded but never checked seenMessageHashes)', async () => {
    const text = 'the widget test passes now, in this exact wording';
    const lines = [
      { timestamp: '2026-07-05T10:00:00.000Z', type: 'session_meta', payload: { session_id: CODEX_SESSION_ID, cwd: '/x' } },
      { timestamp: '2026-07-05T10:00:01.000Z', type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-test-5' } },
      { timestamp: '2026-07-05T10:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: text } },
      {
        timestamp: '2026-07-05T10:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
          internal_chat_message_metadata_passthrough: { turn_id: 't1' },
        },
      },
    ].map((o) => JSON.stringify(o));

    const s = await parseCodex(readJsonlLines(toStream(lines)), CODEX_SESSION_ID);
    const texts = s.turns.flatMap((t) => t.blocks.filter((b) => b.type === 'text').map((b) => b.text));
    expect(texts).toEqual([text]);
  });

  it('a token_count with no indexable block for the current call opens a fresh usage-only turn instead of overwriting the previous call (regression: lastAssistant stayed stale across a new user turn)', async () => {
    const lines = [
      { timestamp: '2026-07-08T10:00:00.000Z', type: 'session_meta', payload: { session_id: CODEX_SESSION_ID, cwd: '/x' } },
      { timestamp: '2026-07-08T10:00:01.000Z', type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-test-8' } },
      {
        timestamp: '2026-07-08T10:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'first question' }],
          internal_chat_message_metadata_passthrough: { turn_id: 't1' },
        },
      },
      {
        timestamp: '2026-07-08T10:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'first answer' }],
          internal_chat_message_metadata_passthrough: { turn_id: 't1' },
        },
      },
      {
        timestamp: '2026-07-08T10:00:04.000Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 10 } } },
      },
      // New user turn — whatever assistant call preceded it is done.
      {
        timestamp: '2026-07-08T10:00:05.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'second question' }],
          internal_chat_message_metadata_passthrough: { turn_id: 't2' },
        },
      },
      // The reply to the second question produced only encrypted reasoning — no indexable
      // response_item/message — so this token_count is the only signal of that call.
      {
        timestamp: '2026-07-08T10:00:06.000Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 200, output_tokens: 20 } } },
      },
    ].map((o) => JSON.stringify(o));

    const s = await parseCodex(readJsonlLines(toStream(lines)), CODEX_SESSION_ID);
    const roles = s.turns.map((t) => t.role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant']);

    const firstAssistant = s.turns[1]!;
    expect(firstAssistant.blocks.map((b) => b.text)).toEqual(['first answer']);
    expect(firstAssistant.usage?.inputTokens).toBe(100); // untouched by the second token_count

    const secondAssistant = s.turns[3]!;
    expect(secondAssistant.blocks).toHaveLength(0); // usage-only turn, no indexable block
    expect(secondAssistant.usage?.inputTokens).toBe(200);
  });

  it('a token_count after a context_compacted marker opens a fresh usage-only turn instead of overwriting the pre-compaction reply (regression: lastAssistant stayed stale across the compaction marker)', async () => {
    const lines = [
      { timestamp: '2026-07-09T10:00:00.000Z', type: 'session_meta', payload: { session_id: CODEX_SESSION_ID, cwd: '/x' } },
      { timestamp: '2026-07-09T10:00:01.000Z', type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-test-9' } },
      {
        timestamp: '2026-07-09T10:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'compaction test question' }],
          internal_chat_message_metadata_passthrough: { turn_id: 't1' },
        },
      },
      {
        timestamp: '2026-07-09T10:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'pre-compaction answer' }],
          internal_chat_message_metadata_passthrough: { turn_id: 't1' },
        },
      },
      // Usage A — belongs to the reply above.
      {
        timestamp: '2026-07-09T10:00:04.000Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 10 } } },
      },
      { timestamp: '2026-07-09T10:00:05.000Z', type: 'event_msg', payload: { type: 'context_compacted' } },
      // Usage B — the compaction request's own usage, with no indexable reply of its own.
      {
        timestamp: '2026-07-09T10:00:06.000Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 200, output_tokens: 20 } } },
      },
    ].map((o) => JSON.stringify(o));

    const s = await parseCodex(readJsonlLines(toStream(lines)), CODEX_SESSION_ID);
    const roles = s.turns.map((t) => t.role);
    expect(roles).toEqual(['user', 'assistant', 'system', 'assistant']);

    const preCompactionReply = s.turns[1]!;
    expect(preCompactionReply.blocks.map((b) => b.text)).toEqual(['pre-compaction answer']);
    expect(preCompactionReply.usage?.inputTokens).toBe(100); // untouched by the post-compaction token_count

    expect(s.turns[2]!.compaction?.kind).toBe('codex-window');

    const postCompactionUsage = s.turns[3]!;
    expect(postCompactionUsage.blocks).toHaveLength(0); // usage-only turn, no indexable block
    expect(postCompactionUsage.usage?.inputTokens).toBe(200);
  });

  it('a token_count after a top-level world_state marker also opens a fresh usage-only turn (regression: only the event_msg/context_compacted marker reset lastAssistant, not the top-level compacted/world_state shape)', async () => {
    const lines = [
      { timestamp: '2026-07-09T11:00:00.000Z', type: 'session_meta', payload: { session_id: CODEX_SESSION_ID, cwd: '/x' } },
      { timestamp: '2026-07-09T11:00:01.000Z', type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-test-9' } },
      {
        timestamp: '2026-07-09T11:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'world_state test question' }],
          internal_chat_message_metadata_passthrough: { turn_id: 't1' },
        },
      },
      {
        timestamp: '2026-07-09T11:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'pre-world_state answer' }],
          internal_chat_message_metadata_passthrough: { turn_id: 't1' },
        },
      },
      // Usage A — belongs to the reply above.
      {
        timestamp: '2026-07-09T11:00:04.000Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 10 } } },
      },
      // Top-level marker shape (not event_msg/context_compacted).
      { timestamp: '2026-07-09T11:00:05.000Z', type: 'world_state', payload: {} },
      // Usage B — with no indexable reply of its own.
      {
        timestamp: '2026-07-09T11:00:06.000Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 200, output_tokens: 20 } } },
      },
    ].map((o) => JSON.stringify(o));

    const s = await parseCodex(readJsonlLines(toStream(lines)), CODEX_SESSION_ID);
    const roles = s.turns.map((t) => t.role);
    expect(roles).toEqual(['user', 'assistant', 'system', 'assistant']);

    const preMarkerReply = s.turns[1]!;
    expect(preMarkerReply.blocks.map((b) => b.text)).toEqual(['pre-world_state answer']);
    expect(preMarkerReply.usage?.inputTokens).toBe(100); // untouched by the post-marker token_count

    expect(s.turns[2]!.compaction?.kind).toBe('codex-window');

    const postMarkerUsage = s.turns[3]!;
    expect(postMarkerUsage.blocks).toHaveLength(0); // usage-only turn, no indexable block
    expect(postMarkerUsage.usage?.inputTokens).toBe(200);
  });
});
