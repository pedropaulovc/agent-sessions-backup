import { verifyGitHubOidc } from '../src/auth/github-oidc';

const PUBLIC_SUFFIX = '-preview.sessions.vza.net';
const CONTROL_HOST = 'preview-control.sessions.vza.net';
const PREVIEW_VERSION_SUFFIX = '.agent-sessions-nonproduction.workers.dev';
const COOKIE = '__Host-preview-edge';
const ASSERTION_TTL_SECONDS = 45;
const ASSERTION_CLOCK_SKEW_SECONDS = 5;
const SESSION_TTL_SECONDS = 3600;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const AUDIENCES = {
  browser: 'urn:sessions:preview:browser:v1',
  action: 'urn:sessions:preview:action:v1',
  origin: 'urn:sessions:preview:origin:v1',
  destination: 'urn:sessions:preview:destination:v1',
} as const;

type Audience = 'preview-browser' | 'preview-action';
type JsonWebKeyWithKid = JsonWebKey & { kid: string; alg?: string; revoked?: boolean; notBefore?: number; notAfter?: number };
interface SigningKey { kid: string; privateKeyPem?: string; publicJwk?: JsonWebKey; notBefore?: number; notAfter?: number; revoked?: boolean }
interface SigningRing { active: SigningKey; previous?: SigningKey[]; revokedKids?: string[] }

interface FrontDoorEnv {
  PREVIEW_EDGE_AUTH: DurableObjectNamespace;
  EDGE_ISSUER: string;
  BROWSER_SIGNING_KEYS: string;
  ACTION_SIGNING_KEYS: string;
  ORIGIN_SIGNING_KEYS: string;
  DESTINATION_ATTESTATION_PRIVATE_JWK: string;
  DEBUG_IMPORT_ASSERTION_PRIVATE_JWK: string;
  PREVIEW_CONTROL_DEPLOY_WORKFLOW_REF: string;
  PREVIEW_CONTROL_CLOSE_WORKFLOW_REF: string;
  PREVIEW_CONTROL_JANITOR_WORKFLOW_REF: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ACCESS_ALLOWED_EMAILS: string;
  PREVIEW_CONTROL_REPOSITORY: string;
  PREVIEW_CONTROL_DEFAULT_REF: string;
  PREVIEW_CONTROL_DEPLOY_AUD: string;
  PREVIEW_CONTROL_CLOSE_AUD: string;
  PREVIEW_CONTROL_JANITOR_AUD: string;
}

interface PreviewAppBinding {
  fetch(request: Request): Promise<Response>;
}

interface TrustedPreviewIngressEnv {
  APP: PreviewAppBinding;
  PREVIEW_ORIGIN_ASSERTION_JWKS: string;
}

type PreviewResource = { kind: string; id: string; name: string; generation: string };
export interface RouteTuple {
  generation: string;
  versionUrl: string;
  head: string;
  artifactDigest: string;
  environmentNonce: string;
  buildInputDigest: string;
  schemaDigest: string;
  resources: PreviewResource[];
  smoke?: { digest: string; recordedAt: number };
}

export interface PreviewState {
  lifecycle: 'open' | 'closed';
  epoch: number;
  expectedHead: string;
  live: RouteTuple | null;
  candidates: Record<string, RouteTuple>;
  rollback: RouteTuple | null;
  deletionInventory: RouteTuple[];
  closedAt?: number;
}

interface RegisterInput extends Omit<RouteTuple, 'head'> { pr: number; epoch: number; head: string; priorHead?: string }
interface CasInput { pr: number; epoch: number; head: string; generation: string; priorLiveGeneration: string | null }
interface CloseInput { pr: number; epoch: number; head: string }
interface GrantInput {
  pr: number;
  epoch: number;
  head: string;
  generation: string;
  audience: Audience;
  method: string;
  target: string;
  bodyDigest?: string;
  actor: string;
  purpose?: string;
  machineId?: string;
  isAdmin?: boolean;
  expiresIn?: number;
}
interface EdgeGrant extends GrantInput { code: string; expiresAt: number }
interface EdgeSession extends Omit<EdgeGrant, 'code' | 'expiresIn'> { id: string; host: string; expiresAt: number }
interface DestinationRecord {
  id: string;
  pr: number;
  head: string;
  generation: string;
  artifactDigest: string;
  environmentNonce: string;
  buildInputDigest: string;
  inventoryDigest: string | null;
  maxBytes: number;
  actor: string;
  expiresAt: number;
  publicKeyJwk: JsonWebKey;
  sessionIds: string[];
}

interface DestinationKeyRecord {
  destinationId: string;
  head: string;
  generation: string;
  artifactDigest: string;
  expiresAt: number;
  privateKeyJwk: JsonWebKey;
}

interface DebugManifestObject {
  objectId: string;
  size: number;
  sha256: string;
  ciphertextSize: number;
  ciphertextSha256: string;
  wrappedKey: string;
  nonce: string;
  aad: string;
}

interface DebugManifest {
  format: 1;
  sessionIds: string[];
  inventoryDigest: string;
  totalSize: number;
  objectCount: number;
  expiresAt: number;
  objects: DebugManifestObject[];
  signature: { alg: 'ES256'; value: string };
}

type DestinationImportState = 'pending' | 'committed' | 'failed' | 'aborted' | 'expired' | 'invalidated' | 'cleaned';

interface DestinationImport {
  destination: DestinationRecord;
  manifest: DebugManifest;
  upstreamCapability: string;
  usedObjectIds: string[];
  reservedObjectIds: string[];
  state: 'pending';
  expiresAt: number;
}

interface DestinationImportTombstone {
  id: string;
  state: Exclude<DestinationImportState, 'pending'>;
  expiresAt: number;
}

type StoredDestinationImport = DestinationImport | DestinationImportTombstone;

interface DestinationStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

interface GenerationAllocation {
  pr: number;
  epoch: number;
  head: string;
  generation: string;
  artifactDigest: string;
  buildInputDigest: string;
  environmentNonce: string;
  schemaDigest?: string;
  versionUrl?: string;
  planned: Array<{ kind: string; name: string }>;
  recorded: PreviewResource[];
  createdAt: number;
}

interface DestinationExchange {
  challenge: string;
  result: Record<string, unknown>;
  expiresAt: number;
}
export interface CleanupResource {
  kind: string;
  id: string | null;
  name: string;
  generation: string;
  source: 'route' | 'allocation';
}

function cleanupResources(tuples: RouteTuple[], source: CleanupResource['source'] = 'route'): CleanupResource[] {
  return tuples.flatMap((tuple) => tuple.resources.map((resource) => ({ ...resource, source })));
}

export function destinationUsable(

  record: Pick<DestinationRecord, 'head' | 'generation' | 'artifactDigest' | 'expiresAt'> | null,
  state: PreviewState,
  now = Date.now(),
): boolean {
  return !!record
    && record.expiresAt > now
    && state.lifecycle === 'open'
    && state.live?.head === record.head
    && state.live.generation === record.generation
    && state.live.artifactDigest === record.artifactDigest;
}
export function validDestinationManifestTotals(manifest: DebugManifest, maxBytes: number): boolean {
  if (
    !Array.isArray(manifest.objects)
    || !Number.isSafeInteger(manifest.totalSize) || manifest.totalSize < 0
    || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || manifest.totalSize > maxBytes
  ) return false;
  let plaintextTotal = 0;
  let ciphertextTotal = 0;
  for (const object of manifest.objects) {
    if (
      !Number.isSafeInteger(object.size) || object.size < 0
      || !Number.isSafeInteger(object.ciphertextSize) || object.ciphertextSize < 0
      || object.ciphertextSize !== object.size + 16
    ) return false;
    plaintextTotal += object.size;
    ciphertextTotal += object.ciphertextSize;
    if (!Number.isSafeInteger(plaintextTotal) || !Number.isSafeInteger(ciphertextTotal)) return false;
  }
  return plaintextTotal === manifest.totalSize;
}

function pendingDestinationImport(value: StoredDestinationImport | undefined): value is DestinationImport {
  return value?.state === 'pending';
}

function auditDestination(destinationId: string, state: DestinationImportState | 'authorized'): void {
  console.info('preview_destination_lifecycle', { destinationId, state });
}

export type TransitionResult = { ok: true; state: PreviewState; inventory?: CleanupResource[] } | { ok: false; status: 409 | 410; reason: string };

function generationRank(value: string): bigint | null {
  const match = /^g(\d+)-[0-9a-f]{12}$/.exec(value);
  return match ? BigInt(match[1]!) : null;
}

function validHead(head: string): boolean {
  return /^[0-9a-f]{40}$/.test(head);
}

function validTuple(input: RegisterInput): boolean {
  if (!Number.isSafeInteger(input.pr) || input.pr <= 0 || !Number.isSafeInteger(input.epoch) || input.epoch <= 0) return false;
  if (!validHead(input.head) || generationRank(input.generation) === null) return false;
  const edgeName = `pr-${input.pr}-${input.generation}-edge`;
  const appName = `pr-${input.pr}-${input.generation}-app`;
  try {
    const url = new URL(input.versionUrl);
    if (
      url.protocol !== 'https:' || !url.hostname.endsWith(PREVIEW_VERSION_SUFFIX)
      || !url.hostname.includes(edgeName)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    ) return false;
  } catch {
    return false;
  }
  if (
    !/^[0-9a-f]{64}$/.test(input.artifactDigest)
    || !/^[A-Za-z0-9_-]{16,128}$/.test(input.environmentNonce)
    || !/^[0-9a-f]{64}$/.test(input.buildInputDigest)
    || !/^[0-9a-f]{64}$/.test(input.schemaDigest)
    || !Array.isArray(input.resources)
    || input.resources.some((resource) => !resource
      || resource.generation !== input.generation
      || !resource.name?.startsWith(`pr-${input.pr}-${input.generation}-`))
  ) return false;
  const workerIdentity = (kind: string, name: string) => input.resources
    .filter((resource) => resource.kind === kind && resource.name === name).length === 1;
  return workerIdentity('app-version', appName)
    && workerIdentity('app-worker', appName)
    && workerIdentity('edge-version', edgeName)
    && workerIdentity('edge-worker', edgeName);
}

export function registerCandidate(current: PreviewState | undefined, input: RegisterInput): TransitionResult {
  if (!validTuple(input)) return { ok: false, status: 409, reason: 'invalid_candidate' };
  if (!current) {
    if (input.epoch !== 1) return { ok: false, status: 409, reason: 'bad_initial_epoch' };
    return {
      ok: true,
      state: {
        lifecycle: 'open', epoch: 1, expectedHead: input.head, live: null,
        candidates: { [input.generation]: tupleOf(input) }, rollback: null, deletionInventory: [],
      },
    };
  }
  if (current.lifecycle === 'closed') return { ok: false, status: 410, reason: 'closed' };
  let base = current;
  let superseded: RouteTuple[] = [];
  if (input.head !== current.expectedHead) {
    if (input.epoch !== current.epoch || input.priorHead !== current.expectedHead) {
      return { ok: false, status: 409, reason: 'stale_head' };
    }
    superseded = Object.values(current.candidates);
    base = {
      ...current,
      epoch: current.epoch + 1,
      expectedHead: input.head,
      candidates: {},
      deletionInventory: [...current.deletionInventory, ...superseded],
    };
  } else {
    const guard = openCas(current, input.epoch, input.head);
    if (guard) return guard;
  }
  const incoming = generationRank(input.generation)!;
  const ranks = [base.live, base.rollback, ...Object.values(base.candidates)].filter(Boolean).map((v) => generationRank(v!.generation)!).filter((v): v is bigint => v !== null);
  if (ranks.some((rank) => rank >= incoming)) return { ok: false, status: 409, reason: 'stale_generation' };
  return {
    ok: true,
    state: { ...base, candidates: { ...base.candidates, [input.generation]: tupleOf(input) } },
    ...(superseded.length ? { inventory: cleanupResources(superseded) } : {}),
  };
}
function tupleOf(input: RegisterInput): RouteTuple {
  return {
    generation: input.generation, versionUrl: input.versionUrl, head: input.head,
    artifactDigest: input.artifactDigest, environmentNonce: input.environmentNonce,
    buildInputDigest: input.buildInputDigest,
    schemaDigest: input.schemaDigest, resources: input.resources,
  };
}

function openCas(current: PreviewState, epoch: number, head: string): Extract<TransitionResult, { ok: false }> | null {
  if (current.lifecycle === 'closed') return { ok: false, status: 410, reason: 'closed' };
  if (current.epoch !== epoch) return { ok: false, status: 409, reason: 'stale_epoch' };
  if (current.expectedHead !== head) return { ok: false, status: 409, reason: 'stale_head' };
  return null;
}

