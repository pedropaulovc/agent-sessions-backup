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

  it('dedupes event_msg messages by full text, not just a shared prefix (regression: prefix-only key dropped distinct pasted-log messages)', async () => {
    const sharedPrefix = 'A'.repeat(300); // longer than the old 256-char prefix key
    const firstText = `${sharedPrefix} first-tail`;
    const secondText = `${sharedPrefix} second-tail-DIFFERENT`;
    const lines = [
      { timestamp: '2026-07-04T10:00:00.000Z', type: 'session_meta', payload: { session_id: CODEX_SESSION_ID, cwd: '/x' } },
      { timestamp: '2026-07-04T10:00:01.000Z', type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-test-4' } },
      { timestamp: '2026-07-04T10:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: firstText } },
      { timestamp: '2026-07-04T10:00:03.000Z', type: 'event_msg', payload: { type: 'agent_message', message: secondText } },
      // A genuine duplicate of the first message must still be deduped.
      { timestamp: '2026-07-04T10:00:04.000Z', type: 'event_msg', payload: { type: 'agent_message', message: firstText } },
    ].map((o) => JSON.stringify(o));

    const s = await parseCodex(readJsonlLines(toStream(lines)), CODEX_SESSION_ID);
    const texts = s.turns.flatMap((t) => t.blocks.filter((b) => b.type === 'text').map((b) => b.text));
    expect(texts).toHaveLength(2);
    expect(texts).toContain(firstText);
    expect(texts).toContain(secondText);
  });
});
