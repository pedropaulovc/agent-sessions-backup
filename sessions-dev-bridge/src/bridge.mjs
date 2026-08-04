import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalBytes, randomId } from './canonical.mjs';
import { generateDestinationKey, decryptObject } from './snapshot.mjs';
import { pollProgress, DebugTransport } from './debug-transport.mjs';

const ENROLLMENT_SCOPE = 'local-destination-attest';
const DESTINATION_SCOPE = 'local-destination-attest';
const IMPORT_SCOPE = 'session-debug-import';
const ATTESTATION_LIFETIME_MS = 5 * 60_000;

export class SessionsDevBridge {
  constructor(dependencies) {
    this.release = dependencies.release;
    this.state = dependencies.state;
    this.keyProvider = dependencies.keyProvider;
    this.buildDriver = dependencies.buildDriver;
    this.localEnvironmentFactory = dependencies.localEnvironmentFactory;
    this.production = dependencies.production;
    this.authorization = dependencies.authorization;
    this.enrollment = dependencies.enrollment;
    this.remoteDestinations = dependencies.remoteDestinations;
    this.snapshotVerifier = dependencies.snapshotVerifier;
    this.localTransportFactory = dependencies.localTransportFactory ?? ((environment) => new DebugTransport({ apiBase: environment.url.origin, browserBase: environment.url.origin, allowLoopback: true }));
    this.clock = dependencies.clock ?? (() => Date.now());
    this.onProgress = dependencies.onProgress ?? (() => {});
  }

  async enroll(deviceLabel) {
    if (typeof deviceLabel !== 'string' || !/^[\p{L}\p{N} ._-]{1,80}$/u.test(deviceLabel)) throw new Error('device label must be 1-80 plain characters');
    if (!this.enrollment) throw new Error('this protected release has no configured enrollment service');
    if (!(await this.keyProvider.available())) throw new Error('a non-exportable TPM-backed key is required for local import; software fallback is disabled');
    const key = await this.keyProvider.create();
    if (key.hardwareBacked !== true || !['windows-cng-tpm', 'tpm2-pkcs11'].includes(key.provider)) {
      await this.keyProvider.remove(key.keyRef).catch(() => {});
      throw new Error('key provider did not create a hardware-backed non-exportable key');
    }
    const requestedExpiry = this.clock() + 365 * 24 * 60 * 60_000;
    const deviceId = randomId(24);
    try {
      const result = await this.authorization.enroll({
        request: {
          deviceId,
          label: deviceLabel,
          publicJwk: key.publicKeyJwk,
          releaseDigest: this.release.digest,
          keyProtection: key.provider,
          expiresAt: requestedExpiry,
        },
        enrollment: this.enrollment,
      });
      if (!result || result.deviceId !== deviceId || result.scope !== ENROLLMENT_SCOPE) throw new Error('enrollment service returned invalid metadata');
      const expiresAt = Number.isSafeInteger(result.expiresAt) ? Math.min(result.expiresAt, requestedExpiry) : requestedExpiry;
      if (expiresAt <= this.clock()) throw new Error('enrollment service returned an expiry that is already in the past');
      await this.state.saveEnrollment({
        format: 1,
        deviceId,
        deviceLabel,
        keyProvider: key.provider,
        keyRef: key.keyRef,
        publicKeyJwk: key.publicKeyJwk,
        scope: ENROLLMENT_SCOPE,
        releaseDigest: this.release.digest,
        counter: result.counter ?? 0,
        expiresAt,
      });
      return Object.freeze({ deviceId, expiresAt: new Date(expiresAt).toISOString() });
    } catch (error) {
      await this.keyProvider.remove(key.keyRef).catch(() => {});
      throw error;
    }
  }

  async pull({ sessionId, target, checkout }) {
    validateSessionId(sessionId);
    const parsedTarget = parseTarget(target);
    if (parsedTarget.kind === 'local') return this.#pullLocal(sessionId, checkout);
    return this.#pullRemote(sessionId, parsedTarget.pr);
  }