export function promoteCandidate(current: PreviewState, input: CasInput): TransitionResult {
  const guard = openCas(current, input.epoch, input.head);
  if (guard) return guard;
  const candidate = current.candidates[input.generation];
  if (!candidate) return { ok: false, status: 409, reason: 'candidate_not_found' };
  if (!candidate.smoke) return { ok: false, status: 409, reason: 'candidate_not_smoked' };
  if ((current.live?.generation ?? null) !== input.priorLiveGeneration) return { ok: false, status: 409, reason: 'live_changed' };
  const candidates = { ...current.candidates };
  delete candidates[input.generation];
  return { ok: true, state: { ...current, live: candidate, rollback: current.live, candidates } };
}

export function rollbackLive(current: PreviewState, input: CasInput): TransitionResult {
  const guard = openCas(current, input.epoch, input.head);
  if (guard) return guard;
  if ((current.live?.generation ?? null) !== input.priorLiveGeneration) return { ok: false, status: 409, reason: 'live_changed' };
  if (!current.rollback || current.rollback.generation !== input.generation) return { ok: false, status: 409, reason: 'rollback_not_found' };
  return { ok: true, state: { ...current, live: current.rollback, rollback: current.live } };
}

export function closePreview(current: PreviewState | undefined, input: CloseInput, now = Date.now()): TransitionResult {
  if (!current) {
    if (input.epoch !== 1 || !validHead(input.head)) {
      return { ok: false, status: 409, reason: 'invalid_initial_close' };
    }
    return {
      ok: true,
      state: {
        lifecycle: 'closed',
        epoch: 2,
        expectedHead: input.head,
        live: null,
        rollback: null,
        candidates: {},
        deletionInventory: [],
        closedAt: now,
      },
      inventory: [],
    };
  }
  if (current.lifecycle === 'closed') {
    if (current.epoch !== input.epoch) return { ok: false, status: 409, reason: 'stale_epoch' };
    if (current.expectedHead !== input.head) return { ok: false, status: 409, reason: 'stale_head' };
    return { ok: true, state: current, inventory: cleanupResources(current.deletionInventory) };
  }
  const guard = openCas(current, input.epoch, input.head);
  if (guard) return guard;
  const inventory = [current.live, current.rollback, ...Object.values(current.candidates)].filter((tuple): tuple is RouteTuple => !!tuple);
  const state: PreviewState = {
    ...current, lifecycle: 'closed', epoch: current.epoch + 1, live: null, rollback: null,
    candidates: {}, deletionInventory: [...current.deletionInventory, ...inventory], closedAt: now,
  };
  return { ok: true, state, inventory: cleanupResources(state.deletionInventory) };
}

function randomToken(bytes = 32): string {
  const out = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = '';
  for (const byte of out) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function json(body: unknown, status = 200, extra?: HeadersInit): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...extra } });
}

async function requestJson<T>(request: Request): Promise<T | null> {
  try { return await request.json() as T; } catch { return null; }
}

