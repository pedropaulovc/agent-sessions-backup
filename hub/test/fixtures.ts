/** Synthetic fixture builders mirroring real on-disk schemas. No real session content — the repo is public. */

export const CC_SESSION_ID = '11111111-2222-4333-8444-555555555555';
export const CC_SUBAGENT_PARENT = CC_SESSION_ID;

export function ccUserLine(opts: {
  uuid: string;
  parentUuid?: string | null;
  text?: string;
  toolResult?: { toolUseId: string; content: string; toolUseResult?: unknown };
  image?: boolean;
  ts?: string;
}): string {
  const content: unknown[] = [];
  if (opts.text) content.push({ type: 'text', text: opts.text });
  if (opts.toolResult) {
    content.push({ type: 'tool_result', tool_use_id: opts.toolResult.toolUseId, content: opts.toolResult.content });
  }
  if (opts.image) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8='.repeat(10) } });
  }
  return JSON.stringify({
    parentUuid: opts.parentUuid ?? null,
    isSidechain: false,
    userType: 'external',
    cwd: '/home/tester/src/demo',
    sessionId: CC_SESSION_ID,
    version: '2.1.99',
    gitBranch: 'main',
    type: 'user',
    message: { role: 'user', content: content.length === 1 && opts.text ? opts.text : content },
    ...(opts.toolResult?.toolUseResult !== undefined ? { toolUseResult: opts.toolResult.toolUseResult } : {}),
    uuid: opts.uuid,
    timestamp: opts.ts ?? '2026-07-01T10:00:00.000Z',
  });
}

export function ccAssistantLine(opts: {
  uuid: string;
  parentUuid: string;
  text?: string;
  thinking?: string;
  toolUse?: { id: string; name: string; input: unknown };
  ts?: string;
}): string {
  const content: unknown[] = [];
  if (opts.thinking) content.push({ type: 'thinking', thinking: opts.thinking, signature: 'sig' });
  if (opts.text) content.push({ type: 'text', text: opts.text });
  if (opts.toolUse) content.push({ type: 'tool_use', id: opts.toolUse.id, name: opts.toolUse.name, input: opts.toolUse.input });
  return JSON.stringify({
    parentUuid: opts.parentUuid,
    isSidechain: false,
    cwd: '/home/tester/src/demo',
    sessionId: CC_SESSION_ID,
    version: '2.1.99',
    gitBranch: 'main',
    type: 'assistant',
    requestId: 'req_test123',
    message: {
      id: 'msg_test',
      role: 'assistant',
      model: 'claude-test-1',
      content,
      usage: {
        input_tokens: 11,
        output_tokens: 22,
        cache_creation_input_tokens: 33,
        cache_read_input_tokens: 44,
        cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 3 },
        service_tier: 'standard',
      },
    },
    uuid: opts.uuid,
    timestamp: opts.ts ?? '2026-07-01T10:00:05.000Z',
  });
}

export function ccNoiseLines(): string[] {
  return [
    JSON.stringify({ type: 'progress', data: { x: 1 }, sessionId: CC_SESSION_ID }),
    JSON.stringify({ type: 'file-history-snapshot', snapshot: 'y'.repeat(100), sessionId: CC_SESSION_ID }),
    JSON.stringify({ type: 'queue-operation', op: 'pop', sessionId: CC_SESSION_ID }),
    JSON.stringify({ type: 'ai-title', title: 'Demo session about parsing' }),
    JSON.stringify({ type: 'brand-new-unknown-type', payload: 'whatever' }),
    'this is not json at all {{{',
  ];
}

export const CODEX_SESSION_ID = '019f0000-0000-7000-8000-000000000abc';

