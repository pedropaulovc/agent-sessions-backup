import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PREVIEW_ACCOUNT_ID,
  acknowledgedResources,
  assertInventoryItem,
  assertPreviewAccount,
  assertTrustedWorkflowRef,
  generatedBuildConfig,
  generatedPrivateAppConfig,
  generatedTrustedWrapperConfig,
  inventoryGenerations,
  migrationArtifactSqlNames,
  resourceNames,
} from '../../infra/cf/preview-trust.mjs';

const SHA = 'a'.repeat(40);
const GENERATION = 'g123-aaaaaaaaaaaa';
const ASSET_SECRET = 's'.repeat(43);
function debugPublicJwk() {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    ...publicKey.export({ format: 'jwk' }),
    alg: 'ES256',
    key_ops: ['verify'],
    revoked: false,
    use: 'sig',
  };
}
const DEBUG_IMPORT_JWK = debugPublicJwk();
const DEBUG_MANIFEST_JWK = debugPublicJwk();
const ASSERTION_JWKS = JSON.stringify({
  keys: [{
    kid: 'preview-key',
    kty: 'EC',
    notAfter: 4_102_444_800_000,
    notBefore: 0,
    revoked: false,
  }],
});

function privateAppConfig(application = {
  assetSigningSecret: ASSET_SECRET,
  debugImportAssertionPublicJwk: JSON.stringify(DEBUG_IMPORT_JWK),
  debugExportManifestVerifyPublicJwk: JSON.stringify(DEBUG_MANIFEST_JWK),
}) {
  const names = resourceNames(42, 123, SHA);
  return generatedPrivateAppConfig({
    accountId: PREVIEW_ACCOUNT_ID,
    main: '/artifact/worker.mjs',
    migrationsDir: '/artifact/migrations',
    names,
    resources: {
      artifactDigest: 'b'.repeat(64),
      buildInputDigest: 'c'.repeat(64),
      d1: 'preview-d1-id',
      environmentNonce: 'e'.repeat(43),
      headSha: SHA,
      kv: 'preview-kv-id',
      migrationDigest: 'd'.repeat(64),
      pr: 42,
      schemaDigest: 'f'.repeat(64),
    },
    assertions: {
      actionJwks: ASSERTION_JWKS,
      browserJwks: ASSERTION_JWKS,
      issuer: 'https://preview-control.example.test/',
      originJwks: ASSERTION_JWKS,
    },
    application,
  });
}

describe('trusted preview workflow identity', () => {
  it('binds the allowed workflow ref to the validated full repository name', () => {
    const repository = 'pedropaulovc/agent-sessions-backup';
    const expected = `${repository}/.github/workflows/preview-control.yml@refs/heads/main`;
    expect(assertTrustedWorkflowRef(repository, expected)).toBe(expected);
    expect(() => assertTrustedWorkflowRef(
      repository,
      `lookalike/${expected}`,
    )).toThrow(/trusted default-branch preview-control workflow/);
    expect(() => assertTrustedWorkflowRef(
      repository,
      'attacker/agent-sessions-backup/.github/workflows/preview-control.yml@refs/heads/main',
    )).toThrow(/trusted default-branch preview-control workflow/);
  });
});

describe('trusted migration packaging', () => {
  it('accepts canonical baseline metadata without copying it as a migration', () => {
    expect(migrationArtifactSqlNames([
      'source-baseline.json',
      '0002_next.sql',
      'manifest.json',
      'historical-baseline.json',
      '0001_init.sql',
    ])).toEqual(['0001_init.sql', '0002_next.sql']);
    expect(() => migrationArtifactSqlNames([
      'manifest.json',
      '0001_init.sql',
      'attacker.json',
    ])).toThrow(/unexpected migration entry/);
    expect(() => migrationArtifactSqlNames([
      'manifest.json',
      '0001_init.sql',
      'constructor',
    ])).toThrow(/unexpected migration entry/);
  });
});

