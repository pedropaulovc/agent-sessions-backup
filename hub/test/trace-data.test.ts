import { describe, expect, it } from 'vitest';
import { readJsonlLines } from '../src/ingest/jsonl';
import type { NormalizedTurn } from '../src/ingest/normalize';
import { parseOmp } from '../src/ingest/parsers/omp';
import { buildSessionTrace } from '../src/viewer/trace-data';
import { toStream } from './fixtures';

const epoch = Date.parse('2026-07-19T10:00:00.000Z');

function model(timing?: NormalizedTurn['timing']): NormalizedTurn {
  return {
    index: 0, role: 'assistant', onMainPath: true, ts: new Date(epoch + 9000).toISOString(), timing,
    blocks: [{ type: 'text', text: 'Answer', byteStart: 0, byteLen: 1 }],
  };
}

async function parse(records: object[]) {
  const session = await parseOmp(readJsonlLines(toStream([
    JSON.stringify({ type: 'session', id: 'trace-test', version: 3 }),
    ...records.map((record) => JSON.stringify(record)),
  ])), 'trace-test');
  return session.turns.map((turn) => ({ turn, turnIndex: turn.index + 20, onMainPath: turn.onMainPath }));
}

describe('buildSessionTrace', () => {
  it('distinguishes recorded durations from lone timestamps and rejects invalid or reversed intervals', () => {
    const turns = [
      model({ startMs: epoch + 1000, endMs: epoch + 3000 }),
      model({ startMs: epoch + 4000, durationMs: 1000 }),
      model({ endMs: epoch + 6000, durationMs: 500 }),
      model({ startMs: epoch + 2000 }),
      model({ startMs: epoch + 3000, endMs: epoch + 1000, durationMs: 500 }),
      model({ startMs: NaN, endMs: Infinity, durationMs: -1 }),
      model(),
      { ...model(), ts: undefined },
    ].map((turn) => ({ turn, onMainPath: true }));
    const { events } = buildSessionTrace(turns, 'chronological');
    expect(events.slice(0, 3).map((event) => [event.timing, event.startMs, event.endMs])).toEqual([
      ['recorded', epoch + 1000, epoch + 3000],
      ['recorded', epoch + 4000, epoch + 5000],
      ['recorded', epoch + 5500, epoch + 6000],
    ]);
    expect(events.slice(3).map((event) => [event.timing, event.startMs, event.endMs])).toEqual([
      ['timestamp', epoch + 2000, undefined],
      ['timestamp', epoch + 9000, undefined],
      ['timestamp', epoch + 9000, undefined],
      ['timestamp', epoch + 9000, undefined],
      ['timestamp', undefined, undefined],
    ]);
  });

  it('joins out-of-order results through lifecycle metadata and links to the call, not a suppressed result', async () => {
    const turns = await parse([
      { type: 'message', parentId: 'start', timestamp: new Date(epoch + 9000).toISOString(), message: {
        id: 'result', role: 'toolResult', toolCallId: 'call', timestamp: epoch + 3600, isError: true,
        content: [{ type: 'text', text: 'first chunk' }, { type: 'text', text: 'second chunk' }],
      } },
      { type: 'custom', id: 'start', parentId: 'assistant', customType: 'tool_execution_start', data: {
        toolCallId: 'call', startedAt: new Date(epoch + 3100).toISOString(),
      } },
      { type: 'message', id: 'assistant', timestamp: new Date(epoch + 8000).toISOString(), message: {
        role: 'assistant', model: 'test-model', timestamp: epoch + 1000, completedAt: epoch + 3000,
        usage: { input: 12, output: 4 }, content: [{ type: 'toolCall', id: 'call', name: 'read', arguments: {} }],
      } },
      { type: 'message', id: 'final', parentId: 'result', message: { role: 'assistant', content: 'Done' } },
    ]);
    const trace = buildSessionTrace(turns, 'effective');
    expect(trace.events.map((event) => event.kind)).toEqual(['model', 'tool', 'model']);
    expect(trace.events[0]).toMatchObject({ timing: 'recorded', startMs: epoch + 1000, endMs: epoch + 3000, inputTokens: 12, outputTokens: 4 });
    expect(trace.events[1]).toMatchObject({ label: 'read', timing: 'recorded', startMs: epoch + 3100, endMs: epoch + 3600, isError: true, turnIndex: 21 });
    const resultOnly = buildSessionTrace(turns.slice(0, 1), 'effective').events;
    expect(resultOnly).toMatchObject([{ kind: 'tool', label: 'read', turnIndex: 20, timing: 'recorded' }]);
  });

  it('does not borrow results or start markers across branches with reused tool ids', async () => {
    const turns = await parse([
      { type: 'message', id: 'root', message: { role: 'user', content: 'Run it' } },
      { type: 'message', id: 'old-call', parentId: 'root', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'reused', name: 'old-tool' }] } },
      { type: 'custom', id: 'old-start', parentId: 'old-call', customType: 'tool_execution_start', data: { toolCallId: 'reused', startedAt: epoch + 1000 } },
      { type: 'message', id: 'old-result', parentId: 'old-start', message: { role: 'toolResult', toolCallId: 'reused', timestamp: epoch + 2000, isError: true, content: 'old' } },
      { type: 'message', id: 'new-call', parentId: 'root', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'reused', name: 'new-tool' }] } },
      { type: 'message', id: 'new-result', parentId: 'new-call', message: { role: 'toolResult', toolCallId: 'reused', timestamp: epoch + 6000, content: 'new' } },
      { type: 'message', id: 'orphan', parentId: 'root', message: { role: 'toolResult', toolCallId: 'reused', timestamp: epoch + 7000, content: 'not a descendant of either call' } },
      { type: 'message', id: 'final', parentId: 'new-result', message: { role: 'assistant', content: 'Done' } },
    ]);
    const chronological = buildSessionTrace(turns, 'chronological').events.filter((event) => event.kind === 'tool');
    expect(chronological.map((event) => [event.label, event.timing, event.isError])).toEqual([
      ['old-tool', 'recorded', true],
      ['new-tool', 'timestamp', undefined],
      ['Tool result', 'timestamp', undefined],
    ]);
    expect(chronological[1]?.endMs).toBeUndefined();
    expect(buildSessionTrace(turns, 'effective').events.filter((event) => event.kind === 'tool')).toMatchObject([
      { label: 'new-tool', timing: 'timestamp', startMs: epoch + 6000, turnIndex: 23 },
    ]);
  });
});