export class PreviewEdgeAuth {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await requestJson<Record<string, unknown>>(request) : null;
    if (request.method === 'GET' && url.pathname === '/state') return this.stateResponse();
    if (request.method === 'GET' && url.pathname === '/allocations') return this.allocationsResponse();
    if (request.method === 'POST' && url.pathname === '/begin-generation') return this.beginGeneration(body);
    if (request.method === 'POST' && url.pathname === '/record-resource') return this.recordResource(body);
    if (request.method === 'POST' && url.pathname === '/register') return this.registerTransition(body);
    if (request.method === 'POST' && url.pathname === '/smoke-success') return this.smokeSuccess(body);
    if (request.method === 'POST' && url.pathname === '/promote') return this.transition(body, promoteCandidate);
    if (request.method === 'POST' && url.pathname === '/rollback') return this.transition(body, rollbackLive);
    if (request.method === 'POST' && url.pathname === '/close') return this.transition(body, closePreview);
    if (request.method === 'POST' && url.pathname === '/consume-control') return this.consume(`control:${String(body?.jti ?? '')}`, Number(body?.expiresAt));
    if (request.method === 'POST' && url.pathname === '/grant') return this.createGrant(body as unknown as GrantInput);
    if (request.method === 'POST' && url.pathname === '/consume-grant') return this.consumeGrant(String(body?.code ?? ''), String(body?.host ?? ''));
    if (request.method === 'POST' && url.pathname === '/session') return this.readSession(String(body?.id ?? ''), String(body?.host ?? ''));
    if (request.method === 'POST' && url.pathname === '/janitor') return this.janitor(body);
    if (request.method === 'POST' && url.pathname === '/register-pr') return this.registerPr(Number(body?.pr));
    if (request.method === 'GET' && url.pathname === '/list-prs') return this.listPrs();
    if (request.method === 'POST' && url.pathname === '/destination-create') return this.createDestination(body);
    if (request.method === 'POST' && url.pathname === '/destination-consume') return this.consumeDestination(body);
    if (request.method === 'POST' && url.pathname === '/destination-extend') return this.extendDestination(body);
    if (request.method === 'POST' && url.pathname === '/janitor-ack') return this.janitorAck(body);
    if (request.method === 'POST' && url.pathname === '/destination-start-import') return this.startDestinationImport(body);
    if (request.method === 'POST' && url.pathname === '/destination-object') return this.consumeDestinationObject(body);
    if (request.method === 'POST' && url.pathname === '/destination-object-reserve') return this.reserveDestinationObject(body);
    if (request.method === 'POST' && url.pathname === '/destination-object-finish') return this.finishDestinationObject(body);
    if (request.method === 'POST' && url.pathname === '/destination-exchange-create') return this.createDestinationExchange(body);
    if (request.method === 'POST' && url.pathname === '/destination-exchange-consume') return this.consumeDestinationExchange(body);
    if (request.method === 'POST' && url.pathname === '/destination-commit') return this.commitDestinationImport(body);
    if (request.method === 'POST' && url.pathname === '/destination-finish') return this.finishDestinationImport(body);
    if (request.method === 'POST' && url.pathname === '/destination-status') return this.destinationImportStatus(body);
    return json({ error: 'not_found' }, 404);
  }

  private async stateResponse(): Promise<Response> {
    const state = await this.state.storage.get<PreviewState>('route');
    return state ? json(state) : json({ error: 'not_found' }, 404);
  }

  private async allocationsResponse(): Promise<Response> {
    const rows = await this.state.storage.list<GenerationAllocation>({ prefix: 'allocation:' });
    return json({ allocations: [...rows.values()] });
  }
  private async beginGeneration(body: Record<string, unknown> | null): Promise<Response> {
    if (!body || !Array.isArray(body.planned)) return json({ error: 'bad_json' }, 400);
    const pr = Number(body.pr);
    const epoch = Number(body.epoch);
    const head = String(body.head ?? '');
    const generation = String(body.generation ?? '');
    const allowedKinds: Record<string, true> = {
      'app-worker': true, 'app-version': true, 'edge-worker': true, 'edge-version': true,
      d1: true, r2: true, kv: true, queue: true,
    };
    const planned = body.planned as Array<{ kind?: unknown; name?: unknown }>;
    if (
      !Number.isSafeInteger(pr) || pr <= 0 || !Number.isSafeInteger(epoch) || epoch <= 0
      || !validHead(head) || generationRank(generation) === null || planned.length === 0
      || !/^[0-9a-f]{64}$/.test(String(body.artifactDigest ?? ''))
      || !/^[0-9a-f]{64}$/.test(String(body.buildInputDigest ?? ''))
      || !/^[A-Za-z0-9_-]{16,128}$/.test(String(body.environmentNonce ?? ''))
      || planned.some((item) => typeof item.kind !== 'string' || !allowedKinds[item.kind]
        || typeof item.name !== 'string' || !item.name.startsWith(`pr-${pr}-${generation}-`))
      || new Set(planned.map((item) => `${item.kind}\0${item.name}`)).size !== planned.length
    ) return json({ error: 'invalid_plan' }, 400);
    const allocation: GenerationAllocation = {
      pr, epoch, head, generation,
      artifactDigest: String(body.artifactDigest),
      buildInputDigest: String(body.buildInputDigest),
      environmentNonce: String(body.environmentNonce),
      planned: planned as Array<{ kind: string; name: string }>,
      recorded: [],
      createdAt: Date.now(),
    };
    const key = `allocation:${generation}`;
    return this.state.storage.transaction(async (tx) => {
      const existing = await tx.get<GenerationAllocation>(key);
      if (existing) {
        const same = JSON.stringify(existing.planned) === JSON.stringify(allocation.planned)
          && existing.pr === pr && existing.epoch === epoch && existing.head === head
          && existing.artifactDigest === allocation.artifactDigest
          && existing.buildInputDigest === allocation.buildInputDigest;
        return same ? json(existing) : json({ error: 'generation_collision' }, 409);
      }
      await tx.put(key, allocation);
      return json(allocation, 201);
    });
  }

  private async recordResource(body: Record<string, unknown> | null): Promise<Response> {
    if (!body) return json({ error: 'bad_json' }, 400);
    const generation = String(body.generation ?? '');
    const resource = body.resource as PreviewResource | undefined;
    if (!resource || resource.generation !== generation || !resource.id || !resource.kind || !resource.name) {
      return json({ error: 'invalid_resource' }, 400);
    }
    return this.state.storage.transaction(async (tx) => {
      const key = `allocation:${generation}`;
      const allocation = await tx.get<GenerationAllocation>(key);
      if (!allocation || allocation.pr !== Number(body.pr) || allocation.head !== body.head) {
        return json({ error: 'allocation_not_found' }, 404);
      }
      if (!allocation.planned.some((item) => item.kind === resource.kind && item.name === resource.name)) {
        return json({ error: 'unplanned_resource' }, 409);
      }
      const collision = allocation.recorded.find((item) => item.id === resource.id
        || item.kind === resource.kind && item.name === resource.name);
      if (collision) {
        return JSON.stringify(collision) === JSON.stringify(resource)
          ? json(allocation)
          : json({ error: 'resource_collision' }, 409);
      }
      const schemaDigest = body.schemaDigest === undefined ? allocation.schemaDigest : String(body.schemaDigest);
      if (schemaDigest !== undefined && !/^[0-9a-f]{64}$/.test(schemaDigest)) {
        return json({ error: 'invalid_schema_digest' }, 400);
      }
      let versionUrl = allocation.versionUrl;
      if (body.versionUrl !== undefined) {
        try {
          const parsed = new URL(String(body.versionUrl));
          if (resource.kind !== 'edge-version' || parsed.protocol !== 'https:'
            || !parsed.hostname.endsWith('.workers.dev') || parsed.pathname !== '/') {
            return json({ error: 'invalid_version_url' }, 400);
          }
          versionUrl = parsed.href;
        } catch {
          return json({ error: 'invalid_version_url' }, 400);
        }
      }
      const next = { ...allocation, schemaDigest, versionUrl, recorded: [...allocation.recorded, resource] };
      await tx.put(key, next);
      return json(next, 201);
    });
  }

  private async registerTransition(body: Record<string, unknown> | null): Promise<Response> {
    if (!body) return json({ error: 'bad_json' }, 400);
    return this.state.storage.transaction(async (tx) => {
      const generation = String(body.generation ?? '');
      const key = `allocation:${generation}`;
      const allocation = await tx.get<GenerationAllocation>(key);
      if (!allocation) return json({ error: 'allocation_not_found' }, 409);
      const resources = Array.isArray(body.resources) ? body.resources as PreviewResource[] : [];
      const normalize = (items: PreviewResource[]) => [...items]
        .sort((a, b) => `${a.kind}\0${a.name}\0${a.id}`.localeCompare(`${b.kind}\0${b.name}\0${b.id}`));
      if (
        allocation.pr !== Number(body.pr) || allocation.head !== body.head
        || allocation.planned.length !== allocation.recorded.length
        || JSON.stringify(normalize(resources)) !== JSON.stringify(normalize(allocation.recorded))
      ) return json({ error: 'incomplete_or_mismatched_inventory' }, 409);
      const current = await tx.get<PreviewState>('route');
      const result = registerCandidate(current, body as unknown as RegisterInput);
      if (!result.ok) return json({ error: result.reason }, result.status);
      await tx.put('route', result.state);
      await tx.delete(key);
      return json(result.inventory ? { state: result.state, inventory: result.inventory } : result.state);
    });
  }


  private async smokeSuccess(body: Record<string, unknown> | null): Promise<Response> {
    if (!body || !/^[0-9a-f]{64}$/.test(String(body.smokeDigest ?? ''))) {
      return json({ error: 'invalid_smoke_digest' }, 400);
    }
    return this.state.storage.transaction(async (tx) => {
      const route = await tx.get<PreviewState>('route');
      if (!route) return json({ error: 'not_found' }, 404);
      const guard = openCas(route, Number(body.epoch), String(body.head));
      if (guard) return json({ error: guard.reason }, guard.status);
      const generation = String(body.generation ?? '');
      const candidate = route.candidates[generation];
      if (!candidate) return json({ error: 'candidate_not_found' }, 409);
      const next = {
        ...route,
        candidates: {
          ...route.candidates,
          [generation]: { ...candidate, smoke: { digest: String(body.smokeDigest), recordedAt: Date.now() } },
        },
      };
      await tx.put('route', next);
      return json(next);
    });
  }
  private async transition(body: Record<string, unknown> | null, fn: (state: never, input: never) => TransitionResult): Promise<Response> {
    if (!body) return json({ error: 'bad_json' }, 400);
    let next: PreviewState | undefined;
    const response = await this.state.storage.transaction(async (tx) => {
      const current = await tx.get<PreviewState>('route');
      if (!current && fn !== registerCandidate && fn !== closePreview) return json({ error: 'not_found' }, 404);
      const result = fn(current as never, body as never);
      if (!result.ok) return json({ error: result.reason }, result.status);
      next = result.state;
      await tx.put('route', result.state);
      return json(result.inventory ? { state: result.state, inventory: result.inventory } : result.state);
    });
    if (response.ok && next) await this.scrubInvalidDestinations(next);
    return response;
  }

  private async consume(key: string, expiresAt: number): Promise<Response> {
    if (key.endsWith(':') || !Number.isFinite(expiresAt) || Date.now() >= expiresAt) return json({ error: 'invalid_or_expired' }, 401);
    return this.state.storage.transaction(async (tx) => {
      if (await tx.get(key)) return json({ error: 'replayed' }, 409);
      await tx.put(key, expiresAt);
      return json({ ok: true });
    });
  }

  private async createGrant(input: GrantInput): Promise<Response> {
    const route = await this.state.storage.get<PreviewState>('route');
    if (!route) return json({ error: 'not_found' }, 404);
    const guard = openCas(route, input.epoch, input.head);
    if (guard) return json({ error: guard.reason }, guard.status);
    const tuple = route.live?.generation === input.generation ? route.live : route.candidates[input.generation];
    if (!tuple) return json({ error: 'generation_not_routable' }, 409);
    const method = input.method?.toUpperCase();
    const isMutation = MUTATING_METHODS.has(method);
    const badDigest = isMutation
      ? !/^[0-9a-f]{64}$/.test(input.bodyDigest ?? '')
      : input.bodyDigest !== undefined;
    if (
      !method || (input.target !== '*' && !canonicalTarget(input.target))
      || !['preview-browser', 'preview-action'].includes(input.audience)
      || (input.audience === 'preview-action' && (input.target === '*' || method === '*' || !input.machineId))
      || badDigest || !input.actor
    ) return json({ error: 'invalid_grant' }, 400);
    const maxTtl = input.audience === 'preview-browser' ? SESSION_TTL_SECONDS : 600;
    const ttl = Math.min(Math.max(input.expiresIn ?? 300, 1), maxTtl);
    const code = randomToken();
    const grant: EdgeGrant = { ...input, code, method, expiresAt: Date.now() + ttl * 1000 };
    await this.state.storage.put(`grant:${await sha256Hex(code)}`, grant);
    return json({ code, expiresAt: grant.expiresAt });
  }

  private async consumeGrant(code: string, host: string): Promise<Response> {
    const key = `grant:${await sha256Hex(code)}`;
    return this.state.storage.transaction(async (tx) => {
      const grant = await tx.get<EdgeGrant>(key);
      if (!grant || Date.now() >= grant.expiresAt) return json({ error: 'invalid_or_expired' }, 401);
      await tx.delete(key);
      const id = randomToken();
      const session: EdgeSession = { ...grant, id, host };
      await tx.put(`session:${await sha256Hex(id)}`, session);
      return json(session);
    });
  }

  private async readSession(id: string, host: string): Promise<Response> {
    const key = `session:${await sha256Hex(id)}`;
    return this.state.storage.transaction(async (tx) => {
      const session = await tx.get<EdgeSession>(key);
      if (!session || session.host !== host || Date.now() >= session.expiresAt) return json({ error: 'invalid_session' }, 401);
      const route = await tx.get<PreviewState>('route');
      if (!route || route.lifecycle !== 'open' || route.epoch !== session.epoch || route.expectedHead !== session.head) return json({ error: 'stale_session' }, 401);
      const tuple = route.live?.generation === session.generation ? route.live : route.candidates[session.generation];
      if (!tuple) return json({ error: 'stale_generation' }, 401);
      // Action capability codes become a one-request edge session. Browser sessions
      // remain reusable until their short expiry so navigation/subresources work.
      if (session.audience === 'preview-action') await tx.delete(key);
      return json({ session, tuple });
    });
  }

  private async janitor(body: Record<string, unknown> | null): Promise<Response> {
    if (!body || !Array.isArray(body.deleteGenerations)) return json({ error: 'bad_json' }, 400);
    const requested = new Set(body.deleteGenerations.map(String));
    const response = await this.state.storage.transaction(async (tx) => {
      const route = await tx.get<PreviewState>('route');
      const allocationRows = await tx.list<GenerationAllocation>({ prefix: 'allocation:' });
      const allocations = [...allocationRows.values()].filter((item) => requested.has(item.generation));
      if (route) {
        if (route.epoch !== Number(body.epoch) || route.expectedHead !== String(body.head)) {
          return json({ error: route.epoch !== Number(body.epoch) ? 'stale_epoch' : 'stale_head' }, 409);
        }
      } else if (!allocations.length || allocations.some((item) =>
        item.epoch !== Number(body.epoch) || item.head !== String(body.head))) {
        return json({ error: 'not_found_or_stale' }, 409);
      }

      let next = route;
      const newlyRetired: RouteTuple[] = [];
      if (route) {
        const protectedGenerations = route.lifecycle === 'open'
          ? new Set([route.live?.generation, route.rollback?.generation])
          : new Set<string | undefined>();
        const candidates = { ...route.candidates };
        for (const generation of requested) {
          if (protectedGenerations.has(generation)) return json({ error: 'protected_generation' }, 409);
          const tuple = candidates[generation];
          if (tuple) { newlyRetired.push(tuple); delete candidates[generation]; }
        }
        next = {
          ...route,
          candidates,
          deletionInventory: [...route.deletionInventory, ...newlyRetired],
        };
        await tx.put('route', next);
      }

      const allocationInventory: CleanupResource[] = allocations.flatMap((allocation) => {
        const recorded = allocation.recorded.map((resource) => ({ ...resource, source: 'allocation' as const }));
        const recordedNames = new Set(allocation.recorded.map((resource) => `${resource.kind}\0${resource.name}`));
        const planned = allocation.planned
          .filter((item) => !recordedNames.has(`${item.kind}\0${item.name}`))
          .map((item) => ({
            ...item,
            id: null,
            generation: allocation.generation,
            source: 'allocation' as const,
          }));
        return [...recorded, ...planned];
      });
      // Deletion inventory and partial allocation ledgers remain until an explicit
      // acknowledgement, so a failed cleanup is returned again on the next janitor run.
      const inventory = [
        ...cleanupResources(next?.deletionInventory ?? []),
        ...allocationInventory,
      ];
      return json({ state: next ?? null, inventory });
    });
    if (response.ok) {
      const route = await this.state.storage.get<PreviewState>('route');
      await this.scrubInvalidDestinations(route, requested);
    }
    return response;
  }

  private async janitorAck(body: Record<string, unknown> | null): Promise<Response> {
    if (!body || !Array.isArray(body.deleted)) return json({ error: 'bad_json' }, 400);
    const deleted = body.deleted as Array<{ kind: string; id: string | null; name: string; generation: string }>;
    const matches = (resource: { kind: string; id?: string | null; name: string }, generation: string) =>
      deleted.some((item) => item.generation === generation && item.kind === resource.kind
        && item.name === resource.name && item.id === (resource.id ?? null));
    return this.state.storage.transaction(async (tx) => {
      const route = await tx.get<PreviewState>('route');
      if (route && (route.epoch !== Number(body.epoch) || route.expectedHead !== String(body.head))) {
        return json({ error: 'stale_state' }, 409);
      }
      let next = route;
      if (route) {
        const deletionInventory = route.deletionInventory.flatMap((tuple) => {
          const resources = tuple.resources.filter((resource) => !matches(resource, tuple.generation));
          return resources.length ? [{ ...tuple, resources }] : [];
        });
        next = { ...route, deletionInventory };
        await tx.put('route', next);
      }
      const rows = await tx.list<GenerationAllocation>({ prefix: 'allocation:' });
      for (const [key, allocation] of rows) {
        const recorded = allocation.recorded.filter((resource) => !matches(resource, allocation.generation));
        const planned = allocation.planned.filter((resource) => !matches({ ...resource, id: null }, allocation.generation));
        if (!recorded.length && !planned.length) await tx.delete(key);
        else await tx.put(key, { ...allocation, recorded, planned });
      }
      return json({ state: next ?? null });
    });
  }

  private async registerPr(pr: number): Promise<Response> {
    if (!Number.isSafeInteger(pr) || pr <= 0) return json({ error: 'bad_pr' }, 400);
    const prs = new Set(await this.state.storage.get<number[]>('prs') ?? []);
    prs.add(pr);
    await this.state.storage.put('prs', [...prs].sort((a, b) => a - b));
    return json({ ok: true });
  }

  private async listPrs(): Promise<Response> {
    return json({ prs: await this.state.storage.get<number[]>('prs') ?? [] });
  }

  private async retireDestination(
    storage: DestinationStorage,
    id: string,
    state: Exclude<DestinationImportState, 'pending'>,
  ): Promise<{ tombstone: DestinationImportTombstone; changed: boolean }> {
    const [keyRecord, destination, storedImport] = await Promise.all([
      storage.get<DestinationKeyRecord>(`destination-key:${id}`),
      storage.get<DestinationRecord>(`destination:${id}`),
      storage.get<StoredDestinationImport>(`destination-import:${id}`),
    ]);
    const activeImport = pendingDestinationImport(storedImport) ? storedImport : undefined;
    let tombstone: DestinationImportTombstone;
    if (!storedImport || pendingDestinationImport(storedImport)) {
      tombstone = {
        id,
        state,
        expiresAt: storedImport?.expiresAt ?? keyRecord?.expiresAt ?? destination?.expiresAt ?? Date.now(),
      };
    } else {
      tombstone = storedImport;
    }
    await Promise.all([
      storage.delete(`destination-key:${id}`),
      storage.delete(`destination:${id}`),
      storage.put(`destination-import:${id}`, tombstone),
      storage.put(`destination-used:${id}`, tombstone.expiresAt),
    ]);
    return { tombstone, changed: !!keyRecord || !!destination || !!activeImport || !storedImport };
  }

  private async scheduleDestinationAlarm(): Promise<void> {
    const [keys, imports] = await Promise.all([
      this.state.storage.list<DestinationKeyRecord>({ prefix: 'destination-key:' }),
      this.state.storage.list<StoredDestinationImport>({ prefix: 'destination-import:' }),
    ]);
    let earliest: number | null = null;
    for (const record of keys.values()) {
      if (earliest === null || record.expiresAt < earliest) earliest = record.expiresAt;
    }
    for (const value of imports.values()) {
      if (pendingDestinationImport(value) && (earliest === null || value.expiresAt < earliest)) {
        earliest = value.expiresAt;
      }
    }
    if (earliest === null) {
      if (await this.state.storage.getAlarm() !== null) await this.state.storage.deleteAlarm();
    } else {
      await this.state.storage.setAlarm(earliest);
    }
  }

  private async scrubInvalidDestinations(route?: PreviewState, generations?: ReadonlySet<string>): Promise<void> {
    const terminalState: Exclude<DestinationImportState, 'pending'> = generations ? 'cleaned' : 'invalidated';
    const retired = await this.state.storage.transaction(async (tx) => {
      const [keys, imports] = await Promise.all([
        tx.list<DestinationKeyRecord>({ prefix: 'destination-key:' }),
        tx.list<StoredDestinationImport>({ prefix: 'destination-import:' }),
      ]);
      const ids = new Set<string>();
      for (const record of keys.values()) {
        if (generations?.has(record.generation) || !route || !destinationUsable(record, route)) {
          ids.add(record.destinationId);
        }
      }
      for (const [key, value] of imports) {
        if (
          pendingDestinationImport(value)
          && (generations?.has(value.destination.generation) || !route || !destinationUsable(value.destination, route))
        ) {
          ids.add(key.slice('destination-import:'.length));
        }
      }
      const changed: string[] = [];
      for (const id of ids) {
        if ((await this.retireDestination(tx as unknown as DestinationStorage, id, terminalState)).changed) {
          changed.push(id);
        }
      }
      return changed;
    });
    for (const id of retired) auditDestination(id, terminalState);
    if (retired.length) await this.scheduleDestinationAlarm();
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const retired = await this.state.storage.transaction(async (tx) => {
      const storage = tx as unknown as DestinationStorage;
      const [keys, imports] = await Promise.all([
        tx.list<DestinationKeyRecord>({ prefix: 'destination-key:' }),
        tx.list<StoredDestinationImport>({ prefix: 'destination-import:' }),
      ]);
      const ids = new Set<string>();
      for (const record of keys.values()) {
        if (record.expiresAt <= now) ids.add(record.destinationId);
      }
      for (const [key, value] of imports) {
        if (pendingDestinationImport(value) && value.expiresAt <= now) {
          ids.add(key.slice('destination-import:'.length));
        }
      }
      const changed: string[] = [];
      for (const id of ids) {
        if ((await this.retireDestination(storage, id, 'expired')).changed) changed.push(id);
      }
      return changed;
    });
    for (const id of retired) auditDestination(id, 'expired');
    await this.scheduleDestinationAlarm();
  }

  private async createDestination(body: Record<string, unknown> | null): Promise<Response> {
    if (!body) return json({ error: 'bad_json' }, 400);
    const { privateKeyJwk, ...publicFields } = body as unknown as DestinationRecord & { privateKeyJwk?: JsonWebKey };
    const record = publicFields as DestinationRecord;
    const route = await this.state.storage.get<PreviewState>('route');
    if (
      !/^[A-Za-z0-9_-]{20,128}$/.test(record.id)
      || privateKeyJwk?.kty !== 'RSA' || typeof privateKeyJwk.d !== 'string' || !privateKeyJwk.d
      || !destinationUsable(record, route ?? {
        lifecycle: 'closed', epoch: 0, expectedHead: '', live: null, candidates: {}, rollback: null, deletionInventory: [],
      })
    ) return json({ error: 'invalid_or_live_tuple_changed' }, 409);
    const response = await this.state.storage.transaction(async (tx) => {
      if (
        await tx.get(`destination:${record.id}`)
        || await tx.get(`destination-key:${record.id}`)
        || await tx.get(`destination-used:${record.id}`)
        || await tx.get(`destination-import:${record.id}`)
      ) return json({ error: 'destination_collision' }, 409);
      await tx.put(`destination:${record.id}`, record);
      await tx.put(`destination-key:${record.id}`, {
        destinationId: record.id,
        head: record.head,
        generation: record.generation,
        artifactDigest: record.artifactDigest,
        expiresAt: record.expiresAt,
        privateKeyJwk,
      } satisfies DestinationKeyRecord);
      return json({ ok: true });
    });
    if (response.ok) {
      auditDestination(record.id, 'authorized');
      await this.scheduleDestinationAlarm();
    }
    return response;
  }

  private async consumeDestination(body: Record<string, unknown> | null): Promise<Response> {
    const id = String(body?.id ?? '');
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(id)) return json({ error: 'invalid_destination' }, 401);
    let invalidated = false;
    const response = await this.state.storage.transaction(async (tx) => {
      const usedKey = `destination-used:${id}`;
      if (await tx.get(usedKey)) return json({ error: 'destination_replayed' }, 409);
      const key = `destination:${id}`;
      const record = await tx.get<DestinationRecord>(key);
      const keyRecord = await tx.get<DestinationKeyRecord>(`destination-key:${id}`);
      const route = await tx.get<PreviewState>('route');
      if (!record || !keyRecord) return json({ error: 'invalid_destination' }, 401);
      if (!route || !destinationUsable(record, route) || !destinationUsable(keyRecord, route)) {
        invalidated = (await this.retireDestination(tx as unknown as DestinationStorage, id, 'invalidated')).changed;
        return json({ error: 'expired_or_live_changed' }, 409);
      }
      await tx.delete(key);
      await tx.put(usedKey, record.expiresAt);
      return json(record);
    });
    if (invalidated) {
      auditDestination(id, 'invalidated');
      await this.scheduleDestinationAlarm();
    }
    return response;
  }

  private async extendDestination(body: Record<string, unknown> | null): Promise<Response> {
    const id = String(body?.id ?? '');
    const inventoryDigest = String(body?.inventoryDigest ?? '');
    if (!/^[0-9a-f]{64}$/.test(inventoryDigest)) return json({ error: 'invalid_inventory_digest' }, 400);
    let invalidated = false;
    const response = await this.state.storage.transaction(async (tx) => {
      const key = `destination:${id}`;
      const record = await tx.get<DestinationRecord>(key);
      const route = await tx.get<PreviewState>('route');
      if (!record) return json({ error: 'invalid_destination' }, 404);
      if (!route || !destinationUsable(record, route)) {
        invalidated = (await this.retireDestination(tx as unknown as DestinationStorage, id, 'invalidated')).changed;
        return json({ error: 'expired_or_live_changed' }, 409);
      }
      if (record.inventoryDigest !== null) return json({ error: 'expired_used_or_extended' }, 409);
      if (body?.actor !== record.actor) return json({ error: 'actor_mismatch' }, 403);
      const next = { ...record, inventoryDigest };
      await tx.put(key, next);
      return json(next);
    });
    if (invalidated) {
      auditDestination(id, 'invalidated');
      await this.scheduleDestinationAlarm();
    }
    return response;
  }

  private async startDestinationImport(body: Record<string, unknown> | null): Promise<Response> {
    if (!body) return json({ error: 'bad_json' }, 400);
    const value = body.import as Partial<DestinationImport> | undefined;
    const destinationInput = value?.destination;
    const manifest = value?.manifest;
    const upstreamCapability = value?.upstreamCapability;
    if (!destinationInput?.id || !upstreamCapability || !manifest) {
      return json({ error: 'invalid_import' }, 400);
    }
    const id = destinationInput.id;
    const expiresAt = Math.min(destinationInput.expiresAt, manifest.expiresAt, Number(value.expiresAt));
    let invalidated = false;
    const response = await this.state.storage.transaction(async (tx) => {
      if (await tx.get(`destination-import:${id}`)) return json({ error: 'import_exists' }, 409);
      if (await tx.get(`destination-used:${id}`) === undefined) return json({ error: 'destination_not_consumed' }, 409);
      const keyRecord = await tx.get<DestinationKeyRecord>(`destination-key:${id}`);
      const route = await tx.get<PreviewState>('route');
      if (
        !keyRecord || !route || !Number.isFinite(expiresAt) || expiresAt <= Date.now()
        || !destinationUsable(destinationInput, route) || !destinationUsable(keyRecord, route)
        || keyRecord.destinationId !== id
      ) {
        invalidated = (await this.retireDestination(tx as unknown as DestinationStorage, id, 'invalidated')).changed;
        return json({ error: 'expired_or_live_changed' }, 409);
      }
      const { privateKeyJwk: _private, ...destination } = destinationInput as DestinationRecord & { privateKeyJwk?: unknown };
      const stored: DestinationImport = {
        destination,
        manifest,
        upstreamCapability,
        usedObjectIds: [],
        reservedObjectIds: [],
        state: 'pending',
        expiresAt,
      };
      await tx.put(`destination-import:${id}`, stored);
      return json({ importId: id }, 201);
    });
    if (invalidated) auditDestination(id, 'invalidated');
    if (response.ok || invalidated) await this.scheduleDestinationAlarm();
    return response;
  }

  private async consumeDestinationObject(body: Record<string, unknown> | null): Promise<Response> {
    const id = String(body?.id ?? '');
    const objectId = String(body?.objectId ?? '');
    let invalidated = false;
    const response = await this.state.storage.transaction(async (tx) => {
      const key = `destination-import:${id}`;
      const stored = await tx.get<StoredDestinationImport>(key);
      if (!pendingDestinationImport(stored)) return json({ error: stored ? 'import_terminal' : 'import_not_found' }, 409);
      const route = await tx.get<PreviewState>('route');
      const keyRecord = await tx.get<DestinationKeyRecord>(`destination-key:${id}`);
      if (!route || !keyRecord || !destinationUsable(stored.destination, route) || !destinationUsable(keyRecord, route)) {
        invalidated = (await this.retireDestination(tx as unknown as DestinationStorage, id, 'invalidated')).changed;
        return json({ error: 'expired_or_live_changed' }, 409);
      }
      if (stored.usedObjectIds.includes(objectId)) return json({ error: 'object_replayed' }, 409);
      const object = stored.manifest.objects.find((item) => item.objectId === objectId);
      if (!object) return json({ error: 'object_not_allowed' }, 404);
      return json({ import: stored, object, privateKeyJwk: keyRecord.privateKeyJwk });
    });
    if (invalidated) {
      auditDestination(id, 'invalidated');
      await this.scheduleDestinationAlarm();
    }
    return response;
  }

  private async reserveDestinationObject(body: Record<string, unknown> | null): Promise<Response> {
    const id = String(body?.id ?? '');
    const objectId = String(body?.objectId ?? '');
    return this.state.storage.transaction(async (tx) => {
      const key = `destination-import:${id}`;
      const stored = await tx.get<StoredDestinationImport>(key);
      if (!pendingDestinationImport(stored)) return json({ error: 'import_terminal' }, 409);
      if (stored.usedObjectIds.includes(objectId) || stored.reservedObjectIds.includes(objectId)) {
        return json({ error: 'object_replayed' }, 409);
      }
      if (!stored.manifest.objects.some((item) => item.objectId === objectId)) {
        return json({ error: 'object_not_allowed' }, 404);
      }
      const next: DestinationImport = {
        ...stored,
        reservedObjectIds: [...stored.reservedObjectIds, objectId],
      };
      await tx.put(key, next);
      return json({ ok: true });
    });
  }

  private async finishDestinationObject(body: Record<string, unknown> | null): Promise<Response> {
    const id = String(body?.id ?? '');
    const objectId = String(body?.objectId ?? '');
    const delivered = body?.delivered;
    if (typeof delivered !== 'boolean') return json({ error: 'invalid_delivery_state' }, 400);
    return this.state.storage.transaction(async (tx) => {
      const key = `destination-import:${id}`;
      const stored = await tx.get<StoredDestinationImport>(key);
      if (!pendingDestinationImport(stored)) return json({ error: 'import_terminal' }, 409);
      if (!stored.reservedObjectIds.includes(objectId)) {
        if (delivered && stored.usedObjectIds.includes(objectId)) return json({ ok: true });
        if (!delivered && !stored.usedObjectIds.includes(objectId)) return json({ ok: true });
        return json({ error: 'object_not_reserved' }, 409);
      }
      const next: DestinationImport = {
        ...stored,
        reservedObjectIds: stored.reservedObjectIds.filter((item) => item !== objectId),
        usedObjectIds: delivered ? [...stored.usedObjectIds, objectId] : stored.usedObjectIds,
      };
      await tx.put(key, next);
      return json({ ok: true });
    });
  }

  private async commitDestinationImport(body: Record<string, unknown> | null): Promise<Response> {
    const id = String(body?.id ?? '');
    let invalidated = false;
    const response = await this.state.storage.transaction(async (tx) => {
      const stored = await tx.get<StoredDestinationImport>(`destination-import:${id}`);
      if (!pendingDestinationImport(stored)) return json({ error: stored ? 'commit_replayed' : 'import_not_found' }, 409);
      const route = await tx.get<PreviewState>('route');
      const keyRecord = await tx.get<DestinationKeyRecord>(`destination-key:${id}`);
      if (!route || !keyRecord || !destinationUsable(stored.destination, route) || !destinationUsable(keyRecord, route)) {
        invalidated = (await this.retireDestination(tx as unknown as DestinationStorage, id, 'invalidated')).changed;
        return json({ error: 'expired_or_live_changed' }, 409);
      }
      if (stored.reservedObjectIds.length || stored.usedObjectIds.length !== stored.manifest.objects.length) {
        return json({ error: 'objects_missing' }, 409);
      }
      return json({ import: stored });
    });
    if (invalidated) {
      auditDestination(id, 'invalidated');
      await this.scheduleDestinationAlarm();
    }
    return response;
  }

  private async finishDestinationImport(body: Record<string, unknown> | null): Promise<Response> {
    const id = String(body?.id ?? '');
    const state = body?.state;
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(id) || !['committed', 'failed', 'aborted'].includes(String(state))) {
      return json({ error: 'invalid_terminal_state' }, 400);
    }
    let changed = false;
    const response = await this.state.storage.transaction(async (tx) => {
      const stored = await tx.get<StoredDestinationImport>(`destination-import:${id}`);
      if (stored && !pendingDestinationImport(stored)) {
        return stored.state === state ? json({ import: stored }) : json({ error: 'import_terminal' }, 409);
      }
      if (!stored && !await tx.get(`destination-key:${id}`)) return json({ error: 'import_not_found' }, 404);
      if (state === 'committed' && !stored) return json({ error: 'import_not_found' }, 404);
      if (
        state === 'committed' && stored
        && (stored.reservedObjectIds.length || stored.usedObjectIds.length !== stored.manifest.objects.length)
      ) return json({ error: 'objects_missing' }, 409);
      const retired = await this.retireDestination(
        tx as unknown as DestinationStorage,
        id,
        state as 'committed' | 'failed' | 'aborted',
      );
      changed = retired.changed;
      return json({ import: retired.tombstone });
    });
    if (changed) auditDestination(id, state as 'committed' | 'failed' | 'aborted');
    if (response.ok) await this.scheduleDestinationAlarm();
    return response;
  }

  private async destinationImportStatus(body: Record<string, unknown> | null): Promise<Response> {
    const id = String(body?.id ?? '');
    let invalidated = false;
    const response = await this.state.storage.transaction(async (tx) => {
      const stored = await tx.get<StoredDestinationImport>(`destination-import:${id}`);
      if (!stored) return json({ error: 'import_not_found' }, 404);
      if (!pendingDestinationImport(stored)) return json({ import: stored });
      const route = await tx.get<PreviewState>('route');
      const keyRecord = await tx.get<DestinationKeyRecord>(`destination-key:${id}`);
      if (!route || !keyRecord || !destinationUsable(stored.destination, route) || !destinationUsable(keyRecord, route)) {
        const retired = await this.retireDestination(tx as unknown as DestinationStorage, id, 'invalidated');
        invalidated = retired.changed;
        return json({ import: retired.tombstone }, 409);
      }
      return json({ import: stored });
    });
    if (invalidated) {
      auditDestination(id, 'invalidated');
      await this.scheduleDestinationAlarm();
    }
    return response;
  }
  private async createDestinationExchange(body: Record<string, unknown> | null): Promise<Response> {
    const code = String(body?.code ?? '');
    const challenge = String(body?.challenge ?? '');
    const expiresAt = Number(body?.expiresAt);
    if (
      !/^[A-Za-z0-9_-]{32,128}$/.test(code) || !/^[A-Za-z0-9_-]{43}$/.test(challenge)
      || !Number.isFinite(expiresAt) || Date.now() >= expiresAt
      || !body?.result || typeof body.result !== 'object' || Array.isArray(body.result)
    ) return json({ error: 'invalid_exchange' }, 400);
    await this.state.storage.put(`destination-exchange:${await sha256Hex(code)}`, {
      challenge,
      result: body.result as Record<string, unknown>,
      expiresAt,
    } satisfies DestinationExchange);
    return json({ code, expiresAt }, 201);
  }

  private async consumeDestinationExchange(body: Record<string, unknown> | null): Promise<Response> {
    const code = String(body?.code ?? '');
    const verifier = String(body?.verifier ?? '');
    const digest = await sha256Hex(code);
    const key = `destination-exchange:${digest}`;
    const usedKey = `destination-exchange-used:${digest}`;
    return this.state.storage.transaction(async (tx) => {
      if (await tx.get(usedKey)) return json({ error: 'code_replayed' }, 409);
      const exchange = await tx.get<DestinationExchange>(key);
      if (!exchange || Date.now() >= exchange.expiresAt) return json({ error: 'invalid_or_expired_code' }, 401);
      if (await sha256Url(verifier) !== exchange.challenge) return json({ error: 'pkce_mismatch' }, 403);
      await tx.delete(key);
      await tx.put(usedKey, exchange.expiresAt);
      return json(exchange.result);
    });
  }
}

