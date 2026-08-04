/** Verification of GitHub Actions OIDC tokens.
 *
 * Cloudflare has no workload-identity federation for its API. The trusted preview control plane
 * therefore verifies short-lived GitHub Actions assertions before using its own non-production
 * account credential. It pins repository, workflow/ref, audience, event, and run identity; PR code
 * receives neither that credential nor a reusable assertion. Production resources live in a
 * different Cloudflare account and are absent from every preview binding.
 */

const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
const GITHUB_JWKS_URL = `${GITHUB_ISSUER}/.well-known/jwks`;

/** The claims this hub cares about. GitHub sets many more. */
export interface GitHubOidcClaims {
  iss: string;
  aud: string | string[];
  sub: string;
  exp: number;
  nbf?: number;
  iat?: number;
  repository?: string;
  repository_owner?: string;
  ref?: string;
  environment?: string;
  workflow?: string;
  event_name?: string;
}

export type OidcResult =
  | { ok: true; claims: GitHubOidcClaims }
  // `retryable` marks a failure that says nothing about the token -- GitHub's JWKS endpoint being
  // unreachable -- so a caller can retry instead of failing a valid run.
  | { ok: false; reason: string; retryable?: boolean };

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
  n: string;
  e: string;
}

/** Decode, or null if the segment is not valid base64url.
 *
 * `atob` THROWS on an invalid character, and on this publicly reachable route an unauthenticated
 * caller can send a syntactically valid header/payload with a signature of `%` — turning an
 * intended, controlled 401 into an uncaught platform 500. Every caller must handle null. */
function b64urlToBytesOrNull(s: string): Uint8Array | null {
  try {
    return b64urlToBytes(s);
  } catch {
    return null;
  }
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson<T>(segment: string): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(segment))) as T;
  } catch {
    return null;
  }
}

/** GitHub rotates signing keys, so the key set is fetched rather than pinned. `cacheTtl` keeps
 * this off the hot path without holding a stale set past a rotation. */
/** Minimum gap between cache-bypassing JWKS fetches, per isolate.
 *
 * The uncached refetch exists for key rotation, but it is reachable BEFORE signature verification
 * (the kid is read from an unverified header), and this route is publicly reachable. Without a
 * throttle an unauthenticated flood of syntactically valid JWTs each carrying a fresh random kid
 * forces one outbound GitHub request apiece — burning Worker resources and risking rate-limiting
 * the JWKS access that legitimate migration runs depend on. One refresh a minute is far more than
 * rotation needs and far less than a flood wants.
 */
const UNCACHED_JWKS_MIN_INTERVAL_MS = 60_000;
let lastUncachedJwksFetch = 0;

