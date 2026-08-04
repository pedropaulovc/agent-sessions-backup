#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { join, resolve } from 'node:path';
import { verifyInstalledRelease, packageRoot } from './provenance.mjs';
import { StateStore, defaultStateDirectory } from './state.mjs';
import { platformKeyProvider } from './key-provider.mjs';
import { EmbeddedBuildDriver } from './local-build.mjs';
import { EmbeddedLocalEnvironmentFactory } from './local-environment.mjs';
import { DebugTransport } from './debug-transport.mjs';
import { BrowserAuthorization } from './browser-authorization.mjs';
import { SnapshotVerifier } from './snapshot.mjs';
import { SessionsDevBridge } from './bridge.mjs';
import { EnrollmentTransport, loadTrustedServiceConfig } from './trusted-services.mjs';
import { RemoteDestinationTransport } from './remote-destination.mjs';

try {
  const release = await verifyInstalledRelease();
  const keys = JSON.parse(await readFile(join(packageRoot, 'src', 'production-manifest-key.json'), 'utf8'));
  const services = await loadTrustedServiceConfig();
  const stateDirectory = defaultStateDirectory();
  const state = new StateStore(stateDirectory);
  const keyProvider = platformKeyProvider(stateDirectory);
  const production = new DebugTransport();
  const authorization = new BrowserAuthorization();
  const bridge = new SessionsDevBridge({
    release,
    state,
    keyProvider,
    buildDriver: new EmbeddedBuildDriver({ consent: confirmDirtyInputs }),
    localEnvironmentFactory: new EmbeddedLocalEnvironmentFactory(stateDirectory, keys.keys[0]),
    production,
    authorization,
    enrollment: services.enrollment === null ? null : new EnrollmentTransport(services.enrollment),
    remoteDestinations: new RemoteDestinationTransport(),
    snapshotVerifier: new SnapshotVerifier(keys.keys),
    onProgress: (progress) => stderr.write(`sessions-dev-bridge: ${progress.status}${progress.checkpoint ? ` (${progress.checkpoint})` : ''}\n`),
  });
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.command === 'enroll') {
    const result = await bridge.enroll(parsed.deviceLabel);
    stdout.write(`Enrolled hardware-backed device ${result.deviceId}; expires ${result.expiresAt}.\n`);
  } else {
    const result = await bridge.pull({ sessionId: parsed.sessionId, target: parsed.target, checkout: parsed.checkout });
    if (result.target === 'local') {
      stdout.write(`Session ${result.sessionId} imported into bridge-owned destination ${result.environment.url.href}\nPress Ctrl+C to stop it.\n`);
      await waitForSignal();
      await result.environment.dispose();
    } else stdout.write(`Session ${result.sessionId} imported into ${result.target}.\n`);
  }
} catch (error) {
  stderr.write(`sessions-dev-bridge: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function parseArguments(args) {
  const command = args.shift();
  if (command === 'enroll') {
    let deviceLabel = `${process.env.COMPUTERNAME || process.env.HOSTNAME || 'developer device'}`;
    while (args.length) {
      const flag = args.shift();
      if (flag === '--device-label' && args.length) deviceLabel = args.shift();
      else throw usage();
    }
    return { command, deviceLabel };
  }
  if (command === 'pull') {
    let sessionId;
    let target;
    let checkout = process.cwd();
    while (args.length) {
      const flag = args.shift();
      if (flag === '--session' && args.length && sessionId === undefined) sessionId = args.shift();
      else if (flag === '--target' && args.length && target === undefined) target = args.shift();
      else if (flag === '--checkout' && args.length && checkout === process.cwd()) checkout = resolve(args.shift());
      else throw usage();
    }
    if (!sessionId || !target) throw usage();
    return { command, sessionId, target, checkout };
  }
  throw usage();
}

function usage() {
  return new Error('usage: sessions-dev-bridge enroll [--device-label <label>] | sessions-dev-bridge pull --session <id> --target local|pr-<number> [--checkout <path>]');
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