function prFromHost(hostname: string): number | null {
  const host = hostname.toLowerCase();
  if (!host.endsWith(PUBLIC_SUFFIX)) return null;

  const label = host.slice(0, -PUBLIC_SUFFIX.length);
  const match = /^pr-([1-9]\d*)$/.exec(label);
  const pr = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(pr) ? pr : null;
}

function objectStub(env: FrontDoorEnv, pr: number): DurableObjectStub {
  return env.PREVIEW_EDGE_AUTH.get(env.PREVIEW_EDGE_AUTH.idFromName(`pr-${pr}`));
}

function finishDestinationLifecycle(
  stub: DurableObjectStub,
  id: string,
  state: 'committed' | 'failed' | 'aborted',
): Promise<Response> {
  return stub.fetch('https://edge.internal/destination-finish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, state }),
  });
}

function finishDestinationObjectForward(
  stub: DurableObjectStub,
  id: string,
  objectId: string,
  delivered: boolean,
): Promise<Response> {
  return stub.fetch('https://edge.internal/destination-object-finish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, objectId, delivered }),
  });
}

function registryStub(env: FrontDoorEnv): DurableObjectStub {
  return env.PREVIEW_EDGE_AUTH.get(env.PREVIEW_EDGE_AUTH.idFromName('registry'));
}

