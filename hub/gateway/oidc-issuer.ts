// Standalone OIDC issuer for Cloudflare-worker → Azure federation.
//
// Publishes the discovery document + JWKS that Azure Entra fetches to validate
// the self-signed client assertions sessions-telemetry-gateway mints (see
// ./oidc-sign.ts and ./telemetry-gateway.ts). This is the whole point of the
// "zero Azure secret" design: no connection string or instrumentation key ever
// leaves this repo — Azure trusts this issuer's public key instead.
//
// This worker holds ONLY public keys. Signing happens in the telemetry
// gateway, which reads the matching private key from the OIDC_SIGNING_KEY
// Worker secret (a classic `wrangler secret`, not a Secrets Store binding —
// see hub/gateway/telemetry-gateway.ts's header for why). The gateway's
// OIDC_SIGNING_KID (in
// hub/wrangler.telemetry-gateway.jsonc) must always match ACTIVE_KID below —
// that's the kid it stamps in its JWT header and the one Entra actually needs
// to resolve against a key in PUBLIC_JWKS to verify the signature.
//
// Ported from youtube-mirror's worker/oidc-issuer.ts (GCP federation removed —
// this deployment only federates to Azure), then extended to publish a JWKS
// **array** rather than a single key, so a signing-key rotation can carry both
// the old and new key simultaneously while Entra's (and any other relying
// party's) cached copy of this endpoint catches up.
//
// Rotation sequence (see also infra/cf/telemetry.md "Rotate the signing key"):
//   1. Generate a new keypair (`node scripts/generate-gateway-key.mjs`).
//   2. Add its public JWK to PUBLIC_JWKS (keep the old one too) and redeploy
//      this worker. Do NOT change ACTIVE_KID yet.
//   3. Wait at least one Cache-Control max-age window (below) so every cached
//      copy of /.well-known/jwks.json — Entra's included — has the new key.
//   4. Set the new private key as the OIDC_SIGNING_KEY Worker secret, set
//      OIDC_SIGNING_KID to the new kid, and set ACTIVE_KID here to match;
//      redeploy both workers.
//   5. Once nothing is minting assertions with the old kid (immediately, since
//      step 4 was one deploy), remove the old entry from PUBLIC_JWKS and
//      redeploy this worker again.

interface Env {
  ISSUER_URL: string;
}

interface Jwk {
  kty: string;
  kid: string;
  n: string;
  e: string;
  alg: string;
  use: string;
}

// The kid the telemetry gateway currently signs with (must equal
// OIDC_SIGNING_KID on sessions-telemetry-gateway). During a rotation this is
// the OLD kid until step 4 above flips it to the new one.
const ACTIVE_KID = "3f2d383f";

// The live signing key: public half of the RSA-2048 keypair whose private key
// is set as the OIDC_SIGNING_KEY Worker secret on sessions-telemetry-gateway
// (generated via `node scripts/generate-gateway-key.mjs` at M4 deploy — the
// private key is never committed). During a rotation, add the new key here
// alongside this one before flipping ACTIVE_KID (see the header comment).
const PUBLIC_JWKS: Jwk[] = [
  {
    kty: "RSA",
    kid: "3f2d383f",
    n: "qs_b5uajR6hY_7YoGmnPz4l7RAwKnvf-aaUvqaad7qF0Zb6jjUuTr5fAAGnN6oELuII-zyIGT53tdAPyYX7qbGj6xJk-_RV8PY-1DoCEgNXf3pmOP53nxT5-Znj045fd_dQvOWrG4tf_PbUhaXbF5aKrP2h-qWfh1lkZ-sVVfgw5gnLHXj2512HnUNDE7KAKwuQzo6DbWkU2LJ_-DbEj8D4h9bckyQSw1-BU00eXwWy9I2UVVo3CjLz1ttBwOoY9eZRrQgGV3Tjj9CDJneVmOegCNmlv4jrgLAQ-qEbO3mWfCx2Sg7T4qpsM08V7pq2VtJlXhj__ae5Yqy0dRE6A2Q",
    e: "AQAB",
    alg: "RS256",
    use: "sig",
  },
];

// Rotation-tolerant: short enough that a newly-published key propagates to
// relying parties (Entra's JWKS cache included) well within the window a
// rotation actually waits (step 3 above), unlike the previous 1h value.
const JWKS_CACHE_CONTROL = "public, max-age=300";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (request.method === "GET" && path === "/.well-known/openid-configuration") {
      return Response.json(
        {
          issuer: env.ISSUER_URL,
          jwks_uri: `${env.ISSUER_URL}/.well-known/jwks.json`,
          response_types_supported: ["id_token"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
        },
        { headers: { "Cache-Control": JWKS_CACHE_CONTROL } },
      );
    }

    if (request.method === "GET" && path === "/.well-known/jwks.json") {
      return Response.json(
        { keys: PUBLIC_JWKS },
        { headers: { "Cache-Control": JWKS_CACHE_CONTROL } },
      );
    }

    return new Response("Not found", { status: 404 });
  },
};

// Exported for tests / operational sanity checks: the issuer should never
// serve a JWKS that's missing the key the gateway is actually signing with.
export function activeKeyIsPublished(): boolean {
  return PUBLIC_JWKS.some((k) => k.kid === ACTIVE_KID);
}
