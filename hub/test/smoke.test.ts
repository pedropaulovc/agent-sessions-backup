import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('scaffold', () => {
  it('serves /healthz', async () => {
    const res = await SELF.fetch('https://sessions.vza.net/healthz');
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);
  });

  it('501s unimplemented API routes', async () => {
    const res = await SELF.fetch('https://api.sessions.vza.net/api/v1/search?q=x');
    expect(res.status).toBe(501);
  });
});