export function codexLines(): string[] {
  const meta = {
    timestamp: '2026-07-02T09:00:00.000Z',
    type: 'session_meta',
    payload: {
      session_id: CODEX_SESSION_ID,
      cwd: '/home/tester/src/demo',
      originator: 'codex-tui',
      cli_version: '0.150.0',
      model_provider: 'openai',
      base_instructions: 'x'.repeat(500),
      git: { commit_hash: 'abc123', branch: 'main', repository_url: 'https://github.com/tester/demo' },
    },
  };
  const turnCtx = {
    timestamp: '2026-07-02T09:00:01.000Z',
    type: 'turn_context',
    payload: { turn_id: 't1', cwd: '/home/tester/src/demo', model: 'gpt-test-2', approval_policy: 'never' },
  };
  const userMsg = {
    timestamp: '2026-07-02T09:00:02.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'please fix the flaky widget test' }],
      internal_chat_message_metadata_passthrough: { turn_id: 't1' },
    },
  };
  const reasoning = {
    timestamp: '2026-07-02T09:00:03.000Z',
    type: 'response_item',
    payload: {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'Considering the widget test flake' }],
      encrypted_content: 'zzzz',
      internal_chat_message_metadata_passthrough: { turn_id: 't2' },
    },
  };
  const call = {
    timestamp: '2026-07-02T09:00:04.000Z',
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'shell',
      call_id: 'call_1',
      arguments: '{"command":"pytest -k widget"}',
      internal_chat_message_metadata_passthrough: { turn_id: 't2' },
    },
  };
  const output = {
    timestamp: '2026-07-02T09:00:05.000Z',
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: 'call_1',
      output: '1 passed in 0.5s',
      internal_chat_message_metadata_passthrough: { turn_id: 't2' },
    },
  };
  const assistantMsg = {
    timestamp: '2026-07-02T09:00:06.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'The widget test passes now.' }],
      internal_chat_message_metadata_passthrough: { turn_id: 't2' },
    },
  };
  const tokenCount = {
    timestamp: '2026-07-02T09:00:07.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 900, cached_input_tokens: 500, output_tokens: 80, reasoning_output_tokens: 20, total_tokens: 980 },
        last_token_usage: { input_tokens: 900, cached_input_tokens: 500, output_tokens: 80, reasoning_output_tokens: 20, total_tokens: 980 },
        model_context_window: 250000,
      },
    },
  };
  const dupAgentMsg = {
    timestamp: '2026-07-02T09:00:08.000Z',
    type: 'event_msg',
    payload: { type: 'agent_message', message: 'The widget test passes now.' },
  };
  const compacted = {
    timestamp: '2026-07-02T09:00:09.000Z',
    type: 'event_msg',
    payload: { type: 'context_compacted' },
  };
  const unknown = { timestamp: '2026-07-02T09:00:10.000Z', type: 'inter_agent_communication_metadata', payload: { z: 1 } };
  return [meta, turnCtx, userMsg, reasoning, call, output, assistantMsg, tokenCount, dupAgentMsg, compacted, unknown].map((o) =>
    JSON.stringify(o),
  );
}

/** A valid 1x1 transparent PNG, base64-encoded — used to round-trip the blob endpoint. */
export const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

interface CcLineOpts {
  uuid: string;
  parentUuid?: string | null;
  role: 'user' | 'assistant';
  text?: string;
  thinking?: string;
  toolUse?: { id: string; name: string; input: unknown };
  toolResult?: { toolUseId: string; content: string; isError?: boolean };
  image?: { mediaType: string; data: string };
  ts?: string;
}

/** Parametrized Claude Code envelope builder (any session id, either role). Mirrors real on-disk shape. */
export function ccLine(sessionId: string, o: CcLineOpts): string {
  const content: unknown[] = [];
  if (o.thinking) content.push({ type: 'thinking', thinking: o.thinking, signature: 'sig' });
  if (o.text) content.push({ type: 'text', text: o.text });
  if (o.toolUse) content.push({ type: 'tool_use', id: o.toolUse.id, name: o.toolUse.name, input: o.toolUse.input });
  if (o.toolResult) {
    content.push({
      type: 'tool_result',
      tool_use_id: o.toolResult.toolUseId,
      content: o.toolResult.content,
      ...(o.toolResult.isError ? { is_error: true } : {}),
    });
  }
  if (o.image) content.push({ type: 'image', source: { type: 'base64', media_type: o.image.mediaType, data: o.image.data } });

  const envelope: Record<string, unknown> = {
    parentUuid: o.parentUuid ?? null,
    isSidechain: false,
    userType: 'external',
    cwd: '/home/tester/src/demo',
    sessionId,
    version: '2.1.99',
    gitBranch: 'main',
    type: o.role,
    message:
      o.role === 'assistant'
        ? {
            id: 'msg_test',
            role: 'assistant',
            model: 'claude-test-1',
            content,
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, service_tier: 'standard' },
          }
        : { role: 'user', content },
    uuid: o.uuid,
    timestamp: o.ts ?? '2026-07-01T10:00:00.000Z',
  };
  if (o.role === 'assistant') envelope.requestId = 'req_test123';
  return JSON.stringify(envelope);
}

/** Linear alternating user/assistant chain of `turns` turns — all on the main path. */
export function ccLinearSession(sessionId: string, turns: number): string {
  const lines: string[] = [];
  let parent: string | null = null;
  for (let i = 0; i < turns; i++) {
    const uuid = `t-${i}`;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    lines.push(ccLine(sessionId, { uuid, parentUuid: parent, role, text: `turn number ${i} content` }));
    parent = uuid;
  }
  return lines.join('\n');
}

export function toStream(lines: string[]): ReadableStream<Uint8Array> {
  const body = new TextEncoder().encode(lines.join('\n') + '\n');
  return new ReadableStream({
    start(controller) {
      // Deliver in awkward chunk sizes to exercise cross-chunk line assembly.
      for (let i = 0; i < body.length; i += 7) controller.enqueue(body.subarray(i, Math.min(i + 7, body.length)));
      controller.close();
    },
  });
}
