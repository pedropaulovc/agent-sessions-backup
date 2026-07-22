import { describe, expect, it } from 'vitest';
import { computeFirstInteractionTitle, sessionDisplayTitle, type TitleBlock } from '../src/session-title';

/** Build an eligible main-path user/assistant text block; override any field per case. */
function block(overrides: Partial<TitleBlock> & { text: string | null }): TitleBlock {
  return {
    turnIndex: 0,
    blockIndex: 0,
    role: 'user',
    btype: 'text',
    onMainPath: true,
    ...overrides,
  };
}

/** One block per turn, numbered in order. */
function turns(...texts: (string | null)[]): TitleBlock[] {
  return texts.map((text, i) => block({ turnIndex: i, text }));
}

describe('computeFirstInteractionTitle', () => {
  it('returns the first eligible user/agent text, trimmed and capped at 120 chars', () => {
    expect(computeFirstInteractionTitle(turns('  Hello there  '))).toBe('Hello there');
    const long = 'x'.repeat(200);
    expect(computeFirstInteractionTitle(turns(long))).toBe('x'.repeat(120));
  });

  it('returns null when no block qualifies', () => {
    expect(computeFirstInteractionTitle([])).toBe(null);
    expect(computeFirstInteractionTitle(turns('   ', ''))).toBe(null);
  });

  it('ignores tool, system, non-text, off-main-path, and null-text blocks', () => {
    expect(
      computeFirstInteractionTitle([
        block({ turnIndex: 0, role: 'tool', text: 'tool result' }),
        block({ turnIndex: 1, role: 'system', text: 'system prompt' }),
        block({ turnIndex: 2, btype: 'thinking', text: 'thinking' }),
        block({ turnIndex: 3, onMainPath: false, text: 'abandoned' }),
        block({ turnIndex: 4, text: null }),
        block({ turnIndex: 5, text: 'the real prompt' }),
      ]),
    ).toBe('the real prompt');
  });

  it('strips a leading image wrapper and titles from the prompt after it', () => {
    const text = '<image name=[Image #1] path="a.png">\n</image>\n\nInspect the drawing';
    expect(computeFirstInteractionTitle(turns(text))).toBe('Inspect the drawing');
  });

  it('strips a leading fork-boilerplate wrapper and titles from the prompt after it', () => {
    const text = '<fork-boilerplate>\ninherited context\n</fork-boilerplate>\n\nRefactor the title logic';
    expect(computeFirstInteractionTitle(turns(text))).toBe('Refactor the title logic');
  });

  it('strips interleaved image and fork-boilerplate wrappers', () => {
    const text =
      '<image name=[Image #1] path="a.png">\n</image>\n\n' +
      '<fork-boilerplate>\nctx\n</fork-boilerplate>\n\nMixed wrappers prompt';
    expect(computeFirstInteractionTitle(turns(text))).toBe('Mixed wrappers prompt');
  });

  it('falls through to a later turn when a block is only wrapper boilerplate', () => {
    expect(
      computeFirstInteractionTitle(
        turns('<fork-boilerplate>\njust context\n</fork-boilerplate>', 'Second turn prompt'),
      ),
    ).toBe('Second turn prompt');
  });

  it('rejects a whole turn whose representative starts with an injected wrapper', () => {
    expect(
      computeFirstInteractionTitle([
        block({ turnIndex: 0, blockIndex: 0, text: '<system-reminder>injected</system-reminder>' }),
        // same turn, later block: the turn is already dropped, this must not become the title
        block({ turnIndex: 0, blockIndex: 1, text: 'same-turn text must not title' }),
        block({ turnIndex: 1, text: 'first later turn title' }),
      ]),
    ).toBe('first later turn title');
  });

  it('skips server-tool metadata to a real block later in the same turn', () => {
    expect(
      computeFirstInteractionTitle([
        block({ turnIndex: 0, blockIndex: 0, text: '{"type":"server_tool_use","id":"x"}' }),
        block({ turnIndex: 0, blockIndex: 1, text: 'real text after server tool metadata' }),
      ]),
    ).toBe('real text after server tool metadata');
  });

  it('decodes a scheduled-task name from its attribute, ignoring the path and body', () => {
    const text =
      '<scheduled-task name="update&amp;daily&#45;notes" file="C:\\x\\SKILL.md">body</scheduled-task>';
    expect(computeFirstInteractionTitle(turns(text))).toBe('update&daily-notes');
  });

  it('uses a teammate-message summary attribute, decoded', () => {
    const text = '<teammate-message from="lead" summary="Fix &amp; verify &quot;it&quot; &#x1F680;">body</teammate-message>';
    expect(computeFirstInteractionTitle(turns(text))).toBe('Fix & verify "it" 🚀');
  });

  it('uses a teammate-message task_assignment subject (plain, no decode)', () => {
    const text = '<teammate-message>{"type":"task_assignment","subject":"Ship the feature"}</teammate-message>';
    expect(computeFirstInteractionTitle(turns(text))).toBe('Ship the feature');
  });

  it('extracts nested task-notification, command-message, and task subjects', () => {
    expect(
      computeFirstInteractionTitle(turns('<task-notification>\n<summary>Background &#x2705;</summary>\n</task-notification>')),
    ).toBe('Background ✅');
    expect(
      computeFirstInteractionTitle(turns('<command-message>run the &lt;thing&gt;</command-message>')),
    ).toBe('run the <thing>');
    expect(computeFirstInteractionTitle(turns('<task>\ndo the work\n</task>'))).toBe('do the work');
  });

  it('does not treat <taskboard> as a <task> element', () => {
    expect(computeFirstInteractionTitle(turns('<taskboard>not a task</taskboard>'))).toBe('<taskboard>not a task</taskboard>');
  });
});

describe('sessionDisplayTitle', () => {
  it('prefers the derived title, then the stored title, then the session id', () => {
    expect(sessionDisplayTitle('derived', 'stored', 'sess-1')).toBe('derived');
    expect(sessionDisplayTitle(null, 'stored', 'sess-1')).toBe('stored');
    expect(sessionDisplayTitle(null, null, 'sess-1')).toBe('sess-1');
    expect(sessionDisplayTitle('', '', 'sess-1')).toBe('sess-1');
  });
});
