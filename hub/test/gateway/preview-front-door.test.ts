import { describe, expect, it, vi } from 'vitest';
import {
  PreviewEdgeAuth,
  canonicalJson,
  canonicalTarget,
  closePreview,
  destinationUsable,
  promoteCandidate,
  registerCandidate,
  safeRequestHeaders,
  safeResponseHeaders,
  signDestinationAttestation,
  verifyDestinationAttestation,
  trustedPreviewIngress,
  validLoopbackCallback,
  validDestinationManifestTotals,
  type PreviewState,
} from '../../gateway/preview-front-door';
import configSource from '../../wrangler.preview-front-door.jsonc?raw';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const DIGEST = 'd'.repeat(64);

function candidate(generation: string, head = HEAD_A, epoch = 1) {
  const app = `pr-42-${generation}-app`;
  const edge = `pr-42-${generation}-edge`;
  return {
    pr: 42,
    epoch,
    head,
    generation,
    versionUrl: `https://version-${edge}.agent-sessions-nonproduction.workers.dev/`,
    artifactDigest: DIGEST,
    environmentNonce: 'environment_nonce_42',
    buildInputDigest: DIGEST,
    schemaDigest: DIGEST,
    resources: [
      { kind: 'd1', id: `${generation}-db`, name: `pr-42-${generation}-db`, generation },
      { kind: 'app-version', id: `${generation}-app-version`, name: app, generation },
      { kind: 'app-worker', id: app, name: app, generation },
      { kind: 'edge-version', id: `${generation}-edge-version`, name: edge, generation },
      { kind: 'edge-worker', id: edge, name: edge, generation },
    ],
  };
}

function smoked(state: PreviewState, generation: string): PreviewState {
  return {
    ...state,
    candidates: {
      ...state.candidates,
      [generation]: { ...state.candidates[generation]!, smoke: { digest: DIGEST, recordedAt: 1 } },
    },
  };
}

function registered(generation = 'g1-aaaaaaaaaaaa'): PreviewState {
  const result = registerCandidate(undefined, candidate(generation));
  if (!result.ok) throw new Error(result.reason);
  return result.state;
}

