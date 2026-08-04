#!/usr/bin/env node
import { createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { once } from 'node:events';
import { migrationDeploymentIdentity, resolveMigrationDigest, runMigrations } from './lib/migration-runner.mjs';
import { HUB_ROOT, DEV_ROOT, assertSafeExistingStatePath, localStatePath, resolveStatePath } from './lib/dev-paths.mjs';
import { buildReproducibly } from './lib/dev-manifests.mjs';
import {
  acquireOwnership,
  createEnvironmentNonce,
  recordRuntime,
  releaseOwnership,
  removeOwnedState,
} from './lib/dev-ownership.mjs';
import { createProcessTracker, retryPortSelection, runCaptured, spawnOwned, terminateProcessTree } from './lib/dev-process.mjs';
import { seedSynthetic, syntheticSeedManifest } from './lib/dev-seed.mjs';

const HELP = `Usage: node scripts/environment.mjs <command> [options]

Commands:
  local                 Start a reusable, loopback-only local environment
  e2e                   Start a fresh loopback-only environment and remove it on exit
  reset                 Safely remove a stopped local environment under .dev

Local options:
  --name <name>         State name under .dev/local (default: default)
  --persist-to <path>   Explicit path exactly matching hub/.dev/local/<name>
  --port <port>         Loopback port (default: 8787)
  --readiness-ms <ms>   Readiness/indexing timeout (default: 30000)

E2E options:
  --port <port>         Loopback port; 0 or omitted selects a fresh port
  --readiness-ms <ms>   Readiness/indexing timeout (default: 30000)

Reset options:
  --name <name>         State name under .dev/local (default: default)
  --persist-to <path>   Explicit path exactly matching hub/.dev/local/<name>

Environment:
  DEV_DIAGNOSTICS_DIR   E2E teardown destination for wrangler.log,
                        environment-manifest.json, and schema-diagnostics.json

Synthetic fixtures are always the default. Private corpus upload is available only via
npm run session:seed-corpus -- --acknowledge-private-data.
`;

function parseArguments(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) return { help: true };
  const command = argv[0];
  if (!['local', 'e2e', 'reset'].includes(command)) throw new Error(`unknown command: ${command}`);
  const values = { command, name: 'default', port: command === 'local' ? 8787 : 0, readinessMs: 30_000 };
  const allowed = command === 'reset'
    ? new Set(['--name', '--persist-to'])
    : command === 'local'
      ? new Set(['--name', '--persist-to', '--port', '--readiness-ms'])
      : new Set(['--port', '--readiness-ms']);
  const seen = new Set();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!allowed.has(flag)) throw new Error(`unknown option for ${command}: ${flag}`);
    if (seen.has(flag)) throw new Error(`duplicate option: ${flag}`);
    seen.add(flag);
    if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new Error(`missing value for ${flag}`);
    const value = argv[index + 1];
    if (flag === '--name') {
      values.name = value;
      values.nameExplicit = true;
    }
    if (flag === '--persist-to') values.persistTo = value;
    if (flag === '--port') values.port = Number(value);
    if (flag === '--readiness-ms') values.readinessMs = Number(value);
  }
  if (values.nameExplicit && values.persistTo) throw new Error('--name and --persist-to are mutually exclusive');
  if (!Number.isInteger(values.readinessMs) || values.readinessMs < 1000 || values.readinessMs > 300_000) {
    throw new Error('--readiness-ms must be an integer from 1000 through 300000');
  }
  return values;
}

async function assertNoSecretFiles() {
  const entries = await readdir(HUB_ROOT, { withFileTypes: true });
  const unsafe = entries.filter((entry) => entry.name === '.dev.vars' || entry.name.startsWith('.dev.vars.') || entry.name === '.env' || entry.name.startsWith('.env.'));
  if (unsafe.length) throw new Error(`local orchestration refuses secret-bearing files: ${unsafe.map((entry) => entry.name).sort().join(', ')}`);
}

function safeChildEnvironment() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(CLOUDFLARE_|CF_API|WRANGLER_|SETUP_TOKEN$|ASSET_SIGNING_SECRET$|PRODUCTION_)/i.test(key)) continue;
    env[key] = value;
  }
  env.WRANGLER_SEND_METRICS = 'false';
  env.ENVIRONMENT = 'development';
  return env;
}

function wranglerPath() {
  return join(HUB_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
}

async function checkPrerequisites() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(major) || major < 20) throw new Error(`Node 20 or newer is required; found ${process.version}`);
  try {
    const info = await lstat(wranglerPath());
    if (!info.isFile()) throw new Error('not a file');
  } catch (error) {
    throw new Error(`pinned Wrangler is unavailable; run npm ci in ${HUB_ROOT} (${error.message})`);
  }
  await assertNoSecretFiles();
}

