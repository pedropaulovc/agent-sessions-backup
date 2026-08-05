#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyInstalledRelease, packageRoot } from './provenance.mjs';
import { DebugTransport } from './debug-transport.mjs';
import { BrowserAuthorization } from './browser-authorization.mjs';
import { SnapshotVerifier } from './snapshot.mjs';
import { SessionsDevBridge } from './bridge.mjs';
import { loadProductionManifestKeys } from './production-keys.mjs';
import { parseArguments } from './cli-arguments.mjs';

export async function runCli(argv = process.argv.slice(2), options = {}) {
  const output = options.stdout ?? stdout;
  const errorOutput = options.stderr ?? stderr;
  const verifyRelease = options.verifyRelease ?? verifyInstalledRelease;
  const parse = options.parseArguments ?? parseArguments;
  const loadManifestKeys = options.loadProductionManifestKeys ?? loadProductionManifestKeys;
  const release = await verifyRelease();
  const parsed = parse(argv);
  const keys = await loadManifestKeys(join(packageRoot, 'src', 'production-manifest-key.json'));
  let enrollment = null;
  let remoteDestinations = null;
  if (parsed.command === 'enroll') {
    const loadEnrollment = options.loadEnrollment ?? loadEnrollmentTransport;
    enrollment = await loadEnrollment();
  } else if (parsed.target !== 'local') {
    const loadRemoteDestinations = options.loadRemoteDestinations ?? loadRemoteDestinationTransport;
    remoteDestinations = await loadRemoteDestinations();
  }
  const dependencies = {
    manifestVerificationKey: keys.keys[0],
    production: options.production ?? new DebugTransport(),
    authorization: options.authorization ?? new BrowserAuthorization(),
    enrollment,
    remoteDestinations,
    snapshotVerifier: options.snapshotVerifier ?? new SnapshotVerifier(keys.keys),
    onProgress: (progress) => errorOutput.write(`sessions-dev-bridge: ${progress.status}${progress.checkpoint ? ` (${progress.checkpoint})` : ''}\n`),
  };
  const bridge = await createCommandBridge(release, parsed, dependencies, {
    loadLocalDependencies: options.loadLocalDependencies,
  });
  if (parsed.command === 'enroll') {
    const result = await bridge.enroll(parsed.deviceLabel);
    output.write(`Enrolled hardware-backed device ${result.deviceId}; expires ${result.expiresAt}.\n`);
    return;
  }
  const result = await bridge.pull({ sessionId: parsed.sessionId, target: parsed.target, checkout: parsed.checkout });
  if (result.target === 'local') {
    output.write(`Session ${result.sessionId} imported into bridge-owned destination ${result.environment.url.href}\nPress Ctrl+C to stop it.\n`);
    await waitForSignal();
    await result.environment.dispose();
    return;
  }
  output.write(`Session ${result.sessionId} imported into ${result.target}.\n`);
}

export async function createCommandBridge(
  release,
  parsed,
  { manifestVerificationKey, ...dependencies },
  { loadLocalDependencies = loadCommandLocalDependencies } = {},
) {
  const needsLocalDependencies = parsed.command === 'enroll'
    || (parsed.command === 'pull' && parsed.target === 'local');
  const localDependencies = needsLocalDependencies
    ? await loadLocalDependencies(parsed, manifestVerificationKey)
    : {};
  return new SessionsDevBridge({ release, ...dependencies, ...localDependencies });
}

async function loadEnrollmentTransport() {
  const { EnrollmentTransport, loadTrustedServiceConfig } = await import('./trusted-services.mjs');
  const services = await loadTrustedServiceConfig();
  return services.enrollment ? new EnrollmentTransport(services.enrollment) : null;
}

async function loadRemoteDestinationTransport() {
  const { RemoteDestinationTransport } = await import('./remote-destination.mjs');
  return new RemoteDestinationTransport();
}

async function loadCommandLocalDependencies(parsed, manifestVerificationKey) {
  const [
    { StateStore, defaultStateDirectory },
    { platformKeyProvider },
  ] = await Promise.all([
    import('./state.mjs'),
    import('./key-provider.mjs'),
  ]);
  const stateDirectory = defaultStateDirectory();
  const dependencies = {
    state: new StateStore(stateDirectory),
    keyProvider: platformKeyProvider(stateDirectory),
  };
  if (parsed.command === 'pull') {
    const [
      { EmbeddedBuildDriver },
      { EmbeddedLocalEnvironmentFactory },
    ] = await Promise.all([
      import('./local-build.mjs'),
      import('./local-environment.mjs'),
    ]);
    dependencies.buildDriver = new EmbeddedBuildDriver({ consent: confirmDirtyInputs });
    dependencies.localEnvironmentFactory = new EmbeddedLocalEnvironmentFactory(stateDirectory, manifestVerificationKey);
  }
  return dependencies;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runCli();
  } catch (error) {
    stderr.write(`sessions-dev-bridge: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}


async function confirmDirtyInputs(paths) {
  stderr.write('The pinned build consumes these dirty or untracked paths:\n');
  for (const path of paths) stderr.write(`  ${path}\n`);
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('dirty consumed inputs require interactive consent');
  const prompt = createInterface({ input: stdin, output: stdout });
  try { return (await prompt.question('Build and attest these exact inputs? Type yes: ')) === 'yes'; }
  finally { prompt.close(); }
}

function waitForSignal() {
  return new Promise((resolveSignal) => {
    process.once('SIGINT', resolveSignal);
    process.once('SIGTERM', resolveSignal);
  });
}
