// Telemetry gateway: Cloudflare Workers observability (OTLP/JSON, logs+traces)
// → OTLP/protobuf → Azure Monitor DCR ingestion, authenticated with an Entra
// bearer minted via workload-identity federation. Zero Azure secrets: no
// connection string or instrumentation key is ever configured anywhere — the
// only credential material is the RSA private key in the OIDC_SIGNING_KEY
// secret, which never leaves Cloudflare.
//
// Ported from youtube-mirror's worker/telemetry-gateway.ts (the DCR/OTLP-
// protobuf path — NOT twitter-mirror's Application-Insights-Breeze
// track-envelope translator, which targets a different, non-DCR ingestion API).
//
// OIDC_SIGNING_KEY is a classic Worker secret (`wrangler secret put`), NOT a
// Cloudflare Secrets Store binding — Secrets Store caps values at 1024 bytes
// (developers.cloudflare.com/secrets-store/manage-secrets/), and a PKCS#8
// RSA-2048 PEM is ~1.7KB, so it doesn't fit there in any encoding. Classic
// Worker secrets allow up to 5KB (developers.cloudflare.com/workers/platform/
// limits/, "Environment variables"), which does fit. See infra/cf/telemetry.md.

import { signAssertion } from "./oidc-sign";
import { encodeLogsChunks, encodeTraceChunks, type ChunkResult } from "./otlp-protobuf";

interface Env {
  TENANT_ID: string;
  APP_CLIENT_ID: string;
  // Azure Monitor native OTLP/DCR ingestion endpoints (one per signal). Each is a
  // full URL ending in /otlp/v1/{traces,logs} — see hub/wrangler.telemetry-gateway.jsonc.
  // Workers observability emits no metrics, so no OTLP_METRICS_ENDPOINT is wired.
  OTLP_TRACES_ENDPOINT: string;
  OTLP_LOGS_ENDPOINT: string;
  // Shared federation identity (see infra/cf/telemetry.md + infra/azure/provision.sh).
  // OIDC_SIGNING_KEY holds the RSA private key whose public half
  // sessions-oidc-issuer publishes — a plain Worker secret string (see the
  // file header comment for why this isn't a Secrets Store binding).
  OIDC_ISSUER_URL: string;
  OIDC_SIGNING_KID: string;
  OIDC_SIGNING_KEY: string;
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
    privateKeyPem: env.OIDC_SIGNING_KEY,
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
// HTTP 415), so we transcode per signal before forwarding. `chunk` maps the
// parsed OTLP JSON to a list of protobuf wire chunks, each under the DCR cap.
type OtlpChunker = (json: Record<string, unknown>, maxBytes: number) => ChunkResult;

// Azure Monitor's Logs Ingestion API caps a single POST at ~1 MB uncompressed —
// an oversized batch gets 413, and Cloudflare head-of-line retries the same batch
// forever, so a single 413 wedges the whole export (observed during the 6 GB
// backfill's access-log burst). We split each batch into chunks below this cap;
// 900 KB leaves comfortable margin under the ~1 MB ceiling.
const MAX_DCR_BYTES = 900_000;

// This worker has no observability.logs/traces destinations of its own (see
// hub/wrangler.telemetry-gateway.jsonc) and must not — it IS the /v1/{logs,traces}
// sink, so exporting its own logs back to itself would be a recursion loop. These
// console lines are visible via `wrangler tail`/the dashboard only; they never
// reach Azure/OTelLogs (see infra/azure/alerts/collector-errors.kql's header).
function logGatewayEvent(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: "collector.event", level: "error", ...fields }));
}

async function forwardOtlp(
  request: Request,
  env: Env,
  endpoint: string,
  chunk: OtlpChunker,
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

  const { chunks, dropped } = chunk(JSON.parse(jsonText) as Record<string, unknown>, MAX_DCR_BYTES);
  if (dropped > 0) {
    logGatewayEvent({ tag: "gateway-record-dropped", endpoint, dropped });
  }
  if (chunks.length === 0) {
    // Valid but empty batch — nothing to forward.
    return new Response(null, { status: 204 });
  }

  // We ALWAYS return success to Cloudflare once we've started dispatching, even if
  // individual chunk POSTs fail. CF head-of-line retries a failed batch forever, so
  // propagating a 413/5xx would re-wedge the entire pipeline; a rare dropped chunk
  // (logged for `wrangler tail`) beats a stalled export. Same philosophy as the
  // auth-mismatch 200 above.
  let token: string;
  try {
    token = await getEntraToken(env);
  } catch (e) {
    logGatewayEvent({ tag: "gateway-token-error", endpoint, error: String(e) });
    return new Response(null, { status: 204 });
  }

  for (let i = 0; i < chunks.length; i++) {
    try {
      const upstream = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-protobuf", Authorization: `Bearer ${token}` },
        body: chunks[i],
      });
      if (!upstream.ok) {
        const body = await upstream.text();
        logGatewayEvent({
          tag: "gateway-upstream-error",
          endpoint,
          status: upstream.status,
          chunk: `${i + 1}/${chunks.length}`,
          bytes: chunks[i]!.byteLength,
          body: body.slice(0, 500),
        });
      }
    } catch (e) {
      logGatewayEvent({
        tag: "gateway-upstream-exception",
        endpoint,
        chunk: `${i + 1}/${chunks.length}`,
        error: String(e),
      });
    }
  }

  return new Response(null, { status: 204 });
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
      if (path === "/v1/traces") return forwardOtlp(request, env, env.OTLP_TRACES_ENDPOINT, encodeTraceChunks);
      if (path === "/v1/logs") return forwardOtlp(request, env, env.OTLP_LOGS_ENDPOINT, encodeLogsChunks);
    }

    return new Response("OK", { status: 200 });
  },
};
