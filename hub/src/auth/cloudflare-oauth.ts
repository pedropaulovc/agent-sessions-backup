import { DurableObject } from 'cloudflare:workers';

const AUTHORIZATION_ENDPOINT = 'https://dash.cloudflare.com/oauth2/auth';
const TOKEN_ENDPOINT = 'https://dash.cloudflare.com/oauth2/token';
const REVOKE_ENDPOINT = 'https://dash.cloudflare.com/oauth2/revoke';
const REQUIRED_SCOPE = 'ssl-and-certificates.write';
const OFFLINE_SCOPE = 'offline_access';
const PENDING_TTL_MS = 5 * 60 * 1000;
const EXPIRY_SKEW_MS = 60 * 1000;
const BROKER_NAME = 'managed-ca';
const INTERNAL_ERROR_HEADER = 'x-cloudflare-oauth-broker-error';

type AuthorizationState = 'authorized' | 'reauthorization_required';

interface PendingAuthorization {
  state: string;
  verifier: string;
  expiresAt: number;
}

interface OAuthGrant {
  state: AuthorizationState;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  scopes: string[];
  updatedAt: string;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
}

export type ClientCertificateOperation =
  | { kind: 'sign'; csr: string; validity_days: number }
  | { kind: 'get'; cert_id: string }
  | { kind: 'revoke'; cert_id: string };

