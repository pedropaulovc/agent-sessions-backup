/** Normalized session model shared by all harness parsers, the index writer, and the APIs. */

export type Harness =
  | 'claude-code'
  | 'codex'
  | 'chatgpt-web'
  | 'claude-web'
  | 'claude-cowork'
  | 'prompt-log'
  | 'omp'
  | 'unknown';

export type Role = 'user' | 'assistant' | 'system' | 'developer' | 'tool';

export interface ExternalAssetRef {
  digest: string;
  fileName: string;
  mediaType: string;
}

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
  externalAsset?: ExternalAssetRef;
  byteStart: number;
  byteLen: number;
}

const RASTER_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
/** Normalize a MIME value before comparing or rendering it. */
export function normalizeMediaType(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.split(';', 1)[0]?.trim().toLowerCase();
  return normalized || undefined;
}


/** Convert an external source path into the bounded, R2-safe filename used for asset keys. */
export function safeAssetFilename(sourcePath: string | undefined): string {
  const base = (sourcePath ?? '').split(/[\\/]/).pop() ?? '';
  let safe = base.replace(/[^A-Za-z0-9._-]/g, '_');
  if (safe.length > 128) {
    const dot = safe.lastIndexOf('.');
    const suffix = dot > 0 ? safe.slice(dot) : '';
    safe = suffix.length > 0 && suffix.length < 128
      ? `${safe.slice(0, 128 - suffix.length)}${suffix}`
      : safe.slice(0, 128);
  }
  return safe || 'asset';
}

/** Suffix for an external asset relative to the owning transcript's R2 key. */
export function assetRelSuffix(parentRelpath: string, digest: string, fileName: string): string {
  return `${parentRelpath}.assets/${digest.toLowerCase()}/${safeAssetFilename(fileName)}`;
}

/** Extract validated external image metadata without retaining the local source path. */
export function externalAssetFromImage(
  raw: Record<string, unknown>,
  enclosingDetails?: Record<string, unknown>,
): ExternalAssetRef | undefined {
  const source = isRecord(raw.source) ? raw.source : undefined;
  const rawDetails = isRecord(raw.details) ? raw.details : undefined;
  const details = isRecord(rawDetails?.meta) ? rawDetails : enclosingDetails;
  const meta = isRecord(details?.meta) ? details.meta : undefined;
  const sourceMeta = isRecord(meta?.source) ? meta.source : undefined;
  const sourcePath = typeof sourceMeta?.value === 'string' ? sourceMeta.value : undefined;
  const data = typeof raw.data === 'string' ? raw.data : typeof source?.data === 'string' ? source.data : undefined;
  const digest = data?.match(/^blob:sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase();
  const rawMediaType =
    typeof raw.mimeType === 'string' ? raw.mimeType :
    typeof raw.mediaType === 'string' ? raw.mediaType :
    typeof raw.media_type === 'string' ? raw.media_type :
    typeof raw.mime === 'string' ? raw.mime :
    typeof source?.mimeType === 'string' ? source.mimeType :
    typeof source?.mime_type === 'string' ? source.mime_type :
    typeof source?.media_type === 'string' ? source.media_type :
    typeof source?.mediaType === 'string' ? source.mediaType :
    typeof source?.mime === 'string' ? source.mime : undefined;
  const mediaType = normalizeMediaType(rawMediaType);
  if (!digest || !sourcePath || !mediaType || !RASTER_MEDIA_TYPES.has(mediaType)) return undefined;
  return { digest, fileName: safeAssetFilename(sourcePath), mediaType };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  /** Source line offsets for a blockless marker turn (compaction). Lets the index writer persist a row
   * so pagination/byte-windows account for the turn even though it yields no content blocks. */
  byteStart?: number;
  byteLen?: number;
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
