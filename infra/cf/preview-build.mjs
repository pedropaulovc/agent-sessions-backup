import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  assertContainedRegularFile,
  assertTrustedWorkflowRef,
  fail,
  fileRecord,
  generatedBuildConfig,
  migrationArtifactSqlNames,
  headSha,
  parseArgs,
  positiveInteger,
  repositoryName,
  resourceNames,
  resolveBundlerInputPath,
  sha256Bytes,
  stableJson,
  wranglerWorkerBundle,
  writeCanonicalJson,
} from './preview-trust.mjs';

const args = parseArgs(process.argv.slice(2), new Set([
  'source',
  'trusted-root',
  'out',
  'repository',
  'pr',
  'head-sha',
  'source-run-id',
  'build-run-id',
  'run-attempt',
  'workflow-ref',
]));

const sourceRoot = path.resolve(args.source ?? '');
const trustedRoot = path.resolve(args['trusted-root'] ?? '');
const out = path.resolve(args.out ?? '');
const repository = repositoryName(args.repository);
const pr = positiveInteger(args.pr, 'PR number');
const sha = headSha(args['head-sha']);
const sourceRunId = positiveInteger(args['source-run-id'], 'source workflow run ID');
const buildRunId = positiveInteger(args['build-run-id'], 'build workflow run ID');
const runAttempt = positiveInteger(args['run-attempt'], 'run attempt');
const workflowRef = assertTrustedWorkflowRef(repository, args['workflow-ref']);

const sourceHub = path.join(sourceRoot, 'hub');
const trustedHub = path.join(trustedRoot, 'hub');
await assertContainedRegularFile(sourceRoot, path.join(sourceHub, 'package-lock.json'), 'source lockfile');
await assertContainedRegularFile(sourceRoot, path.join(sourceHub, 'src', 'preview.ts'), 'preview entrypoint');
await assertContainedRegularFile(trustedRoot, path.join(trustedHub, 'package-lock.json'), 'trusted lockfile');
const wranglerBin = await assertContainedRegularFile(
  trustedRoot,
  path.join(trustedHub, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
  'trusted Wrangler',
);

await mkdir(out, { recursive: false });
const payload = path.join(out, 'payload');
const migrationsOut = path.join(payload, 'migrations');
await mkdir(migrationsOut, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), 'sessions-preview-build-'));

