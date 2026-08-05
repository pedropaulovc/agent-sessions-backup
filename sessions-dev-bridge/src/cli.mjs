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

export async function runCli(argv = process.argv.slice(2)) {
  const release = await verifyInstalledRelease();
  const parsed = parseArguments(argv);
  const keys = await loadProductionManifestKeys(join(packageRoot, 'src', 'production-manifest-key.json'));
  let enrollment = null;
  let remoteDestinations = null;
  if (parsed.command === 'enroll') {
    const { EnrollmentTransport, loadTrustedServiceConfig } = await import('./trusted-services.mjs');
    const services = await loadTrustedServiceConfig();
    enrollment = services.enrollment ? new EnrollmentTransport(services.enrollment) : null;
  } else if (parsed.target !== 'local') {
    const { RemoteDestinationTransport } = await import('./remote-destination.mjs');
    remoteDestinations = new RemoteDestinationTransport();
  }
  const dependencies = {
    manifestVerificationKey: keys.keys[0],
    production: new DebugTransport(),
    authorization: new BrowserAuthorization(),
    enrollment,
    remoteDestinations,
    snapshotVerifier: new SnapshotVerifier(keys.keys),
    onProgress: (progress) => stderr.write(`sessions-dev-bridge: ${progress.status}${progress.checkpoint ? ` (${progress.checkpoint})` : ''}\n`),
  };
  const bridge = await createCommandBridge(release, parsed, dependencies);
  if (parsed.command === 'enroll') {
    const result = await bridge.enroll(parsed.deviceLabel);
    stdout.write(`Enrolled hardware-backed device ${result.deviceId}; expires ${result.expiresAt}.\n`);
    return;
  }
  const result = await bridge.pull({ sessionId: parsed.sessionId, target: parsed.target, checkout: parsed.checkout });
  if (result.target === 'local') {
    stdout.write(`Session ${result.sessionId} imported into bridge-owned destination ${result.environment.url.href}\nPress Ctrl+C to stop it.\n`);
    await waitForSignal();
    await result.environment.dispose();
  } else stdout.write(`Session ${result.sessionId} imported into ${result.target}.\n`);
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
