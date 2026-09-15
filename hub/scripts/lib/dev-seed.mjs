import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HUB_ROOT } from './dev-paths.mjs';
import { seedManifest, sha256 } from './dev-manifests.mjs';

const FIXTURE_DIR = join(HUB_ROOT, 'test', 'fixtures', 'local');
const PRIMARY = join(FIXTURE_DIR, 'e2e-synthetic-session.jsonl');
const PAGER = join(FIXTURE_DIR, 'e2e-pager-session.jsonl');
const EXTERNAL_BASE64 = join(FIXTURE_DIR, 'fixture-external.png.base64');
const SKILL = join(FIXTURE_DIR, 'e2e-managed-skill.md');
const MACHINE = 'e2e-machine';
const STORE = 'claude-projects';
const PRIMARY_SESSION_ID = '00000000-0000-4000-8000-000000000001';
const PAGER_SESSION_ID = '00000000-0000-4000-8000-000000000002';
const PRIMARY_RELPATH = `-workspace-e2e-fixtures/${PRIMARY_SESSION_ID}.jsonl`;
const PAGER_RELPATH = `-workspace-e2e-fixtures/${PAGER_SESSION_ID}.jsonl`;
const EXTERNAL_DIGEST = '431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460';
const EXTERNAL_RELPATH = `${PRIMARY_RELPATH}.assets/${EXTERNAL_DIGEST}/fixture-external.png`;
const SKILL_STORE = 'omp-skills';
const SKILL_NAME = 'e2e-managed-skill';
const SKILL_RELPATH = `${SKILL_NAME}/SKILL.md`;

// The cost fan-out fixture: one OMP main session plus three subagent sidecars, each on a
// different model. It exists because a viewer that shows money must be provable with money on
// screen — with only the Claude Code fixtures above, every preview rendered `cost unknown`, which
// exercises exactly one of the three cost states.
//
// OMP subagent identity comes from the PATH, not from the file contents: `detect()` matches the
// `<date>_<sessionId>` main-file stem, so a sidecar under the same-named DIRECTORY becomes
// `omp:<parent>:<relative path>` with `parent_session_id` set. The fixtures also carry
// `parentSession` in their header, as real OMP sidecars do.
const COST_PARENT_SESSION_ID = '00000000-0000-4000-8000-000000000003';
const COST_STORE = 'omp';
const COST_PARENT_STEM = `-workspace-e2e-fixtures/2026-07-02_${COST_PARENT_SESSION_ID}`;
const COST_PARENT_RELPATH = `${COST_PARENT_STEM}.jsonl`;
const COST_PARENT_FILE = 'e2e-cost-parent-session.jsonl';
// One descriptor list for both seeding paths: the local one resolves `file` inside FIXTURE_DIR,
// the preview one against the same directory in the checkout, and both derive the session id and
// the indexing probe from these fields rather than restating them.
//
// `kind` is what the indexing probe needs: search hides subagent sessions unless `subagent=yes`
// is passed (see session-filters.ts), so probing a sidecar without it waits forever on a session
// that indexed seconds ago.
const COST_FIXTURES = Object.freeze([
  {
    file: COST_PARENT_FILE,
    relpath: COST_PARENT_RELPATH,
    sessionId: COST_PARENT_SESSION_ID,
    kind: 'main',
    model: 'claude-sonnet-4-5-20250929',
    marker: 'cerulean abacus',
  },
  // These two report cache reads INSIDE the input count (`subset` accounting), while the parent's
  // Claude model reports them beside it — one fixture, both hit-rate denominators.
  {
    file: 'e2e-cost-scout-subagent.jsonl',
    relpath: `${COST_PARENT_STEM}/scout-alpha.jsonl`,
    sessionId: `omp:${COST_PARENT_SESSION_ID}:scout-alpha.jsonl`,
    kind: 'subagent',
    model: 'gpt-5-mini',
    marker: 'Subagent alpha',
  },
  {
    file: 'e2e-cost-review-subagent.jsonl',
    relpath: `${COST_PARENT_STEM}/review-beta.jsonl`,
    sessionId: `omp:${COST_PARENT_SESSION_ID}:review-beta.jsonl`,
    kind: 'subagent',
    model: 'gemini-2.5-pro',
    marker: 'Subagent beta',
  },
  // No price row exists for this model, which is the point: the parent's rolled-up figure has to
  // render as a `subtotal`, never as a total that silently drops an unpriced call.
  {
    file: 'e2e-cost-unpriced-subagent.jsonl',
    relpath: `${COST_PARENT_STEM}/tally-gamma.jsonl`,
    sessionId: `omp:${COST_PARENT_SESSION_ID}:tally-gamma.jsonl`,
    kind: 'subagent',
    model: 'local-fixture-unpriced-model',
    marker: 'Subagent gamma',
  },
]);