function bearer(request: Request): string | null {
  const value = request.headers.get('authorization');
  return value?.startsWith('Bearer ') ? value.slice(7) : null;
}

interface ControlClaims {
  jti?: string;
  job_workflow_ref?: string;
  actor?: string;
  run_id?: string;
  event_name?: string;
  ref?: string;
  exp: number;
  repository?: string;
}

async function authorizeControl(
  request: Request,
  env: FrontDoorEnv,
  stub: DurableObjectStub,
  audience: string,
  workflowRef: string,
  expectedPr?: number,
  body?: Record<string, unknown>,
): Promise<Response | ControlClaims> {
  const token = bearer(request);
  if (!token) return json({ error: 'missing_token' }, 401);
  const verified = await verifyGitHubOidc(token, {
    expectedAudience: audience,
    expectedRepository: env.PREVIEW_CONTROL_REPOSITORY,
  });
  if (!verified.ok) return json({ error: verified.reason }, verified.retryable ? 503 : 401);
  const claims = verified.claims as typeof verified.claims & ControlClaims;
  if (!claims.jti || claims.job_workflow_ref !== workflowRef || !claims.actor || !claims.run_id) {
    return json({ error: 'bad_control_claims' }, 403);
  }
  if (!['workflow_dispatch', 'workflow_run', 'pull_request_target', 'schedule'].includes(claims.event_name ?? '')) {
    return json({ error: 'bad_event' }, 403);
  }
  if (claims.ref !== env.PREVIEW_CONTROL_DEFAULT_REF) return json({ error: 'bad_ref' }, 403);
  if (expectedPr !== undefined && Number(body?.pr) !== expectedPr) return json({ error: 'pr_mismatch' }, 403);
  const consumed = await stub.fetch('https://edge.internal/consume-control', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jti: claims.jti, expiresAt: claims.exp * 1000 }),
  });
  if (!consumed.ok) return json({ error: 'control_replay' }, consumed.status);
  return claims;
}

async function verifySourceRun(
  env: FrontDoorEnv,
  body: Record<string, unknown>,
  pr: number,
): Promise<{ ok: true; sourceRunId: string } | { ok: false; response: Response }> {
  const sourceRunId = String(body.sourceRunId ?? '');
  if (!/^[1-9]\d*$/.test(sourceRunId)) {
    return { ok: false, response: json({ error: 'missing_source_run' }, 403) };
  }
  try {
    const response = await fetch(
      `https://api.github.com/repos/${env.PREVIEW_CONTROL_REPOSITORY}/actions/runs/${sourceRunId}`,
      {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'sessions-preview-front-door' },
        cf: { cacheEverything: true, cacheTtl: 60 },
      },
    );
    if (!response.ok) return { ok: false, response: json({ error: 'source_run_unavailable' }, 503) };
    const run = await response.json() as {
      event?: string;
      head_sha?: string;
      head_repository?: { full_name?: string };
      pull_requests?: Array<{ number?: number }>;
    };
    if (
      run.event !== 'pull_request'
      || run.head_sha !== body.head
      || run.head_repository?.full_name !== env.PREVIEW_CONTROL_REPOSITORY
      || !run.pull_requests?.some((item) => item.number === pr)
    ) {
      return { ok: false, response: json({ error: 'source_run_binding_mismatch' }, 403) };
    }
    return { ok: true, sourceRunId };
  } catch {
    return { ok: false, response: json({ error: 'source_run_unavailable' }, 503) };
  }
}

