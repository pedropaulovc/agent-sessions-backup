// RS256 assertion signer for workload-identity federation.
//
// The telemetry gateway authenticates to Azure without any long-lived cloud
// secret: it self-signs a short-lived JWT with the private key whose public
// half is published by the sessions-oidc-issuer worker (see ./oidc-issuer.ts).
// Azure Entra fetches that issuer's JWKS to verify the signature, then hands
// back an access token via the client_credentials/client_assertion flow. This
// module owns the signing; the caller (telemetry-gateway.ts) owns the exchange.
//
// Ported from youtube-mirror's worker/oidc-sign.ts (logic unchanged).

export interface AssertionParams {
  issuer: string;
  subject: string;
  audience: string;
  kid: string;
  privateKeyPem: string;
  ttlSeconds?: number;
}

function base64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** Mint a signed RS256 JWT usable as an OAuth client assertion / subject token. */
export async function signAssertion(params: AssertionParams): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", kid: params.kid, typ: "JWT" };
  const payload = {
    iss: params.issuer,
    sub: params.subject,
    aud: params.audience,
    iat: now,
    exp: now + (params.ttlSeconds ?? 300),
    jti: crypto.randomUUID(),
  };

  const encoder = new TextEncoder();
  const headerB64 = base64url(encoder.encode(JSON.stringify(header)).buffer as ArrayBuffer);
  const payloadB64 = base64url(encoder.encode(JSON.stringify(payload)).buffer as ArrayBuffer);
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importPrivateKey(params.privateKeyPem);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(signingInput));

  return `${signingInput}.${base64url(signature)}`;
}
