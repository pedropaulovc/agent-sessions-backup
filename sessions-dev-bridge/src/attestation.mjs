import { createPublicKey, verify } from 'node:crypto';
import { canonicalBytes, canonicalJson, assertBase64url, assertExactKeys, assertHex } from './canonical.mjs';

const LOCAL_KEYS = ['format', 'scope', 'kind', 'jti', 'iat', 'exp', 'inventoryDigest', 'encryptionPublicJwk', 'environmentNonce', 'artifactDigest', 'buildInputDigest', 'deviceId', 'deviceCounter', 'releaseDigest', 'keyProtection'];

export function verifyLocalDestinationAttestation(attestation, policy) {
  assertExactKeys(attestation, ['payload', 'signature']);
  const payload = attestation.payload;
  assertExactKeys(payload, LOCAL_KEYS);
  if (payload.format !== 1 || payload.scope !== 'local-destination-attest' || payload.kind !== 'local') throw new Error('destination attestation scope mismatch');
  if (payload.releaseDigest !== policy.releaseDigest) throw new Error('destination attestation release provenance mismatch');
  if (payload.deviceId !== policy.deviceId || payload.keyProtection !== policy.keyProtection || payload.keyProtection === 'software') throw new Error('destination attestation device mismatch');
  if (!Number.isSafeInteger(payload.deviceCounter) || payload.deviceCounter <= policy.lastCounter) throw new Error('destination attestation counter replay');
  assertBase64url(payload.jti, 'attestation jti');
  if (policy.usedJtis.has(payload.jti)) throw new Error('destination attestation jti replay');
  const now = policy.now ?? Date.now();
  if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat > now + 30_000 || payload.exp <= now || payload.exp - payload.iat > 15 * 60_000) throw new Error('destination attestation is expired or has invalid lifetime');
  validateDestinationFields(payload);
  for (const key of ['environmentNonce', 'artifactDigest', 'buildInputDigest', 'inventoryDigest']) {
    if (canonicalJson(payload[key]) !== canonicalJson(policy.destination[key])) throw new Error('destination attestation destination mismatch');
  }
  if (canonicalJson(payload.encryptionPublicJwk) !== canonicalJson(policy.destination.encryptionPublicJwk)) throw new Error('destination attestation destination mismatch');
  const signature = Buffer.from(assertBase64url(attestation.signature, 'attestation signature'), 'base64url');
  if (signature.length !== 64) throw new Error('destination attestation signature length mismatch');
  const publicKey = createPublicKey({ key: policy.publicKeyJwk, format: 'jwk' });
  if (!verify('sha256', canonicalBytes(payload), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)) throw new Error('destination attestation signature mismatch');
  policy.usedJtis.add(payload.jti);
  return Object.freeze({ counter: payload.deviceCounter, jti: payload.jti });
}

function validateDestinationFields(payload) {
  assertBase64url(payload.environmentNonce, 'environment nonce');
  assertHex(payload.artifactDigest, 64, 'artifact digest');
  assertHex(payload.buildInputDigest, 64, 'build input digest');
  if (payload.inventoryDigest !== null) assertHex(payload.inventoryDigest, 64, 'inventory digest');
  const key = payload.encryptionPublicJwk;
  if (!key || key.kty !== 'RSA' || typeof key.n !== 'string' || typeof key.e !== 'string' || key.d !== undefined) throw new Error('destination encryption key must be public RSA');
}
