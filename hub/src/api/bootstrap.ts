import type { Identity } from '../auth/identity';

// Centrally-managed collector config served to every enrolled machine at startup. The
// collector merges this OVER its local config, so the hub can retune scan cadence, caps,
// and per-store toggles fleet-wide without redeploying agents. Kept minimal and versioned:
// `schema_version` lets an older collector ignore keys it doesn't understand rather than
// choke on them. Defaults live here; an operator overrides any subset by writing a JSON
// object to meta['collector_config'] (via POST /api/v1/admin/machines' sibling admin path
// or wrangler d1), which is shallow-merged on top of these.
export const COLLECTOR_CONFIG_SCHEMA_VERSION = 1;

export const DEFAULT_COLLECTOR_CONFIG = {
  schema_version: COLLECTOR_CONFIG_SCHEMA_VERSION,
  scan_interval_seconds: 900, // filesystem rescan cadence (15m)
  heartbeat_interval_seconds: 900,
  // Hard cap the collector honors per single-file upload. 100 MiB is Cloudflare's request
  // body ceiling on this plan; files above it route through the multipart path (m7-upload).
  max_upload_bytes: 100 * 1024 * 1024,
  // Per-store capture toggles. Absent store => collector uses its own default (on).
  stores: {
    'claude-code': true,
    codex: true,
    'chatgpt-web': true,
    'claude-web': true,
    'export-inbox': true,
  },
  redact_env: true,
} as const;

/** GET /api/v1/bootstrap — any enrolled machine. Returns the merged collector config. */
export async function bootstrap(env: Env, identity: Identity): Promise<Response> {
  if (identity.kind !== 'machine') return Response.json({ error: 'unauthorized' }, { status: 401 });

  const override = await env.DB.prepare("SELECT value FROM meta WHERE key = 'collector_config'").first<{
    value: string;
  }>();

  let merged: Record<string, unknown> = { ...DEFAULT_COLLECTOR_CONFIG };
  if (override?.value) {
    try {
      const parsed = JSON.parse(override.value) as Record<string, unknown>;
      // Shallow merge: operator override wins per top-level key, but schema_version is fixed
      // by the code that defined this payload's shape — an override can't forge a version the
      // hub isn't actually serving, or collectors would mis-parse a config they can't read.
      merged = { ...merged, ...parsed, schema_version: COLLECTOR_CONFIG_SCHEMA_VERSION };
    } catch {
      // A malformed override must not take down bootstrap for the whole fleet — fall back to
      // defaults and self-log for `wrangler tail`.
      console.log(JSON.stringify({ event: 'hub.bootstrap.bad_override', machine: identity.machineId }));
    }
  }

  return Response.json(merged);
}
