import { describe, expect, it } from 'vitest';
import { readJsonlLines } from '../src/ingest/jsonl';
import { parseChatgptWeb } from '../src/ingest/parsers/chatgpt-web';
import { parseClaudeWeb } from '../src/ingest/parsers/claude-web';
import { parsePromptLog } from '../src/ingest/parsers/history';
import { isConversationsEntry, parseExportArchive } from '../src/ingest/parsers/export-inbox';
import { toStream } from './fixtures';
import {
  chatgptExportZip,
  chatgptWebConversation,
  claudeExportZip,
  claudeWebConversation,
  emptyExportZip,
  historyLines,
} from './web-fixtures';

/** Every turn's [byteStart, byteLen) slice of the raw must contain the given anchor, and turn
 * offsets must be strictly increasing (monotonic with turn_index) so viewer byte-windows page. */
function assertOffsets(raw: string, turns: Array<{ blocks: Array<{ byteStart: number; byteLen: number }> }>, anchorOf: (i: number) => string): void {
  let prev = -1;
  turns.forEach((t, i) => {
    const b = t.blocks[0]!;
    expect(b.byteStart).toBeGreaterThan(prev);
    prev = b.byteStart;
    expect(b.byteStart).toBeGreaterThanOrEqual(0);
    expect(b.byteStart + b.byteLen).toBeLessThanOrEqual(raw.length);
    expect(raw.slice(b.byteStart, b.byteStart + b.byteLen)).toContain(anchorOf(i));
  });
}

describe('parseChatgptWeb', () => {
  it('parses a mapping tree into turns with roles, thinking, tool calls, images, model and title', () => {
    const raw = chatgptWebConversation({
      id: 'conv-cgpt-1',
      title: 'Flurbo analysis',
      turns: [
        { node: 'n1', parent: 'root-node', role: 'user', text: 'summarize the flurbo report please' },
        { node: 'n2', parent: 'n1', role: 'assistant', thinking: 'the user wants a flurbo summary', model: 'gpt-test-4o' },
        { node: 'n3', parent: 'n2', role: 'assistant', tool: { recipient: 'python', code: 'open("flurbo.txt").read()' }, model: 'gpt-test-4o' },
        { node: 'n4', parent: 'n3', role: 'tool', text: 'flurbo count: 42' },
        { node: 'n5', parent: 'n4', role: 'assistant', text: 'The flurbo report shows 42 flurbos.', model: 'gpt-test-4o' },
      ],
      currentNode: 'n5',
    });
    const s = parseChatgptWeb(raw, 'conv-cgpt-1');

    expect(s.harness).toBe('chatgpt-web');
    expect(s.title).toBe('Flurbo analysis');
    expect(s.models).toEqual(['gpt-test-4o']);
    expect(s.primaryModel).toBe('gpt-test-4o');
    expect(s.turns.map((t) => t.role)).toEqual(['user', 'assistant', 'assistant', 'tool', 'assistant']);
    expect(s.turns[1]!.blocks[0]!.type).toBe('thinking');
    const toolUse = s.turns[2]!.blocks[0]!;
    expect(toolUse.type).toBe('tool_use');
    expect(toolUse.toolName).toBe('python');
    expect(s.turns[3]!.blocks[0]!.type).toBe('tool_result');
    expect(s.turns.every((t) => t.onMainPath)).toBe(true);
    assertOffsets(raw, s.turns, (i) => ['n1', 'n2', 'n3', 'n4', 'n5'][i]!);
  });

  it('dims an abandoned (regenerated) branch not on the current_node path', () => {
    const raw = chatgptWebConversation({
      id: 'conv-cgpt-2',
      turns: [
        { node: 'n1', parent: 'root-node', role: 'user', text: 'question' },
        { node: 'n2', parent: 'n1', role: 'assistant', text: 'first answer (regenerated away)' },
        { node: 'n3', parent: 'n1', role: 'assistant', text: 'second answer (current)' },
      ],
      currentNode: 'n3',
    });
    const s = parseChatgptWeb(raw, 'conv-cgpt-2');
    const byText = (t: string) => s.turns.find((x) => x.blocks.some((b) => b.text?.includes(t)))!;
    expect(byText('regenerated away').onMainPath).toBe(false);
    expect(byText('second answer').onMainPath).toBe(true);
    expect(byText('question').onMainPath).toBe(true);
  });

  it('extracts multimodal text and renders image asset pointers as inert placeholders (no blob-backed media)', () => {
    const raw = chatgptWebConversation({
      id: 'conv-cgpt-3',
      turns: [{ node: 'n1', parent: 'root-node', role: 'user', multimodal: ['look at this', { image: 'abc123' }] }],
    });
    const s = parseChatgptWeb(raw, 'conv-cgpt-3');
    // Web media is a reference, not inline bytes: only text blocks, never a blob-backed 'image'.
    expect(s.turns[0]!.blocks.every((b) => b.type === 'text')).toBe(true);
    expect(s.turns[0]!.blocks.map((b) => b.text)).toEqual(['look at this', '[image]']);
  });

  it('counts unknown content types without crashing (empty conversation yields no turns)', () => {
    const empty = parseChatgptWeb(JSON.stringify({ mapping: { 'root-node': { id: 'root-node', message: null, parent: null, children: [] } }, current_node: 'root-node' }), 'conv-empty');
    expect(empty.turns).toHaveLength(0);
    expect(empty.stats.parseErrorLines).toBe(0);
  });

  it('does not throw on malformed JSON, records a parse error', () => {
    const s = parseChatgptWeb('{ not valid json', 'conv-bad');
    expect(s.turns).toHaveLength(0);
    expect(s.stats.parseErrorLines).toBe(1);
  });
});

