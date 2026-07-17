/** Normalized session model shared by all harness parsers, the index writer, and the APIs. */

export type Harness =
  | 'claude-code'
  | 'codex'
  | 'chatgpt-web'
  | 'claude-web'
  | 'claude-cowork'
  | 'prompt-log'
  | 'unknown';

export type Role = 'user' | 'assistant' | 'system' | 'developer' | 'tool';

export interface NormalizedBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image' | 'document' | 'prompt';
  /** Indexable text, already capped. Absent for image/document. */
  text?: string;
  truncated?: boolean;
  toolUseId?: string;
  toolName?: string;
  isError?: boolean;
  subagentSessionId?: string;
  mediaType?: string;
  byteStart: number;
  byteLen: number;
}

export interface TurnUsage {
  model?: string;
  serviceTier?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheCreation5mTokens?: number;
  cacheCreation1hTokens?: number;
  cacheReadTokens?: number;
  inferenceGeo?: string;
  requestId?: string;
}

export interface NormalizedTurn {
  index: number;
  id?: string;
  parentId?: string;
  onMainPath: boolean;
  role: Role;
  ts?: string;
  model?: string;
  usage?: TurnUsage;
  compaction?: { kind: 'codex-window' | 'claude-compact'; replacesTurns?: [number, number] };
  blocks: NormalizedBlock[];
}

export interface NormalizedSession {
  id: string;
  harness: Harness;
  cwd?: string;
  repoUrl?: string;
  gitBranch?: string;
  models: string[];
  primaryModel?: string;
  title?: string;
  startedAt?: string;
  endedAt?: string;
  parentSessionId?: string;
  parentToolUseId?: string;
  isSidechain: boolean;
  harnessVersion?: string;
  turns: NormalizedTurn[];
  /** Line-level accounting for parse quality gates. */
  stats: { lines: number; parseErrorLines: number; skippedLineTypes: Record<string, number> };
}

/** Byte caps for indexable text per block type (plan: 16K text/thinking, 2K tool_use, 4K tool_result). */
export const CAPS = {
  text: 16 * 1024,
  thinking: 16 * 1024,
  tool_use: 2 * 1024,
  tool_result: 4 * 1024,
  prompt: 16 * 1024,
} as const;

export function cap(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}
