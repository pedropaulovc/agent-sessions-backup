#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadAndValidateManifest,
  migrationManifestAtRef,
  validateManifestShape,
} from './lib/migration-manifest.mjs';
import { inspectMigrations, migrationFailureDiagnostic, runMigrations, writeMigrationInspection } from './lib/migration-runner.mjs';

const hubRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(hubRoot, '..');

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index];
    if (!name.startsWith('--') || index + 1 >= rest.length || rest[index + 1].startsWith('--')) {
      throw new Error(`expected --name value, found ${name}`);
    }
    options[name.slice(2)] = rest[index + 1];
    index += 1;
  }
  return { command, options };
}

function resolveOption(value) {
  return value ? path.resolve(value) : undefined;
}

async function trustedBaseManifest(options, migrationsDir) {
  const suppliedBase = resolveOption(options['base-manifest']);
  if (suppliedBase && options['base-ref']) {
    throw new Error('--base-manifest and --base-ref are mutually exclusive');
  }
  if (suppliedBase) {
    return validateManifestShape(JSON.parse(await readFile(suppliedBase, 'utf8')));
  }
  const baseRef = options['base-ref'] ?? await githubBaseSha();
  if (baseRef) {
    if (!/^[0-9a-f]{40}$/.test(baseRef)) {
      throw new Error('--base-ref must be a full protected commit SHA');
    }
    const migrationsPath = path.relative(repositoryRoot, migrationsDir).split(path.sep).join('/');
    if (migrationsPath === '..' || migrationsPath.startsWith('../') || path.isAbsolute(migrationsPath)) {
      throw new Error('--base-ref requires a migrations directory inside the repository');
    }
    // A new shard namespace has no deployed history to preserve. Prove its absence
    // at the protected base before accepting the initial all-ledger schema policy.
    // An unreadable ref or an existing-but-invalid tree is never an empty history.
    if (migrationsPath === 'hub/migrations-index') {
      const gitOptions = { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true };
      const treeArgs = ['ls-tree', '-r', '--name-only', baseRef, '--', migrationsPath];
      let tree = spawnSync('git', treeArgs, gitOptions);
      if (tree.error) throw new Error(`cannot execute git: ${tree.error.message}`);
      if (tree.status !== 0) {
        const fetched = spawnSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', baseRef], gitOptions);
        if (fetched.error || fetched.status !== 0) {
          throw new Error(`cannot fetch migration base ${baseRef}: ${fetched.error?.message ?? fetched.stderr}`);
        }
        tree = spawnSync('git', treeArgs, gitOptions);
      }
      if (tree.error || tree.status !== 0) {
        throw new Error(`cannot read migration base ${baseRef}: ${tree.error?.message ?? tree.stderr}`);
      }
      if (!tree.stdout.trim()) {
        const initial = validateManifestShape(JSON.parse(await readFile(path.join(migrationsDir, 'source-baseline.json'), 'utf8')));
        if (initial.ledgerStartsAt !== 1 || initial.reservedSequences?.length !== 0
            || initial.migrations.length !== 1 || initial.migrations[0].sequence !== 1) {
          throw new Error('a new shard migration tree requires an initial 0001 baseline with ledgerStartsAt=1 and no reserved sequences');
        }
        return initial;
      }
    }
    return migrationManifestAtRef({ ref: baseRef, repositoryRoot, migrationsPath });
  }
  throw new Error('migration manifest validation requires independent policy evidence from --base-manifest or a protected base ref');
}

async function githubBaseSha() {
  if (!process.env.GITHUB_EVENT_PATH) return undefined;
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  return event.pull_request?.base?.sha;
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  const migrationsDir = resolveOption(options['migrations-dir']) ?? path.join(hubRoot, 'migrations');
  const manifestPath = resolveOption(options.manifest) ?? path.join(migrationsDir, 'manifest.json');
  if (command === 'check-base') {
    const base = await trustedBaseManifest(options, migrationsDir);
    const result = await loadAndValidateManifest({
      migrationsDir,
      manifestPath,
      trustedBaseManifest: base,
    });
    process.stdout.write(`${JSON.stringify({ migrationDigest: result.digest, immutableThrough: base.migrations.at(-1).sequence })}\n`);
    return;
  }
  if (command === 'check') {
    const base = await trustedBaseManifest(options, migrationsDir);
    const result = await loadAndValidateManifest({
      migrationsDir,
      manifestPath,
      trustedBaseManifest: base,
    });
    process.stdout.write(`${JSON.stringify({ migrationDigest: result.digest })}\n`);
    return;
  }
  if (command === 'inspect') {
    const snapshot = await inspectMigrations({
      target: options.target,
      config: resolveOption(options.config),
      database: options.database ?? 'DB',
      databaseId: options['database-id'],
      persistTo: resolveOption(options['persist-to']),
      migrationsDir,
      manifestPath,
      baseManifestPath: resolveOption(options['base-manifest']),
      historyPath: resolveOption(options.history),
    });
    process.stdout.write(`${JSON.stringify(snapshot)}\n`);
    if (options.output) await writeMigrationInspection(resolveOption(options.output), snapshot);
    if (snapshot.status !== 'complete') process.exitCode = 1;
    return;
  }
  if (command !== 'apply') throw new Error('usage: migrations.mjs <check|check-base|inspect|apply> [--name value ...]');
  let releaseManifest;
  let releasePublicKey;
  if (options['release-manifest']) releaseManifest = JSON.parse(await readFile(resolveOption(options['release-manifest']), 'utf8'));
  if (options['release-public-key']) releasePublicKey = await readFile(resolveOption(options['release-public-key']), 'utf8');
  const result = await runMigrations({
    target: options.target,
    config: resolveOption(options.config),
    database: options.database ?? 'DB',
    databaseId: options['database-id'],
    persistTo: resolveOption(options['persist-to']),
    journalPath: resolveOption(options.journal),
    artifactDigest: options['artifact-digest'],
    deploymentId: options['deployment-id'],
    migrationsDir,
    manifestPath,
    baseManifestPath: resolveOption(options['base-manifest']),
    historyPath: resolveOption(options.history),
    releaseManifest,
    releasePublicKey,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: 'migration command failed', ...migrationFailureDiagnostic(error) })}\n`);
  process.exitCode = 1;
});
