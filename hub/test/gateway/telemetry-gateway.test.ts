import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import gateway, { resetTokenCache } from '../../gateway/telemetry-gateway';

// Unit tests for the gateway's own request handling (bearer check, transcode,
// forward). The outbound `fetch` (both the Entra token exchange and the DCR
// upstream POST) is mocked — no real network / Azure calls.

async function pemFromGeneratedKeyPair(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const der = (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer;
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----`;
}

function makeEnv(privateKeyPem: string) {
  return {
    TENANT_ID: 'tenant-123',
    APP_CLIENT_ID: 'client-abc',
    OTLP_TRACES_ENDPOINT: 'https://dce.example.westus2-1.ingest.monitor.azure.com/dataCollectionRules/dcr-1/streams/Microsoft-OTLP-Traces/otlp/v1/traces',
    OTLP_LOGS_ENDPOINT: 'https://dce.example.westus2-1.ingest.monitor.azure.com/dataCollectionRules/dcr-1/streams/Microsoft-OTLP-Logs/otlp/v1/logs',
    OIDC_ISSUER_URL: 'https://sessions-oidc-issuer.example.workers.dev',
    OIDC_SIGNING_KID: 'test-kid',
    OIDC_SIGNING_KEY: privateKeyPem,
    GATEWAY_FEDERATION_SUBJECT: 'cf-worker:sessions-telemetry-gateway',
    INGEST_BEARER: 'test-bearer-secret',
  };
}

const ctx = {} as ExecutionContext;

describe('telemetry-gateway fetch handler', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // The Entra token is cached at module scope; clear it so each test exercises the
    // token path from scratch (the token-failure test depends on no cached token).
    resetTokenCache();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers 200 with no outbound calls when the bearer does not match (anti-retry-storm)', async () => {
    const env = makeEnv('unused');
    const req = new Request('https://gateway.example/v1/logs', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-secret' },
      body: JSON.stringify({ resourceLogs: [] }),
    });

    const res = await gateway.fetch(req, env as never, ctx);
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 200 with no outbound calls when the Authorization header is missing entirely', async () => {
    const env = makeEnv('unused');
    const req = new Request('https://gateway.example/v1/traces', { method: 'POST', body: '{}' });

    const res = await gateway.fetch(req, env as never, ctx);
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('transcodes a valid-bearer OTLP JSON payload to protobuf and forwards with an Entra bearer (204 to CF regardless of upstream status)', async () => {
    const pem = await pemFromGeneratedKeyPair();
    const env = makeEnv(pem);

    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      if (url.includes('login.microsoftonline.com')) {
        return new Response(JSON.stringify({ access_token: 'fake-entra-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // The DCR upstream call.
      expect(url).toBe(env.OTLP_LOGS_ENDPOINT);
      const headers = new Headers(init?.headers);
      expect(headers.get('Content-Type')).toBe('application/x-protobuf');
      expect(headers.get('Authorization')).toBe('Bearer fake-entra-token');
      expect(init?.body).toBeInstanceOf(Uint8Array);
      expect((init?.body as Uint8Array).byteLength).toBeGreaterThan(0);

      return new Response('{}', { status: 202, headers: { 'Content-Type': 'application/json' } });
    });

    const otlpJson = {
      resourceLogs: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'sessions-hub' } }] },
          scopeLogs: [
            {
              logRecords: [
                { timeUnixNano: '1782964800000000000', severityNumber: 9, body: { stringValue: '{"event":"hub.heartbeat"}' } },
              ],
            },
          ],
        },
      ],
    };

    const req = new Request('https://gateway.example/v1/logs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.INGEST_BEARER}` },
      body: JSON.stringify(otlpJson),
    });

    const res = await gateway.fetch(req, env as never, ctx);
    // The gateway now returns 204 to Cloudflare once chunks are dispatched — never
    // propagating the upstream status — so a DCR failure can't head-of-line-wedge
    // CF's retry queue. The upstream here (202) still gets exactly one forward.
    expect(res.status).toBe(204);
    expect(fetchMock).toHaveBeenCalledTimes(2); // token exchange + upstream forward
  });

  it('does not throw when the upstream DCR responds with a bodyless 204 (Response forbids a body on null-body statuses)', async () => {
    const pem = await pemFromGeneratedKeyPair();
    const env = makeEnv(pem);

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('login.microsoftonline.com')) {
        return new Response(JSON.stringify({ access_token: 'fake-entra-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Azure's DCR ingestion endpoint returning a bodyless success response.
      return new Response(null, { status: 204 });
    });

    const req = new Request('https://gateway.example/v1/traces', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.INGEST_BEARER}` },
      body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{ name: 's' }] }] }] }),
    });

    const res = await gateway.fetch(req, env as never, ctx);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('answers 200 without calling fetch for an empty body', async () => {
    const env = makeEnv('unused');
    const req = new Request('https://gateway.example/v1/logs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.INGEST_BEARER}` },
    });

    const res = await gateway.fetch(req, env as never, ctx);
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 200 for unrecognized routes/methods without touching the OTLP path', async () => {
    const env = makeEnv('unused');
    const req = new Request('https://gateway.example/', { method: 'GET' });
    const res = await gateway.fetch(req, env as never, ctx);
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('splits an oversized batch into multiple DCR POSTs and returns 204', async () => {
    const pem = await pemFromGeneratedKeyPair();
    const env = makeEnv(pem);

    let upstreamPosts = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('login.microsoftonline.com')) {
        return new Response(JSON.stringify({ access_token: 'fake-entra-token', expires_in: 3600 }), { status: 200 });
      }
      upstreamPosts++;
      expect((init?.body as Uint8Array).byteLength).toBeLessThanOrEqual(1_000_000); // under Azure's cap
      return new Response(null, { status: 204 });
    });

    // 6 × ~300 KB log records ≈ 1.8 MB > the 900 KB chunk cap.
    const bigBody = `{"event":"http.access","blob":"${'a'.repeat(300_000)}"}`;
    const otlpJson = {
      resourceLogs: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'sessions-hub' } }] },
          scopeLogs: [
            {
              logRecords: Array.from({ length: 6 }, (_, i) => ({
                timeUnixNano: String(1782964800000000000n + BigInt(i)),
                body: { stringValue: bigBody },
              })),
            },
          ],
        },
      ],
    };

    const req = new Request('https://gateway.example/v1/logs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.INGEST_BEARER}` },
      body: JSON.stringify(otlpJson),
    });

    const res = await gateway.fetch(req, env as never, ctx);
    expect(res.status).toBe(204);
    expect(upstreamPosts).toBeGreaterThan(1); // batch was split
  });

  it('returns 204 to Cloudflare even when the DCR rejects a chunk with 413 — poison drop (never head-of-line-wedge)', async () => {
    const pem = await pemFromGeneratedKeyPair();
    const env = makeEnv(pem);

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('login.microsoftonline.com')) {
        return new Response(JSON.stringify({ access_token: 'fake-entra-token', expires_in: 3600 }), { status: 200 });
      }
      // Simulate today's outage: the DCR rejects the payload as too large.
      return new Response('payload too large', { status: 413 });
    });

    const req = new Request('https://gateway.example/v1/logs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.INGEST_BEARER}` },
      body: JSON.stringify({
        resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: '{"event":"x"}' } }] }] }],
      }),
    });

    const res = await gateway.fetch(req, env as never, ctx);
    // A 413 is poison — no retry can ever land it — so we drop the chunk and still
    // ack, letting CF advance its queue instead of retrying the 413 forever.
    expect(res.status).toBe(204);
  });

  it('returns 503 and dispatches NOTHING when the Entra token exchange fails (transient, keep retryable)', async () => {
    const pem = await pemFromGeneratedKeyPair();
    const env = makeEnv(pem);

    let dcrPosts = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('login.microsoftonline.com')) {
        // Azure AD momentarily unavailable — no access_token in the body.
        return new Response(JSON.stringify({ error: 'temporarily_unavailable', error_description: 'try later' }), {
          status: 503,
        });
      }
      dcrPosts++;
      return new Response(null, { status: 204 });
    });

    const req = new Request('https://gateway.example/v1/logs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.INGEST_BEARER}` },
      body: JSON.stringify({
        resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: '{"event":"x"}' } }] }] }],
      }),
    });

    const res = await gateway.fetch(req, env as never, ctx);
    // The batch is valid — only the token minting failed — so CF should retry it.
    expect(res.status).toBe(503);
    expect(dcrPosts).toBe(0); // nothing forwarded without a token
  });

  it('posts every chunk but returns 503 when one chunk hits a transient 429 (redeliver the batch)', async () => {
    const pem = await pemFromGeneratedKeyPair();
    const env = makeEnv(pem);

    let dcrPosts = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('login.microsoftonline.com')) {
        return new Response(JSON.stringify({ access_token: 'fake-entra-token', expires_in: 3600 }), { status: 200 });
      }
      dcrPosts++;
      // First chunk gets throttled (transient); the rest succeed.
      return dcrPosts === 1
        ? new Response('slow down', { status: 429 })
        : new Response(null, { status: 204 });
    });

    // 6 × ~300 KB records → splits into multiple chunks so we can prove the loop keeps
    // going past the throttled first chunk.
    const bigBody = `{"event":"http.access","blob":"${'a'.repeat(300_000)}"}`;
    const otlpJson = {
      resourceLogs: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'sessions-hub' } }] },
          scopeLogs: [
            {
              logRecords: Array.from({ length: 6 }, (_, i) => ({
                timeUnixNano: String(1782964800000000000n + BigInt(i)),
                body: { stringValue: bigBody },
              })),
            },
          ],
        },
      ],
    };

    const req = new Request('https://gateway.example/v1/logs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.INGEST_BEARER}` },
      body: JSON.stringify(otlpJson),
    });

    const res = await gateway.fetch(req, env as never, ctx);
    // Transient → CF must redeliver the whole batch (duplicates-over-loss).
    expect(res.status).toBe(503);
    expect(dcrPosts).toBeGreaterThan(1); // did NOT bail after the 429 — posted the rest
  });
});