async function controlRoute(request: Request, url: URL, env: FrontDoorEnv): Promise<Response> {
  const body = request.method === 'POST'
    ? await requestJson<Record<string, unknown>>(request)
    : Object.fromEntries(url.searchParams);
  if (!body) return json({ error: 'bad_json' }, 400);
  const operation = url.pathname.slice('/_control/'.length);
  if (operation === 'list' && request.method === 'GET') {
    const registry = registryStub(env);
    const authorized = await authorizeControl(
      request,
      env,
      registry,
      env.PREVIEW_CONTROL_JANITOR_AUD,
      env.PREVIEW_CONTROL_JANITOR_WORKFLOW_REF,
    );
    if (authorized instanceof Response) return authorized;
    const listed = await registry.fetch('https://edge.internal/list-prs');
    const { prs } = await listed.json() as { prs: number[] };
    const states = await Promise.all(prs.map(async (pr) => {
      const stub = objectStub(env, pr);
      const [stateResponse, allocationResponse] = await Promise.all([
        stub.fetch('https://edge.internal/state'),
        stub.fetch('https://edge.internal/allocations'),
      ]);
      const { allocations } = await allocationResponse.json() as { allocations: GenerationAllocation[] };
      return {
        pr,
        state: stateResponse.ok ? await stateResponse.json() as PreviewState : null,
        allocations,
      };
    }));
    return json({ states });
  }

  const pr = Number(body.pr);
  if (!Number.isSafeInteger(pr) || pr <= 0) return json({ error: 'bad_pr' }, 400);
  const closeOperation = operation === 'close' || operation === 'close-state' || operation === 'close-ack';
  const audience = closeOperation
    ? env.PREVIEW_CONTROL_CLOSE_AUD
    : operation === 'janitor' || operation === 'janitor-ack'
      ? env.PREVIEW_CONTROL_JANITOR_AUD
      : env.PREVIEW_CONTROL_DEPLOY_AUD;
  const workflowRef = closeOperation
    ? env.PREVIEW_CONTROL_CLOSE_WORKFLOW_REF
    : operation === 'janitor' || operation === 'janitor-ack'
      ? env.PREVIEW_CONTROL_JANITOR_WORKFLOW_REF
      : env.PREVIEW_CONTROL_DEPLOY_WORKFLOW_REF;
  const stub = objectStub(env, pr);
  const authorized = await authorizeControl(request, env, stub, audience, workflowRef, pr, body);
  if (authorized instanceof Response) return authorized;

  if (['begin-generation', 'record-resource', 'register', 'grant', 'smoke-route', 'smoke-success', 'promote', 'rollback'].includes(operation)) {
    const source = await verifySourceRun(env, body, pr);
    if (!source.ok) return source.response;
    if (body.actor !== undefined && body.actor !== authorized.actor) {
      return json({ error: 'oidc_binding_mismatch' }, 403);
    }
    if (
      typeof body.generation === 'string'
      && body.generation !== `g${source.sourceRunId}-${String(body.head).slice(0, 12)}`
    ) {
      return json({ error: 'generation_binding_mismatch' }, 403);
    }
    if (operation === 'grant' || operation === 'smoke-route') body.actor = authorized.actor;
  }

  if (operation === 'grant' || operation === 'smoke-route') {
    const response = await stub.fetch('https://edge.internal/grant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) return response;
    const result = await response.json() as { code: string; expiresAt: number };
    return json({
      ...result,
      bootstrapUrl: `https://pr-${pr}${PUBLIC_SUFFIX}/_edge/bootstrap?code=${encodeURIComponent(result.code)}`,
    });
  }
  if ((operation === 'state' || operation === 'close-state') && request.method === 'GET') {
    return stub.fetch('https://edge.internal/state');
  }
  if (!['begin-generation', 'record-resource', 'register', 'smoke-success', 'promote', 'rollback', 'close', 'close-ack', 'janitor', 'janitor-ack'].includes(operation) || request.method !== 'POST') {
    return json({ error: 'not_found' }, 404);
  }
  const internalOperation = operation === 'close-ack' ? 'janitor-ack' : operation;
  const response = await stub.fetch(`https://edge.internal/${internalOperation}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if ((operation === 'begin-generation' || operation === 'register') && response.ok) {
    await registryStub(env).fetch('https://edge.internal/register-pr', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pr }),
    });
  }
  return response;
}

function decodeSegment(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch { return null; }
}

function parseJsonSegment<T>(value: string): T | null {
  const bytes = decodeSegment(value);
  if (!bytes) return null;
  try { return JSON.parse(new TextDecoder().decode(bytes)) as T; } catch { return null; }
}

async function verifyRs256Signature(
  token: string,
  keys: JsonWebKeyWithKid[],
  now: number,
): Promise<Record<string, unknown> | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  const header = parseJsonSegment<{ alg?: string; kid?: string }>(h);
  const claims = parseJsonSegment<Record<string, unknown>>(p);
  if (!header || header.alg !== 'RS256' || !header.kid || !claims) return null;
  const key = keys.find((item) => item.kid === header.kid && !item.revoked && (item.notBefore === undefined || now >= item.notBefore) && (item.notAfter === undefined || now < item.notAfter));
  const signature = decodeSegment(s);
  if (!key || !signature) return null;
  try {
    const imported = await crypto.subtle.importKey('jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', imported, signature, new TextEncoder().encode(`${h}.${p}`))) return null;
  } catch { return null; }
  return claims;
}

async function verifyRs256Jwt(token: string, keys: JsonWebKeyWithKid[], expected: { issuer: string; audience: string; now?: number }): Promise<Record<string, unknown> | null> {
  const now = expected.now ?? Math.floor(Date.now() / 1000);
  const claims = await verifyRs256Signature(token, keys, now);
  if (!claims) return null;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== expected.issuer || !aud.includes(expected.audience) || typeof claims.exp !== 'number' || now >= claims.exp || typeof claims.iat !== 'number' || claims.iat > now + 30) return null;
  return claims;
}

async function previewOriginAssertionFailure(
  token: string,
  request: Request,
  jwksSource: string,
): Promise<string | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return 'malformed';
  const header = parseJsonSegment<Record<string, unknown>>(parts[0]!);
  if (header?.alg !== 'RS256' || header.typ !== 'JWT' || typeof header.kid !== 'string') {
    return 'invalid_header';
  }
  let keys: JsonWebKeyWithKid[];
  try {
    const parsed = JSON.parse(jwksSource) as { keys?: JsonWebKeyWithKid[] };
    keys = Array.isArray(parsed.keys) ? parsed.keys : [];
  } catch {
    return 'invalid_jwks';
  }
  const now = Math.floor(Date.now() / 1000);
  const claims = await verifyRs256Signature(token, keys, now);
  if (!claims) return 'invalid_signature';
  if (claims.iss !== `https://${CONTROL_HOST}`) return 'issuer_mismatch';
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(AUDIENCES.origin)) return 'audience_mismatch';
  if (typeof claims.exp !== 'number' || now >= claims.exp) return 'expired';
  if (typeof claims.iat !== 'number' || claims.iat > now + ASSERTION_CLOCK_SKEW_SECONDS) return 'invalid_clock';
  const url = new URL(request.url);
  const target = canonicalTarget(`${url.pathname}${url.search}`);
  if (!target) return 'invalid_target';
  if (claims.method !== request.method) return 'method_mismatch';
  if (claims.target !== target) return 'target_mismatch';
  if (claims.exp - claims.iat > ASSERTION_TTL_SECONDS) return 'invalid_ttl';
  if (typeof claims.jti !== 'string' || claims.jti.length < 16) return 'invalid_jti';
  const digest = await bodyDigest(request);
  if (MUTATING_METHODS.has(request.method)) {
    return claims.bodyDigest === digest ? null : 'body_digest_mismatch';
  }
  return claims.bodyDigest === undefined ? null : 'unexpected_body_digest';
}

/** Authenticate trusted-front-door traffic before entering the private generation binding. */
export async function trustedPreviewIngress(
  request: Request,
  env: TrustedPreviewIngressEnv,
): Promise<Response> {
  const assertion = request.headers.get('x-preview-origin-assertion');
  const reason = assertion
    ? await previewOriginAssertionFailure(assertion, request.clone(), env.PREVIEW_ORIGIN_ASSERTION_JWKS)
    : 'missing';
  if (reason) {
    console.warn(JSON.stringify({ event: 'preview.origin.denied', reason }));
    return json({ error: 'invalid_origin_assertion', reason }, 403);
  }
  return env.APP.fetch(request);
}

async function validateAccess(request: Request, env: FrontDoorEnv): Promise<{ actor: string } | null> {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return null;
  const certsUrl = `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
  let keys: JsonWebKeyWithKid[];
  try {
    const response = await fetch(certsUrl, { cf: { cacheEverything: true, cacheTtl: 300 } });
    if (!response.ok) return null;
    keys = ((await response.json()) as { keys?: JsonWebKeyWithKid[] }).keys ?? [];
  } catch { return null; }
  const claims = await verifyRs256Jwt(token, keys, { issuer: `https://${env.ACCESS_TEAM_DOMAIN}`, audience: env.ACCESS_AUD });
  const actor = typeof claims?.email === 'string' ? claims.email.toLowerCase() : '';
  const allowed = new Set(env.ACCESS_ALLOWED_EMAILS.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean));
  return actor && allowed.has(actor) ? { actor } : null;
}

function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemBytes(pem: string): Uint8Array {
  const base64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  return Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
}

async function signJwt(ringSource: string, claims: Record<string, unknown>): Promise<string> {
  const ring = JSON.parse(ringSource) as SigningRing;
  const now = Math.floor(Date.now() / 1000);
  if (!ring.active?.kid || !ring.active.privateKeyPem || ring.active.revoked || ring.revokedKids?.includes(ring.active.kid) || (ring.active.notBefore !== undefined && now < ring.active.notBefore) || (ring.active.notAfter !== undefined && now >= ring.active.notAfter)) throw new Error('no active signing key');
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: ring.active.kid })));
  const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey('pkcs8', pemBytes(ring.active.privateKeyPem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}

export function canonicalTarget(input: string): string | null {
  if (!input.startsWith('/') || input.startsWith('//') || /%(?:2f|5c)/i.test(input) || /%(?![0-9a-f]{2})/i.test(input) || input.includes('#')) return null;
  try {
    const url = new URL(input, 'https://canonical.invalid');
    if (`${url.pathname}${url.search}` !== input) return null;
    const seen = new Set<string>();
    for (const key of url.searchParams.keys()) {
      const normalized = key.toLowerCase();
      if (seen.has(normalized)) return null;
      seen.add(normalized);
    }
    return input;
  } catch { return null; }
}

async function sha256Hex(value: string | ArrayBuffer): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((v) => v.toString(16).padStart(2, '0')).join('');
}

async function sha256Url(value: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

async function bodyDigest(request: Request): Promise<string | undefined> {
  if (!MUTATING_METHODS.has(request.method)) return undefined;
  return sha256Hex(await request.clone().arrayBuffer());
}

export interface DestinationAttestation {
  payload: Record<string, unknown>;
  signature: string;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

export async function signDestinationAttestation(
  env: Pick<FrontDoorEnv, 'DESTINATION_ATTESTATION_PRIVATE_JWK'>,
  payload: Record<string, unknown>,
): Promise<DestinationAttestation> {
  const jwk = JSON.parse(env.DESTINATION_ATTESTATION_PRIVATE_JWK) as JsonWebKey;
  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(canonicalJson(payload)),
  );
  return { payload, signature: b64url(new Uint8Array(signature)) };
}

export async function verifyDestinationAttestation(
  attestation: DestinationAttestation,
  env: Pick<FrontDoorEnv, 'DESTINATION_ATTESTATION_PRIVATE_JWK'>,
): Promise<Record<string, unknown> | null> {
  if (!attestation?.payload || typeof attestation.signature !== 'string') return null;
  let privateJwk: JsonWebKey;
  try { privateJwk = JSON.parse(env.DESTINATION_ATTESTATION_PRIVATE_JWK) as JsonWebKey; } catch { return null; }
  const { d: _private, key_ops: _privateOperations, ...publicJwk } = privateJwk;
  const signature = decodeSegment(attestation.signature);
  if (!signature) return null;
  try {
    const key = await crypto.subtle.importKey(
      'jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
    );
    if (!await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      signature,
      new TextEncoder().encode(canonicalJson(attestation.payload)),
    )) return null;
  } catch { return null; }
  const payload = attestation.payload;
  const now = Date.now();
  if (
    payload.format !== 1 || payload.scope !== 'remote-destination-attest' || payload.kind !== 'remote'
    || typeof payload.iat !== 'number' || typeof payload.exp !== 'number'
    || now < payload.iat - 5_000 || now >= payload.exp || payload.exp - payload.iat > 15 * 60_000
    || typeof payload.jti !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(payload.jti)
  ) return null;
  return payload;
}

async function signDebugImportPayload(env: FrontDoorEnv, payload: Record<string, unknown>): Promise<string> {
  const jwk = JSON.parse(env.DEBUG_IMPORT_ASSERTION_PRIVATE_JWK) as JsonWebKey;
  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(canonicalJson(payload)),
  );
  return b64url(new Uint8Array(signature));
}



async function mintOriginAssertion(
  env: FrontDoorEnv,
  tuple: RouteTuple,
  pr: number,
  method: string,
  target: string,
  digest?: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(env.ORIGIN_SIGNING_KEYS, {
    iss: env.EDGE_ISSUER,
    aud: AUDIENCES.origin,
    pr,
    head: tuple.head,
    generation: tuple.generation,
    artifactDigest: tuple.artifactDigest,
    method,
    target,
    bodyDigest: digest,
    iat: now,
    exp: now + ASSERTION_TTL_SECONDS,
    jti: randomToken(16),
  });
}

async function forwardDebug(
  env: FrontDoorEnv,
  tuple: RouteTuple,
  pr: number,
  method: string,
  target: string,
  body: ArrayBuffer | string | undefined,
  extraHeaders: HeadersInit,
  fetchUpstream: typeof fetch,
): Promise<Response> {
  const digest = MUTATING_METHODS.has(method)
    ? await sha256Hex(body ?? new ArrayBuffer(0))
    : undefined;
  const headers = new Headers(extraHeaders);
  headers.set('x-preview-origin-assertion', await mintOriginAssertion(env, tuple, pr, method, target, digest));
  headers.set('origin', new URL(tuple.versionUrl).origin);
  const upstreamUrl = new URL(target, tuple.versionUrl);
  const upstream = await fetchUpstream(new Request(upstreamUrl, {
    method,
    headers,
    body,
    redirect: 'manual',
  }));
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: safeResponseHeaders(upstream.headers, upstreamUrl, new URL(`https://pr-${pr}${PUBLIC_SUFFIX}/`)),
  });
}

function exactSessionIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.some((id) => typeof id !== 'string' || !id || id.length > 256)) return null;
  const sorted = [...value].sort();
  return new Set(sorted).size === sorted.length && JSON.stringify(sorted) === JSON.stringify(value) ? sorted : null;
}

async function readExactBoundedBody(request: Request, expectedBytes: number): Promise<ArrayBuffer | null> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && (!/^(?:0|[1-9]\d*)$/.test(contentLength) || Number(contentLength) !== expectedBytes)) {
    try { await request.body?.cancel(); } catch { /* The mismatch is already terminal for this request. */ }
    return null;
  }
  if (!request.body) return expectedBytes === 0 ? new ArrayBuffer(0) : null;
  const output = new Uint8Array(expectedBytes);
  const reader = request.body.getReader();
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return offset === expectedBytes ? output.buffer : null;
      if (offset + value.byteLength > expectedBytes) {
        await reader.cancel();
        return null;
      }
      output.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

export function validLoopbackCallback(value: string): boolean {
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1'
      && Number.isInteger(port) && port >= 1024 && port <= 65535
      && url.pathname === '/callback' && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

async function createDestinationExchange(
  env: FrontDoorEnv,
  pr: number,
  challenge: string,
  result: Record<string, unknown>,
): Promise<Response> {
  const code = randomToken(32);
  const expiresAt = Math.min(Number(result.expiresAt ?? Date.now() + 5 * 60_000), Date.now() + 5 * 60_000);
  const response = await objectStub(env, pr).fetch('https://edge.internal/destination-exchange-create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, challenge, result, expiresAt }),
  });
  return response.ok ? json({ code, expiresAt }) : response;
}

