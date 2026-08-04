#!/usr/bin/env node
import { generateKeyPairSync, sign } from 'node:crypto';
import { chmod, mkdir, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalJson,
  loadAndValidateManifest,
  migrationManifestAtRef,
  sha256,
  validateHistoricalBaseline,
} from './lib/migration-manifest.mjs';
import { measureRemoteSchemaDigest } from './lib/migration-runner.mjs';

const hubRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(hubRoot, '..');
const DIGEST = /^[0-9a-f]{64}$/;

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!name?.startsWith('--') || value == null || value.startsWith('--')) {
      throw new Error(`expected --name value, found ${name ?? '<none>'}`);
    }
    options[name.slice(2)] = value;
  }
  return { command, options };
}

function required(options, name) {
  const value = options[name];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`--${name} is required`);
  return value;
}

function resolveOption(value) {
  return path.resolve(value);
}

async function writeNewFile(filePath, bytes, mode) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const handle = await open(filePath, 'wx', mode);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  await chmod(filePath, mode);
}

async function assertExternalBaseArtifact(baseManifestPath) {
  const [artifact, repository] = await Promise.all([
    realpath(baseManifestPath),
    realpath(repositoryRoot),
  ]);
  const relative = path.relative(repository, artifact);
  if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new Error('--base-manifest must be an externally trusted artifact outside the active worktree');
  }
}

async function trustedAnchors(options) {
  const migrationsDir = resolveOption(options['migrations-dir'] ?? path.join(hubRoot, 'migrations'));
  const manifestPath = resolveOption(options.manifest ?? path.join(migrationsDir, 'manifest.json'));
  const baseManifestOption = options['base-manifest'];
  const baseRef = options['base-ref'];
  if (baseManifestOption && baseRef) {
    throw new Error('--base-manifest and --base-ref are mutually exclusive');
  }
  if (!baseManifestOption && !baseRef) {
    throw new Error('production baseline approval requires an externally trusted --base-manifest or protected --base-ref');
  }
  let baseManifestPath;
  let trustedBaseManifest;
  if (baseManifestOption) {
    baseManifestPath = resolveOption(baseManifestOption);
    await assertExternalBaseArtifact(baseManifestPath);
  } else {
    if (!/^[0-9a-f]{40}$/.test(baseRef)) {
      throw new Error('--base-ref must be a full protected commit SHA');
    }
    trustedBaseManifest = migrationManifestAtRef({ ref: baseRef, repositoryRoot });
  }
  const historyPath = resolveOption(options.history ?? path.join(migrationsDir, 'historical-baseline.json'));
  const { manifest, digest: migrationDigest } = await loadAndValidateManifest({
    migrationsDir,
    manifestPath,
    baseManifestPath,
    trustedBaseManifest,
  });
  const history = JSON.parse(await readFile(historyPath, 'utf8'));
  validateHistoricalBaseline(history, manifest);
  return {
    migrationDigest,
    historicalBaselineDigest: sha256(`${canonicalJson(history)}\n`),
    throughSequence: manifest.ledgerStartsAt - 1,
  };
}

async function measure(options) {
  const outputPath = resolveOption(required(options, 'output'));
  const config = resolveOption(required(options, 'config'));
  const anchors = await trustedAnchors(options);
  const schemaDigest = await measureRemoteSchemaDigest({
    target: 'production',
    config,
    database: options.database ?? 'sessions-index',
  });
  const measurement = {
    formatVersion: 1,
    kind: 'production-schema-measurement',
    ...anchors,
    schemaDigest,
    measuredAt: new Date().toISOString(),
  };
  await writeNewFile(outputPath, `${JSON.stringify(measurement, null, 2)}\n`, 0o600);
  process.stdout.write(`${JSON.stringify({ measurement: outputPath, schemaDigest })}\n`);
}

async function approve(options) {
  const measurementPath = resolveOption(required(options, 'measurement'));
  const privateKeyPath = resolveOption(required(options, 'private-key'));
  const publicKeyPath = resolveOption(required(options, 'public-key'));
  const envelopePath = resolveOption(required(options, 'envelope'));
  const approvedBy = required(options, 'approved-by').trim();
  const reason = required(options, 'reason').trim();
  if (reason.length < 10) throw new Error('--reason must record a meaningful human approval rationale');

  const anchors = await trustedAnchors(options);
  const measurement = JSON.parse(await readFile(measurementPath, 'utf8'));
  if (measurement?.formatVersion !== 1
      || measurement.kind !== 'production-schema-measurement'
      || measurement.migrationDigest !== anchors.migrationDigest
      || measurement.historicalBaselineDigest !== anchors.historicalBaselineDigest
      || measurement.throughSequence !== anchors.throughSequence
      || !DIGEST.test(measurement.schemaDigest ?? '')
      || typeof measurement.measuredAt !== 'string'
      || !Number.isFinite(Date.parse(measurement.measuredAt))) {
    throw new Error('measurement does not match the current trusted migration and historical baseline artifacts');
  }

  const payload = {
    kind: 'production-schema-baseline',
    approved: true,
    throughSequence: anchors.throughSequence,
    migrationDigest: anchors.migrationDigest,
    historicalBaselineDigest: anchors.historicalBaselineDigest,
    schemaDigest: measurement.schemaDigest,
    measuredAt: measurement.measuredAt,
    approvedBy,
    approvedAt: new Date().toISOString(),
    reason,
  };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const envelope = {
    formatVersion: 1,
    payload,
    signature: sign(null, Buffer.from(`${canonicalJson(payload)}\n`), privateKey).toString('base64'),
  };

  await writeNewFile(privateKeyPath, privatePem, 0o600);
  await writeNewFile(publicKeyPath, publicPem, 0o644);
  await writeNewFile(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`, 0o644);
  process.stdout.write(`${JSON.stringify({ publicKey: publicKeyPath, envelope: envelopePath })}\n`);
}

const { command, options } = parseArguments(process.argv.slice(2));
const action = command === 'measure' ? measure : command === 'approve' ? approve : null;
if (!action) {
  throw new Error('usage: approve-production-baseline.mjs <measure|approve> --name value ...');
}
await action(options);
