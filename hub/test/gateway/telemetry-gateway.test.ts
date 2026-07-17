import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import gateway from '../../gateway/telemetry-gateway';

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
    OIDC_SIGNING_KEY: { get: async () => privateKeyPem },
    GATEWAY_FEDERATION_SUBJECT: 'cf-worker:sessions-telemetry-gateway',
    INGEST_BEARER: 'test-bearer-secret',
  };
}

const ctx = {} as ExecutionContext;

describe('telemetry-gateway fetch handler', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
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

  it('transcodes a valid-bearer OTLP JSON payload to protobuf and forwards with an Entra bearer', async () => {
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
    expect(res.status).toBe(202);
    expect(fetchMock).toHaveBeenCalledTimes(2); // token exchange + upstream forward
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
});