describe('parseClaudeWeb', () => {
  it('parses chat_messages with content blocks, tool use/result, thinking, model and title', () => {
    const raw = claudeWebConversation({
      uuid: 'conv-cw-1',
      name: 'Gallium notes',
      model: 'claude-test-web',
      messages: [
        { uuid: 'm1', parent: '00000000-0000-4000-8000-000000000000', sender: 'human', content: [{ type: 'text', text: 'find the melting point of gallium' }] },
        {
          uuid: 'm2',
          parent: 'm1',
          sender: 'assistant',
          content: [
            { type: 'thinking', thinking: 'searching the notes' },
            { type: 'tool_use', id: 'tu1', name: 'search_notes', input: { q: 'gallium' } },
          ],
        },
        { uuid: 'm3', parent: 'm2', sender: 'human', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'gallium melts at 29.76 C' }] }] },
        { uuid: 'm4', parent: 'm3', sender: 'assistant', content: [{ type: 'text', text: 'Gallium melts just below body temperature.' }] },
      ],
      currentLeaf: 'm4',
    });
    const s = parseClaudeWeb(raw, 'conv-cw-1');

    expect(s.harness).toBe('claude-web');
    expect(s.title).toBe('Gallium notes');
    expect(s.models).toEqual(['claude-test-web']);
    expect(s.turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(s.turns[1]!.blocks.map((b) => b.type)).toEqual(['thinking', 'tool_use']);
    expect(s.turns[1]!.blocks[1]!.toolName).toBe('search_notes');
    expect(s.turns[2]!.blocks[0]!.type).toBe('tool_result');
    expect(s.turns[2]!.blocks[0]!.text).toContain('29.76');
    expect(s.turns.every((t) => t.onMainPath)).toBe(true);
    assertOffsets(raw, s.turns, (i) => ['m1', 'm2', 'm3', 'm4'][i]!);
  });

  it('dims an edited branch not on the current_leaf path', () => {
    const raw = claudeWebConversation({
      uuid: 'conv-cw-2',
      messages: [
        { uuid: 'm1', parent: '00000000-0000-4000-8000-000000000000', sender: 'human', text: 'the question' },
        { uuid: 'm2', parent: 'm1', sender: 'assistant', text: 'abandoned reply' },
        { uuid: 'm3', parent: 'm1', sender: 'assistant', text: 'current reply' },
      ],
      currentLeaf: 'm3',
    });
    const s = parseClaudeWeb(raw, 'conv-cw-2');
    const byText = (t: string) => s.turns.find((x) => x.blocks.some((b) => b.text?.includes(t)))!;
    expect(byText('abandoned reply').onMainPath).toBe(false);
    expect(byText('current reply').onMainPath).toBe(true);
  });

  it('falls back to flat text when the content array is empty or only unknown types (skip-and-count)', () => {
    const raw = claudeWebConversation({
      uuid: 'conv-cw-3',
      messages: [
        { uuid: 'm1', parent: '00000000-0000-4000-8000-000000000000', sender: 'human', content: [], text: 'flat rendering only' },
        { uuid: 'm2', parent: 'm1', sender: 'assistant', content: [{ type: 'brand_new_block', foo: 1 }], text: 'assistant flat fallback' },
      ],
    });
    const s = parseClaudeWeb(raw, 'conv-cw-3');
    expect(s.turns.map((t) => t.blocks[0]!.text)).toEqual(['flat rendering only', 'assistant flat fallback']);
    expect(s.stats.skippedLineTypes['content:brand_new_block']).toBe(1);
  });

  it('yields no turns for an empty conversation and does not throw on malformed JSON', () => {
    expect(parseClaudeWeb(JSON.stringify({ uuid: 'c', chat_messages: [] }), 'c').turns).toHaveLength(0);
    const bad = parseClaudeWeb('not json {{{', 'c');
    expect(bad.turns).toHaveLength(0);
    expect(bad.stats.parseErrorLines).toBe(1);
  });
});

