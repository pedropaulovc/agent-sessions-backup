#!/usr/bin/env node
/**
 * Provision the credentials the CI `preview` job needs, and inject them into the repository.
 *
 *   node infra/cf/preview-token.mjs          # report what is configured and what is missing
 *   node infra/cf/preview-token.mjs --set    # provision and push everything
 *
 * Three values, all at REPOSITORY scope, because the preview job declares a dynamic
 * `preview/pr-<n>` environment and a dynamic environment cannot carry secrets:
 *
 *   secret   CLOUDFLARE_PPE_API_TOKEN     account-owned, non-production-only, 90-day
 *   secret   PREVIEW_BEARER_SEED          the standing seed every preview bearer derives from
 *   variable CLOUDFLARE_PPE_ACCOUNT_ID    the non-production account, pinned in preview-trust.mjs
 *
 * Wrangler's own OAuth is short-lived (it carries expires_in/refresh_token), so it is used here
 * to authenticate the operator and prove account membership — never as the CI credential itself.
 * The long-lived API token is minted through the account token API when that OAuth grant is
 * allowed to, and otherwise pasted in from the dashboard with the exact recipe printed below.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PREVIEW_ACCOUNT_ID,
  PRODUCTION_ACCOUNT_ID,
  fail,
  previewBearerToken,
} from './preview-trust.mjs';
import { previewSeedPath, readPreviewSeed } from '../../hub/scripts/preview-open.mjs';

const TOKEN_SECRET = 'CLOUDFLARE_PPE_API_TOKEN';
const SEED_SECRET = 'PREVIEW_BEARER_SEED';
const ACCOUNT_VARIABLE = 'CLOUDFLARE_PPE_ACCOUNT_ID';

const WRANGLER_PROFILE = 'preview';
const WRANGLER_USERNAME = 'pedro@vezza.com.br';
const WORKERS_DEV_SUBDOMAIN = 'sessions-ppe';
const PREVIEW_ACCOUNT_NAME = 'sessions-ppe-vza-net';
const TOKEN_NAME = 'agent-sessions-preview-control';
const TOKEN_DAYS = 90;
const MAX_ACCOUNT_PAGES = 20;

/**
 * Exactly what the preview job does with the token, and nothing else. Wrangler's OAuth scopes
 * (used only to authenticate the operator) and the API token's permission groups (what CI
 * actually holds) are different vocabularies for the same list — both are spelled out so a
 * silent widening is visible in review.
 */
const WRANGLER_SCOPES = [
  'account:read',
  'user:read',
  'workers:write',
  'workers_scripts:write',
  'workers_kv:write',
  'd1:write',
  'queues:write',
];