export class CloudflareOAuthUnavailable extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'CloudflareOAuthUnavailable';
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomUrlSafe(byteLength: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function sha256UrlSafe(value: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

function configuredScopes(env: Env): string[] | null {
  const scopes = (env.CF_OAUTH_SCOPES ?? '').split(/\s+/).filter(Boolean);
  if (!scopes.includes(REQUIRED_SCOPE) || !scopes.includes(OFFLINE_SCOPE)) return null;
  return scopes;
}

function internalError(reason: string, status = 503): Response {
  return Response.json(
    { error: 'cloudflare_oauth_unavailable', reason },
    { status, headers: { [INTERNAL_ERROR_HEADER]: reason } },
  );
}

function validCertId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function parseGrantedScopes(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
  return [];
}

function tokenForm(fields: Record<string, string>): URLSearchParams {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

function brokerStub(env: Env): DurableObjectStub | null {
  if (!env.CF_OAUTH_BROKER || !env.CF_OAUTH_CLIENT_ID || !env.CF_OAUTH_REDIRECT_URI || !configuredScopes(env)) return null;
  return env.CF_OAUTH_BROKER.get(env.CF_OAUTH_BROKER.idFromName(BROKER_NAME));
}

async function callBroker(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const stub = brokerStub(env);
  if (!stub) return internalError('not_configured');
  return stub.fetch(`https://cloudflare-oauth.internal${path}`, init);
}

export async function startCloudflareOAuth(env: Env): Promise<Response> {
  return callBroker(env, '/authorize', { method: 'POST' });
}

export async function cloudflareOAuthStatus(env: Env): Promise<Response> {
  return callBroker(env, '/status');
}

export async function disconnectCloudflareOAuth(env: Env): Promise<Response> {
  return callBroker(env, '/disconnect', { method: 'POST' });
}

export async function completeCloudflareOAuth(url: URL, env: Env): Promise<Response> {
  const body = {
    code: url.searchParams.get('code'),
    state: url.searchParams.get('state'),
    error: url.searchParams.get('error'),
  };
  const res = await callBroker(env, '/callback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; reason?: string };
  const title = result.ok ? 'Cloudflare connected' : 'Cloudflare connection failed';
  const detail = result.ok ? 'The hub can now manage client certificates.' : `Error: ${result.error ?? result.reason ?? 'unknown'}`;
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title><main><h1>${title}</h1><p>${detail}</p></main>`,
    { status: res.status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  );
}

export async function cloudflareClientCertificateRequest(env: Env, operation: ClientCertificateOperation): Promise<Response> {
  const res = await callBroker(env, '/client-certificate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(operation),
  });
  const reason = res.headers.get(INTERNAL_ERROR_HEADER);
  if (reason) throw new CloudflareOAuthUnavailable(reason);
  return res;
}

/** Singleton OAuth and managed-CA broker. OAuth bearer credentials never leave this object. */
export class CloudflareOAuthBroker extends DurableObject<Env> {
  private refreshInFlight: Promise<string> | null = null;
  private grantMutationTail: Promise<void> = Promise.resolve();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/authorize' && request.method === 'POST') return this.authorize();
    if (url.pathname === '/callback' && request.method === 'POST') return this.callback(request);
    if (url.pathname === '/status' && request.method === 'GET') return this.status();
    if (url.pathname === '/disconnect' && request.method === 'POST') return this.disconnect();
    if (url.pathname === '/client-certificate' && request.method === 'POST') return this.clientCertificate(request);
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  private configuration(): { clientId: string; redirectUri: string; scopes: string[]; zoneId: string } | null {
    const scopes = configuredScopes(this.env);
    if (!this.env.CF_OAUTH_CLIENT_ID || !this.env.CF_OAUTH_REDIRECT_URI || !this.env.CF_ZONE_ID || !scopes) return null;
    return { clientId: this.env.CF_OAUTH_CLIENT_ID, redirectUri: this.env.CF_OAUTH_REDIRECT_URI, scopes, zoneId: this.env.CF_ZONE_ID };
  }

  private async authorize(): Promise<Response> {
    const config = this.configuration();
    if (!config) return internalError('not_configured');
    const verifier = randomUrlSafe(48);
    const pending: PendingAuthorization = {
      state: randomUrlSafe(32),
      verifier,
      expiresAt: Date.now() + PENDING_TTL_MS,
    };
    await this.ctx.storage.put('pending_authorization', pending);
    const url = new URL(AUTHORIZATION_ENDPOINT);
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: config.scopes.join(' '),
      state: pending.state,
      code_challenge: await sha256UrlSafe(verifier),
      code_challenge_method: 'S256',
    }).toString();
    return Response.json({ authorization_url: url.toString(), expires_at: new Date(pending.expiresAt).toISOString() });
  }

  private async callback(request: Request): Promise<Response> {
    const config = this.configuration();
    if (!config) return internalError('not_configured');
    const body = (await request.json().catch(() => ({}))) as { code?: unknown; state?: unknown; error?: unknown };
    const pending = await this.ctx.storage.get<PendingAuthorization>('pending_authorization');
    await this.ctx.storage.delete('pending_authorization');
    if (typeof body.error === 'string' && body.error) return internalError('authorization_denied', 400);
    if (!pending || pending.expiresAt < Date.now()) return internalError('authorization_expired', 400);
    if (typeof body.state !== 'string' || body.state !== pending.state) return internalError('invalid_state', 400);
    if (typeof body.code !== 'string' || !body.code) return internalError('missing_code', 400);

    return this.withGrantMutation(async () => {
      const res = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: tokenForm({
          grant_type: 'authorization_code',
          client_id: config.clientId,
          redirect_uri: config.redirectUri,
          code: body.code as string,
          code_verifier: pending.verifier,
        }),
      });
      const token = (await res.json().catch(() => ({}))) as TokenResponse;
      if (!res.ok) return internalError('code_exchange_failed', 502);
      const grant = this.validateGrant(token, null, config.scopes);
      if (!grant) return internalError('invalid_token_response', 502);
      await this.ctx.storage.put('grant', grant);
      console.log(JSON.stringify({ event: 'hub.certs.oauth_authorized', scopes: grant.scopes }));
      return Response.json({ ok: true });
    });
  }

  private async status(): Promise<Response> {
    const grant = await this.ctx.storage.get<OAuthGrant>('grant');
    if (!grant) return Response.json({ authorization: 'missing' });
    return Response.json({ authorization: grant.state, scopes: grant.scopes, updated_at: grant.updatedAt });
  }

  private async disconnect(): Promise<Response> {
    const config = this.configuration();
    if (!config) return internalError('not_configured');
    return this.withGrantMutation(async () => {
      const grant = await this.ctx.storage.get<OAuthGrant>('grant');
      if (!grant) return Response.json({ ok: true, authorization: 'missing' });
      const res = await fetch(REVOKE_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: tokenForm({ client_id: config.clientId, token: grant.refreshToken, token_type_hint: 'refresh_token' }),
      });
      if (!res.ok) return internalError('grant_revoke_failed', 502);
      await this.ctx.storage.delete('grant');
      console.log(JSON.stringify({ event: 'hub.certs.oauth_disconnected' }));
      return Response.json({ ok: true, authorization: 'missing' });
    });
  }

  private async clientCertificate(request: Request): Promise<Response> {
    const config = this.configuration();
    if (!config) return internalError('not_configured');
    const operation = (await request.json().catch(() => null)) as ClientCertificateOperation | null;
    const validated = this.validateOperation(operation);
    if (!validated) return internalError('invalid_operation', 400);
    let accessToken: string;
    try {
      accessToken = await this.accessToken();
    } catch (error) {
      const reason = error instanceof CloudflareOAuthUnavailable ? error.reason : 'refresh_failed';
      return internalError(reason);
    }
    let response = await this.callManagedCa(config.zoneId, accessToken, validated);
    if (response.status !== 401 && response.status !== 403) return response;
    try {
      accessToken = await this.accessToken('force_refresh');
    } catch (error) {
      const reason = error instanceof CloudflareOAuthUnavailable ? error.reason : 'refresh_failed';
      return internalError(reason);
    }
    response = await this.callManagedCa(config.zoneId, accessToken, validated);
    if (response.status === 401 || response.status === 403) {
      console.log(JSON.stringify({ event: 'hub.certs.cf_auth_failed', reason: `access_${response.status}` }));
    }
    return response;
  }

  private validateOperation(operation: ClientCertificateOperation | null): ClientCertificateOperation | null {
    if (!operation || typeof operation !== 'object') return null;
    if (operation.kind === 'sign') {
      if (typeof operation.csr !== 'string' || !operation.csr.includes('BEGIN CERTIFICATE REQUEST')) return null;
      if (!Number.isInteger(operation.validity_days) || operation.validity_days < 1 || operation.validity_days > 3650) return null;
      return operation;
    }
    if (operation.kind === 'get' && validCertId(operation.cert_id)) return operation;
    if (operation.kind === 'revoke' && validCertId(operation.cert_id)) return operation;
    return null;
  }

  private async callManagedCa(zoneId: string, accessToken: string, operation: ClientCertificateOperation): Promise<Response> {
    const base = `https://api.cloudflare.com/client/v4/zones/${zoneId}/client_certificates`;
    const url = operation.kind === 'sign' ? base : `${base}/${encodeURIComponent(operation.cert_id)}`;
    const init: RequestInit = { headers: { authorization: `Bearer ${accessToken}` } };
    if (operation.kind === 'sign') {
      init.method = 'POST';
      init.headers = { ...init.headers, 'content-type': 'application/json' };
      init.body = JSON.stringify({ csr: operation.csr, validity_days: operation.validity_days });
    }
    if (operation.kind === 'revoke') init.method = 'DELETE';
    const response = await fetch(url, init);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
    });
  }

  private async accessToken(mode: 'cached' | 'force_refresh' = 'cached'): Promise<string> {
    const grant = await this.ctx.storage.get<OAuthGrant>('grant');
    if (!grant) throw new CloudflareOAuthUnavailable('not_authorized');
    if (grant.state === 'reauthorization_required') throw new CloudflareOAuthUnavailable('reauthorization_required');
    if (mode === 'cached' && grant.accessToken && grant.accessExpiresAt - EXPIRY_SKEW_MS > Date.now()) return grant.accessToken;
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.withGrantMutation(async () => {
      const latest = await this.ctx.storage.get<OAuthGrant>('grant');
      if (!latest) throw new CloudflareOAuthUnavailable('not_authorized');
      if (latest.state === 'reauthorization_required') throw new CloudflareOAuthUnavailable('reauthorization_required');
      if (mode === 'cached' && latest.accessToken && latest.accessExpiresAt - EXPIRY_SKEW_MS > Date.now()) return latest.accessToken;
      return this.refresh(latest);
    }).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async withGrantMutation<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.grantMutationTail;
    let release!: () => void;
    this.grantMutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async refresh(current: OAuthGrant): Promise<string> {
    const config = this.configuration();
    if (!config) throw new CloudflareOAuthUnavailable('not_configured');
    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenForm({ grant_type: 'refresh_token', client_id: config.clientId, refresh_token: current.refreshToken }),
    });
    const token = (await response.json().catch(() => ({}))) as TokenResponse;
    if (!response.ok) {
      if (token.error === 'invalid_grant') {
        await this.ctx.storage.put('grant', { ...current, state: 'reauthorization_required', accessToken: '', accessExpiresAt: 0, updatedAt: new Date().toISOString() });
        console.log(JSON.stringify({ event: 'hub.certs.cf_auth_failed', reason: 'refresh_invalid_grant' }));
        throw new CloudflareOAuthUnavailable('reauthorization_required');
      }
      throw new CloudflareOAuthUnavailable('refresh_failed');
    }
    const next = this.validateGrant(token, current.refreshToken, current.scopes);
    if (!next) throw new CloudflareOAuthUnavailable('invalid_refresh_response');
    await this.ctx.storage.put('grant', next);
    return next.accessToken;
  }

  private validateGrant(token: TokenResponse, existingRefreshToken: string | null, requestedScopes: string[]): OAuthGrant | null {
    if (typeof token.access_token !== 'string' || !token.access_token) return null;
    const refreshToken = typeof token.refresh_token === 'string' && token.refresh_token ? token.refresh_token : existingRefreshToken;
    if (!refreshToken) return null;
    if (typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0) return null;
    // RFC 6749 lets the token response omit `scope` when it exactly matches the request. If the
    // provider returns a scope value, treat it as authoritative and fail closed on a downgrade.
    const returnedScopes = parseGrantedScopes(token.scope);
    const scopes = returnedScopes.length > 0 ? returnedScopes : requestedScopes;
    if (!scopes.includes(REQUIRED_SCOPE)) return null;
    return {
      state: 'authorized',
      accessToken: token.access_token,
      refreshToken,
      accessExpiresAt: Date.now() + token.expires_in * 1000,
      scopes,
      updatedAt: new Date().toISOString(),
    };
  }
}
