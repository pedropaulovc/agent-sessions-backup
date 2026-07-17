// Generates the RSA-2048 keypair used by the OIDC workload-identity federation
// (hub/gateway/oidc-sign.ts + hub/gateway/telemetry-gateway.ts → Azure Entra).
//
// Usage:
//   node scripts/generate-gateway-key.mjs > private-key.pem
//
// stdout: the PKCS#8 PEM private key — pipe straight into a classic Worker
// secret as OIDC_SIGNING_KEY (`wrangler secret put OIDC_SIGNING_KEY --config
// hub/wrangler.telemetry-gateway.jsonc`). NOT a Cloudflare Secrets Store
// binding: Secrets Store caps values at 1024 bytes, but this PEM is ~1.7KB —
// see hub/gateway/telemetry-gateway.ts's header. Never commit it.
//
// stderr: the public JWK (with a fresh `kid`) — paste into
// hub/gateway/oidc-issuer.ts's PUBLIC_JWK, and set that same `kid` as
// OIDC_SIGNING_KID in hub/wrangler.telemetry-gateway.jsonc.
//
// Ported from twitter-mirror's scripts/generate-gateway-key.ts (plain Node,
// no TypeScript build step needed for a one-off keygen script).

import { generateKeyPairSync, randomBytes } from "node:crypto";

const kid = randomBytes(4).toString("hex");

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "jwk" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

process.stdout.write(privateKey);

const publicJwk = {
  kty: publicKey.kty,
  kid,
  n: publicKey.n,
  e: publicKey.e,
  alg: "RS256",
  use: "sig",
};

console.error("\nPublic JWK (paste into hub/gateway/oidc-issuer.ts's PUBLIC_JWK,");
console.error("and set kid as OIDC_SIGNING_KID in hub/wrangler.telemetry-gateway.jsonc):\n");
console.error(JSON.stringify(publicJwk, null, 2));
