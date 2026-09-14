import type { Identity } from '../auth/identity';

// Collector configuration contract served to enrolled machines. The current collector does not
// fetch this endpoint, so hub overrides affect fleet/control-plane clients only; they cannot retune
// deployed agents. `schema_version` lets a future collector ignore keys it does not understand.
// Defaults live here; an operator overrides any subset by writing a JSON object to
// meta['collector_config'] (via POST /api/v1/admin/machines' sibling admin path or wrangler d1),
// which is shallow-merged on top of these.
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
  // Store catalog for fleet and control-plane clients. The collector does not consult these
  // booleans when building filesystem roots: ADDITIVE_DEFAULT_STORES ('omp', 'omp-skills') are
  // re-added to persisted configs, WEBCAPTURE_STORES are setdefault-ed, and other roots come from
  // the machine's local `stores` map. These keys MUST still be actual store names. Source of truth:
  // collector/src/agent_collector/config.py — DEFAULT_STORES + WEBCAPTURE_STORES. Note the local
  // Claude Code store key is 'claude' (the harness dir ~/.claude), NOT 'claude-code'.
  // fleet-endpoints.test.ts asserts this catalog is a subset of those sets.
  store_toggles: {
    claude: true,
    codex: true,
    'chatgpt-web': true,
    'claude-web': true,
    'export-inbox': true,
    omp: true,
    'omp-skills': true,
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
      // or centrally overwrite machine-specific roots. Store enablement is not currently collector-enforced;
      // store_toggles is an informational catalog for fleet/control-plane clients. Roots remain local-only.
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
