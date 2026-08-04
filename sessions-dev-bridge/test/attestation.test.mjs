import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalBytes } from '../src/canonical.mjs';
import { verifyLocalDestinationAttestation } from '../src/attestation.mjs';

const now = Date.parse('2026-08-03T12:00:00.000Z');
const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const publicKeyJwk = pair.publicKey.export({ format: 'jwk' });
const encryptionPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const destination = Object.freeze({
  environmentNonce: 'bm9uY2U',
  buildInputDigest: 'c'.repeat(64),
  artifactDigest: 'd'.repeat(64),
  encryptionPublicJwk: encryptionPair.publicKey.export({ format: 'jwk' }),
  inventoryDigest: null,
});

function make(overrides = {}) {
  const payload = {
    format: 1,
    scope: 'local-destination-attest',
    kind: 'local',
    jti: 'anRpLWZvdXI',
    iat: now - 1000,
    exp: now + 60_000,
    inventoryDigest: destination.inventoryDigest,
    encryptionPublicJwk: destination.encryptionPublicJwk,
    environmentNonce: destination.environmentNonce,
    artifactDigest: destination.artifactDigest,
    buildInputDigest: destination.buildInputDigest,
    deviceId: 'device-1',
    deviceCounter: 4,
    releaseDigest: 'a'.repeat(64),
    keyProtection: 'windows-cng-tpm',
    ...overrides,
  };
  return { payload, signature: sign('sha256', canonicalBytes(payload), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') };
}

function policy(overrides = {}) {
  return { releaseDigest: 'a'.repeat(64), deviceId: 'device-1', keyProtection: 'windows-cng-tpm', publicKeyJwk, lastCounter: 3, usedJtis: new Set(), destination, now, ...overrides };
}

test('accepts an exact fresh hardware device attestation once', () => {
  const state = policy();
  assert.deepEqual(verifyLocalDestinationAttestation(make(), state), { counter: 4, jti: 'anRpLWZvdXI' });
  assert.throws(() => verifyLocalDestinationAttestation(make({ deviceCounter: 5 }), state), /jti replay/);
});

test('rejects wrong release provenance, scope, destination, counter, and jti', () => {
  assert.throws(() => verifyLocalDestinationAttestation(make({ releaseDigest: 'e'.repeat(64) }), policy()), /release provenance/);
  assert.throws(() => verifyLocalDestinationAttestation(make({ scope: 'session:export:any' }), policy()), /scope/);
  assert.throws(() => verifyLocalDestinationAttestation(make({ artifactDigest: 'e'.repeat(64) }), policy()), /destination mismatch/);
  assert.throws(() => verifyLocalDestinationAttestation(make({ buildInputDigest: 'e'.repeat(64) }), policy()), /destination mismatch/);
  assert.throws(() => verifyLocalDestinationAttestation(make({ deviceCounter: 3 }), policy()), /counter replay/);
  assert.throws(() => verifyLocalDestinationAttestation(make(), policy({ usedJtis: new Set(['anRpLWZvdXI']) })), /jti replay/);
});

test('rejects expired assertions, software protection, and signatures by another key', () => {
  assert.throws(() => verifyLocalDestinationAttestation(make({ exp: now }), policy()), /expired/);
  assert.throws(() => verifyLocalDestinationAttestation(make({ keyProtection: 'software' }), policy({ keyProtection: 'software' })), /device mismatch/);
  const wrong = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
  assert.throws(() => verifyLocalDestinationAttestation(make(), policy({ publicKeyJwk: wrong })), /signature mismatch/);
});
