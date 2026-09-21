import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ingestOmpQa, OMP_QA_MAX_BODY_BYTES } from '../src/api/omp-qa';
import { route } from '../src/router';
import { API } from './hosts';

const testEnv = env as unknown as Env;
const prodEnv = { ...testEnv, ENVIRONMENT: 'production' } as Env;
const ctx = {} as ExecutionContext;
const installs = new Set<string>();
let sourceSequence = 0;


type QaPayload = {
  agent: { name: string; version: string };
  installId: string;
  platform: string;
  arch: string;
  entries: Array<{ id: number; model: string; version: string; tool: string; report: string }>;
};

function payload(installId: string): QaPayload {
  installs.add(installId);
  return {
    agent: { name: 'omp', version: '0.1.0' },
    installId,
    platform: 'linux',
    arch: 'x64',
    entries: [
      { id: 1, model: 'gpt-5', version: '1.2.3', tool: 'edit', report: 'first report' },
      { id: 2, model: 'claude-sonnet', version: '4.0.0', tool: 'read', report: 'second report' },
    ],
  };
}

async function post(body: unknown, url = `${API}/omp-qa`): Promise<Response> {
  sourceSequence += 1;
  return SELF.fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': `192.0.2.${sourceSequence}`,
    },
    body: JSON.stringify(body),
  });
}

async function countRows(installId: string): Promise<number> {
  const row = await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM omp_qa_reports WHERE install_id = ?1')
    .bind(installId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

afterEach(async () => {
  for (const installId of installs) {
    await testEnv.DB.prepare('DELETE FROM omp_qa_reports WHERE install_id = ?1').bind(installId).run();
  }
  installs.clear();
});

describe('POST /omp-qa', () => {
  it('inserts every valid entry and exposes the stored fields', async () => {
    const installId = `qa-${crypto.randomUUID()}`;
    const response = await post(payload(installId));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 2, duplicates: 0 });

    const rows = await testEnv.DB.prepare(
      `SELECT install_id, entry_id, agent_name, agent_version, platform, arch, model, omp_version, tool, report,
              received_at
         FROM omp_qa_reports
        WHERE install_id = ?1
        ORDER BY entry_id`,
    ).bind(installId).all<{
      install_id: string;
      entry_id: number;
      agent_name: string;
      agent_version: string;
      platform: string;
      arch: string;
      model: string;
      omp_version: string;
      tool: string;
      report: string;
      received_at: string;
    }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results[0]).toMatchObject({
      install_id: installId,
      entry_id: 1,
      agent_name: 'omp',
      agent_version: '0.1.0',
      platform: 'linux',
      arch: 'x64',
      model: 'gpt-5',
      omp_version: '1.2.3',
      tool: 'edit',
      report: 'first report',
    });
    expect(rows.results[0]!.received_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('treats replayed install and entry ids as successful duplicates', async () => {
    const body = payload(`qa-${crypto.randomUUID()}`);
    const first = await post(body);
    const replay = await post(body);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ accepted: 0, duplicates: 2 });
    expect(await countRows(body.installId)).toBe(2);
  });

  it('rejects malformed batches before any entry is written', async () => {
    const body = payload(`qa-${crypto.randomUUID()}`);
    body.entries[1]!.id = body.entries[0]!.id;
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(await countRows(body.installId)).toBe(0);

    const malformedJson = await SELF.fetch(`${API}/omp-qa`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(malformedJson.status).toBe(400);
  });

  it('rejects a body over 256 KiB before writing', async () => {
    const installId = `qa-${crypto.randomUUID()}`;
    installs.add(installId);
    const oversized = JSON.stringify({ ...payload(installId), padding: 'x'.repeat(OMP_QA_MAX_BODY_BYTES) });
    expect(new TextEncoder().encode(oversized).byteLength).toBeGreaterThan(OMP_QA_MAX_BODY_BYTES);
    const response = await SELF.fetch(`${API}/omp-qa`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: oversized,
    });
    expect(response.status).toBe(413);
    expect(await countRows(installId)).toBe(0);
  });

  it('routes production POST publicly before host and identity dispatch', async () => {
    const body = payload(`qa-${crypto.randomUUID()}`);
    const response = await route(
      new Request(`${API}/omp-qa`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '192.0.2.250',
        },
        body: JSON.stringify(body),
      }),
      prodEnv,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 2, duplicates: 0 });
    expect(await countRows(body.installId)).toBe(2);
  });

  it('can be called directly without auth headers', async () => {
    const body = payload(`qa-${crypto.randomUUID()}`);
    const response = await ingestOmpQa(
      new Request(`${API}/omp-qa`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.251' },
        body: JSON.stringify(body),
      }),
      testEnv,
    );
    expect(response.status).toBe(200);
    expect(await countRows(body.installId)).toBe(2);
  });

  it('rejects browser-simple content types and rate-limited sources', async () => {
    const body = payload(`qa-${crypto.randomUUID()}`);
    const unsupported = await ingestOmpQa(
      new Request(`${API}/omp-qa`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body) }),
      testEnv,
    );
    expect(unsupported.status).toBe(415);

    const limitedEnv = {
      ...testEnv,
      OMP_QA_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: false }) },
    } as unknown as Env;
    const limited = await ingestOmpQa(
      new Request(`${API}/omp-qa`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.252' },
        body: JSON.stringify(body),
      }),
      limitedEnv,
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(await countRows(body.installId)).toBe(0);
  });
});