function promoted(generation = 'g1-aaaaaaaaaaaa'): PreviewState {
  const state = registered(generation);
  const result = promoteCandidate(smoked(state, generation), {
    pr: 42, epoch: 1, head: HEAD_A, generation, priorLiveGeneration: null,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.state;
}

function destinationLifecycleHarness(initialRoute: PreviewState | null = promoted()) {
  const data = new Map<string, unknown>();
  if (initialRoute) data.set('route', initialRoute);
  let alarmAt: number | null = null;
  const storage = {
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); },
    delete: async (key: string) => data.delete(key),
    list: async <T>({ prefix }: { prefix: string }) => new Map(
      [...data.entries()].filter(([key]) => key.startsWith(prefix)),
    ) as Map<string, T>,
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(storage),
    getAlarm: async () => alarmAt,
    setAlarm: async (value: number) => { alarmAt = value; },
    deleteAlarm: async () => { alarmAt = null; },
  };
  const object = new PreviewEdgeAuth({ storage } as unknown as DurableObjectState);
  const post = (path: string, body: unknown) => object.fetch(new Request(`https://edge.internal/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  return { data, object, post, alarm: () => alarmAt };
}

function destinationRecord(id: string, expiresAt: number) {
  const live = promoted().live!;
  return {
    id,
    pr: 42,
    head: live.head,
    generation: live.generation,
    artifactDigest: live.artifactDigest,
    environmentNonce: live.environmentNonce,
    buildInputDigest: live.buildInputDigest,
    inventoryDigest: null,
    maxBytes: 1_000,
    actor: 'actor@example.com',
    expiresAt,
    publicKeyJwk: { kty: 'RSA', n: 'public', e: 'AQAB' },
    privateKeyJwk: { kty: 'RSA', n: 'public', e: 'AQAB', d: 'PRIVATE_DESTINATION_KEY' },
    sessionIds: ['session-a'],
  };
}

function emptyDestinationImport(
  destination: Record<string, unknown> & { expiresAt: number; privateKeyJwk: JsonWebKey },
) {
  const { privateKeyJwk: _private, ...publicDestination } = destination;
  const objects: Parameters<typeof validDestinationManifestTotals>[0]['objects'] = [];
  return {
    destination: publicDestination,
    manifest: {
      format: 1,
      sessionIds: ['session-a'],
      inventoryDigest: 'f'.repeat(64),
      totalSize: 0,
      objectCount: 0,
      expiresAt: destination.expiresAt,
      objects,
      signature: { alg: 'ES256', value: 'signature' },
    },
    upstreamCapability: 'upstream-capability',
    usedObjectIds: [],
    state: 'pending',
    expiresAt: destination.expiresAt,
  };
}

function expectNoDestinationPrivateMaterial(data: Map<string, unknown>): void {
  const remaining = [...data.entries()].filter(([key]) => key.startsWith('destination'));
  expect(JSON.stringify(remaining)).not.toContain('PRIVATE_DESTINATION_KEY');
  expect(remaining.some(([key]) => key.startsWith('destination-key:'))).toBe(false);
}

describe('preview front door configuration', () => {
  it('is the sole public router and owns only dedicated preview edge state', () => {
    const config = JSON.parse(configSource.replace(/^\s*\/\/.*$/gm, '')) as Record<string, unknown>;
    expect(config).toMatchObject({
      name: 'sessions-preview-front-door',
      main: 'gateway/preview-front-door.ts',
      workers_dev: false,
      preview_urls: false,
      routes: [
        { pattern: '*-preview.sessions.vza.net/*', zone_name: 'vza.net' },
        { pattern: 'preview-control.sessions.vza.net/*', zone_name: 'vza.net' },
      ],
      durable_objects: { bindings: [{ name: 'PREVIEW_EDGE_AUTH', class_name: 'PreviewEdgeAuth' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['PreviewEdgeAuth'] }],
    });
    expect(config).not.toHaveProperty('d1_databases');
    expect(config).not.toHaveProperty('kv_namespaces');
    expect(config).not.toHaveProperty('r2_buckets');
  });
});

describe('trusted generation ingress', () => {
  it('classifies missing, target, and clock assertion denials before app dispatch', async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const encode = (value: unknown) => {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    };
    const token = async (target: string, overrides: Record<string, unknown> = {}) => {
      const now = Math.floor(Date.now() / 1000);
      const header = encode({ alg: 'RS256', typ: 'JWT', kid: 'origin-test' });
      const claims = encode({
        iss: 'https://preview-control.sessions.vza.net',
        aud: 'urn:sessions:preview:origin:v1',
        method: 'GET',
        target,
        iat: now,
        exp: now + 45,
        jti: 'origin_assertion_test_jti',
        ...overrides,
      });
      const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        pair.privateKey,
        new TextEncoder().encode(`${header}.${claims}`),
      );
      let binary = '';
      for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
      return `${header}.${claims}.${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
    };
    const app = { fetch: vi.fn(async () => new Response('private app')) };
    const env = {
      APP: app,
      PREVIEW_ORIGIN_ASSERTION_JWKS: JSON.stringify({
        keys: [{
          ...publicJwk,
          kid: 'origin-test',
          notBefore: 0,
          notAfter: Math.floor(Date.now() / 1000) + 300,
          revoked: false,
        }],
      }),
    };
    const request = new Request('https://version-edge.preview.workers.dev/healthz');
    const missing = await trustedPreviewIngress(request.clone(), env);
    expect(missing.status).toBe(403);
    await expect(missing.json()).resolves.toEqual({ error: 'invalid_origin_assertion', reason: 'missing' });
    const wrongTarget = await trustedPreviewIngress(new Request(request, {
      headers: { 'x-preview-origin-assertion': await token('/wrong') },
    }), env);
    expect(wrongTarget.status).toBe(403);
    await expect(wrongTarget.json()).resolves.toEqual({ error: 'invalid_origin_assertion', reason: 'target_mismatch' });
    const future = Math.floor(Date.now() / 1000) + 6;
    const wrongClock = await trustedPreviewIngress(new Request(request, {
      headers: { 'x-preview-origin-assertion': await token('/healthz', { iat: future, exp: future + 45 }) },
    }), env);
    expect(wrongClock.status).toBe(403);
    await expect(wrongClock.json()).resolves.toEqual({ error: 'invalid_origin_assertion', reason: 'invalid_clock' });
    expect(app.fetch).not.toHaveBeenCalled();

    const accepted = await trustedPreviewIngress(new Request(request, {
      headers: { 'x-preview-origin-assertion': await token('/healthz') },
    }), env);
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toBe('private app');
    expect(app.fetch).toHaveBeenCalledOnce();
  });
});

