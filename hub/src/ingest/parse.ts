import { readJsonlLines } from './jsonl';
import type { Harness, NormalizedSession } from './normalize';
import { parseChatgptWeb } from './parsers/chatgpt-web';
import { parseClaudeCode } from './parsers/claude-code';
import { parseClaudeWeb } from './parsers/claude-web';
import { parseCodex } from './parsers/codex';
import { parsePromptLog } from './parsers/history';

/**
 * Harnesses whose raw object holds exactly ONE session and therefore flow through the standard
 * canonical/dedupe machinery. Export ZIPs are excluded — one archive fans out to many sessions and
 * is handled specially in the consumer.
 */
export const SINGLE_SESSION_HARNESSES: ReadonlySet<Harness> = new Set<Harness>([
  'claude-code',
  'codex',
  'chatgpt-web',
  'claude-web',
  'prompt-log',
]);

/** Web-capture conversations are one JSON document (no line structure) — read whole, never windowed. */
export function isWebHarness(harness: string): boolean {
  return harness === 'chatgpt-web' || harness === 'claude-web';
}

/** Parse a single-session R2 object end to end, routing by harness (whole document vs JSONL stream). */
export async function parseObject(
  harness: Harness,
  sessionId: string,
  obj: R2ObjectBody,
): Promise<NormalizedSession> {
  if (harness === 'chatgpt-web') return parseChatgptWeb(await obj.text(), sessionId);
  if (harness === 'claude-web') return parseClaudeWeb(await obj.text(), sessionId);
  const lines = readJsonlLines(obj.body);
  if (harness === 'codex') return parseCodex(lines, sessionId);
  if (harness === 'prompt-log') return parsePromptLog(lines, sessionId);
  return parseClaudeCode(lines, sessionId);
}
