export const OMP_QA_MAX_BODY_BYTES = 256 * 1024;
const MAX_BODY_BYTES = OMP_QA_MAX_BODY_BYTES;
const MAX_ENTRIES = 50;

interface OmpQaEntry {
  id: number;
  model: string;
  version: string;
  tool: string;
  report: string;
}

interface OmpQaPayload {
  agentName: string;
  agentVersion: string;
  installId: string;
  platform: string;
  arch: string;
  entries: OmpQaEntry[];
}

type BodyReadResult =
  | { bytes: Uint8Array }
  | { error: 'body_too_large' | 'body_read_failed' };

function errorResponse(error: string, status = 400): Response {
  return Response.json({ error }, { status });
}

async function readBoundedBody(request: Request): Promise<BodyReadResult> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return { error: 'body_too_large' };
    }
  }

  if (!request.body) return { bytes: new Uint8Array() };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!next.value) continue;
      total += next.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The bounded read has already established the response; cancellation is best effort.
        }
        return { error: 'body_too_large' };
      }
      chunks.push(next.value);
    }
  } catch {
    return { error: 'body_read_failed' };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parsePayload(value: unknown): OmpQaPayload | null {
  const body = objectRecord(value);
  if (!body) return null;

  const agent = objectRecord(body.agent);
  if (!agent) return null;
  const agentName = nonEmptyString(agent.name);
  const agentVersion = nonEmptyString(agent.version);
  if (agentName !== 'omp' || agentVersion === null) return null;

  const installId = nonEmptyString(body.installId);
  const platform = nonEmptyString(body.platform);
  const arch = nonEmptyString(body.arch);
  if (installId === null || platform === null || arch === null || !Array.isArray(body.entries)) return null;
  if (body.entries.length < 1 || body.entries.length > MAX_ENTRIES) return null;

  const ids = new Set<number>();
  const entries: OmpQaEntry[] = [];
  for (const value of body.entries) {
    const entry = objectRecord(value);
    if (!entry) return null;
    const id = entry.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || ids.has(id)) return null;
    ids.add(id);

    const model = nonEmptyString(entry.model);
    const version = nonEmptyString(entry.version);
    const tool = nonEmptyString(entry.tool);
    const report = nonEmptyString(entry.report);
    if (model === null || version === null || tool === null || report === null) return null;
    entries.push({
      id,
      model: model.slice(0, 256),
      version: version.slice(0, 256),
      tool: tool.slice(0, 128),
      report,
    });
  }

  return {
    agentName,
    agentVersion: agentVersion.slice(0, 256),
    installId: installId.slice(0, 256),
    platform: platform.slice(0, 32),
    arch: arch.slice(0, 32),
    entries,
  };
}

async function dedupKey(payload: OmpQaPayload, entry: OmpQaEntry): Promise<string> {
  const identity = JSON.stringify([
    payload.installId,
    entry.id,
    entry.model,
    entry.version,
    entry.tool,
    entry.report,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}


/** POST /omp-qa — public, bounded OMP auto-QA report intake. */
export async function ingestOmpQa(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') return errorResponse('unsupported_media_type', 415);

  const source = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const rateLimit = await env.OMP_QA_RATE_LIMITER.limit({ key: source });
  if (!rateLimit.success) {
    return Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'retry-after': '60' } });
  }

  const body = await readBoundedBody(request);
  if ('error' in body) {
    return errorResponse(body.error, body.error === 'body_too_large' ? 413 : 400);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body.bytes));
  } catch {
    return errorResponse('bad_json');
  }

  const payload = parsePayload(parsedJson);
  if (!payload) return errorResponse('invalid_payload');

  const statements = await Promise.all(payload.entries.map(async (entry) =>
    env.DB.prepare(
      `INSERT INTO omp_qa_reports
         (install_id, entry_id, dedup_key, agent_name, agent_version, platform, arch, model, omp_version, tool, report)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT(dedup_key) DO NOTHING`,
    ).bind(
      payload.installId,
      entry.id,
      await dedupKey(payload, entry),
      payload.agentName,
      payload.agentVersion,
      payload.platform,
      payload.arch,
      entry.model,
      entry.version,
      entry.tool,
      entry.report,
    ),
  ));

  const results = await env.DB.batch(statements);
  const accepted = results.reduce((count, result) => count + ((result.meta?.changes ?? 0) > 0 ? 1 : 0), 0);
  return Response.json({ accepted, duplicates: payload.entries.length - accepted });
}