describe('preview browser session grants', () => {
  it('accepts a wildcard browser grant and keeps its session reusable across targets', async () => {
    const { post } = destinationLifecycleHarness();
    const issued = await post('grant', {
      pr: 42,
      epoch: 1,
      head: HEAD_A,
      generation: 'g1-aaaaaaaaaaaa',
      audience: 'preview-browser',
      method: '*',
      target: '*',
      actor: 'reviewer@example.test',
      expiresIn: 3600,
    });
    expect(issued.status).toBe(200);
    const grant = await issued.json() as { code: string };
    const consumed = await post('consume-grant', { code: grant.code, host: 'pr-42-preview.sessions.vza.net' });
    expect(consumed.status).toBe(200);
    const session = await consumed.json() as { id: string; method: string; target: string };
    expect(session).toMatchObject({ method: '*', target: '*' });

    for (const target of ['/', '/healthz']) {
      const routed = await post('session', { id: session.id, host: 'pr-42-preview.sessions.vza.net' });
      expect(routed.status, target).toBe(200);
      await expect(routed.json()).resolves.toMatchObject({
        session: { method: '*', target: '*' },
        tuple: { generation: 'g1-aaaaaaaaaaaa' },
      });
    }
  });
});

describe('crash-safe generation inventory', () => {
  it('retains typed partial allocations after hard cancellation and blocks final register', async () => {
    const data = new Map<string, unknown>();
    const storage = {
      get: async <T>(key: string) => data.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { data.set(key, value); },
      delete: async (key: string) => data.delete(key),
      list: async <T>({ prefix }: { prefix: string }) => new Map(
        [...data.entries()].filter(([key]) => key.startsWith(prefix)),
      ) as Map<string, T>,
      transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(storage),
    };
    const object = new PreviewEdgeAuth({ storage } as unknown as DurableObjectState);
    const post = (path: string, body: unknown) => object.fetch(new Request(`https://edge.internal/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    const base = candidate('g77-aaaaaaaaaaaa');
    const planned = [
      { kind: 'd1', name: 'pr-42-g77-aaaaaaaaaaaa-db' },
      { kind: 'r2', name: 'pr-42-g77-aaaaaaaaaaaa-objects' },
    ];
    expect((await post('begin-generation', { ...base, planned })).status).toBe(201);
    expect((await post('record-resource', {
      pr: 42, head: HEAD_A, generation: base.generation,
      resource: { kind: 'd1', id: 'db-id', name: planned[0]!.name, generation: base.generation },
    })).status).toBe(201);

    const resumed = await post('begin-generation', {
      ...base,
      environmentNonce: 'replacement_nonce_must_not_win',
      planned,
    });
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({
      environmentNonce: base.environmentNonce,
      recorded: [{ kind: 'd1', id: 'db-id', name: planned[0]!.name, generation: base.generation }],
    });

    // Simulate cancellation here: the per-generation record remains discoverable even
    // though no candidate route was ever registered.
    const inventory = await object.fetch(new Request('https://edge.internal/allocations'));
    expect(await inventory.json()).toMatchObject({
      allocations: [{
        generation: base.generation,
        planned,
        recorded: [{ kind: 'd1', id: 'db-id', name: planned[0]!.name, generation: base.generation }],
      }],
    });
    expect((await post('register', {
      ...base,
      resources: [{ kind: 'd1', id: 'db-id', name: planned[0]!.name, generation: base.generation }],
    })).status).toBe(409);
  });
});

describe('preview routing CAS', () => {
  it('registers a candidate for smoke without changing the live tuple', () => {
    const live = promoted();
    const result = registerCandidate(live, candidate('g2-bbbbbbbbbbbb'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.live?.generation).toBe('g1-aaaaaaaaaaaa');
    expect(result.state.candidates['g2-bbbbbbbbbbbb']?.versionUrl)
      .toBe('https://version-pr-42-g2-bbbbbbbbbbbb-edge.agent-sessions-nonproduction.workers.dev/');
  });

  it('rejects a missing or non-canonical build input digest before a candidate can route', () => {
    const missing = candidate('g2-bbbbbbbbbbbb') as Record<string, unknown>;
    delete missing.buildInputDigest;
    expect(registerCandidate(undefined, missing as never)).toMatchObject({ ok: false, reason: 'invalid_candidate' });
    expect(registerCandidate(undefined, {
      ...candidate('g2-bbbbbbbbbbbb'),
      buildInputDigest: 'SHA256:NOT-CANONICAL',
    })).toMatchObject({ ok: false, reason: 'invalid_candidate' });
  });

  it('rejects a private-app URL in place of the trusted wrapper tuple', () => {
    const generation = 'g2-bbbbbbbbbbbb';
    expect(registerCandidate(undefined, {
      ...candidate(generation),
      versionUrl: `https://version-pr-42-${generation}-app.agent-sessions-nonproduction.workers.dev/`,
    })).toMatchObject({ ok: false, reason: 'invalid_candidate' });
  });

  it('rejects stale generation, head, epoch, candidate, and prior-live promotion', () => {
    const live = promoted('g9-aaaaaaaaaaaa');
    expect(registerCandidate(live, candidate('g8-bbbbbbbbbbbb'))).toMatchObject({ ok: false, reason: 'stale_generation' });
    expect(registerCandidate(live, candidate('g10-bbbbbbbbbbbb', HEAD_B))).toMatchObject({ ok: false, reason: 'stale_head' });
    expect(registerCandidate(live, candidate('g10-bbbbbbbbbbbb', HEAD_A, 2))).toMatchObject({ ok: false, reason: 'stale_epoch' });
    expect(promoteCandidate(live, { pr: 42, epoch: 1, head: HEAD_A, generation: 'g2-bbbbbbbbbbbb', priorLiveGeneration: live.live!.generation })).toMatchObject({ ok: false, reason: 'candidate_not_found' });

    const next = registerCandidate(live, candidate('g10-bbbbbbbbbbbb'));
    if (!next.ok) throw new Error(next.reason);
    expect(promoteCandidate(smoked(next.state, 'g10-bbbbbbbbbbbb'), { pr: 42, epoch: 1, head: HEAD_A, generation: 'g10-bbbbbbbbbbbb', priorLiveGeneration: null })).toMatchObject({ ok: false, reason: 'live_changed' });
  });

  it('tombstones a never-provisioned PR and blocks later registration', async () => {
    const { object, post } = destinationLifecycleHarness(null);
    const response = await post('close', { pr: 42, epoch: 1, head: HEAD_A });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: {
        lifecycle: 'closed',
        epoch: 2,
        expectedHead: HEAD_A,
        live: null,
        rollback: null,
        candidates: {},
        deletionInventory: [],
        closedAt: expect.any(Number),
      },
      inventory: [],
    });
    const stored = await object.fetch(new Request('https://edge.internal/state'));
    expect(stored.status).toBe(200);
    const tombstone = await stored.json() as PreviewState;
    expect(tombstone).toMatchObject({ lifecycle: 'closed', expectedHead: HEAD_A });
    expect(registerCandidate(tombstone, candidate('g2-bbbbbbbbbbbb')))
      .toMatchObject({ ok: false, status: 410, reason: 'closed' });
  });

  it('makes close win when it commits before promotion', () => {
    const withCandidate = registerCandidate(promoted(), candidate('g2-bbbbbbbbbbbb'));
    if (!withCandidate.ok) throw new Error(withCandidate.reason);
    const closed = closePreview(withCandidate.state, { pr: 42, epoch: 1, head: HEAD_A }, 100);
    if (!closed.ok) throw new Error(closed.reason);
    expect(closed.state).toMatchObject({ lifecycle: 'closed', epoch: 2, live: null, rollback: null, candidates: {} });
    expect([...new Set(closed.inventory?.map((resource) => resource.generation))].sort())
      .toEqual(['g1-aaaaaaaaaaaa', 'g2-bbbbbbbbbbbb']);
    const replay = closePreview(closed.state, { pr: 42, epoch: 2, head: HEAD_A }, 200);
    expect(replay).toMatchObject({
      ok: true,
      state: { lifecycle: 'closed', epoch: 2, closedAt: 100 },
    });
    if (!replay.ok) throw new Error(replay.reason);
    expect(replay.inventory).toEqual(closed.inventory);
    expect(closePreview(closed.state, { pr: 42, epoch: 1, head: HEAD_A }, 200))
      .toMatchObject({ ok: false, status: 409, reason: 'stale_epoch' });
    expect(promoteCandidate(closed.state, { pr: 42, epoch: 1, head: HEAD_A, generation: 'g2-bbbbbbbbbbbb', priorLiveGeneration: 'g1-aaaaaaaaaaaa' })).toMatchObject({ ok: false, status: 410, reason: 'closed' });
  });

  it('makes a committed promotion visible to the competing close, then tombstones every route', () => {
    const withCandidate = registerCandidate(promoted(), candidate('g2-bbbbbbbbbbbb'));
    if (!withCandidate.ok) throw new Error(withCandidate.reason);
    const promotedSecond = promoteCandidate(smoked(withCandidate.state, 'g2-bbbbbbbbbbbb'), {
      pr: 42, epoch: 1, head: HEAD_A, generation: 'g2-bbbbbbbbbbbb', priorLiveGeneration: 'g1-aaaaaaaaaaaa',
    });
    if (!promotedSecond.ok) throw new Error(promotedSecond.reason);
    expect(promotedSecond.state.live?.generation).toBe('g2-bbbbbbbbbbbb');
    const closed = closePreview(promotedSecond.state, { pr: 42, epoch: 1, head: HEAD_A }, 101);
    if (!closed.ok) throw new Error(closed.reason);
    expect(closed.state.live).toBeNull();
    expect([...new Set(closed.inventory?.map((resource) => resource.generation))].sort())
      .toEqual(['g1-aaaaaaaaaaaa', 'g2-bbbbbbbbbbbb']);
  });
});
describe('destination attestation interoperability', () => {
  it('emits DebugExport canonical ES256 {payload,signature} with the exact remote schema', async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
    ) as CryptoKeyPair;
    const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    if (privateJwk instanceof ArrayBuffer) throw new Error('JWK export returned binary key data');
    const now = Date.now();
    const payload = {
      format: 1,
      scope: 'remote-destination-attest',
      kind: 'remote',
      jti: 'destination_jti_1234',
      iat: now,
      exp: now + 600_000,
      destinationId: 'destination_id_123456',
      prNumber: 42,
      headSha: HEAD_A,
      generation: 'g1-aaaaaaaaaaaa',
      artifactDigest: DIGEST,
      environmentNonce: 'environment_nonce_42',
      buildInputDigest: DIGEST,
      inventoryDigest: null,
      sessionIds: ['session-a'],
      maxBytes: 1_000_000,
      encryptionPublicJwk: { kty: 'RSA', n: 'public', e: 'AQAB' },
    };
    const attestation = await signDestinationAttestation(
      { DESTINATION_ATTESTATION_PRIVATE_JWK: JSON.stringify(privateJwk) },
      payload,
    );
    expect(Object.keys(attestation).sort()).toEqual(['payload', 'signature']);
    expect(attestation.payload).toEqual(payload);
    expect(attestation.signature).toMatch(/^[A-Za-z0-9_-]+$/);
    const signature = attestation.signature.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(signature + '='.repeat((4 - signature.length % 4) % 4));
    expect(await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.publicKey,
      Uint8Array.from(binary, (ch) => ch.charCodeAt(0)),
      new TextEncoder().encode(canonicalJson(payload)),
    )).toBe(true);
    expect(privateJwk.key_ops).toEqual(['sign']);
    await expect(verifyDestinationAttestation(
      attestation,
      { DESTINATION_ATTESTATION_PRIVATE_JWK: JSON.stringify(privateJwk) },
    )).resolves.toEqual(payload);
  });
});