/** Deterministic `model_prices` rows for the cost fixture's models.
 *
 * Disposable environments have no price catalog: the real one is synced daily from LiteLLM by a
 * cron the local dev worker and the per-PR previews do not run, so `usage.usd` stays NULL and
 * every cost renders unknown. These rows are fixture data, marked `source = 'fixture'` so they
 * are distinguishable from a real snapshot, and are inserted into local and preview D1 only —
 * never by a migration, which would reach production.
 *
 * The rates are the real published rates for these models as of 2026-07, in the table's unit —
 * DOLLARS PER MILLION TOKENS, which is what `pricing.ts` divides by `MILLION`. Getting that unit
 * wrong is silent: the fixture still prices, just at a millionth of the real cost.
 *
 * The `cache_accounting` values are the real ones too: Anthropic reports cache reads BESIDE the
 * input count (`disjoint`), OpenAI and Google report them INSIDE it (`subset`). That distinction
 * is the denominator of the detail panel's cache hit rate, so a fixture that got it wrong would
 * prove nothing about the column.
 */
export const FIXTURE_MODEL_PRICES = Object.freeze([
  {
    model: 'claude-sonnet-4-5-20250929',
    provider: 'anthropic',
    input_cost: 3,
    output_cost: 15,
    cache_read_cost: 0.3,
    cache_write_5m_cost: 3.75,
    cache_write_1h_cost: 6,
    cache_accounting: 'disjoint',
  },
  {
    model: 'gpt-5-mini',
    provider: 'openai',
    input_cost: 0.25,
    output_cost: 2,
    cache_read_cost: 0.025,
    cache_write_5m_cost: null,
    cache_write_1h_cost: null,
    cache_accounting: 'subset',
  },
  {
    model: 'gemini-2.5-pro',
    provider: 'google',
    input_cost: 1.25,
    output_cost: 10,
    cache_read_cost: 0.31,
    cache_write_5m_cost: null,
    cache_write_1h_cost: null,
    cache_accounting: 'subset',
  },
]);

/** `FIXTURE_MODEL_PRICES` as one SQL statement, for whichever D1 the caller can reach.
 *
 * Literals rather than bound parameters: the local path speaks to `wrangler d1 execute --command`
 * and the preview path to the D1 HTTP API, and only the numbers and a fixed model list vary, all
 * of them defined in this file. `INSERT OR REPLACE` keeps re-provisioning a persistent preview
 * database idempotent, and an `effective_from` far in the past makes the row apply to every
 * fixture turn regardless of its timestamp.
 */
export function fixtureModelPriceSql() {
  const values = FIXTURE_MODEL_PRICES.map((price) => [
    `'${price.model}'`,
    `'1970-01-01T00:00:00.000Z'`,
    `'fixture/${price.model}'`,
    `'${price.provider}'`,
    price.input_cost,
    price.output_cost,
    price.cache_read_cost,
    price.cache_write_5m_cost ?? 'NULL',
    price.cache_write_1h_cost ?? 'NULL',
    `'${price.cache_accounting}'`,
    `'fixture'`,
    `'2026-07-02T00:00:00.000Z'`,
  ].join(', '));
  return 'INSERT OR REPLACE INTO model_prices (model, effective_from, litellm_key, provider, '
    + 'input_cost, output_cost, cache_read_cost, cache_write_5m_cost, cache_write_1h_cost, '
    + `cache_accounting, source, fetched_at) VALUES ${values.map((row) => `(${row})`).join(', ')};`;
}

export const SYNTHETIC_EXPECTATIONS = Object.freeze({
  machine: MACHINE,
  store: STORE,
  primarySessionId: PRIMARY_SESSION_ID,
  primaryTitle: 'Find the deterministic saffron telescope browser fixture.',
  pagerSessionId: PAGER_SESSION_ID,
  primaryRelpath: PRIMARY_RELPATH,
  pagerTitle: 'This second deterministic session verifies machine-filtered pagination.',
  pagerRelpath: PAGER_RELPATH,
  pagerSearchPhrase: 'machine-filtered',
  searchPhrase: 'saffron telescope',
  externalDigest: EXTERNAL_DIGEST,
  externalFileName: 'fixture-external.png',
  externalRelpath: EXTERNAL_RELPATH,
  skillName: SKILL_NAME,
  skillStore: SKILL_STORE,
  skillRelpath: SKILL_RELPATH,
  skillSourceMarker: 'deterministic indigo compass skill marker',
  costStore: COST_STORE,
  costParentSessionId: COST_PARENT_SESSION_ID,
  costParentTitle: 'Cost fixture: cerulean abacus fan-out',
  costSearchPhrase: 'cerulean abacus',
  costParentModel: COST_FIXTURES[0].model,
  costUnpricedModel: 'local-fixture-unpriced-model',
  // Both figures are arithmetic on the fixture's token counts and FIXTURE_MODEL_PRICES, so the
  // browser suite asserting them catches a pricing or rollup regression, not just a rendered
  // string: $1.23 of Claude turns here, plus $0.215 and $0.706 of subagents, with the fourth
  // subagent unpriced — which is why the rolled-up figure is a `subtotal`.
  costSubtreeLabel: '$2.15 subtotal',
  costParentOwnLabel: '$1.23',
  // Every cost fixture file with the relpath it uploads to, the session id it becomes and the
  // phrase that proves it indexed. Both seeding paths iterate this, and the browser suite reads
  // the ids and models from it, so the fan-out's shape is declared exactly once.
  costFixtures: COST_FIXTURES,
  costSubagentSessionIds: COST_FIXTURES.slice(1).map((fixture) => fixture.sessionId),
});

