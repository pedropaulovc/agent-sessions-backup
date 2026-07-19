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
  // Threshold at/above which the collector routes a file through the multipart path instead of a
  // single PUT. Cloudflare's request-body cap is 100 *decimal* MB (100_000_000, not 104_857_600),
  // so a `100 * 1024 * 1024` value would still 413 files in the 100.0–104.9 MB band. Set to
  // 90_000_000 to match m7-upload's collector default (multipart_threshold_mb = 90), leaving margin
  // under the decimal cap. Keep this number in lockstep with that collector constant — one source
  // of truth; when the collector's is exported into the shared config, reference it here.
  max_upload_bytes: 90_000_000,
  // Per-store capture toggles. This MUST NOT be named `stores`: Config.stores is the collector's map
  // of store name -> filesystem root, and bootstrap is merged over that local config. Absent toggle =>
  // collector uses its own default (on). These keys MUST be the collector's actual store names, or a
  // fleet override silently no-ops. Source of truth:
  // collector/src/agent_collector/config.py — DEFAULT_STORES ('claude', 'codex') + WEBCAPTURE_STORES
  // ('chatgpt-web', 'claude-web', 'export-inbox'). Note the local Claude Code store key is 'claude'
  // (the harness dir ~/.claude), NOT 'claude-code'. fleet-endpoints.test.ts asserts this ⊆ that set.
  store_toggles: {
    claude: true,
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
      // `stores` is reserved for the collector's local name -> filesystem-root map. Never echo a stale
      // or mistaken hub override under that key: merging it over Config would replace paths with booleans
      // (or centrally overwrite machine-specific roots) before the collector can scan. Store enablement
      // belongs under store_toggles; roots remain local-only.
      const safeOverride = { ...parsed };
      delete safeOverride.stores;
      merged = { ...merged, ...safeOverride, schema_version: COLLECTOR_CONFIG_SCHEMA_VERSION };
    } catch {
      // A malformed override must not take down bootstrap for the whole fleet — fall back to
      // defaults and self-log for `wrangler tail`.
      console.log(JSON.stringify({ event: 'hub.bootstrap.bad_override', machine: identity.machineId }));
    }
  }

  return Response.json(merged);
}
