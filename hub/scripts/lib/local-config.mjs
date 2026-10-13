import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Keep local storage IDs stable across restarts, independently of production shard IDs.
export function localDatabaseBindings(baseConfig, hubRoot) {
  const main = baseConfig.d1_databases?.find((database) => database.binding === 'DB');
  if (!main?.database_id || !main.database_name) throw new Error('local config requires the main DB binding');
  return [
    {
      binding: 'DB',
      database_name: main.database_name,
      database_id: main.database_id,
      migrations_dir: path.join(hubRoot, 'migrations'),
    },
    ...Array.from({ length: 2 }, (_, shard) => ({
      binding: `IDX${String(shard).padStart(2, '0')}`,
      database_name: `sessions-index-local-${String(shard).padStart(2, '0')}`,
      database_id: `00000000-0000-4000-8000-${String(shard).padStart(12, '0')}`,
      migrations_dir: path.join(hubRoot, 'migrations-index'),
    })),
  ];
}

export function generatedLocalConfig({ baseConfig, hubRoot, revision }) {
  if (typeof revision !== 'string' || !revision) throw new Error('local config requires a deployment revision');
  // Only copy runtime settings: never inherit production routes, account selection,
  // named environments, or remote binding overrides into a generated local config.
  const config = {};
  for (const key of [
    'name', 'compatibility_date', 'compatibility_flags', 'limits', 'rules',
    'r2_buckets', 'kv_namespaces', 'ratelimits', 'durable_objects', 'exports', 'queues',
  ]) {
    if (baseConfig[key] !== undefined) config[key] = baseConfig[key];
  }
  return {
    ...config,
    main: path.resolve(hubRoot, baseConfig.main),
    workers_dev: false,
    preview_urls: false,
    routes: [],
    vars: {
      ...baseConfig.vars,
      ENVIRONMENT: 'development',
      INDEX_SHARD_COUNT: '2',
      INDEX_MODE: 'active',
      DEPLOYMENT_REVISION: revision,
    },
    d1_databases: localDatabaseBindings(baseConfig, hubRoot),
  };
}

export async function assertReusableLocalTopology({ stateDir, databases, hasLegacyBlocks }) {
  const reset = `npm --prefix hub run dev:reset -- --name ${path.basename(stateDir)}`;
  let diagnostics;
  try {
    diagnostics = JSON.parse(await readFile(path.join(stateDir, 'schema-diagnostics.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`local schema diagnostics are unreadable; stop and reset disposable state with: ${reset}`);
  }
  if (diagnostics) {
    const previous = diagnostics.databases;
    if (!Array.isArray(previous) || previous.length !== databases.length
        || databases.some((database, index) =>
          previous[index]?.databaseBinding !== database.binding
          || previous[index]?.databaseId !== database.database_id
          || previous[index]?.persistTo !== path.resolve(stateDir))) {
      throw new Error(`local state has a pre-sharding or mismatched database layout; no migrations applied. Stop and reset disposable state with: ${reset}`);
    }
    return;
  }
  // A startup interrupted before diagnostics were written can resume its journals.
  // But unidentified legacy block data must never be dropped by the fresh-only cutover.
  if (await hasLegacyBlocks()) {
    throw new Error(`local state contains legacy blocks without a verified shard layout; no migrations applied. Stop and reset disposable state with: ${reset}`);
  }
}

export async function writeLocalConfig({ stateDir, hubRoot, revision }) {
  const { experimental_readRawConfig } = await import('wrangler');
  const { rawConfig: baseConfig } = experimental_readRawConfig(
    { config: path.join(hubRoot, 'wrangler.jsonc') },
    { redirect: false },
  );
  const config = generatedLocalConfig({ baseConfig, hubRoot, revision });
  const configPath = path.join(stateDir, 'wrangler.local.json');
  await mkdir(stateDir, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { config, configPath };
}