describe('remote destination lifetime', () => {
  it('fails on expiry, consumption/replay, and live tuple drift', () => {
    const state = promoted();
    const live = state.live!;
    const record = {
      head: live.head,
      generation: live.generation,
      artifactDigest: live.artifactDigest,
      expiresAt: 2_000,
    };
    expect(destinationUsable(record, state, 1_999)).toBe(true);
    expect(destinationUsable(record, state, 2_000)).toBe(false);
    expect(destinationUsable(null, state, 1_000), 'a consumed one-use record cannot replay').toBe(false);
    expect(destinationUsable({ ...record, head: HEAD_B }, state, 1_000)).toBe(false);
    expect(destinationUsable({ ...record, generation: 'g2-bbbbbbbbbbbb' }, state, 1_000)).toBe(false);
    expect(destinationUsable({ ...record, artifactDigest: 'e'.repeat(64) }, state, 1_000)).toBe(false);
    expect(destinationUsable(record, { ...state, lifecycle: 'closed', live: null }, 1_000)).toBe(false);
  });
});

describe('destination private-key lifecycle', () => {
  it('expires abandoned authorizations at the earliest alarm and tolerates repeated alarms', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const audit = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const harness = destinationLifecycleHarness();
      const first = destinationRecord('destination_first_12345', 1_010_000);
      const second = destinationRecord('destination_second_1234', 1_020_000);
      expect((await harness.post('destination-create', second)).status).toBe(200);
      expect((await harness.post('destination-create', first)).status).toBe(200);
      expect(harness.alarm()).toBe(first.expiresAt);
      expect(JSON.stringify(harness.data.get(`destination:${first.id}`))).not.toContain('PRIVATE_DESTINATION_KEY');

      vi.setSystemTime(first.expiresAt);
      await harness.object.alarm();
      expect(harness.data.get(`destination-import:${first.id}`)).toEqual({
        id: first.id, state: 'expired', expiresAt: first.expiresAt,
      });
      expect(harness.alarm()).toBe(second.expiresAt);
      await harness.object.alarm();
      expect(harness.data.get(`destination-import:${first.id}`)).toEqual({
        id: first.id, state: 'expired', expiresAt: first.expiresAt,
      });
      expectNoDestinationPrivateMaterial(new Map(
        [...harness.data].filter(([key]) => !key.endsWith(second.id)),
      ));
      expect(audit.mock.calls.every(([, event]) =>
        !JSON.stringify(event).includes('PRIVATE_DESTINATION_KEY'))).toBe(true);
    } finally {
      audit.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(['failed', 'aborted'] as const)('scrubs a %s import and keeps an idempotent replay tombstone', async (state) => {
    const audit = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const harness = destinationLifecycleHarness();
      const destination = destinationRecord(`destination_${state}_123456`, Date.now() + 60_000);
      expect((await harness.post('destination-create', destination)).status).toBe(200);
      expect((await harness.post('destination-consume', { id: destination.id })).status).toBe(200);
      expect((await harness.post('destination-start-import', {
        import: emptyDestinationImport(destination),
      })).status).toBe(201);
      expect(JSON.stringify(harness.data.get(`destination-import:${destination.id}`)))
        .not.toContain('PRIVATE_DESTINATION_KEY');

      const finished = await harness.post('destination-finish', { id: destination.id, state });
      expect(finished.status).toBe(200);
      expect(await finished.json()).toEqual({
        import: { id: destination.id, state, expiresAt: destination.expiresAt },
      });
      expect((await harness.post('destination-finish', { id: destination.id, state })).status).toBe(200);
      expect((await harness.post('destination-finish', {
        id: destination.id, state: state === 'failed' ? 'aborted' : 'failed',
      })).status).toBe(409);
      expectNoDestinationPrivateMaterial(harness.data);
    } finally {
      audit.mockRestore();
    }
  });

  it('scrubs only after a successful commit and rejects commit replay', async () => {
    const audit = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const harness = destinationLifecycleHarness();
      const destination = destinationRecord('destination_commit_123456', Date.now() + 60_000);
      await harness.post('destination-create', destination);
      await harness.post('destination-consume', { id: destination.id });
      await harness.post('destination-start-import', { import: emptyDestinationImport(destination) });

      const prepared = await harness.post('destination-commit', { id: destination.id });
      expect(prepared.status).toBe(200);
      expect(harness.data.has(`destination-key:${destination.id}`)).toBe(true);
      expect((await harness.post('destination-finish', {
        id: destination.id, state: 'committed',
      })).status).toBe(200);
      expect((await harness.post('destination-commit', { id: destination.id })).status).toBe(409);
      expect(harness.data.get(`destination-import:${destination.id}`)).toEqual({
        id: destination.id, state: 'committed', expiresAt: destination.expiresAt,
      });
      expectNoDestinationPrivateMaterial(harness.data);
    } finally {
      audit.mockRestore();
    }
  });

  it('scrubs authorization keys on PR close and pending import keys on head invalidation', async () => {
    const audit = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const closedHarness = destinationLifecycleHarness();
      const closeDestination = destinationRecord('destination_close_1234567', Date.now() + 60_000);
      await closedHarness.post('destination-create', closeDestination);
      expect((await closedHarness.post('close', { pr: 42, epoch: 1, head: HEAD_A })).status).toBe(200);
      expect(closedHarness.data.get(`destination-import:${closeDestination.id}`)).toMatchObject({
        id: closeDestination.id, state: 'invalidated',
      });
      expectNoDestinationPrivateMaterial(closedHarness.data);

      const headHarness = destinationLifecycleHarness();
      const headDestination = destinationRecord('destination_head_12345678', Date.now() + 60_000);
      await headHarness.post('destination-create', headDestination);
      await headHarness.post('destination-consume', { id: headDestination.id });
      await headHarness.post('destination-start-import', { import: emptyDestinationImport(headDestination) });
      const route = headHarness.data.get('route') as PreviewState;
      headHarness.data.set('route', {
        ...route,
        expectedHead: HEAD_B,
        live: route.live ? { ...route.live, head: HEAD_B } : null,
      });
      expect((await headHarness.post('destination-status', { id: headDestination.id })).status).toBe(409);
      expect(headHarness.data.get(`destination-import:${headDestination.id}`)).toMatchObject({
        id: headDestination.id, state: 'invalidated',
      });
      expectNoDestinationPrivateMaterial(headHarness.data);
    } finally {
      audit.mockRestore();
    }
  });

  it('reserves object delivery atomically, releases failures, and commits only delivered objects', async () => {
    const audit = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const harness = destinationLifecycleHarness();
      const destination = destinationRecord('destination_object_123456', Date.now() + 60_000);
      const value = emptyDestinationImport(destination);
      value.manifest = {
        ...value.manifest,
        totalSize: 1,
        objectCount: 1,
        objects: [{
          objectId: 'object-a',
          size: 1,
          sha256: 'a'.repeat(64),
          ciphertextSize: 17,
          ciphertextSha256: 'b'.repeat(64),
          wrappedKey: 'wrapped',
          nonce: 'nonce',
          aad: '{}',
        }],
      };
      await harness.post('destination-create', destination);
      await harness.post('destination-consume', { id: destination.id });
      await harness.post('destination-start-import', { import: value });

      const metadata = await harness.post('destination-object', { id: destination.id, objectId: 'object-a' });
      expect(metadata.status).toBe(200);
      expect((await metadata.json() as { import: { usedObjectIds: string[]; reservedObjectIds: string[] } }).import)
        .toMatchObject({ usedObjectIds: [], reservedObjectIds: [] });
      expect((await harness.post('destination-object-reserve', {
        id: destination.id, objectId: 'object-a',
      })).status).toBe(200);
      expect((await harness.post('destination-object-reserve', {
        id: destination.id, objectId: 'object-a',
      })).status).toBe(409);
      expect((await harness.post('destination-object-finish', {
        id: destination.id, objectId: 'object-a', delivered: false,
      })).status).toBe(200);
      expect((await harness.post('destination-object-reserve', {
        id: destination.id, objectId: 'object-a',
      })).status).toBe(200);
      expect((await harness.post('destination-object-finish', {
        id: destination.id, objectId: 'object-a', delivered: true,
      })).status).toBe(200);
      expect((await harness.post('destination-commit', { id: destination.id })).status).toBe(200);
      await harness.post('destination-finish', { id: destination.id, state: 'committed' });
      expectNoDestinationPrivateMaterial(harness.data);
    } finally {
      audit.mockRestore();
    }
  });

  it('validates exact safe plaintext and AES-GCM ciphertext totals', () => {
    const object = {
      objectId: 'object-a',
      size: 4,
      sha256: 'a'.repeat(64),
      ciphertextSize: 20,
      ciphertextSha256: 'b'.repeat(64),
      wrappedKey: 'wrapped',
      nonce: 'nonce',
      aad: '{}',
    };
    const manifest = {
      format: 1 as const,
      sessionIds: ['session-a'],
      inventoryDigest: 'f'.repeat(64),
      totalSize: 4,
      objectCount: 1,
      expiresAt: Date.now() + 60_000,
      objects: [object],
      signature: { alg: 'ES256' as const, value: 'signature' },
    };
    expect(validDestinationManifestTotals(manifest, 4)).toBe(true);
    expect(validDestinationManifestTotals({ ...manifest, totalSize: 3 }, 4)).toBe(false);
    expect(validDestinationManifestTotals({ ...manifest, objects: [{ ...object, size: -1 }] }, 4)).toBe(false);
    expect(validDestinationManifestTotals({
      ...manifest, objects: [{ ...object, ciphertextSize: object.size + 15 }],
    }, 4)).toBe(false);
    expect(validDestinationManifestTotals(manifest, 3)).toBe(false);
    expect(validDestinationManifestTotals({
      ...manifest,
      totalSize: Number.MAX_SAFE_INTEGER,
      objects: [
        { ...object, size: Number.MAX_SAFE_INTEGER - 16, ciphertextSize: Number.MAX_SAFE_INTEGER },
        { ...object, objectId: 'object-b', size: 17, ciphertextSize: 33 },
      ],
    }, Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});

describe('browser/loopback destination handoff', () => {
  it('accepts only exact loopback callback origins', () => {
    expect(validLoopbackCallback('http://127.0.0.1:43123/callback')).toBe(true);
    expect(validLoopbackCallback('https://127.0.0.1:43123/callback')).toBe(false);
    expect(validLoopbackCallback('http://localhost:43123/callback')).toBe(false);
    expect(validLoopbackCallback('http://127.0.0.1:43123/other')).toBe(false);
    expect(validLoopbackCallback('http://127.0.0.1:43123/callback?steal=1')).toBe(false);
    expect(validLoopbackCallback('http://evil.example:43123/callback')).toBe(false);
  });

  it('binds exchange codes to PKCE, expiry, and one-use replay consumption', async () => {
    const data = new Map<string, unknown>();
    const storage = {
      get: async <T>(key: string) => data.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { data.set(key, value); },
      delete: async (key: string) => data.delete(key),
      list: async <T>({ prefix }: { prefix: string }) => new Map(
        [...data.entries()].filter(([key]) => key.startsWith(prefix)),
      ) as Map<string, T>,
      transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(storage),
    };
    const object = new PreviewEdgeAuth({ storage } as unknown as DurableObjectState);
    const verifier = 'v'.repeat(48);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    let binary = '';
    for (const byte of digest) binary += String.fromCharCode(byte);
    const challenge = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const post = (path: string, body: unknown) => object.fetch(new Request(`https://edge.internal/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    const code = 'c'.repeat(43);
    expect((await post('destination-exchange-create', {
      code, challenge, result: { exact: 'attestation' }, expiresAt: Date.now() + 60_000,
    })).status).toBe(201);
    expect((await post('destination-exchange-consume', { code, verifier: 'wrong' })).status).toBe(403);
    const accepted = await post('destination-exchange-consume', { code, verifier });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ exact: 'attestation' });
    expect((await post('destination-exchange-consume', { code, verifier })).status).toBe(409);

    const expiredCode = 'e'.repeat(43);
    // Insert an expired record directly because creation correctly refuses already-expired codes.
    const encoded = new TextEncoder().encode(expiredCode);
    const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoded))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    data.set(`destination-exchange:${hex}`, { challenge, result: {}, expiresAt: Date.now() - 1 });
    expect((await post('destination-exchange-consume', { code: expiredCode, verifier })).status).toBe(401);
  });
});

describe('request boundary', () => {
  it('binds the complete raw pathname/query and rejects ambiguous encodings/selectors', () => {
    expect(canonicalTarget('/s/id?view=chronological&page=4')).toBe('/s/id?view=chronological&page=4');
    expect(canonicalTarget('/s%2fid')).toBeNull();
    expect(canonicalTarget('/s/%ZZ')).toBeNull();
    expect(canonicalTarget('/s?id=one&id=two')).toBeNull();
    expect(canonicalTarget('//evil.example/x')).toBeNull();
  });

  it('constructs requests and responses from distinct allowlists', () => {
    const request = safeRequestHeaders(new Headers({
      accept: 'text/html', authorization: 'Bearer secret', cookie: 'secret=1',
      'cf-access-jwt-assertion': 'access', 'x-forwarded-for': '127.0.0.1', 'x-unknown': 'drop',
      'content-type': 'application/json', origin: 'https://evil.example',
      'x-content-hash': `sha256:${DIGEST}`, 'x-file-mtime': '2026-07-01T00:00:00.000Z',
      'x-file-size': '42', 'x-part-is-last': '1', 'x-part-size': '5242880',
    }), 'https://g1.preview.workers.dev', true);
    expect(Object.fromEntries(request)).toEqual({
      accept: 'text/html',
      'content-type': 'application/json',
      origin: 'https://g1.preview.workers.dev',
      'x-content-hash': `sha256:${DIGEST}`,
      'x-file-mtime': '2026-07-01T00:00:00.000Z',
      'x-file-size': '42',
      'x-part-is-last': '1',
      'x-part-size': '5242880',
    });

    const response = safeResponseHeaders(
      new Headers({ 'content-type': 'text/html', 'set-cookie': 'stolen=1', 'x-secret': 'drop', location: 'https://g1.preview.workers.dev/s/id' }),
      new URL('https://g1.preview.workers.dev/'),
      new URL('https://pr-42-preview.sessions.vza.net/'),
    );
    expect(Object.fromEntries(response)).toEqual({
      'content-type': 'text/html', location: 'https://pr-42-preview.sessions.vza.net/s/id',
    });
  });
});