describe('parsePromptLog (history.jsonl)', () => {
  it('turns each prompt line into a user prompt block with byte offsets, title and time range', async () => {
    const lines = historyLines([
      { display: 'first prompt about widgets', timestamp: 1_700_000_000_000, project: '/home/tester/src/demo' },
      { prompt: 'second prompt', timestamp: 1_700_000_100_000 },
      { raw: 'this is not json {{{' },
      { display: '', timestamp: 1_700_000_150_000 }, // well-formed but no prompt text
      { display: 'third prompt', timestamp: 1_700_000_200_000 },
    ]);
    const s = await parsePromptLog(readJsonlLines(toStream(lines)), 'promptlog:testbox:claude');

    expect(s.harness).toBe('prompt-log');
    expect(s.title).toBe('first prompt about widgets');
    expect(s.cwd).toBe('/home/tester/src/demo');
    expect(s.turns.map((t) => t.blocks[0]!.text)).toEqual(['first prompt about widgets', 'second prompt', 'third prompt']);
    expect(s.turns.every((t) => t.role === 'user' && t.blocks[0]!.type === 'prompt')).toBe(true);
    expect(s.stats.parseErrorLines).toBe(1);
    expect(s.stats.skippedLineTypes['no-prompt-text']).toBe(1);
    // Epoch-ms normalized to ISO; range spans first..last.
    expect(s.startedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(s.endedAt).toBe(new Date(1_700_000_200_000).toISOString());
    // An already-ISO timestamp passes straight through.
    const iso = await parsePromptLog(readJsonlLines(toStream(historyLines([{ display: 'p', timestamp: '2026-07-02T09:00:00.000Z' }]))), 'pl');
    expect(iso.turns[0]!.ts).toBe('2026-07-02T09:00:00.000Z');

    // Byte offsets re-slice to the source line (same invariant as the other JSONL parsers).
    const rawBytes = new TextEncoder().encode(lines.join('\n') + '\n');
    for (const t of s.turns) {
      const b = t.blocks[0]!;
      const slice = new TextDecoder().decode(rawBytes.subarray(b.byteStart, b.byteStart + b.byteLen));
      expect(slice).toContain(b.text);
    }
  });

  it('caps an oversized prompt and flags truncation', async () => {
    const huge = 'q'.repeat(40_000);
    const s = await parsePromptLog(readJsonlLines(toStream(historyLines([{ display: huge, timestamp: 1 }]))), 'pl');
    expect(s.turns[0]!.blocks[0]!.text!.length).toBe(16 * 1024);
    expect(s.turns[0]!.blocks[0]!.truncated).toBe(true);
  });
});

describe('parseExportArchive', () => {
  it('fans a ChatGPT export ZIP into per-conversation sessions keyed by conversation id', () => {
    const zip = chatgptExportZip([
      { id: 'exp-cgpt-a', title: 'A', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'alpha question' }] },
      { id: 'exp-cgpt-b', title: 'B', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'beta question' }] },
    ]);
    const archive = parseExportArchive(zip);
    expect(archive.harness).toBe('chatgpt-web');
    expect(archive.sessions.map((s) => s.id).sort()).toEqual(['exp-cgpt-a', 'exp-cgpt-b']);
    expect(archive.sessions.every((s) => s.harness === 'chatgpt-web')).toBe(true);
    expect(archive.skipped).toBe(0);
  });

  it('fans a claude.ai export ZIP into per-conversation sessions', () => {
    const zip = claudeExportZip([
      { uuid: 'exp-cw-a', name: 'A', messages: [{ uuid: 'm1', parent: '00000000-0000-4000-8000-000000000000', sender: 'human', text: 'alpha' }] },
    ]);
    const archive = parseExportArchive(zip);
    expect(archive.harness).toBe('claude-web');
    expect(archive.sessions[0]!.id).toBe('exp-cw-a');
    expect(archive.sessions[0]!.harness).toBe('claude-web');
  });

  it('treats a well-formed empty conversations.json array as VALID (empty), distinct from corrupt', () => {
    const emptyArray = parseExportArchive(chatgptExportZip([]));
    expect(emptyArray.valid).toBe(true);
    expect(emptyArray.sessions).toHaveLength(0);

    const noConvFile = parseExportArchive(emptyExportZip());
    expect(noConvFile.valid).toBe(false);
    expect(noConvFile.error).toMatch(/conversations\.json/);

    const corrupt = parseExportArchive(new Uint8Array([1, 2, 3, 4]));
    expect(corrupt.valid).toBe(false);
    expect(corrupt.error).toBeTruthy();
  });

  it('inflates only conversations.json — a large ancillary entry does not sink the parse', () => {
    // A large attachment blob alongside a small conversations.json; the fflate filter must skip it.
    const zip = chatgptExportZip(
      [{ id: 'big-a', title: 'A', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'small conversation' }] }],
      { 'attachments/huge.bin': 'x'.repeat(200_000) },
    );
    const archive = parseExportArchive(zip);
    expect(archive.valid).toBe(true);
    expect(archive.sessions.map((s) => s.id)).toEqual(['big-a']);
  });

  it('isConversationsEntry matches root/nested conversations.json only', () => {
    expect(isConversationsEntry('conversations.json')).toBe(true);
    expect(isConversationsEntry('export/conversations.json')).toBe(true);
    expect(isConversationsEntry('Conversations.JSON')).toBe(true);
    expect(isConversationsEntry('user.json')).toBe(false);
    expect(isConversationsEntry('attachments/image.png')).toBe(false);
  });
});