describe('trusted preview resource ownership', () => {
  it('pins every generated resource to the approved account and PR prefix', () => {
    expect(() => assertPreviewAccount(PREVIEW_ACCOUNT_ID)).not.toThrow();
    expect(() => assertPreviewAccount('18ef3246e9f36d1560485ef53889c0ab')).toThrow(/production/);
    expect(() => assertPreviewAccount('f'.repeat(32))).toThrow(/unapproved/);
    const names = resourceNames(42, 123, SHA);
    expect(names.generation).toBe(GENERATION);
    for (const name of [names.app, names.edge, names.d1, names.r2, names.kv, names.queue, names.dlq]) {
      expect(name.startsWith('pr-42-')).toBe(true);
    }
  });

  it('accepts generation-owned Workers and fail-closed planned null IDs only explicitly', () => {
    const planned = { kind: 'app-worker', id: null, name: resourceNames(42, 123, SHA).app, generation: GENERATION };
    expect(() => assertInventoryItem(planned, 42, GENERATION)).toThrow(/id is required/);
    expect(assertInventoryItem(planned, 42, GENERATION, { allowMissingId: true })).toBe(planned);
    expect(() => assertInventoryItem({
      ...planned,
      kind: 'constructor',
    }, 42, GENERATION, { allowMissingId: true })).toThrow(/unsupported inventory kind/);
    expect(() => assertInventoryItem({ ...planned, name: 'sessions-hub' }, 42, GENERATION, {
      allowMissingId: true,
    })).toThrow(/foreign generation inventory/);
    expect(() => assertInventoryItem({ ...planned, generation: 'g124-bbbbbbbbbbbb' }, 42, GENERATION, {
      allowMissingId: true,
    })).toThrow(/generation mismatch/);
    expect(() => assertInventoryItem({
      ...planned,
      name: 'pr-42-g124-bbbbbbbbbbbb-app',
    }, 42, GENERATION, { allowMissingId: true })).toThrow(/foreign generation inventory/);
  });

  it('ignores malformed janitor inventory entries without losing valid generations', () => {
    expect([...inventoryGenerations([
      null,
      undefined,
      'invalid',
      [],
      {},
      { generation: 'invalid' },
      { generation: GENERATION },
    ])]).toEqual([GENERATION]);
  });

  it('keeps the prior live Worker generation disjoint from candidate rollback inventory', () => {
    const priorLive = resourceNames(42, 122, 'b'.repeat(40));
    const candidate = resourceNames(42, 123, SHA);
    const rollback = [
      { kind: 'app-version', id: 'candidate-app-version', name: candidate.app, generation: candidate.generation },
      { kind: 'app-worker', id: candidate.app, name: candidate.app, generation: candidate.generation },
      { kind: 'edge-version', id: 'candidate-edge-version', name: candidate.edge, generation: candidate.generation },
      { kind: 'edge-worker', id: candidate.edge, name: candidate.edge, generation: candidate.generation },
    ];
    const rollbackNames = new Set(rollback.map(({ name }) => name));

    expect(candidate.host).toBe(priorLive.host);
    expect(rollbackNames.has(priorLive.app)).toBe(false);
    expect(rollbackNames.has(priorLive.edge)).toBe(false);
    for (const item of rollback) {
      expect(assertInventoryItem(item, 42, candidate.generation)).toBe(item);
    }
  });

  it('acknowledges the original trusted identity rather than a resolved discovery ID', () => {
    expect(acknowledgedResources([{
      kind: 'd1', id: null, name: 'pr-42-g123-aaaaaaaaaaaa-sessions-index',
      generation: GENERATION, deleted: true, resolvedId: 'foreign-or-discovered-id',
    }])).toEqual([{
      kind: 'd1', id: null, name: 'pr-42-g123-aaaaaaaaaaaa-sessions-index', generation: GENERATION,
    }]);
  });
});

