import { Miniflare } from 'miniflare';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonicalBytes, randomId } from './canonical.mjs';
import { executeD1Migrations } from './sqlite-statements.mjs';

export class EmbeddedLocalEnvironmentFactory {
  constructor(stateDirectory, manifestVerificationJwk) {
    this.environmentsDirectory = resolve(stateDirectory, 'environments');
    this.manifestVerificationJwk = manifestVerificationJwk;
  }

  async start(build, identity, trust) {
    await mkdir(this.environmentsDirectory, { recursive: true, mode: 0o700 });
    const directory = join(this.environmentsDirectory, identity.environmentNonce);
    await mkdir(directory, { recursive: false, mode: 0o700 });
    const artifactPath = join(directory, 'worker.mjs');
    const manifestPath = join(directory, 'build-input.json');
    try {
      await writeFile(artifactPath, build.bundle, { mode: 0o400, flag: 'wx' });
      await writeFile(manifestPath, canonicalBytes(build.inputManifest), { mode: 0o400, flag: 'wx' });
      await chmod(artifactPath, 0o400);
      await chmod(manifestPath, 0o400);
      const setupToken = randomId(32);
      const miniflare = new Miniflare({
        modules: true,
        script: build.bundle.toString('utf8'),
        compatibilityDate: '2026-07-10',
        compatibilityFlags: ['nodejs_compat'],
        bindings: {
          ENVIRONMENT: 'development',
          API_HOST: '127.0.0.1',
          VIEWER_HOST: '127.0.0.1',
          R2_DASHBOARD_BASE_URL: 'https://dash.cloudflare.com/',
          SETUP_TOKEN: setupToken,
          DEV_AUTH: setupToken,
          ENVIRONMENT_NONCE: identity.environmentNonce,
          ARTIFACT_DIGEST: identity.artifactDigest,
          BUILD_INPUT_DIGEST: identity.buildInputDigest,
          DEBUG_IMPORT_ASSERTION_PUBLIC_JWK: JSON.stringify(trust.importAssertionPublicJwk),
          DEBUG_EXPORT_MANIFEST_VERIFY_PUBLIC_JWK: JSON.stringify(this.manifestVerificationJwk),
        },
        d1Databases: { DB: 'bridge-db' },
        r2Buckets: { RAW: 'bridge-raw' },
        kvNamespaces: { KV: 'bridge-kv' },
        queueProducers: { PARSE_QUEUE: 'bridge-parse' },
        queueConsumers: { 'bridge-parse': { maxBatchSize: 1, maxBatchTimeout: 1, maxRetires: 2 } },
        d1Persist: join(directory, 'destination-state', 'd1'),
        r2Persist: join(directory, 'destination-state', 'r2'),
        kvPersist: join(directory, 'destination-state', 'kv'),
      });
      const bindings = await miniflare.getBindings();
      await executeD1Migrations(bindings.DB, build.migrations);
      const url = await miniflare.ready;
      if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error('local environment did not bind loopback');
      const attested = Object.freeze({
        environmentNonce: identity.environmentNonce,
        artifactDigest: identity.artifactDigest,
        buildInputDigest: identity.buildInputDigest,
      });
      return new OwnedLocalEnvironment(miniflare, url, directory, attested, setupToken);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
}

export class OwnedLocalEnvironment {
  constructor(miniflare, url, directory, attested, setupToken) {
    this.miniflare = miniflare;
    this.url = url;
    this.directory = directory;
    this.attested = attested;
    this.setupToken = setupToken;
  }

  assertAttested(payload) {
    for (const key of ['environmentNonce', 'artifactDigest', 'buildInputDigest']) {
      if (payload[key] !== this.attested[key]) throw new Error(`local destination ${key} changed after attestation`);
    }
  }

  async dispose() {
    this.setupToken = '';
    await this.miniflare.dispose();
  }
}
