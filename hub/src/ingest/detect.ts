import type { Harness } from './normalize';

export interface Detection {
  harness: Harness;
  sessionId?: string;
  /** For Claude Code subagent transcripts: parent session UUID from the path. */
  parentSessionId?: string;
  kind: 'session' | 'subagent' | 'subagent-meta' | 'prompt-log' | 'other';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Map (store, relpath) → harness/session identity. Unknown shapes are stored but not parsed. */
export function detect(store: string, relpath: string): Detection {
  const parts = relpath.split('/');
  const base = parts[parts.length - 1] ?? '';

  if (store === 'claude-projects' || store === 'claude') {
    // <slug>/<uuid>.jsonl
    if (base.endsWith('.jsonl')) {
      const stem = base.slice(0, -'.jsonl'.length);
      const subagentsIdx = parts.indexOf('subagents');
      if (subagentsIdx > 0 && stem.startsWith('agent-')) {
        const parent = parts[subagentsIdx - 1];
        return {
          harness: 'claude-code',
          sessionId: stem.replace(/^agent-/, ''),
          parentSessionId: parent && UUID_RE.test(parent) ? parent : undefined,
          kind: 'subagent',
        };
      }
      if (UUID_RE.test(stem)) {
        return { harness: 'claude-code', sessionId: stem, kind: 'session' };
      }
    }
    if (base.endsWith('.meta.json') && parts.includes('subagents')) {
      return { harness: 'claude-code', kind: 'subagent-meta' };
    }
    if (base === 'history.jsonl') return { harness: 'prompt-log', kind: 'prompt-log' };
    return { harness: 'unknown', kind: 'other' };
  }

  if (store === 'codex-sessions' || store === 'codex') {
    // YYYY/MM/DD/rollout-<ts>-<uuidv7>.jsonl
    const m = base.match(/^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    if (m) return { harness: 'codex', sessionId: m[1]!.toLowerCase(), kind: 'session' };
    if (base === 'history.jsonl') return { harness: 'prompt-log', kind: 'prompt-log' };
    return { harness: 'unknown', kind: 'other' };
  }

  if (store === 'chatgpt-web' && base.endsWith('.json')) {
    return { harness: 'chatgpt-web', sessionId: base.slice(0, -'.json'.length), kind: 'session' };
  }
  if (store === 'claude-web' && base.endsWith('.json')) {
    return { harness: 'claude-web', sessionId: base.slice(0, -'.json'.length), kind: 'session' };
  }

  return { harness: 'unknown', kind: 'other' };
}
