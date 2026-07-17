// Telemetry gateway: Cloudflare Workers observability (OTLP/JSON, logs+traces)
// → OTLP/protobuf → Azure Monitor DCR ingestion, authenticated with an Entra
// bearer minted via workload-identity federation. Zero Azure secrets: no
// connection string or instrumentation key is ever configured anywhere — the
// only credential material is the RSA private key in the OIDC_SIGNING_KEY
// Secrets Store entry, which never leaves Cloudflare.
//
// Ported from youtube-mirror's worker/telemetry-gateway.ts (the DCR/OTLP-
// protobuf path — NOT twitter-mirror's Application-Insights-Breeze
// track-envelope translator, which targets a different, non-DCR ingestion API).

import { signAssertion } from "./oidc-sign";
import { encodeLogsRequest, encodeTraceRequest } from "./otlp-protobuf";

interface Env {
  TENANT_ID: string;
  APP_CLIENT_ID: string;
  // Azure Monitor native OTLP/DCR ingestion endpoints (one per signal). Each is a
  // full URL ending in /otlp/v1/{traces,logs} — see hub/wrangler.telemetry-gateway.jsonc.
  // Workers observability emits no metrics, so no OTLP_METRICS_ENDPOINT is wired.
  OTLP_TRACES_ENDPOINT: string;
  OTLP_LOGS_ENDPOINT: string;
  // Shared federation identity (see infra/cf/telemetry.md + infra/azure/provision.sh).
  // OIDC_SIGNING_KEY is a Secrets Store binding holding the RSA private key whose
  // public half sessions-oidc-issuer publishes.
  OIDC_ISSUER_URL: string;
  OIDC_SIGNING_KID: string;
  OIDC_SIGNING_KEY: { get(): Promise<string> };
  GATEWAY_FEDERATION_SUBJECT: string;
  INGEST_BEARER: string;
}

let tokenCache: { token: string; expiresAt: number } | null = null;

export async function getEntraToken(env: Env): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const assertion = await signAssertion({
    issuer: env.OIDC_ISSUER_URL,
    subject: env.GATEWAY_FEDERATION_SUBJECT,
    audience: "api://AzureADTokenExchange",
    kid: env.OIDC_SIGNING_KID,
    privateKeyPem: await env.OIDC_SIGNING_KEY.get(),
  });

  const body = new URLSearchParams({
    client_id: env.APP_CLIENT_ID,
    grant_type: "client_credentials",
    scope: "https://monitor.azure.com/.default",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
  });

  const res = await fetch(
    `https://login.microsoftonline.com/${env.TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );

  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!data.access_token) {
    throw new Error(
      `Entra token exchange failed: ${data.error} — ${data.error_description}`,
    );
  }

  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in! - 60) * 1000,
  };

  return tokenCache.token;
}

// Cloudflare's Workers-observability OTLP exporter ships OTLP/HTTP JSON. Azure
// Monitor's managed OTLP/DCR ingestion endpoints only accept protobuf (JSON →
// HTTP 415), so we transcode per signal before forwarding. `encode` maps the
// parsed OTLP JSON to protobuf wire bytes.
type OtlpEncoder = (json: Record<string, unknown>) => Uint8Array;

async function forwardOtlp(
  request: Request,
  env: Env,
  endpoint: string,
  encode: OtlpEncoder,
): Promise<Response> {
  // The Cloudflare Workers OTLP exporter authenticates to us with a shared bearer
  // (set on the observability destination). Reject anything else, but answer 200 so
  // a misconfigured exporter doesn't retry-storm.
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${env.INGEST_BEARER}`) {
    return new Response("OK", { status: 200 });
  }

  const rawBytes = await request.arrayBuffer();
  if (rawBytes.byteLength === 0) {
    return new Response("OK", { status: 200 });
  }

  // Cloudflare gzips the OTLP JSON body. Decompress, then transcode to protobuf.
  let jsonText: string;
  const firstBytes = new Uint8Array(rawBytes.slice(0, 2));
  if (firstBytes[0] === 0x1f && firstBytes[1] === 0x8b) {
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    writer.write(rawBytes);
    writer.close();
    jsonText = await new Response(ds.readable).text();
  } else {
    jsonText = new TextDecoder().decode(rawBytes);
  }

  if (jsonText.length === 0) {
    return new Response("OK", { status: 200 });
  }

  const payload = encode(JSON.parse(jsonText) as Record<string, unknown>);
  if (payload.byteLength === 0) {
    return new Response("OK", { status: 200 });
  }

  const token = await getEntraToken(env);

  const upstream = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-protobuf",
      Authorization: `Bearer ${token}`,
    },
    body: payload,
  });

  const upstreamBody = await upstream.text();
  if (!upstream.ok) {
    // This worker has no observability.logs/traces destinations of its own
    // (see hub/wrangler.telemetry-gateway.jsonc) and must not — it IS the
    // /v1/{logs,traces} sink, so exporting its own logs back to itself would
    // be a recursion loop. This line is visible via `wrangler tail`/the
    // Cloudflare dashboard only; it never reaches Azure/OTelLogs, so
    // infra/azure/alerts/collector-errors.kql cannot see it (see that file's
    // header for how gateway-side failures are actually detected).
    console.log(JSON.stringify({
      event: "collector.event",
      level: "error",
      tag: "gateway-upstream-error",
      endpoint,
      status: upstream.status,
      body: upstreamBody.slice(0, 500),
    }));
  }

  // fetch/Response forbids a non-null body on 204/205/304 responses — even an
  // empty string throws. Azure's DCR ingestion endpoint can return a bodyless
  // 204 on success, which would otherwise turn into an unhandled Worker
  // exception here.
  const NULL_BODY_STATUSES = new Set([204, 205, 304]);
  return new Response(NULL_BODY_STATUSES.has(upstream.status) ? null : upstreamBody, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // The OIDC discovery + JWKS this gateway's assertions validate against live in
    // the standalone sessions-oidc-issuer worker (OIDC_ISSUER_URL). Cloudflare
    // Workers observability emits only logs + traces (no metrics), so only those
    // two routes are wired.
    if (request.method === "POST") {
      if (path === "/v1/traces") return forwardOtlp(request, env, env.OTLP_TRACES_ENDPOINT, encodeTraceRequest);
      if (path === "/v1/logs") return forwardOtlp(request, env, env.OTLP_LOGS_ENDPOINT, encodeLogsRequest);
    }

    return new Response("OK", { status: 200 });
  },
};
