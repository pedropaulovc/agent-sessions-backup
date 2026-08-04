import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionsDevBridge } from '../src/bridge.mjs';

const digest = (character) => character.repeat(64);
const release = Object.freeze({ digest: digest('a'), repository: 'pedropaulovc/agent-sessions-backup', commit: 'b'.repeat(40), workflow: '.github/workflows/release-sessions-dev-bridge.yml', runId: '9', version: '1.0.0' });

function localFixture() {
  const signed = [];
  const prepared = [];
  let counter = 0;
  const environment = {
    url: new URL('http://127.0.0.1:8787/'),
    assertAttested(identity) { assert.equal(identity.artifactDigest, digest('c')); },
    async dispose() { throw new Error('must remain alive after success'); },
  };
  const localTransport = {
    async createImport(assertion, manifest) { assert.equal(assertion.payload.inventoryDigest, digest('e')); assert.equal(assertion.payload.destination.buildInputDigest, digest('d')); return { importCapability: 'aW1wb3J0', requiredObjectIds: manifest.objects.map((item) => item.objectId) }; },
    async commitImport() {},
    async getImport() { return { status: 'complete', objectCount: 0 }; },
  };
  const bridge = new SessionsDevBridge({
    release,
    state: {
      async loadEnrollment() { return { keyProvider: 'windows-cng-tpm' }; },
      async reserveCounter(expected) {
        assert.equal(expected, release.digest);
        return { deviceId: 'device-1', keyRef: 'device-key', keyProvider: 'windows-cng-tpm', counter: ++counter };
      },
    },
    keyProvider: {
      async available() { return true; },
      async sign(keyRef, bytes) { assert.equal(keyRef, 'device-key'); signed.push(JSON.parse(Buffer.from(bytes).toString('utf8'))); return Buffer.alloc(64, 7); },
    },
    buildDriver: {
      async build(checkout) {
        assert.equal(checkout, '/trusted/checkout');
        return { bundle: Buffer.from('bundle'), bundleDigest: digest('c'), inputManifest: { format: 1, inputs: [] }, inputDigest: digest('d'), migrations: [] };
      },
    },
    localEnvironmentFactory: { async start(build, identity) { assert.equal(build.bundleDigest, identity.artifactDigest); return environment; } },
    production: {
      async getPrepareJob(capability) { assert.equal(capability, 'am9i'); return { status: 'awaiting_consent', inventoryDigest: digest('e'), totalSize: 0, objectCount: 0, approvalUrl: 'https://sessions.vza.net/debug/jobs/job/consent' }; },
      async exchangeAuthorization(code, verifier) {
        assert.equal(code, 'YXV0aA');
        assert.equal(verifier, 'dmVyaWZpZXI');
        return { exchangeCapability: 'ZXhjaGFuZ2U', manifest: { format: 1, sessionIds: ['session-1'], inventoryDigest: digest('e'), totalSize: 0, objectCount: 0, expiresAt: Date.parse('2026-08-03T12:04:00.000Z'), objects: [], signature: { alg: 'ES256', value: 'x' } } };
      },
    },
    authorization: {
      async prepare(value) { prepared.push(value.destinationAttestation); return { jobCapability: 'am9i', codeVerifier: 'dmVyaWZpZXI' }; },
      async finalize(value) { assert.equal(value.destinationAttestation.payload.inventoryDigest, digest('e')); return { authorizationCode: 'YXV0aA' }; },
    },
    snapshotVerifier: { verifyManifest(manifest, expected) { assert.equal(manifest.sessionIds[0], expected.sessionId); } },
    localTransportFactory() { return localTransport; },
    clock: () => Date.parse('2026-08-03T12:00:00.000Z'),
  });
  return { bridge, signed, prepared, environment };
}

test('signs only release-derived build and destination fields, never caller-supplied digests', async () => {
  const fixture = localFixture();
  const result = await fixture.bridge.pull({
    sessionId: 'session-1', target: 'local', checkout: '/trusted/checkout',
    artifactDigest: digest('f'), buildInputDigest: digest('f'), environmentNonce: 'caller-nonce',
  });
  assert.equal(result.environment, fixture.environment);
  assert.equal(fixture.signed.length, 2);
  for (const payload of fixture.signed) {
    assert.equal(payload.artifactDigest, digest('c'));
    assert.equal(payload.buildInputDigest, digest('d'));
    assert.notEqual(payload.environmentNonce, 'caller-nonce');
    assert.equal(JSON.stringify(payload).includes(digest('f')), false);
  }
  assert.equal(fixture.signed[0].inventoryDigest, null);
  assert.equal(fixture.signed[1].inventoryDigest, digest('e'));
  assert.deepEqual(fixture.signed.map((item) => item.deviceCounter), [1, 2]);
  assert.notEqual(fixture.signed[0].jti, fixture.signed[1].jti);
});

