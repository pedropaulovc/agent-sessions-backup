import type { Harness } from './normalize';

export interface Detection {
  harness: Harness;
  sessionId?: string;
  /** For Claude Code subagent transcripts: parent session UUID from the path. */
  parentSessionId?: string;
  kind: 'session' | 'subagent' | 'subagent-meta' | 'prompt-log' | 'export-archive' | 'other';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Map (store, relpath) → harness/session identity. Unknown shapes are stored but not parsed.
 *
 * `machineId` scopes the synthetic session id for machine-global files that share a relpath
 * across the fleet (`history.jsonl` is the same path on every box): each machine's prompt log is
 * a distinct session, so it must NOT collapse into one via canonical dedupe. Callers that only
 * need the harness (e.g. a reparse that already knows the session id) may omit it.
 */
export function detect(store: string, relpath: string, machineId?: string): Detection {
  const parts = relpath.split('/');
  const base = parts[parts.length - 1] ?? '';

  if (store === 'export-inbox') {
    // A whole export ZIP is an archive of MANY conversations, not one session — parsed hub-side
    // into per-conversation sessions (see consumer.ts). Session id is assigned per conversation.
    if (base.endsWith('.zip')) return { harness: 'unknown', kind: 'export-archive' };
    return { harness: 'unknown', kind: 'other' };
  }

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
    if (base === 'history.jsonl') return promptLog(store, machineId);
    return { harness: 'unknown', kind: 'other' };
  }

  if (store === 'codex-sessions' || store === 'codex') {
    // YYYY/MM/DD/rollout-<ts>-<uuidv7>.jsonl
    const m = base.match(/^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    if (m) return { harness: 'codex', sessionId: m[1]!.toLowerCase(), kind: 'session' };
    if (base === 'history.jsonl') return promptLog(store, machineId);
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

/**
 * history.jsonl is machine-global (one per `~/.claude` or `~/.codex`), and its relpath is
 * identical on every machine — so the session id must fold in machine_id AND store, or two
 * machines' prompt logs would dedupe into one and lose data. Without a machine_id (harness-only
 * callers), leave the id undefined; the harness is still correctly 'prompt-log'.
 */
function promptLog(store: string, machineId: string | undefined): Detection {
  return {
    harness: 'prompt-log',
    kind: 'prompt-log',
    sessionId: machineId ? `promptlog:${machineId}:${store}` : undefined,
  };
}
