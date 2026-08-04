#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadAndValidateManifest,
  migrationManifestAtRef,
  validateManifestShape,
} from './lib/migration-manifest.mjs';
import { runMigrations } from './lib/migration-runner.mjs';

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

async function trustedBaseManifest(options) {
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
    return migrationManifestAtRef({ ref: baseRef, repositoryRoot });
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
    const base = await trustedBaseManifest(options);
    const result = await loadAndValidateManifest({
      migrationsDir,
      manifestPath,
      trustedBaseManifest: base,
    });
    process.stdout.write(`${JSON.stringify({ migrationDigest: result.digest, immutableThrough: base.migrations.at(-1).sequence })}\n`);
    return;
  }
  if (command === 'check') {
    const base = await trustedBaseManifest(options);
    const result = await loadAndValidateManifest({
      migrationsDir,
      manifestPath,
      trustedBaseManifest: base,
    });
    process.stdout.write(`${JSON.stringify({ migrationDigest: result.digest })}\n`);
    return;
  }
  if (command !== 'apply') throw new Error('usage: migrations.mjs <check|check-base|apply> [--name value ...]');
  let releaseManifest;
  let releasePublicKey;
  if (options['release-manifest']) releaseManifest = JSON.parse(await readFile(resolveOption(options['release-manifest']), 'utf8'));
  if (options['release-public-key']) releasePublicKey = await readFile(resolveOption(options['release-public-key']), 'utf8');
  let baselinePublicKey;
  if (options['baseline-public-key']) baselinePublicKey = await readFile(resolveOption(options['baseline-public-key']), 'utf8');
  const result = await runMigrations({
    target: options.target,
    config: resolveOption(options.config),
    database: options.database ?? 'DB',
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
    baselinePath: resolveOption(options.baseline),
    baselinePublicKey,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