function destinationAuthorizationPage(): Response {
  const nonce = randomToken(18);
  const script = `
const status=document.getElementById('status'),approve=document.getElementById('approve');let request;
try{
  const s=location.hash.slice(1).replace(/-/g,'+').replace(/_/g,'/');
  request=JSON.parse(decodeURIComponent(escape(atob(s+'='.repeat((4-s.length%4)%4)))));
  if(!['resolve','attest','extend'].includes(request.operation))throw new Error('bad operation');
  status.textContent='Approve '+request.operation+' for PR '+request.pr+', head '+(request.body.head||'current live')+', sessions: '+(request.body.sessionIds||[]).join(', ');
  approve.disabled=false;
}catch{status.textContent='Invalid bridge request.';}
approve.onclick=async()=>{
  approve.disabled=true;
  try{
    const path=request.operation==='extend'?'/_destination/extend':request.operation==='resolve'?'/_destination/resolve':'/_destination/attest';
    const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...request.body,callback:request.callback,pkceChallenge:request.pkceChallenge})});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'authorization failed');
    const callback=new URL(request.callback);callback.searchParams.set('code',result.code);callback.searchParams.set('state',request.state);location.replace(callback.toString());
  }catch(error){status.textContent=String(error);approve.disabled=false;}
};`;
  return new Response(`<!doctype html><meta charset=\"utf-8\"><title>Approve preview destination</title><h1>Approve preview destination</h1><p id=\"status\">Loading request…</p><button id=\"approve\" disabled>Approve exact destination</button><script nonce=\"${nonce}\">${script}</script>`, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
  });
}

function destinationPayload(record: DestinationRecord): Record<string, unknown> {
  return {
    format: 1,
    scope: 'remote-destination-attest',
    kind: 'remote',
    jti: randomToken(16),
    iat: Date.now(),
    exp: record.expiresAt,
    destinationId: record.id,
    prNumber: record.pr,
    headSha: record.head,
    generation: record.generation,
    artifactDigest: record.artifactDigest,
    environmentNonce: record.environmentNonce,
    buildInputDigest: record.buildInputDigest,
    inventoryDigest: record.inventoryDigest,
    sessionIds: record.sessionIds,
    maxBytes: record.maxBytes,
    encryptionPublicJwk: record.publicKeyJwk,
  };
}

