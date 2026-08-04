#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertImmutableBase,
  canonicalMigrationBytes,
  loadAndValidateManifest,
  sha256,
  validateManifestShape,
} from './lib/migration-manifest.mjs';
import { runMigrations } from './lib/migration-runner.mjs';

const hubRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

function git(args) {
  const result = spawnSync('git', args, {
    cwd: hubRoot,
    encoding: null,
    windowsHide: true,
  });
  if (result.error) throw new Error(`cannot execute git: ${result.error.message}`);
  return result;
}

async function githubBaseSha() {
  if (!process.env.GITHUB_EVENT_PATH) return undefined;
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  return event.pull_request?.base?.sha;
}

function jsonAtRef(ref, repositoryPath) {
  const result = git(['show', `${ref}:${repositoryPath}`]);
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout.toString('utf8'));
  } catch (error) {
    throw new Error(`cannot parse ${repositoryPath} from migration base ${ref}: ${error.message}`);
  }
}

function baseManifestAtRef(ref) {
  let manifest = jsonAtRef(ref, 'hub/migrations/manifest.json');
  if (manifest) return validateManifestShape(manifest);
  let tree = git(['ls-tree', '-r', '--name-only', ref, '--', 'hub/migrations']);
  if (tree.status !== 0) {
    const fetched = git(['fetch', '--no-tags', '--depth=1', 'origin', ref]);
    if (fetched.status !== 0) throw new Error(`cannot fetch migration base ${ref}: ${fetched.stderr.toString('utf8')}`);
    manifest = jsonAtRef(ref, 'hub/migrations/manifest.json');
    if (manifest) return validateManifestShape(manifest);
    tree = git(['ls-tree', '-r', '--name-only', ref, '--', 'hub/migrations']);
  }
  if (tree.status !== 0) throw new Error(`cannot read migration base ${ref}: ${tree.stderr.toString('utf8')}`);
  const policyEvidence = jsonAtRef(ref, 'hub/migrations/source-baseline.json');
  if (!policyEvidence) {
    throw new Error(`migration base ${ref} has no manifest or independent migration policy evidence`);
  }
  const policy = validateManifestShape(policyEvidence);
  const filenames = tree.stdout.toString('utf8').split(/\r?\n/)
    .filter((name) => /^hub\/migrations\/\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => path.basename(name));
  const migrations = filenames.map((filename) => {
    const blob = git(['show', `${ref}:hub/migrations/${filename}`]);
    if (blob.status !== 0) throw new Error(`cannot read ${filename} from migration base ${ref}`);
    return {
      sequence: Number(filename.slice(0, 4)),
      filename,
      sha256: sha256(canonicalMigrationBytes(blob.stdout)),
    };
  });
  return validateManifestShape({
    formatVersion: policy.formatVersion,
    hashEncoding: policy.hashEncoding,
    reservedSequences: policy.reservedSequences,
    ledgerStartsAt: policy.ledgerStartsAt,
    migrations,
  });
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  const migrationsDir = resolveOption(options['migrations-dir']) ?? path.join(hubRoot, 'migrations');
  const manifestPath = resolveOption(options.manifest) ?? path.join(migrationsDir, 'manifest.json');
  if (command === 'check-base') {
    const suppliedBase = resolveOption(options['base-manifest'] ?? process.env.MIGRATION_BASE_MANIFEST);
    const baseRef = options['base-ref'] ?? process.env.MIGRATION_BASE_REF ?? await githubBaseSha();
    const base = suppliedBase
      ? validateManifestShape(JSON.parse(await readFile(suppliedBase, 'utf8')))
      : baseRef
        ? baseManifestAtRef(baseRef)
        : validateManifestShape(JSON.parse(await readFile(path.join(migrationsDir, 'source-baseline.json'), 'utf8')));
    const result = await loadAndValidateManifest({
      migrationsDir,
      manifestPath,
      trustedBaseManifest: base,
    });
    process.stdout.write(`${JSON.stringify({ migrationDigest: result.digest, immutableThrough: base.migrations.at(-1).sequence })}\n`);
    return;
  }
  if (command === 'check') {
    const baseManifestPath = resolveOption(options['base-manifest'] ?? process.env.MIGRATION_BASE_MANIFEST);
    const result = await loadAndValidateManifest({ migrationsDir, manifestPath, baseManifestPath });
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