describe('private preview application key bindings', () => {
  it('binds an isolated asset secret and only public debug verification keys to the private app config', () => {
    const config = privateAppConfig();
    expect(config.vars.ASSET_SIGNING_SECRET).toBe(ASSET_SECRET);
    expect(JSON.parse(config.vars.DEBUG_IMPORT_ASSERTION_PUBLIC_JWK)).toEqual(DEBUG_IMPORT_JWK);
    expect(JSON.parse(config.vars.DEBUG_EXPORT_MANIFEST_VERIFY_PUBLIC_JWK)).toEqual(DEBUG_MANIFEST_JWK);
    expect(JSON.stringify(config.vars)).not.toContain('"d"');
    const names = resourceNames(42, 123, SHA);
    expect(config.name).toBe(names.app);
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.routes).toEqual([]);
    expect(config.d1_databases).toEqual([expect.objectContaining({ binding: 'DB' })]);
    expect(config.r2_buckets).toEqual([{ binding: 'RAW', bucket_name: names.r2 }]);
    expect(config.kv_namespaces).toEqual([{ binding: 'KV', id: 'preview-kv-id' }]);

    const wrapper = generatedTrustedWrapperConfig({
      accountId: PREVIEW_ACCOUNT_ID,
      main: '/trusted/preview-edge.mjs',
      names,
      originJwks: ASSERTION_JWKS,
    });
    expect(wrapper.vars).toEqual({
      PREVIEW_ORIGIN_ASSERTION_JWKS: ASSERTION_JWKS,
    });
    expect(wrapper.preview_urls).toBe(true);
    expect(wrapper.workers_dev).toBe(false);
    expect(wrapper.routes).toEqual([]);
    expect(wrapper.services).toEqual([{ binding: 'APP', service: names.app }]);
    expect(JSON.stringify(wrapper)).not.toContain(ASSET_SECRET);
    expect(JSON.stringify(wrapper)).not.toContain('DEBUG_IMPORT_ASSERTION_PUBLIC_JWK');
    expect(JSON.stringify(wrapper)).not.toContain('DEBUG_EXPORT_MANIFEST_VERIFY_PUBLIC_JWK');

    const prBuildConfig = generatedBuildConfig({
      main: '/pr/worker.mjs',
      workerName: 'pr-42-untrusted-build',
    });
    expect(prBuildConfig).toMatchObject({
      workers_dev: false,
      preview_urls: false,
      routes: [],
    });
    expect(prBuildConfig).not.toHaveProperty('vars');
    expect(JSON.stringify(prBuildConfig)).not.toContain(ASSET_SECRET);
    expect(JSON.stringify(prBuildConfig)).not.toContain('DEBUG_IMPORT_ASSERTION_PUBLIC_JWK');
    expect(JSON.stringify(prBuildConfig)).not.toContain('DEBUG_EXPORT_MANIFEST_VERIFY_PUBLIC_JWK');
  });

  it('emits both debug keys in a Worker-compatible ES256 verification form', async () => {
    const { vars } = privateAppConfig();
    for (const raw of [
      vars.DEBUG_IMPORT_ASSERTION_PUBLIC_JWK,
      vars.DEBUG_EXPORT_MANIFEST_VERIFY_PUBLIC_JWK,
    ]) {
      const key = await crypto.subtle.importKey(
        'jwk',
        JSON.parse(raw),
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
      expect(key.algorithm).toMatchObject({ name: 'ECDSA', namedCurve: 'P-256' });
      expect(key.usages).toEqual(['verify']);
    }
  });

  it.each([
    ['asset signing secret', {
      debugImportAssertionPublicJwk: JSON.stringify(DEBUG_IMPORT_JWK),
      debugExportManifestVerifyPublicJwk: JSON.stringify(DEBUG_MANIFEST_JWK),
    }],
    ['import assertion key', {
      assetSigningSecret: ASSET_SECRET,
      debugExportManifestVerifyPublicJwk: JSON.stringify(DEBUG_MANIFEST_JWK),
    }],
    ['manifest verification key', {
      assetSigningSecret: ASSET_SECRET,
      debugImportAssertionPublicJwk: JSON.stringify(DEBUG_IMPORT_JWK),
    }],
  ])('rejects a missing %s', (_label, application) => {
    expect(() => privateAppConfig(application)).toThrow();
  });

  it.each([
    ['private material', { ...DEBUG_IMPORT_JWK, d: 'private-scalar' }, /private key material/],
    ['wrong algorithm', { ...DEBUG_IMPORT_JWK, alg: 'RS256' }, /non-revoked ES256/],
    ['wrong key use', { ...DEBUG_IMPORT_JWK, use: 'enc' }, /non-revoked ES256/],
    ['wrong operation', { ...DEBUG_IMPORT_JWK, key_ops: ['sign'] }, /non-revoked ES256/],
    ['revoked key', { ...DEBUG_IMPORT_JWK, revoked: true }, /non-revoked ES256/],
    ['wrong curve', { ...DEBUG_IMPORT_JWK, crv: 'P-384' }, /non-revoked ES256/],
    ['missing coordinate', { ...DEBUG_IMPORT_JWK, y: undefined }, /non-revoked ES256/],
    ['off-curve coordinates', { ...DEBUG_IMPORT_JWK, x: 'x'.repeat(43) }, /invalid P-256/],
  ])('rejects an import assertion JWK with %s', (_label, jwk, error) => {
    expect(() => privateAppConfig({
      assetSigningSecret: ASSET_SECRET,
      debugImportAssertionPublicJwk: JSON.stringify(jwk),
      debugExportManifestVerifyPublicJwk: JSON.stringify(DEBUG_MANIFEST_JWK),
    })).toThrow(error);
  });

  it('applies the same public-only validation to the manifest verification key', () => {
    expect(() => privateAppConfig({
      assetSigningSecret: ASSET_SECRET,
      debugImportAssertionPublicJwk: JSON.stringify(DEBUG_IMPORT_JWK),
      debugExportManifestVerifyPublicJwk: JSON.stringify({ ...DEBUG_MANIFEST_JWK, d: 'private-scalar' }),
    })).toThrow(/private key material/);
  });
});