test('enroll binds the exact hardware public key, release, label, and local scope', async () => {
  let saved;
  let request;
  const bridge = new SessionsDevBridge({
    release,
    state: { async saveEnrollment(value) { saved = value; } },
    keyProvider: {
      async available() { return true; },
      async create() { return { hardwareBacked: true, provider: 'windows-cng-tpm', keyRef: 'key-ref', publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'eA', y: 'eQ' } }; },
      async remove() { throw new Error('must retain successful key'); },
    },
    enrollment: { transport: 'fake' },
    authorization: {
      async enroll(value) {
        request = value.request;
        assert.equal(value.enrollment.transport, 'fake');
        return { deviceId: request.deviceId, scope: 'local-destination-attest', expiresAt: request.expiresAt + 60_000, counter: 7 };
      },
    },
    clock: () => Date.parse('2026-08-03T12:00:00.000Z'),
  });
  const enrolled = await bridge.enroll('Developer device');
  assert.equal(enrolled.deviceId, request.deviceId);
  assert.deepEqual(request.publicJwk, { kty: 'EC', crv: 'P-256', x: 'eA', y: 'eQ' });
  assert.equal(request.label, 'Developer device');
  assert.equal(request.releaseDigest, release.digest);
  assert.equal(request.keyProtection, 'windows-cng-tpm');
  assert.equal(saved.keyProvider, 'windows-cng-tpm');
  assert.equal(saved.keyRef, 'key-ref');
  assert.equal(saved.counter, 7);
  assert.equal(saved.expiresAt, request.expiresAt);
  assert.equal(enrolled.expiresAt, new Date(request.expiresAt).toISOString());
});

test('rejects an enrollment expiry that is no longer in the future and removes the new key', async () => {
  const now = Date.parse('2026-08-03T12:00:00.000Z');
  let removed = false;
  const bridge = new SessionsDevBridge({
    release,
    state: { async saveEnrollment() { throw new Error('must not save expired enrollment'); } },
    keyProvider: {
      async available() { return true; },
      async create() { return { hardwareBacked: true, provider: 'windows-cng-tpm', keyRef: 'key-ref', publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'eA', y: 'eQ' } }; },
      async remove(value) { assert.equal(value, 'key-ref'); removed = true; },
    },
    enrollment: {},
    authorization: {
      async enroll({ request }) {
        return { deviceId: request.deviceId, scope: 'local-destination-attest', expiresAt: now, counter: 0 };
      },
    },
    clock: () => now,
  });

  await assert.rejects(bridge.enroll('Developer device'), /expiry that is already in the past/);
  assert.equal(removed, true);
});

test('software key fallback remains disabled for enrollment and local import', async () => {
  let removed = false;
  const bridge = new SessionsDevBridge({
    release,
    state: { async loadEnrollment() { throw new Error('must not load'); } },
    keyProvider: {
      async available() { return true; },
      async create() { return { hardwareBacked: false, keyRef: 'software' }; },
      async remove(value) { assert.equal(value, 'software'); removed = true; },
    },
    authorization: {},
    enrollment: {},
  });
  await assert.rejects(bridge.enroll('Developer device'), /hardware-backed/);
  assert.equal(removed, true);

  bridge.keyProvider = { async available() { return false; } };
  await assert.rejects(bridge.pull({ sessionId: 'session', target: 'local', checkout: '.' }), /software fallback is disabled/);
});

test('accepts only exact local or pr-number target selectors', async () => {
  const fixture = localFixture();
  await assert.rejects(fixture.bridge.pull({ sessionId: 's', target: 'pr-0', checkout: '.' }), /target must/);
  await assert.rejects(fixture.bridge.pull({ sessionId: 's', target: 'local;rm', checkout: '.' }), /target must/);
});