  async #pullLocal(sessionId, checkout) {
    if (!(await this.keyProvider.available())) throw new Error('a non-exportable TPM-backed key is required for local import; software fallback is disabled');
    const enrollment = await this.state.loadEnrollment();
    if (!['windows-cng-tpm', 'tpm2-pkcs11'].includes(enrollment.keyProvider)) throw new Error('software-key enrollment cannot authorize local import');
    const build = await this.buildDriver.build(checkout);
    const encryption = generateDestinationKey();
    const importSigner = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const identity = Object.freeze({
      environmentNonce: randomId(24),
      buildInputDigest: build.inputDigest,
      artifactDigest: build.bundleDigest,
      encryptionPublicJwk: encryption.publicKeyJwk,
    });
    const environment = await this.localEnvironmentFactory.start(build, identity, {
      importAssertionPublicJwk: importSigner.publicKey.export({ format: 'jwk' }),
    });
    let prepared;
    try {
      environment.assertAttested(identity);
      const initial = await this.#attestLocal(identity, null);
      prepared = await this.authorization.prepare({ sessionId, destinationAttestation: initial, production: this.production });
      const job = await pollProgress(() => this.production.getPrepareJob(prepared.jobCapability), {
        transient: ['preparing'], terminal: ['awaiting_consent'], onProgress: this.onProgress,
      });
      const extended = await this.#attestLocal(identity, job.inventoryDigest);
      const authorization = await this.authorization.finalize({ approvalUrl: job.approvalUrl, jobCapability: prepared.jobCapability, destinationAttestation: extended });
      const exchange = await this.production.exchangeAuthorization(authorization.authorizationCode, prepared.codeVerifier);
      this.snapshotVerifier.verifyManifest(exchange.manifest, { sessionId, inventoryDigest: job.inventoryDigest, totalSize: job.totalSize, objectCount: job.objectCount });
      environment.assertAttested(identity);
      const localTransport = this.localTransportFactory(environment);
      const importAssertion = this.#signImportAssertion(importSigner.privateKey, identity, exchange.manifest);
      const imported = await localTransport.createImport(importAssertion, exchange.manifest);
      assertRequiredObjects(imported.requiredObjectIds, exchange.manifest.objects);
      for (const object of exchange.manifest.objects) {
        const ciphertext = await this.production.fetchCiphertext(exchange.exchangeCapability, object);
        await decryptObject({ object, ciphertext, privateKey: encryption.privateKey, consume: async (plaintext) => {
          environment.assertAttested(identity);
          await localTransport.putImportObject(imported.importCapability, object, plaintext);
        }});
      }
      await localTransport.commitImport(imported.importCapability);
      await pollProgress(() => localTransport.getImport(imported.importCapability), {
        transient: ['uploading', 'queued', 'validating', 'promoting'], terminal: ['complete'], onProgress: this.onProgress,
      });
      return Object.freeze({ target: 'local', environment, sessionId });
    } catch (error) {
      if (prepared) await this.authorization.abort(prepared.jobCapability).catch(() => {});
      await environment.dispose().catch(() => {});
      throw error;
    }
  }

  async #pullRemote(sessionId, pr) {
    if (!this.remoteDestinations) throw new Error('this protected release has no configured trusted front-door destination service');
    const destination = await this.remoteDestinations.create({ pr, sessionIds: [sessionId] });
    if (destination.pr !== pr || destination.target !== `pr-${pr}`) throw new Error('trusted front door returned a different destination');
    let prepared;
    try {
      prepared = await this.authorization.prepare({ sessionId, destinationAttestation: destination.attestation, production: this.production });
      const job = await pollProgress(() => this.production.getPrepareJob(prepared.jobCapability), { transient: ['preparing'], terminal: ['awaiting_consent'], onProgress: this.onProgress });
      const extended = await this.remoteDestinations.extend(destination, job.inventoryDigest);
      const authorization = await this.authorization.finalize({ approvalUrl: job.approvalUrl, jobCapability: prepared.jobCapability, destinationAttestation: extended });
      const exchange = await this.production.exchangeAuthorization(authorization.authorizationCode, prepared.codeVerifier);
      this.snapshotVerifier.verifyManifest(exchange.manifest, { sessionId, inventoryDigest: job.inventoryDigest, totalSize: job.totalSize, objectCount: job.objectCount });
      await this.remoteDestinations.transfer({ destination, attestation: extended, manifest: exchange.manifest, exchangeCapability: exchange.exchangeCapability, source: this.production, onProgress: this.onProgress });
      return Object.freeze({ target: `pr-${pr}`, sessionId });
    } catch (error) {
      if (prepared) await this.authorization.abort(prepared.jobCapability).catch(() => {});
      throw error;
    }
  }

  async #attestLocal(identity, inventoryDigest) {
    const enrollment = await this.state.reserveCounter(this.release.digest);
    const issuedAt = this.clock();
    const payload = Object.freeze({
      format: 1,
      scope: DESTINATION_SCOPE,
      kind: 'local',
      jti: randomId(24),
      iat: issuedAt,
      exp: issuedAt + ATTESTATION_LIFETIME_MS,
      inventoryDigest,
      encryptionPublicJwk: identity.encryptionPublicJwk,
      environmentNonce: identity.environmentNonce,
      artifactDigest: identity.artifactDigest,
      buildInputDigest: identity.buildInputDigest,
      deviceId: enrollment.deviceId,
      deviceCounter: enrollment.counter,
      releaseDigest: this.release.digest,
      keyProtection: enrollment.keyProvider,
    });
    const signature = await this.keyProvider.sign(enrollment.keyRef, canonicalBytes(payload));
    if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new Error('device provider returned an invalid ES256 signature');
    return Object.freeze({ payload, signature: Buffer.from(signature).toString('base64url') });
  }

  #signImportAssertion(privateKey, identity, manifest) {
    const now = this.clock();
    const payload = Object.freeze({
      format: 1,
      scope: IMPORT_SCOPE,
      jti: randomId(24),
      iat: now,
      exp: Math.min(now + ATTESTATION_LIFETIME_MS, manifest.expiresAt),
      inventoryDigest: manifest.inventoryDigest,
      sessionIds: manifest.sessionIds,
      destination: Object.freeze({
        environmentNonce: identity.environmentNonce,
        artifactDigest: identity.artifactDigest,
        buildInputDigest: identity.buildInputDigest,
      }),
    });
    return Object.freeze({ payload, signature: sign('sha256', canonicalBytes(payload), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') });
  }
}

function parseTarget(target) {
  if (target === 'local') return { kind: 'local' };
  const match = /^pr-([1-9][0-9]*)$/.exec(target);
  if (!match) throw new Error('target must be local or pr-<number>');
  const pr = Number(match[1]);
  if (!Number.isSafeInteger(pr)) throw new Error('PR number is too large');
  return { kind: 'remote', pr };
}

function validateSessionId(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('session id must be a non-empty printable identifier');
}

function assertRequiredObjects(required, objects) {
  if (!Array.isArray(required)) throw new Error('local importer did not return required object ids');
  const expected = objects.map((object) => object.objectId).sort();
  const actual = [...required].sort();
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) throw new Error('local importer requested an unexpected object set');
}
