import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  PREVIEW_ACCOUNT_ID, previewWranglerEnvironment, wranglerWorkerBundle,
} from '../../infra/cf/preview-trust.mjs';
import { indexControlClient } from '../../infra/cf/index-control.mjs';
import { verifyD1BatchAtomicity } from '../../infra/cf/d1-batch-atomicity.mjs';
import { initializeShardLayouts } from './lib/index-migration.mjs';
import { runMigrations } from './lib/migration-runner.mjs';
import { fixtureModelPriceSql } from './lib/dev-seed.mjs';

const hubRoot = path.resolve(import.meta.dirname, '..');
const wrangler = path.join(hubRoot, 'node_modules/wrangler/bin/wrangler.js');

function run(script, args, env) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: hubRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`standing preview command failed (${result.status}): ${result.stderr || result.stdout}`);
  return result;
}

async function main() {
  const token = process.env.CLOUDFLARE_PPE_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('standing preview requires an explicit non-production Cloudflare API token; no local auth profile is used');
  if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_ACCOUNT_ID !== PREVIEW_ACCOUNT_ID) {
    throw new Error('standing preview refuses a production or mismatched account');
  }
  const env = previewWranglerEnvironment(process.env, token, PREVIEW_ACCOUNT_ID);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sessions-standing-preview-'));
  try {
    const configPath = path.join(temporary, 'preview.json');
    run(path.resolve(hubRoot, '../infra/cf/index-control.mjs'), [
      'provision', '--target', 'preview', '--config', path.join(hubRoot, 'wrangler.jsonc'), '--output', configPath,
    ], env);
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const api = indexControlClient(PREVIEW_ACCOUNT_ID, token);
    const source = api.db(config.d1_databases[0].database_id);
    const tables = await source.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'blocks'");
    if (tables.length && (await source.query('SELECT id FROM blocks LIMIT 1')).length) {
      throw new Error('standing preview metadata target has legacy blocks; refusing destructive migration (use the fresh named metadata database)');
    }
    const outdir = path.join(temporary, 'bundle');
    await mkdir(outdir);
    run(wrangler, ['deploy', '--dry-run', '--config', configPath, '--outdir', outdir], env);
    const bundle = await wranglerWorkerBundle(outdir);
    const artifactDigest = createHash('sha256').update(await readFile(bundle)).digest('hex');
    config.main = bundle;
    config.no_bundle = true;
    config.vars.DEPLOYMENT_REVISION = process.env.GITHUB_SHA ?? `standing-preview:${artifactDigest}`;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    // The static preview moved to a new empty metadata DB; the old DB and R2 archive
    // remain untouched. Subsequent runs migrate these same three database identities.
    const runProcess = async (args) => run(wrangler, args, env);
    for (const binding of config.d1_databases) {
      const directory = binding.migrations_dir;
      await runMigrations({
        target: 'preview', config: configPath, database: binding.binding,
        databaseId: binding.database_id, migrationsDir: directory,
        manifestPath: path.join(directory, 'manifest.json'),
        baseManifestPath: path.join(directory, 'source-baseline.json'),
        ...(binding.binding === 'DB' ? { historyPath: path.join(directory, 'historical-baseline.json') } : {}),
        journalPath: path.join(temporary, `${binding.binding}.journal.json`), artifactDigest,
        deploymentId: `standing-preview:${artifactDigest}:${binding.binding}`, runProcess,
      });
    }
    const shards = config.d1_databases.slice(1).map((binding) => api.db(binding.database_id));
    await initializeShardLayouts(shards);
    const atomicity = await verifyD1BatchAtomicity(shards[0]);
    await source.query(fixtureModelPriceSql());
    run(path.resolve(hubRoot, '../infra/cf/provision-queues.mjs'), ['--target', 'preview'], env);
    run(wrangler, ['deploy', '--config', configPath, '--env='], env);
    console.log(JSON.stringify({ target: 'standing-preview', databaseCount: 3, artifactDigest,
      deploymentRevision: config.vars.DEPLOYMENT_REVISION, atomicity }));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