async function waitForReadiness(baseUrl, expected, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = 'not probed';
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Wrangler exited before readiness (${child.exitCode ?? child.signalCode})`);
    try {
      const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1000) });
      const text = await response.text();
      last = `${response.status} ${text}`;
      if (response.ok) {
        const body = JSON.parse(text);
        const mismatch = Object.entries(expected).find(([key, value]) => body[key] !== value);
        if (!mismatch) return body;
        last = `diagnostic mismatch for ${mismatch[0]}: expected ${mismatch[1]}, received ${body[mismatch[0]]}`;
      }
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  throw new Error(`Wrangler readiness timed out after ${timeoutMs}ms; last probe: ${last}`);
}

async function copyDiagnostics(stateDir) {
  if (!process.env.DEV_DIAGNOSTICS_DIR) return;
  const target = resolve(process.cwd(), process.env.DEV_DIAGNOSTICS_DIR);
  await mkdir(target, { recursive: true });
  for (const name of ['wrangler.log', 'environment-manifest.json', 'schema-diagnostics.json']) {
    try {
      await copyFile(join(stateDir, name), join(target, name));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

async function resetEnvironment(options) {
  const stateDir = await localStatePath(options.name, options.persistTo);
  console.log(`State directory: ${stateDir}`);
  await assertSafeExistingStatePath(stateDir);
  try {
    await lstat(stateDir);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      console.log('Environment is already reset.');
      return;
    }
    throw error;
  }
  const nonce = createEnvironmentNonce();
  const owner = await acquireOwnership(stateDir, nonce);
  await removeOwnedState(stateDir, owner);
  console.log('Environment reset.');
}

async function startEnvironment(options) {
  const mode = options.command;
  await checkPrerequisites();
  let stateDir;
  if (mode === 'local') {
    stateDir = await localStatePath(options.name, options.persistTo);
    await mkdir(stateDir, { recursive: true });
  } else {
    await mkdir(resolve(DEV_ROOT, 'e2e'), { recursive: true });
    stateDir = await mkdtemp(resolve(DEV_ROOT, 'e2e', 'run-'));
    stateDir = await resolveStatePath(stateDir);
  }
  const stateName = mode === 'local' ? basename(stateDir) : 'fresh';

  const nonce = createEnvironmentNonce();
  const owner = await acquireOwnership(stateDir, nonce);
  const tracker = createProcessTracker();
  let child;
  let log;
  let signalExitCode;
  let shutdownRequested = false;
  const requestShutdown = (signal) => {
    shutdownRequested = true;
    if (signal) signalExitCode = signal === 'SIGINT' ? 130 : 143;
    void tracker.terminateAll(signal ?? 'SIGTERM').catch((error) => console.error(error.message));
  };
  const onSignal = (signal) => requestShutdown(signal);
  const onMessage = (message) => {
    if (mode === 'e2e' && message?.type === 'shutdown') requestShutdown();
  };
  const onDisconnect = () => {
    if (mode === 'e2e') requestShutdown();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('message', onMessage);
  process.on('disconnect', onDisconnect);

  try {
    const childEnv = safeChildEnvironment();
    const seed = await syntheticSeedManifest();
    let build;
    try {
      build = await buildReproducibly({
        stateDir,
        wranglerPath: wranglerPath(),
        childEnv,
        tracker,
        shouldAbort: () => shutdownRequested,
      });
    } catch (error) {
      if (!shutdownRequested) throw error;
      if (signalExitCode) process.exitCode = signalExitCode;
      return;
    }
    if (shutdownRequested) {
      if (signalExitCode) process.exitCode = signalExitCode;
      return;
    }
    const expectedMigrationDigest = await resolveMigrationDigest();
    if (shutdownRequested) {
      if (signalExitCode) process.exitCode = signalExitCode;
      return;
    }
    const { journalName, deploymentId } = migrationDeploymentIdentity({
      target: mode,
      stateName,
      artifactDigest: build.artifactDigest,
      migrationDigest: expectedMigrationDigest,
    });
    let migration;
    try {
      migration = await runMigrations({
        target: mode,
        persistTo: stateDir,
        journalPath: join(stateDir, 'migration-journals', journalName),
        artifactDigest: build.artifactDigest,
        expectedMigrationDigest,
        deploymentId,
        runProcess: (args) => {
          if (shutdownRequested) throw new Error('local migration aborted');
          return runCaptured(process.execPath, [wranglerPath(), ...args], {
            cwd: HUB_ROOT,
            env: childEnv,
            label: 'local migration Wrangler',
            tracker,
          });
        },
      });
    } catch (error) {
      if (!shutdownRequested) throw error;
      if (signalExitCode) process.exitCode = signalExitCode;
      return;
    }
    if (migration.pendingMigrations !== 0) throw new Error(`migration verification found ${migration.pendingMigrations} pending migrations`);
    if (shutdownRequested) {
      if (signalExitCode) process.exitCode = signalExitCode;
      return;
    }

    const environmentId = mode === 'local' ? `local-${stateName}` : `e2e-${nonce.slice(0, 12)}`;
    const diagnostics = {
      environmentId,
      environmentNonce: nonce,
      buildInputDigest: build.buildInputDigest,
      artifactDigest: build.artifactDigest,
      migrationDigest: migration.migrationDigest,
      schemaDigest: migration.schemaDigest,
      pendingMigrations: 0,
      seedDigest: seed.digest,
    };
    await writeFile(join(stateDir, 'schema-diagnostics.json'), `${JSON.stringify(migration, null, 2)}\n`, 'utf8');
    const emptyEnv = join(stateDir, 'empty.env');
    await writeFile(emptyEnv, '', { encoding: 'utf8', mode: 0o600 });
    log = createWriteStream(join(stateDir, 'wrangler.log'), { flags: 'a' });

    let started;
    try {
      started = await retryPortSelection(options.port, async (selectedPort) => {
        if (shutdownRequested) throw new Error('Wrangler startup aborted');
        const manifest = {
          formatVersion: 1,
          mode,
          host: '127.0.0.1',
          port: selectedPort,
          stateDir,
          createdAt: new Date().toISOString(),
          ...diagnostics,
          syntheticFixture: {
            machine: 'e2e-machine',
            sessions: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'],
          },
        };
        await writeFile(join(stateDir, 'environment-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        const args = [
          wranglerPath(), 'dev', '--local', '--ip', '127.0.0.1', '--port', String(selectedPort),
          '--persist-to', stateDir, '--env-file', emptyEnv,
          '--var', 'ENVIRONMENT:development',
          '--var', `ENVIRONMENT_ID:${environmentId}`,
          '--var', `ENVIRONMENT_NONCE:${nonce}`,
          '--var', `BUILD_INPUT_DIGEST:${build.buildInputDigest}`,
          '--var', `ARTIFACT_DIGEST:${build.artifactDigest}`,
          '--var', `MIGRATION_DIGEST:${migration.migrationDigest}`,
          '--var', `SCHEMA_DIGEST:${migration.schemaDigest}`,
          '--var', 'PENDING_MIGRATIONS:0',
          '--var', `SEED_DIGEST:${seed.digest}`,
        ];
        let attemptOutput = '';
        child = spawnOwned(process.execPath, args, { cwd: HUB_ROOT, env: childEnv, tracker });
        child.stdout.on('data', (chunk) => {
          attemptOutput += chunk;
          process.stdout.write(chunk);
          log.write(chunk);
        });
        child.stderr.on('data', (chunk) => {
          attemptOutput += chunk;
          process.stderr.write(chunk);
          log.write(chunk);
        });
        const exitPromise = once(child, 'exit');
        await recordRuntime(stateDir, owner, child.pid);
        const baseUrl = `http://127.0.0.1:${selectedPort}`;
        try {
          await waitForReadiness(baseUrl, diagnostics, child, options.readinessMs);
        } catch (error) {
          error.processOutput = attemptOutput;
          throw error;
        }
        return { baseUrl, exitPromise };
      }, {
        onRetry: async () => {
          await terminateProcessTree(child).catch(() => {});
          child = undefined;
        },
      });
    } catch (error) {
      if (!shutdownRequested) throw error;
      if (signalExitCode) process.exitCode = signalExitCode;
      return;
    }

    try {
      await seedSynthetic(started.baseUrl, options.readinessMs, seed.digest);
    } catch (error) {
      if (!shutdownRequested) throw error;
      if (signalExitCode) process.exitCode = signalExitCode;
      return;
    }
    console.log(`Local hub ready: ${started.baseUrl}`);
    console.log(`State directory: ${stateDir}`);
    const [code, signal] = await started.exitPromise;
    if (signalExitCode) process.exitCode = signalExitCode;
    else if (!shutdownRequested && code !== 0) throw new Error(`Wrangler exited with ${code ?? signal}`);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('message', onMessage);
    process.off('disconnect', onDisconnect);
    await tracker.terminateAll();
    if (log) {
      log.end();
      await once(log, 'close').catch(() => {});
    }
    await releaseOwnership(stateDir, owner);
    if (mode === 'e2e') {
      await copyDiagnostics(stateDir);
      await assertSafeExistingStatePath(stateDir);
      await rm(stateDir, { recursive: true, force: false });
    }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (options.command === 'reset') await resetEnvironment(options);
  else await startEnvironment(options);
}

main().catch((error) => {
  console.error(`environment: ${error.message}`);
  process.exitCode = 1;
});