async function fetchJwks(bypassCache = false): Promise<Jwk[] | null> {
  // `cacheEverything` with a 600s TTL keeps the common path off the network. bypassCache forces a
  // fresh fetch for the one case the cache gets wrong: GitHub rotating in a new signing key inside
  // the TTL, so a perfectly valid token names a kid the cached set predates.
  try {
    const res = await fetch(GITHUB_JWKS_URL, {
      cf: bypassCache ? { cacheTtl: 0 } : { cacheTtl: 600, cacheEverything: true },
      ...(bypassCache ? { headers: { 'cache-control': 'no-cache' } } : {}),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { keys?: Jwk[] };
    return body.keys ?? null;
  } catch {
    // A network-layer rejection or malformed JSON is exactly as transient as a 5xx, and must
    // reach the caller as `null` rather than propagating. An uncaught throw here becomes
    // Cloudflare's bodiless platform 500, which CI reads as "the endpoint is not up yet" — so it
    // retries, then exits GREEN with the preview left on an old schema.
    return null;
  }
}

/** Reset the refresh throttle. TEST ONLY — nothing in the request path calls this; the throttle
 * is deliberately process-wide so a flood cannot be escaped by varying the request. */
export function resetJwksThrottleForTests(): void {
  lastUncachedJwksFetch = 0;
}

/** True if a cache-bypassing refresh is allowed right now, consuming the allowance if so.
 *
 * Note the accepted cost: a flood can delay a LEGITIMATE rotation refresh by up to the interval.
 * That is survivable here because the only caller (CI) retries with backoff over a longer window
 * than the throttle, so a run that arrives mid-rotation recovers on a later attempt instead of
 * failing — whereas an unthrottled amplifier has no such ceiling. */
function allowUncachedJwksFetch(now: number): boolean {
  if (now - lastUncachedJwksFetch < UNCACHED_JWKS_MIN_INTERVAL_MS) return false;
  lastUncachedJwksFetch = now;
  return true;
}

/**
 * Verify a GitHub Actions OIDC token.
 *
 * `expectedAudience` and `expectedRepository` are both required and both checked. Audience alone
 * is not enough — any repository can mint a token with an arbitrary `aud` — and repository alone
 * is not enough either, since a token minted for some other service in the same repo would
 * otherwise be replayable here.
 */
export async function verifyGitHubOidc(
  token: string,
  opts: { expectedAudience: string; expectedRepository: string; now?: number },
): Promise<OidcResult> {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed_token' };
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = decodeJson<{ alg?: string; kid?: string }>(headerB64);
  if (!header) return { ok: false, reason: 'malformed_header' };
  // Pin the algorithm. Accepting whatever `alg` the token names is the classic JWT bypass —
  // `none` skips verification, and an HMAC alg would let the public key be used as a shared secret.
  if (header.alg !== 'RS256') return { ok: false, reason: 'unexpected_alg' };
  if (!header.kid) return { ok: false, reason: 'missing_kid' };

  const claims = decodeJson<GitHubOidcClaims>(payloadB64);
  if (!claims) return { ok: false, reason: 'malformed_claims' };
  if (claims.iss !== GITHUB_ISSUER) return { ok: false, reason: 'bad_issuer' };

  let jwks = await fetchJwks();
  let jwk = jwks?.find((k) => k.kid === header.kid);
  let refreshThrottled = false;
  // An unknown kid is far more likely to be a key rotation the cache has not caught up with than a
  // forged token, and a forged one fails signature verification below anyway -- so pay for one
  // uncached fetch before rejecting. Without this, a valid run fails during every rotation window,
  // and since CI now treats any handler error as fatal, it fails RED rather than retrying.
  if (!jwk) {
    if (allowUncachedJwksFetch(Date.now())) {
      jwks = await fetchJwks(true);
      jwk = jwks?.find((k) => k.kid === header.kid);
    } else {
      refreshThrottled = true;
    }
  }
  // Distinguish "GitHub is unreachable" from "this token is bad": the first is transient and the
  // caller should retry, the second never becomes valid. `retryable` is what CI keys off.
  if (!jwks) return { ok: false, reason: 'jwks_unavailable', retryable: true };
  // An unknown kid whose refresh was THROTTLED is not evidence the key does not exist -- the
  // lookup that would have found it never ran. A forged request consuming the allowance just
  // before GitHub rotates would otherwise make a valid CI token fail permanently on its first
  // 401, when the same token succeeds once the interval elapses.
  if (!jwk && refreshThrottled) return { ok: false, reason: 'jwks_refresh_throttled', retryable: true };
  if (!jwk) return { ok: false, reason: 'unknown_kid' };

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signed = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = b64urlToBytesOrNull(signatureB64);
  if (!signature) return { ok: false, reason: 'malformed_signature' };
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signature as BufferSource,
    signed as BufferSource,
  );
  if (!valid) return { ok: false, reason: 'bad_signature' };

  // Claim checks come AFTER signature verification: an unverified payload is attacker-controlled
  // text, so validating it first would be checking a string the attacker chose.
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || now >= claims.exp) return { ok: false, reason: 'expired' };
  if (typeof claims.nbf === 'number' && now < claims.nbf) return { ok: false, reason: 'not_yet_valid' };

  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(opts.expectedAudience)) return { ok: false, reason: 'bad_audience' };
  if (claims.repository !== opts.expectedRepository) return { ok: false, reason: 'bad_repository' };

  return { ok: true, claims };
}
