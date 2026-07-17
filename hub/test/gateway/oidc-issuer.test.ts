import { describe, it, expect } from 'vitest';
import issuer, { activeKeyIsPublished } from '../../gateway/oidc-issuer';

const env = { ISSUER_URL: 'https://sessions-oidc-issuer.example.workers.dev' };

describe('oidc-issuer', () => {
  it('serves OIDC discovery pointing at its own jwks_uri', async () => {
    const req = new Request(`${env.ISSUER_URL}/.well-known/openid-configuration`);
    const res = await issuer.fetch(req, env);
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.issuer).toBe(env.ISSUER_URL);
    expect(body.jwks_uri).toBe(`${env.ISSUER_URL}/.well-known/jwks.json`);
    expect(body.id_token_signing_alg_values_supported).toEqual(['RS256']);
  });

  it('serves a JWKS array (not a single key) with a rotation-tolerant cache window', async () => {
    const req = new Request(`${env.ISSUER_URL}/.well-known/jwks.json`);
    const res = await issuer.fetch(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');

    const body = await res.json<{ keys: Array<{ kid: string; kty: string }> }>();
    expect(Array.isArray(body.keys)).toBe(true);
    expect(body.keys.length).toBeGreaterThan(0);
    for (const key of body.keys) {
      expect(key.kty).toBe('RSA');
    }
  });

  it('404s unrecognized paths', async () => {
    const req = new Request(`${env.ISSUER_URL}/nope`);
    const res = await issuer.fetch(req, env);
    expect(res.status).toBe(404);
  });

  it('always publishes the kid it is currently configured as active (rotation sanity check)', () => {
    // Guards against a rotation step that flips ACTIVE_KID without first
    // publishing the new key in PUBLIC_JWKS (see the rotation sequence
    // documented at the top of gateway/oidc-issuer.ts).
    expect(activeKeyIsPublished()).toBe(true);
  });
});
