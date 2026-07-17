import { describe, it, expect } from 'vitest';
import { signAssertion } from '../../gateway/oidc-sign';

// Ported from youtube-mirror's test/unit/oidc-sign.test.ts.

function pkcs8ToPem(der: ArrayBuffer): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----`;
}

function b64urlToBytes(s: string): Uint8Array {
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}
function b64urlToJson(s: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}
function splitJwt(jwt: string): [string, string, string] {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error(`not a JWT: ${jwt}`);
  return parts as [string, string, string];
}

describe('signAssertion', () => {
  it('produces an RS256 JWT with the given claims that verifies against the public key', async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const pem = pkcs8ToPem((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);

    const jwt = await signAssertion({
      issuer: 'https://sessions-oidc-issuer.example.workers.dev',
      subject: 'cf-worker:sessions-telemetry-gateway',
      audience: 'api://AzureADTokenExchange',
      kid: '5c98ea52',
      privateKeyPem: pem,
      ttlSeconds: 300,
    });

    const [h, p, sig] = splitJwt(jwt);
    expect(b64urlToJson(h)).toMatchObject({ alg: 'RS256', kid: '5c98ea52', typ: 'JWT' });

    const payload = b64urlToJson(p);
    expect(payload.iss).toBe('https://sessions-oidc-issuer.example.workers.dev');
    expect(payload.sub).toBe('cf-worker:sessions-telemetry-gateway');
    expect(payload.aud).toBe('api://AzureADTokenExchange');
    expect((payload.exp as number) - (payload.iat as number)).toBe(300);

    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      pair.publicKey,
      b64urlToBytes(sig),
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(ok).toBe(true);
  });

  it('signatures differ from a mismatched key (rejects forgery)', async () => {
    const [a, b] = (await Promise.all([
      crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']),
      crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']),
    ])) as [CryptoKeyPair, CryptoKeyPair];
    const pem = pkcs8ToPem((await crypto.subtle.exportKey('pkcs8', a.privateKey)) as ArrayBuffer);
    const jwt = await signAssertion({ issuer: 'i', subject: 's', audience: 'aud', kid: 'k', privateKeyPem: pem });
    const [h, p, sig] = splitJwt(jwt);

    // verifying with the OTHER key pair's public key must fail
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', b.publicKey, b64urlToBytes(sig), new TextEncoder().encode(`${h}.${p}`));
    expect(ok).toBe(false);
  });

  it('defaults to a 300s TTL and stamps a fresh jti each call', async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const pem = pkcs8ToPem((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
    const params = { issuer: 'i', subject: 's', audience: 'aud', kid: 'k', privateKeyPem: pem };

    const [jwt1, jwt2] = await Promise.all([signAssertion(params), signAssertion(params)]);
    const p1 = b64urlToJson(splitJwt(jwt1)[1]);
    const p2 = b64urlToJson(splitJwt(jwt2)[1]);

    expect((p1.exp as number) - (p1.iat as number)).toBe(300);
    expect(p1.jti).not.toBe(p2.jti);
  });
});