async function destinationRoute(
  request: Request,
  url: URL,
  env: FrontDoorEnv,
  fetchUpstream: typeof fetch,
): Promise<Response> {
  const publicPr = prFromHost(url.hostname);
  if (url.pathname === '/_destination/authorize' && request.method === 'GET') {
    if (!publicPr || !await validateAccess(request, env)) return json({ error: 'unauthorized' }, 401);
    return destinationAuthorizationPage();
  }
  if (url.pathname === '/_destination/exchange' && request.method === 'POST') {
    const body = await requestJson<Record<string, unknown>>(request);
    const pr = Number(body?.pr);
    if (!Number.isSafeInteger(pr) || pr <= 0) return json({ error: 'bad_pr' }, 400);
    return objectStub(env, pr).fetch('https://edge.internal/destination-exchange-consume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: body?.code, verifier: body?.verifier }),
    });
  }
  if (url.pathname === '/_destination/resolve' && (request.method === 'GET' || request.method === 'POST')) {
    if (!publicPr || !await validateAccess(request, env)) return json({ error: 'unauthorized' }, 401);
    const stateResponse = await objectStub(env, publicPr).fetch('https://edge.internal/state');
    if (!stateResponse.ok) return json({ error: 'not_found' }, 404);
    const state = await stateResponse.json() as PreviewState;
    if (state.lifecycle !== 'open' || !state.live) return json({ error: 'not_routable' }, 409);
    const result = { pr: publicPr, epoch: state.epoch, head: state.expectedHead, live: state.live };
    if (request.method === 'GET') return json(result);
    const body = await requestJson<Record<string, unknown>>(request);
    const challenge = String(body?.pkceChallenge ?? '');
    if (!body || !validLoopbackCallback(String(body.callback ?? '')) || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      return json({ error: 'invalid_resolution_request' }, 400);
    }
    return createDestinationExchange(env, publicPr, challenge, { ...result, expiresAt: Date.now() + 5 * 60_000 });
  }

  if (url.pathname === '/_destination/attest' && request.method === 'POST') {
    if (!publicPr) return json({ error: 'bad_pr' }, 400);
    const access = await validateAccess(request, env);
    if (!access) return json({ error: 'unauthorized' }, 401);
    const body = await requestJson<Record<string, unknown>>(request);
    const sessionIds = exactSessionIds(body?.sessionIds);
    const maxBytes = Number(body?.maxBytes);
    const challenge = String(body?.pkceChallenge ?? '');
    if (
      !body || body.inventoryDigest !== null || !sessionIds
      || !validLoopbackCallback(String(body.callback ?? '')) || !/^[A-Za-z0-9_-]{43}$/.test(challenge)
      || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 536_870_912
    ) return json({ error: 'invalid_attestation_request' }, 400);
    const inventoryDigest = null;
    const stateResponse = await objectStub(env, publicPr).fetch('https://edge.internal/state');
    if (!stateResponse.ok) return json({ error: 'not_found' }, 404);
    const state = await stateResponse.json() as PreviewState;
    const live = state.live;
    if (
      state.lifecycle !== 'open' || !live
      || body.head !== live.head || body.generation !== live.generation
      || body.artifactDigest !== live.artifactDigest
    ) return json({ error: 'live_tuple_changed' }, 409);
    const pair = await crypto.subtle.generateKey(
      {
        name: 'RSA-OAEP',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['encrypt', 'decrypt'],
    ) as CryptoKeyPair;
    const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey;
    const privateKeyJwk = await crypto.subtle.exportKey('jwk', pair.privateKey) as JsonWebKey;
    const id = randomToken(24);
    const expiresAt = Date.now() + 10 * 60_000;
    const record: DestinationRecord = {
      id,
      pr: publicPr,
      head: live.head,
      generation: live.generation,
      artifactDigest: live.artifactDigest,
      inventoryDigest,
      environmentNonce: live.environmentNonce,
      buildInputDigest: live.buildInputDigest,
      maxBytes,
      actor: access.actor,
      expiresAt,
      publicKeyJwk,
      sessionIds,
    };
    const stored = await objectStub(env, publicPr).fetch('https://edge.internal/destination-create', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...record, privateKeyJwk }),
    });
    if (!stored.ok) return stored;
    const result = {
      destinationId: id,
      attestation: await signDestinationAttestation(env, destinationPayload(record)),
      encryptionPublicJwk: publicKeyJwk,
      expiresAt,
    };
    return createDestinationExchange(env, publicPr, challenge, result);
  }

  if (url.pathname === '/_destination/extend' && request.method === 'POST') {
    if (!publicPr) return json({ error: 'bad_pr' }, 400);
    const access = await validateAccess(request, env);
    if (!access) return json({ error: 'unauthorized' }, 401);
    const body = await requestJson<Record<string, unknown>>(request);
    const challenge = String(body?.pkceChallenge ?? '');
    if (
      !body || !/^[A-Za-z0-9_-]{20,128}$/.test(String(body.destinationId ?? ''))
      || !/^[0-9a-f]{64}$/.test(String(body.inventoryDigest ?? ''))
      || !validLoopbackCallback(String(body.callback ?? '')) || !/^[A-Za-z0-9_-]{43}$/.test(challenge)
    ) return json({ error: 'invalid_extension' }, 400);
    const extended = await objectStub(env, publicPr).fetch('https://edge.internal/destination-extend', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: body.destinationId,
        inventoryDigest: body.inventoryDigest,
        actor: access.actor,
      }),
    });
    if (!extended.ok) return extended;
    const record = await extended.json() as DestinationRecord;
    const result = {
      destinationId: record.id,
      attestation: await signDestinationAttestation(env, destinationPayload(record)),
      encryptionPublicJwk: record.publicKeyJwk,
      expiresAt: record.expiresAt,
    };
    return createDestinationExchange(env, publicPr, challenge, result);
  }

  if (url.pathname === '/_destination/imports' && request.method === 'POST') {
    const body = await requestJson<{ attestation?: DestinationAttestation; manifest?: DebugManifest }>(request);
    if (!body?.attestation || !body.manifest) return json({ error: 'bad_json' }, 400);
    const claims = await verifyDestinationAttestation(body.attestation, env);
    const pr = Number(claims?.prNumber);
    const id = String(claims?.destinationId ?? '');
    const sessionIds = exactSessionIds(claims?.sessionIds);
    const manifest = body.manifest;
    if (
      !Number.isSafeInteger(pr) || pr <= 0 || !sessionIds
      || manifest.format !== 1 || manifest.inventoryDigest !== claims?.inventoryDigest
      || JSON.stringify(manifest.sessionIds) !== JSON.stringify(sessionIds)
      || manifest.objectCount !== manifest.objects?.length
      || !validDestinationManifestTotals(manifest, Number(claims?.maxBytes))
      || manifest.expiresAt > Number(claims?.exp)
      || new Set(manifest.objects.map((item) => item.objectId)).size !== manifest.objectCount
    ) return json({ error: 'attestation_manifest_mismatch' }, 403);
    const stub = objectStub(env, pr);
    const consumed = await stub.fetch('https://edge.internal/destination-consume', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
    });
    if (!consumed.ok) return consumed;
    const destination = await consumed.json() as DestinationRecord;
    const stateResponse = await stub.fetch('https://edge.internal/state');
    if (!stateResponse.ok) {
      await finishDestinationLifecycle(stub, id, 'failed');
      return json({ error: 'destination_state_unavailable' }, 502);
    }
    const state = await stateResponse.json() as PreviewState;
    if (!destinationUsable(destination, state) || !state.live) {
      await finishDestinationLifecycle(stub, id, 'failed');
      return json({ error: 'live_tuple_changed' }, 409);
    }
    const now = Date.now();
    const payload = {
      format: 1,
      scope: 'session-debug-import',
      jti: randomToken(16),
      iat: now,
      exp: Math.min(now + 30 * 60_000, destination.expiresAt),
      inventoryDigest: destination.inventoryDigest,
      sessionIds: destination.sessionIds,
      destination: {
        environmentNonce: state.live.environmentNonce,
        artifactDigest: state.live.artifactDigest,
        buildInputDigest: state.live.buildInputDigest,
        headSha: state.live.head,
        prNumber: pr,
      },
    };
    const downstreamBody = JSON.stringify({
      assertion: { payload, signature: await signDebugImportPayload(env, payload) },
      manifest,
    });
    let downstream: Response;
    try {
      downstream = await forwardDebug(
        env, state.live, pr, 'POST', '/api/v1/debug/imports', downstreamBody,
        { 'content-type': 'application/json' }, fetchUpstream,
      );
    } catch {
      await finishDestinationLifecycle(stub, id, 'failed');
      return json({ error: 'upstream_import_failed' }, 502);
    }
    if (downstream.status !== 201) {
      await finishDestinationLifecycle(stub, id, 'failed');
      return downstream;
    }
    let result: { importCapability?: string; requiredObjectIds?: string[]; expiresAt?: number };
    try {
      result = await downstream.clone().json() as typeof result;
    } catch {
      await finishDestinationLifecycle(stub, id, 'failed');
      return json({ error: 'invalid_upstream_response' }, 502);
    }
    if (!result.importCapability || typeof result.expiresAt !== 'number' || !Number.isFinite(result.expiresAt) || result.expiresAt <= now) {
      await finishDestinationLifecycle(stub, id, 'failed');
      return json({ error: 'invalid_upstream_response' }, 502);
    }
    const started: DestinationImport = {
      destination,
      manifest,
      upstreamCapability: result.importCapability,
      usedObjectIds: [],
      reservedObjectIds: [],
      state: 'pending',
      expiresAt: Math.min(destination.expiresAt, manifest.expiresAt, result.expiresAt),
    };
    const saved = await stub.fetch('https://edge.internal/destination-start-import', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ import: started }),
    });
    if (!saved.ok) {
      await finishDestinationLifecycle(stub, id, 'failed');
      return saved;
    }
    return json({
      importId: id,
      uploadBaseUrl: `https://pr-${pr}${PUBLIC_SUFFIX}/_destination/imports/${id}`,
      requiredObjectIds: result.requiredObjectIds,
      expiresAt: result.expiresAt,
    }, 201);
  }

  const objectMatch = /^\/_destination\/imports\/([A-Za-z0-9_-]+)\/objects\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (objectMatch && request.method === 'PUT') {
    const [id, objectId] = objectMatch.slice(1) as [string, string];
    const claimsPr = publicPr;
    if (!claimsPr) return json({ error: 'wrong_destination_host' }, 400);
    const stub = objectStub(env, claimsPr);
    const metadata = await stub.fetch('https://edge.internal/destination-object', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, objectId }),
    });
    if (!metadata.ok) return metadata;
    const {
      import: value,
      object,
      privateKeyJwk,
    } = await metadata.json() as {
      import: DestinationImport;
      object: DebugManifestObject;
      privateKeyJwk: JsonWebKey;
    };
    const ciphertext = await readExactBoundedBody(request, object.ciphertextSize);
    if (!ciphertext || await sha256Hex(ciphertext) !== object.ciphertextSha256) {
      return json({ error: 'ciphertext_mismatch' }, 400);
    }

    let plaintext: ArrayBuffer;
    try {
      const privateKey = await crypto.subtle.importKey(
        'jwk', privateKeyJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt'],
      );
      const wrappedKey = decodeSegment(object.wrappedKey);
      const nonce = decodeSegment(object.nonce);
      let aadValue: unknown;
      try { aadValue = JSON.parse(object.aad); } catch { return json({ error: 'invalid_encryption_metadata' }, 400); }
      if (canonicalJson(aadValue) !== object.aad) return json({ error: 'invalid_encryption_metadata' }, 400);
      const aad = new TextEncoder().encode(object.aad);
      if (!wrappedKey || !nonce) return json({ error: 'invalid_encryption_metadata' }, 400);
      const rawKey = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, wrappedKey);
      const aesKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
      plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
        aesKey,
        ciphertext,
      );
      if (plaintext.byteLength !== object.size || await sha256Hex(plaintext) !== object.sha256) {
        return json({ error: 'plaintext_mismatch' }, 400);
      }
    } catch {
      return json({ error: 'decrypt_failed' }, 400);
    }

    const stateResponse = await stub.fetch('https://edge.internal/state');
    if (!stateResponse.ok) {
      await finishDestinationLifecycle(stub, id, 'failed');
      return json({ error: 'destination_state_unavailable' }, 502);
    }
    const state = await stateResponse.json() as PreviewState;
    if (!destinationUsable(value.destination, state) || !state.live) {
      await finishDestinationLifecycle(stub, id, 'failed');
      return json({ error: 'live_tuple_changed' }, 409);
    }
    const reservation = await stub.fetch('https://edge.internal/destination-object-reserve', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, objectId }),
    });
    if (!reservation.ok) return reservation;

    const target = `/api/v1/debug/imports/${encodeURIComponent(value.upstreamCapability)}/objects/${encodeURIComponent(objectId)}`;
    let forwarded: Response;
    try {
      forwarded = await forwardDebug(
        env, state.live, claimsPr, 'PUT', target, plaintext,
        { 'content-type': 'application/octet-stream', 'x-content-hash': `sha256:${object.sha256}` },
        fetchUpstream,
      );
    } catch {
      await finishDestinationObjectForward(stub, id, objectId, false);
      return json({ error: 'upstream_object_failed' }, 502);
    }
    const completed = await finishDestinationObjectForward(stub, id, objectId, forwarded.ok);
    if (!completed.ok) return json({ error: 'object_state_update_failed' }, 502);
    return forwarded;
  }

  const importMatch = /^\/_destination\/imports\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (importMatch && ['POST', 'GET', 'DELETE'].includes(request.method)) {
    const pr = publicPr;
    if (!pr) return json({ error: 'wrong_destination_host' }, 400);
    const id = importMatch[1]!;
    const stub = objectStub(env, pr);
    if (request.method === 'DELETE') return finishDestinationLifecycle(stub, id, 'aborted');

    const internalPath = request.method === 'POST' ? 'destination-commit' : 'destination-status';
    const resolved = await stub.fetch(`https://edge.internal/${internalPath}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
    });
    if (!resolved.ok) return resolved;
    const { import: value } = await resolved.json() as { import: StoredDestinationImport };
    if (!pendingDestinationImport(value)) return json({ import: value });

    const stateResponse = await stub.fetch('https://edge.internal/state');
    if (!stateResponse.ok) {
      if (request.method === 'POST') await finishDestinationLifecycle(stub, id, 'failed');
      return json({ error: 'destination_state_unavailable' }, 502);
    }
    const state = await stateResponse.json() as PreviewState;
    if (!destinationUsable(value.destination, state) || !state.live) {
      await finishDestinationLifecycle(stub, id, 'failed');
      return json({ error: 'live_tuple_changed' }, 409);
    }
    const target = `/api/v1/debug/imports/${encodeURIComponent(value.upstreamCapability)}${request.method === 'POST' ? '/commit' : ''}`;
    let forwarded: Response;
    try {
      forwarded = await forwardDebug(env, state.live, pr, request.method, target, undefined, {}, fetchUpstream);
    } catch {
      if (request.method === 'POST') await finishDestinationLifecycle(stub, id, 'failed');
      return json({ error: 'upstream_import_failed' }, 502);
    }
    if (request.method === 'POST') {
      const finished = await finishDestinationLifecycle(stub, id, forwarded.ok ? 'committed' : 'failed');
      if (!finished.ok) return json({ error: 'import_state_update_failed' }, 502);
    }
    return forwarded;
  }

  return json({ error: 'not_found' }, 404);
}

const REQUEST_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'content-type',
  'content-length',
  'range',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
  'x-content-hash',
  'x-file-mtime',
  'x-file-size',
  'x-part-is-last',
  'x-part-size',
]);
const RESPONSE_HEADERS = new Set(['content-type', 'content-length', 'content-encoding', 'content-language', 'cache-control', 'etag', 'last-modified', 'accept-ranges', 'content-range', 'vary', 'location', 'content-disposition']);

export function safeRequestHeaders(input: Headers, publicOrigin: string, mutating: boolean): Headers {
  const out = new Headers();
  for (const [name, value] of input) if (REQUEST_HEADERS.has(name.toLowerCase())) out.append(name, value);
  if (mutating) out.set('origin', publicOrigin);
  return out;
}

export function safeResponseHeaders(input: Headers, upstream: URL, publicUrl: URL): Headers {
  const out = new Headers();
  for (const [name, value] of input) if (RESPONSE_HEADERS.has(name.toLowerCase())) out.append(name, value);
  const location = out.get('location');
  if (location) {
    try {
      const resolved = new URL(location, upstream);
      if (resolved.origin === upstream.origin) out.set('location', `${publicUrl.origin}${resolved.pathname}${resolved.search}${resolved.hash}`);
      else if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(location)) out.delete('location');
    } catch { out.delete('location'); }
  }
  return out;
}

function cookieValue(request: Request): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return null;
}

async function routeTuple(stub: DurableObjectStub, sessionId: string, host: string): Promise<{ session: EdgeSession; tuple: RouteTuple } | null> {
  const response = await stub.fetch('https://edge.internal/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: sessionId, host }) });
  return response.ok ? response.json() as Promise<{ session: EdgeSession; tuple: RouteTuple }> : null;
}

async function bootstrap(request: Request, url: URL, env: FrontDoorEnv, pr: number): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
  const code = url.searchParams.get('code');
  if (!code || url.searchParams.size !== 1) return json({ error: 'invalid_grant' }, 400);
  const response = await objectStub(env, pr).fetch('https://edge.internal/consume-grant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, host: url.host }) });
  if (!response.ok) return json({ error: 'invalid_or_replayed_grant' }, response.status);
  const session = await response.json() as EdgeSession;
  return new Response(null, { status: 302, headers: {
    location: '/', 'set-cookie': `${COOKIE}=${session.id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000))}`,
    'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
  } });
}

async function accessSession(request: Request, env: FrontDoorEnv, pr: number, state: PreviewState): Promise<EdgeSession | null> {
  const access = await validateAccess(request, env);
  if (!access || !state.live) return null;
  return {
    id: '', host: new URL(request.url).host, pr, epoch: state.epoch, head: state.expectedHead,
    generation: state.live.generation, audience: 'preview-browser', method: '*', target: '*', actor: access.actor,
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
  };
}

export async function proxyPreview(request: Request, env: FrontDoorEnv, fetchUpstream: typeof fetch = fetch): Promise<Response> {
  const publicUrl = new URL(request.url);
  if (publicUrl.pathname.startsWith('/_destination/')) {
    const destinationHost = publicUrl.hostname === CONTROL_HOST || prFromHost(publicUrl.hostname) !== null;
    if (!destinationHost) return new Response('not found', { status: 404 });
    return destinationRoute(request, publicUrl, env, fetchUpstream);
  }
  if (publicUrl.hostname === CONTROL_HOST && publicUrl.pathname.startsWith('/_control/')) {
    return controlRoute(request, publicUrl, env);
  }
  const pr = prFromHost(publicUrl.hostname);
  if (!pr) return new Response('not found', { status: 404 });
  if (publicUrl.pathname.startsWith('/_control/')) return controlRoute(request, publicUrl, env);
  if (publicUrl.pathname === '/_edge/bootstrap') return bootstrap(request, publicUrl, env, pr);
  const target = canonicalTarget(`${publicUrl.pathname}${publicUrl.search}`);
  if (!target) return json({ error: 'invalid_target' }, 400);
  const stub = objectStub(env, pr);
  let routed: { session: EdgeSession; tuple: RouteTuple } | null = null;
  const id = cookieValue(request);
  if (id) routed = await routeTuple(stub, id, publicUrl.host);
  let issueAccessCookie = false;
  if (!routed) {
    const stateResponse = await stub.fetch('https://edge.internal/state');
    if (!stateResponse.ok) return new Response('not found', { status: 404 });
    const state = await stateResponse.json() as PreviewState;
    if (state.lifecycle === 'closed') return new Response('gone', { status: 410 });
    const session = await accessSession(request, env, pr, state);
    if (!session || !state.live) return new Response('unauthorized', { status: 401 });
    routed = { session, tuple: state.live };
    issueAccessCookie = true;
  }
  const { session, tuple } = routed;
  if (session.method !== '*' && session.method !== request.method) return json({ error: 'method_mismatch' }, 403);
  if (session.target !== '*' && session.target !== target) return json({ error: 'target_mismatch' }, 403);
  const digest = await bodyDigest(request);
  if (session.bodyDigest !== undefined && session.bodyDigest !== digest) return json({ error: 'body_mismatch' }, 403);
  const now = Math.floor(Date.now() / 1000);
  const common = { iss: env.EDGE_ISSUER, pr, head: tuple.head, generation: tuple.generation, method: request.method, target, bodyDigest: digest, iat: now, exp: now + ASSERTION_TTL_SECONDS, jti: randomToken(16) };
  const assertion = session.audience === 'preview-browser'
    ? await signJwt(env.BROWSER_SIGNING_KEYS, { ...common, aud: AUDIENCES.browser, actor: session.actor, identity: 'human' })
    : await signJwt(env.ACTION_SIGNING_KEYS, { ...common, aud: AUDIENCES.action, actor: session.actor, identity: 'machine', purpose: session.purpose, machineId: session.machineId, isAdmin: session.isAdmin === true });
  const origin = await signJwt(env.ORIGIN_SIGNING_KEYS, { ...common, aud: AUDIENCES.origin, artifactDigest: tuple.artifactDigest });
  const upstreamBase = new URL(tuple.versionUrl);
  const upstreamUrl = new URL(target, upstreamBase);
  const headers = safeRequestHeaders(request.headers, upstreamUrl.origin, MUTATING_METHODS.has(request.method));
  headers.set(session.audience === 'preview-browser' ? 'x-preview-browser-assertion' : 'x-preview-action-assertion', assertion);
  headers.set('x-preview-origin-assertion', origin);
  const upstream = await fetchUpstream(new Request(upstreamUrl, { method: request.method, headers, body: request.body, redirect: 'manual' }));
  const responseHeaders = safeResponseHeaders(upstream.headers, upstreamUrl, publicUrl);
  if (issueAccessCookie) {
    const grant: GrantInput = { pr, epoch: session.epoch, head: session.head, generation: session.generation, audience: 'preview-browser', method: '*', target: '*', actor: session.actor, expiresIn: SESSION_TTL_SECONDS };
    const created = await stub.fetch('https://edge.internal/grant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(grant) });
    if (created.ok) {
      const { code } = await created.json() as { code: string };
      const consumed = await stub.fetch('https://edge.internal/consume-grant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, host: publicUrl.host }) });
      if (consumed.ok) {
        const persisted = await consumed.json() as EdgeSession;
        responseHeaders.append('set-cookie', `${COOKIE}=${persisted.id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}`);
      }
    }
  }
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
}

export default {
  fetch(request: Request, env: FrontDoorEnv): Promise<Response> { return proxyPreview(request, env); },
};