export async function syntheticSeedManifest() {
  return seedManifest([
    PRIMARY, PAGER, EXTERNAL_BASE64, SKILL,
    ...COST_FIXTURES.map((fixture) => join(FIXTURE_DIR, fixture.file)),
  ]);
}

async function upload(baseUrl, store, relpath, bytes) {
  const contentHash = sha256(bytes);
  const response = await fetch(`${baseUrl}/api/v1/files/${MACHINE}/${store}/${encodeURIComponent(relpath)}`, {
    method: 'PUT',
    headers: {
      'x-dev-machine': MACHINE,
      'x-content-hash': `sha256:${contentHash}`,
      'x-file-mtime': '2026-07-01T00:00:00.000Z',
      'content-length': String(bytes.length),
    },
    body: bytes,
  });
  const text = await response.text();
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`synthetic upload ${relpath} failed (${response.status}): ${text.slice(0, 500)}`);
  }
}

async function waitForIndexed(baseUrl, sessionId, marker, deadline, kind = 'main') {
  // Search hides subagent sessions unless asked for them, so a sidecar has to be probed with the
  // same filter the viewer would use to see it.
  const query = new URLSearchParams({ q: marker, machine: MACHINE, limit: '20' });
  if (kind === 'subagent') query.set('subagent', 'yes');
  let last = 'not probed';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/search?${query}`, {
        headers: { 'x-dev-machine': MACHINE },
      });
      last = `${response.status} ${await response.text()}`;
      if (response.ok) {
        const body = JSON.parse(last.slice(last.indexOf(' ') + 1));
        if (Array.isArray(body.hits) && body.hits.some((hit) => hit.session_id === sessionId)) return;
      }
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`synthetic session ${sessionId} was not indexed before timeout; last probe: ${last.slice(0, 500)}`);
}

export async function seedSynthetic(baseUrl, timeoutMs = 30_000, expectedDigest) {
  const liveManifest = await syntheticSeedManifest();
  if (expectedDigest && liveManifest.digest !== expectedDigest) {
    throw new Error('synthetic fixtures changed after the environment manifest was recorded');
  }
  const [primary, pager, assetText, skill] = await Promise.all([
    readFile(PRIMARY),
    readFile(PAGER),
    readFile(EXTERNAL_BASE64, 'utf8'),
    readFile(SKILL),
  ]);
  const asset = Buffer.from(assetText.trim(), 'base64');
  if (sha256(asset) !== EXTERNAL_DIGEST) throw new Error('synthetic external asset digest does not match its fixture contract');

  await upload(baseUrl, STORE, EXTERNAL_RELPATH, asset);
  await upload(baseUrl, STORE, PRIMARY_RELPATH, primary);
  await upload(baseUrl, STORE, PAGER_RELPATH, pager);
  await upload(baseUrl, SKILL_STORE, SKILL_RELPATH, skill);
  // The parent goes up before its sidecars so a subagent row never briefly points at a missing
  // parent, which is also the order the collector produces them in.
  for (const fixture of COST_FIXTURES) {
    await upload(baseUrl, COST_STORE, fixture.relpath, await readFile(join(FIXTURE_DIR, fixture.file)));
  }
  // One budget PER session, not one shared across all of them. Indexing is queue-driven, so the
  // sessions finish in upload order and a shared window is spent by the time the last few are
  // probed — which is how the cost fan-out first "failed" to index despite being fully parsed.
  const probe = (sessionId, marker, kind) => waitForIndexed(baseUrl, sessionId, marker, Date.now() + timeoutMs, kind);
  await probe(PRIMARY_SESSION_ID, 'saffron telescope');
  await probe(PAGER_SESSION_ID, 'stable second page');
  for (const fixture of COST_FIXTURES) await probe(fixture.sessionId, fixture.marker, fixture.kind);
  return SYNTHETIC_EXPECTATIONS;
}
