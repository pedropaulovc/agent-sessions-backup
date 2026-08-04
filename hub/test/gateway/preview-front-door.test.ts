import { describe, expect, it } from 'vitest';
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
  validLoopbackCallback,
  type PreviewState,
} from '../../gateway/preview-front-door';
import configSource from '../../wrangler.preview-front-door.jsonc?raw';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const DIGEST = 'd'.repeat(64);

function candidate(generation: string, head = HEAD_A, epoch = 1) {
  return {
    pr: 42,
    epoch,
    head,
    generation,
    versionUrl: `https://${generation}.preview.workers.dev/`,
    artifactDigest: DIGEST,
    environmentNonce: 'environment_nonce_42',
    buildInputDigest: DIGEST,
    schemaDigest: DIGEST,
    resources: [{ kind: 'd1', id: `${generation}-db`, name: `pr-42-${generation}-db`, generation }],
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
    expect(result.state.candidates['g2-bbbbbbbbbbbb']?.versionUrl).toBe('https://g2-bbbbbbbbbbbb.preview.workers.dev/');
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

  it('makes close win when it commits before promotion', () => {
    const withCandidate = registerCandidate(promoted(), candidate('g2-bbbbbbbbbbbb'));
    if (!withCandidate.ok) throw new Error(withCandidate.reason);
    const closed = closePreview(withCandidate.state, { pr: 42, epoch: 1, head: HEAD_A }, 100);
    if (!closed.ok) throw new Error(closed.reason);
    expect(closed.state).toMatchObject({ lifecycle: 'closed', epoch: 2, live: null, rollback: null, candidates: {} });
    expect(closed.inventory?.map((tuple) => tuple.generation).sort()).toEqual(['g1-aaaaaaaaaaaa', 'g2-bbbbbbbbbbbb']);
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
    expect(closed.inventory?.map((tuple) => tuple.generation).sort()).toEqual(['g1-aaaaaaaaaaaa', 'g2-bbbbbbbbbbbb']);
  });
});
describe('destination attestation interoperability', () => {
  it('emits DebugExport canonical ES256 {payload,signature} with the exact remote schema', async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
    ) as CryptoKeyPair;
    const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
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
    }), 'https://g1.preview.workers.dev', true);
    expect(Object.fromEntries(request)).toEqual({
      accept: 'text/html', 'content-type': 'application/json', origin: 'https://g1.preview.workers.dev',
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