const TOKEN_PERMISSION_GROUPS = [
  'Workers Scripts Write',
  'Workers KV Storage Write',
  'D1 Write',
  'Workers R2 Storage Write',
  'Queues Write',
  'Account Settings Read',
];

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function log(message) {
  process.stdout.write(`${message}\n`);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    input: options.input,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' },
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

function runOrFail(command, commandArgs, message, options = {}) {
  const result = run(command, commandArgs, options);
  if (result.status !== 0) fail(`${message}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

async function cloudflare(token, pathname) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    redirect: 'error',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok && body.success !== false, status: response.status, body };
}

async function cloudflarePost(token, pathname, payload) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok && body.success !== false, status: response.status, body };
}

function printIdentity() {
  log('');
  log('  Cloudflare identity to sign in as : ' + WRANGLER_USERNAME);
  log(`  Cloudflare account to select      : ${PREVIEW_ACCOUNT_NAME}`);
  log(`                                      ID ${PREVIEW_ACCOUNT_ID}`);
  log(`                                      workers.dev subdomain ${WORKERS_DEV_SUBDOMAIN}`);
  log('  The ID is what this script checks — an account can be renamed, so if the picker');
  log('  shows a different name, match on the ID.');
  log('  Wrangler has no account/username flags — pick both in the OAuth browser flow.');
  log('  If the account picker offers the production account, you signed in as the wrong');
  log(`  identity: ${WRANGLER_USERNAME} must have no production membership at all.`);
  log('');
  log('  Wrangler OAuth scopes:');
  for (const scope of WRANGLER_SCOPES) log(`    ${scope}`);
  log('');
}

/**
 * The exact dashboard recipe. Cloudflare gates the token APIs behind API Tokens Write, and
 * Wrangler's OAuth grant has no scope that carries it — verified: both
 * /accounts/<id>/tokens/permission_groups and /user/tokens/permission_groups answer an OAuth
 * token with 403 code 9109. Minting a token needs a token, so this one step is unavoidably
 * by hand; everything after it is automated.
 */
function printDashboardRecipe() {
  log('');
  log('  This is the one step that cannot be automated: creating an API token requires an');
  log('  existing token with API Tokens Write, which Wrangler OAuth cannot grant.');
  log('');
  log(`    1. Sign in to https://dash.cloudflare.com as ${WRANGLER_USERNAME}`);
  log(`    2. Open https://dash.cloudflare.com/${PREVIEW_ACCOUNT_ID}/api-tokens`);
  log('    3. Create Token -> Create Custom Token');
  log(`    4. Name: ${TOKEN_NAME}`);
  log('    5. Permissions (all Account-scoped):');
  for (const group of TOKEN_PERMISSION_GROUPS) log(`         Account | ${group}`);
  log(`    6. Account Resources: Include | this account only (${PREVIEW_ACCOUNT_ID})`);
  log('    7. Client IP Filtering: none.  TTL: 90 days.');
  log('    8. Save the value to a file, then:');
  log('');
  log('         node infra/cf/preview-token.mjs --set --token-file /path/to/token');
  log('');
}

/**
 * A stored profile can be dead while still looking perfectly well-formed on disk: Cloudflare
 * revokes an entire OAuth grant family when a rotated refresh token is replayed, which takes the
 * access token with it. Prove the token still works rather than handing a revoked one to the
 * membership check, where it surfaces as a baffling 403.
 */
async function wranglerOauthToken() {
  const probe = run('npx', ['--prefix', 'hub', 'wrangler', 'auth', 'token', '--profile', WRANGLER_PROFILE, '--json']);
  if (probe.status === 0) {
    const auth = JSON.parse(probe.stdout);
    if (auth?.type === 'oauth' && auth.token) {
      if ((await cloudflare(auth.token, '/accounts?per_page=1')).ok) return auth.token;
      log(`Wrangler profile "${WRANGLER_PROFILE}" is no longer accepted by Cloudflare — re-authorizing.`);
    }
  }
  log(`No usable Wrangler OAuth profile "${WRANGLER_PROFILE}" — opening the browser flow.`);
  printIdentity();
  const created = spawnSync('npx', [
    '--prefix', 'hub', 'wrangler', 'auth', 'create', WRANGLER_PROFILE,
    '--browser', '--scopes', ...WRANGLER_SCOPES,
  ], { cwd: REPOSITORY_ROOT, stdio: 'inherit' });
  if (created.status !== 0) fail('Wrangler OAuth authorization failed');
  const auth = JSON.parse(runOrFail(
    'npx',
    ['--prefix', 'hub', 'wrangler', 'auth', 'token', '--profile', WRANGLER_PROFILE, '--json'],
    'Wrangler did not return a token after authorization',
  ));
  if (auth?.type !== 'oauth' || !auth.token) fail('Wrangler returned no OAuth token');
  return auth.token;
}

/**
 * The authorization boundary is account membership, not an email string in repository code:
 * whatever identity signed in must be able to see the preview account and must NOT be able to
 * see production. A token that can reach both accounts is disqualified here, not in CI.
 */
async function listAllAccounts(token, label) {
  const rows = [];
  for (let page = 1; page <= MAX_ACCOUNT_PAGES; page += 1) {
    const accounts = await cloudflare(token, `/accounts?per_page=50&page=${page}`);
    if (!accounts.ok) fail(`${label} could not list its accounts (HTTP ${accounts.status})`);
    const batch = Array.isArray(accounts.body.result) ? accounts.body.result : [];
    rows.push(...batch);
    const total = accounts.body.result_info?.total_count;
    if (batch.length === 0) return rows;
    if (typeof total === 'number' && rows.length >= total) return rows;
  }
  // A refusal gate that silently stops reading is a gate that can be walked around.
  fail(`${label} has more than ${MAX_ACCOUNT_PAGES * 50} accounts — refusing to judge a partial list`);
  return rows;
}

async function assertNonProductionMembership(token, label) {
  const rows = await listAllAccounts(token, label);
  const production = rows.find((row) => row.id === PRODUCTION_ACCOUNT_ID);
  if (production) fail(`${label} can reach the PRODUCTION account (${production.name}) — refusing`);
  const preview = rows.find((row) => row.id === PREVIEW_ACCOUNT_ID);
  if (!preview) fail(`${label} cannot reach the non-production account ${PREVIEW_ACCOUNT_ID}`);
  log(`  ${label}: account "${preview.name}" (${preview.id}), ${rows.length} membership(s), no production.`);
  return preview;
}

function cloudflareErrors(response) {
  const errors = response.body?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return `HTTP ${response.status}`;
  return errors.map((error) => `${error.code}: ${error.message}`).join('; ');
}

async function mintAccountToken(oauthToken) {
  const groups = await cloudflare(oauthToken, `/accounts/${PREVIEW_ACCOUNT_ID}/tokens/permission_groups?per_page=500`);
  if (!groups.ok) {
    log(`  Cannot list token permission groups (${cloudflareErrors(groups)}).`);
    return null;
  }
  const byName = new Map((groups.body.result ?? []).map((group) => [group.name, group]));
  const selected = TOKEN_PERMISSION_GROUPS.map((name) => {
    const group = byName.get(name);
    if (!group) fail(`Cloudflare has no account permission group named "${name}"`);
    return { id: group.id, name: group.name };
  });
  const expiresOn = new Date(Date.now() + TOKEN_DAYS * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');
  const created = await cloudflarePost(oauthToken, `/accounts/${PREVIEW_ACCOUNT_ID}/tokens`, {
    name: TOKEN_NAME,
    policies: [{
      effect: 'allow',
      resources: { [`com.cloudflare.api.account.${PREVIEW_ACCOUNT_ID}`]: '*' },
      permission_groups: selected,
    }],
    expires_on: expiresOn,
  });
  if (!created.ok) {
    log(`  Cannot create the account token (${cloudflareErrors(created)}).`);
    return null;
  }
  const value = created.body.result?.value;
  if (typeof value !== 'string' || value.length === 0) return null;
  log(`  Minted account token ${TOKEN_NAME}, expires ${expiresOn}.`);
  return value;
}

async function verifyApiToken(token) {
  // An account-owned token verifies under its owning account; a user-owned one under /user.
  // The mint path above produces the former, a dashboard-pasted token may be either, so try
  // the account endpoint first and only fall back rather than failing a freshly minted token.
  let verified = await cloudflare(token, `/accounts/${PREVIEW_ACCOUNT_ID}/tokens/verify`);
  if (!verified.ok) verified = await cloudflare(token, '/user/tokens/verify');
  if (!verified.ok) fail(`the API token did not verify (HTTP ${verified.status})`);
  if (verified.body.result?.status !== 'active') {
    fail(`the API token is ${verified.body.result?.status ?? 'in an unknown state'}`);
  }
  await assertNonProductionMembership(token, 'API token');
}

function ghSecretNames() {
  const rows = runOrFail('gh', ['secret', 'list', '--json', 'name'], 'gh secret list failed');
  return new Set(JSON.parse(rows).map((row) => row.name));
}

function ghVariableNames() {
  const rows = runOrFail('gh', ['variable', 'list', '--json', 'name'], 'gh variable list failed');
  return new Set(JSON.parse(rows).map((row) => row.name));
}

function requireSeed(seedFile) {
  // readPreviewSeed already covers $PREVIEW_BEARER_SEED, the Linux-side file, and the Windows
  // copy under /mnt (and throws when profiles disagree), so every consumer of the seed — this
  // script, preview:open, preview-upload-session — resolves it identically.
  const seed = seedFile
    ? readFileSync(path.resolve(seedFile), 'utf8').trim()
    : readPreviewSeed();
  if (!seed || seed.length < 32) {
    fail(`no preview bearer seed of at least 32 characters (looked at ${previewSeedPath()}, `
      + '$PREVIEW_BEARER_SEED, the Windows-side copy under /mnt, and --seed-file). It must be '
      + 'the SAME seed the owner\'s machines hold: a new one invalidates every open preview URL.');
  }
  // Prove the seed derives a well-formed bearer before it becomes a repository secret.
  previewBearerToken(seed, 1);
  return seed;
}

function report() {
  const secrets = ghSecretNames();
  const variables = ghVariableNames();
  const missing = [];
  for (const [kind, name, present] of [
    ['secret', TOKEN_SECRET, secrets.has(TOKEN_SECRET)],
    ['secret', SEED_SECRET, secrets.has(SEED_SECRET)],
    ['variable', ACCOUNT_VARIABLE, variables.has(ACCOUNT_VARIABLE)],
  ]) {
    log(`  ${present ? 'set    ' : 'MISSING'}  repository ${kind} ${name}`);
    if (!present) missing.push(name);
  }
  if (missing.length === 0) {
    log('\nThe preview job has everything it needs.');
    return;
  }
  log('\nRun: node infra/cf/preview-token.mjs --set');
  process.exitCode = 1;
}

async function provision(options) {
  log(`Provisioning preview credentials for the CI preview job.`);
  printIdentity();

  // Derived before anything is installed: a bad seed should stop the run, not leave half a
  // credential set behind.
  const seed = requireSeed(options.seedFile);

  let token = options.tokenFile
    ? readFileSync(path.resolve(options.tokenFile), 'utf8').trim()
    : null;
  if (!token) {
    const oauthToken = await wranglerOauthToken();
    await assertNonProductionMembership(oauthToken, 'Wrangler OAuth');
    token = await mintAccountToken(oauthToken);
  }
  if (token) await verifyApiToken(token);

  // The seed and the account ID never depended on the token, so install them either way: when
  // the token has to be made by hand, that hand step should be the only thing left, not the
  // trigger for redoing the other two.
  runOrFail('gh', ['secret', 'set', SEED_SECRET], `failed to set ${SEED_SECRET}`, { input: seed });
  runOrFail(
    'gh',
    ['variable', 'set', ACCOUNT_VARIABLE, '--body', PREVIEW_ACCOUNT_ID],
    `failed to set ${ACCOUNT_VARIABLE}`,
  );
  if (token) {
    runOrFail('gh', ['secret', 'set', TOKEN_SECRET], `failed to set ${TOKEN_SECRET}`, { input: token });
  }

  log('');
  report();
  if (!token) printDashboardRecipe();
}

function parse(argv) {
  const options = { set: false, tokenFile: null, seedFile: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--set') options.set = true;
    else if (flag === '--token-file') options.tokenFile = argv[index += 1];
    else if (flag === '--seed-file') options.seedFile = argv[index += 1];
    else fail(`unknown argument: ${flag}\n\nusage: preview-token.mjs [--set] [--token-file FILE] [--seed-file FILE]`);
  }
  if (options.tokenFile === undefined || options.seedFile === undefined) fail('expected a path after --token-file/--seed-file');
  return options;
}

const options = parse(process.argv.slice(2));
if (options.set) await provision(options);
else report();