try {
  const names = resourceNames(pr);
  const buildConfig = generatedBuildConfig({
    main: path.join(sourceHub, 'src', 'preview.ts'),
    workerName: names.app,
  });
  const configPath = path.join(temporary, 'wrangler.preview-build.json');
  const metafilePath = path.join(temporary, 'esbuild-meta.json');
  const wranglerOutput = path.join(temporary, 'wrangler-output');
  await writeCanonicalJson(configPath, buildConfig);

  const childEnvironment = {};
  for (const key of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'TEMP', 'TMP', 'CI']) {
    if (process.env[key]) childEnvironment[key] = process.env[key];
  }
  childEnvironment.WRANGLER_LOG = 'error';
  childEnvironment.NODE_ENV = 'production';

  const result = spawnSync(process.execPath, [
    wranglerBin,
    'deploy',
    '--dry-run',
    '--config',
    configPath,
    '--outdir',
    wranglerOutput,
    '--metafile',
    metafilePath,
  ], {
    cwd: sourceHub,
    env: childEnvironment,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10 * 60 * 1000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().slice(-8000);
    fail(`trusted Wrangler build failed with exit ${result.status}:\n${detail}`);
  }

  const bundledWorker = await wranglerWorkerBundle(wranglerOutput);
  const workerPath = path.join(payload, 'worker.mjs');
  await copyFile(bundledWorker, workerPath, fsConstants.COPYFILE_EXCL);

  const worker = await fileRecord(workerPath, 'payload/worker.mjs');
  if (worker.size > 20 * 1024 * 1024) fail('Worker bundle exceeds the size limit');

  const migrationDir = path.join(sourceHub, 'migrations');
  const migrationNames = (await readdir(migrationDir)).sort();
  const migrationSqlNames = migrationArtifactSqlNames(migrationNames);
  const sourceMigrationManifest = JSON.parse(await readFile(path.join(migrationDir, 'manifest.json'), 'utf8'));
  if (sourceMigrationManifest.formatVersion !== 1
    || sourceMigrationManifest.hashEncoding !== 'sha256-canonical-lf'
    || !Array.isArray(sourceMigrationManifest.migrations)
    || !Array.isArray(sourceMigrationManifest.reservedSequences)
    || !Number.isSafeInteger(sourceMigrationManifest.ledgerStartsAt)) {
    fail('source migration manifest has an unsupported shape');
  }
  const migrations = [];
  const numericPrefixes = new Set();
  const declaredByName = new Map(sourceMigrationManifest.migrations.map((item) => [item.filename, item]));
  for (const name of migrationSqlNames) {
    const prefix = name.slice(0, 4);
    if (numericPrefixes.has(prefix)) fail(`duplicate migration numeric prefix: ${prefix}`);
    numericPrefixes.add(prefix);
    const source = path.join(migrationDir, name);
    await assertContainedRegularFile(sourceRoot, source, `migration ${name}`);
    const bytes = await readFile(source);
    if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024) fail(`migration has an invalid size: ${name}`);
    const text = bytes.toString('utf8').replaceAll('\r\n', '\n');
    if (text.includes('\r')) fail(`migration contains a bare carriage return: ${name}`);
    const declared = declaredByName.get(name);
    if (!declared || declared.sequence !== Number(prefix) || declared.sha256 !== sha256Bytes(text)) {
      fail(`migration bytes do not match manifest: ${name}`);
    }
    await copyFile(source, path.join(migrationsOut, name), fsConstants.COPYFILE_EXCL);
    migrations.push(await fileRecord(path.join(migrationsOut, name), `payload/migrations/${name}`));
  }
  if (declaredByName.size !== migrations.length) fail('migration manifest does not exactly enumerate SQL files');
  await copyFile(path.join(migrationDir, 'manifest.json'), path.join(migrationsOut, 'manifest.json'), fsConstants.COPYFILE_EXCL);
  const migrationManifestFile = await fileRecord(path.join(migrationsOut, 'manifest.json'), 'payload/migrations/manifest.json');

  const metadata = JSON.parse(await readFile(metafilePath, 'utf8'));
  if (!metadata.inputs || typeof metadata.inputs !== 'object') fail('Wrangler did not produce an input metafile');
  const buildInputs = [];
  for (const input of Object.keys(metadata.inputs).sort()) {
    if (input.startsWith('<')) continue;
    const file = resolveBundlerInputPath(path.dirname(configPath), input);
    await assertContainedRegularFile(sourceHub, file, `bundler input ${input}`);
    buildInputs.push(await fileRecord(file, path.relative(sourceHub, file)));
  }
  buildInputs.push(await fileRecord(path.join(sourceHub, 'package-lock.json'), 'package-lock.json'));
  buildInputs.sort((left, right) => left.path.localeCompare(right.path));
  const inputPaths = new Set();
  for (const record of buildInputs) {
    if (inputPaths.has(record.path)) fail(`duplicate build input: ${record.path}`);
    inputPaths.add(record.path);
  }

  const migrationDigest = sha256Bytes(`${stableJson({
    formatVersion: sourceMigrationManifest.formatVersion,
    hashEncoding: sourceMigrationManifest.hashEncoding,
    reservedSequences: sourceMigrationManifest.reservedSequences,
    ledgerStartsAt: sourceMigrationManifest.ledgerStartsAt,
    migrations: sourceMigrationManifest.migrations,
  })}\n`);
  const migrationManifest = {
    schema: 'sessions-preview-migrations/v1',
    migrations,
    migrationManifest: migrationManifestFile,
    migrationDigest,
  };
  const buildManifest = {
    schema: 'sessions-preview-build/v1',
    entrypoint: 'payload/worker.mjs',
    headSha: sha,
    inputDigest: sha256Bytes(stableJson(buildInputs)),
    inputs: buildInputs,
    output: worker,
  };
  const content = [worker, migrationManifestFile, ...migrations].sort((left, right) => left.path.localeCompare(right.path));
  const contentManifest = {
    schema: 'sessions-preview-content/v1',
    files: content,
  };
  const artifactDigest = sha256Bytes(stableJson(contentManifest));

  const trustedFiles = [
    'hub/package-lock.json',
    'infra/cf/preview-build.mjs',
    'infra/cf/preview-trust.mjs',
  ];
  const toolchainInputs = [];
  for (const relative of trustedFiles) {
    const file = path.join(trustedRoot, relative);
    await assertContainedRegularFile(trustedRoot, file, `trusted toolchain input ${relative}`);
    toolchainInputs.push(await fileRecord(file, relative));
  }
  const wranglerPackage = JSON.parse(await readFile(path.join(trustedHub, 'node_modules', 'wrangler', 'package.json'), 'utf8'));
  if (wranglerPackage.version !== '4.111.0') fail(`trusted Wrangler version drift: ${wranglerPackage.version}`);

  const provenance = {
    schema: 'sessions-preview-provenance/v1',
    repository,
    pr,
    headSha: sha,
    sourceWorkflowRunId: sourceRunId,
    buildWorkflowRunId: buildRunId,
    runAttempt,
    trustedWorkflowRef: workflowRef,
    artifactDigest,
    buildInputDigest: buildManifest.inputDigest,
    migrationDigest: migrationManifest.migrationDigest,
    toolchain: {
      node: process.version,
      wrangler: wranglerPackage.version,
      digest: sha256Bytes(stableJson(toolchainInputs)),
      inputs: toolchainInputs,
    },
  };

  await writeCanonicalJson(path.join(out, 'build-manifest.json'), buildManifest);
  await writeCanonicalJson(path.join(out, 'migration-manifest.json'), migrationManifest);
  await writeCanonicalJson(path.join(out, 'content-manifest.json'), contentManifest);
  await writeCanonicalJson(path.join(out, 'provenance.json'), provenance);
  process.stdout.write(`${stableJson({ artifactDigest, buildInputDigest: buildManifest.inputDigest, migrationDigest: migrationManifest.migrationDigest })}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
