#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const HELP = `Usage: npm --prefix hub run preview:open -- --pr <positive integer> [--print-only]

Options:
  --pr <number>  Pull request number
  --print-only   Print the URL without opening a browser

Auth: the per-PR bearer is derived from the seed in ~/.config/agent-sessions/preview-seed
(or the PREVIEW_BEARER_SEED environment variable) and appended as ?token=… — visiting it
once sets the preview session cookie. Without a seed the bare URL is printed and the
preview will answer 401.
`;

export function assertSupportedNode(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || major < 22 || (major === 22 && minor < 13)) {
    throw new Error(`Node >=22.13.0 is required; found ${version}`);
  }
}

export function parsePreviewOpenArguments(argv) {
  let pr;
  let printOnly = false;
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== '--pr' && flag !== '--print-only') throw new Error(`unknown option: ${flag}`);
    if (seen.has(flag)) throw new Error(`duplicate option: ${flag}`);
    seen.add(flag);

    if (flag === '--print-only') {
      printOnly = true;
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('missing value for --pr');
    if (!/^[1-9]\d*$/.test(value)) throw new Error('--pr must be a positive integer');
    pr = Number(value);
    if (!Number.isSafeInteger(pr)) throw new Error('--pr must be a safe positive integer');
    index += 1;
  }

  if (pr === undefined) throw new Error('missing required option: --pr');
  return { pr, printOnly };
}

export function previewSeedPath(home = homedir()) {
  return join(home, '.config', 'agent-sessions', 'preview-seed');
}

/** The owner's local copy of the shared seed; environment variable wins for CI-ish callers. */
export function readPreviewSeed(environment = process.env, readFile = readFileSync) {
  const fromEnvironment = environment.PREVIEW_BEARER_SEED?.trim();
  if (fromEnvironment) return fromEnvironment;
  try {
    return readFile(previewSeedPath(), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Must stay in lockstep with previewBearerToken in infra/cf/preview-trust.mjs. */
export function derivePreviewBearer(seed, pr) {
  if (typeof seed !== 'string' || seed.trim().length < 32) {
    throw new Error('preview bearer seed must be at least 32 characters');
  }
  return createHmac('sha256', seed.trim()).update(`sessions-preview-bearer:pr-${pr}`).digest('base64url');
}

export function previewUrl(pr, seed = null) {
  if (!Number.isSafeInteger(pr) || pr <= 0) throw new Error('PR number must be a safe positive integer');
  const base = `https://pr-${pr}-app.agent-sessions-nonproduction.workers.dev`;
  if (seed === null) return base;
  return `${base}/?token=${derivePreviewBearer(seed, pr)}`;
}

export function browserLauncher(url, platform = process.platform) {
  if (platform === 'win32') return { command: 'explorer.exe', args: [url] };
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'linux') return { command: 'xdg-open', args: [url] };
  throw new Error(`unsupported platform: ${platform}`);
}

export async function openBrowser(url, options = {}) {
  const launcher = browserLauncher(url, options.platform);
  const spawnProcess = options.spawnProcess ?? spawn;
  await new Promise((resolveLaunch, rejectLaunch) => {
    const child = spawnProcess(launcher.command, launcher.args, {
      detached: true,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', rejectLaunch);
    child.once('spawn', () => {
      child.unref();
      resolveLaunch();
    });
  });
}

export async function main(argv = process.argv.slice(2), options = {}) {
  assertSupportedNode(options.nodeVersion);
  const parsed = parsePreviewOpenArguments(argv);
  const seed = options.seed !== undefined ? options.seed : readPreviewSeed();
  const log = options.log ?? console.log;
  if (seed === null) {
    (options.warn ?? console.error)(
      `no preview seed found (${previewSeedPath()} or PREVIEW_BEARER_SEED) — printing the URL without a token; the preview will answer 401`,
    );
  }
  const url = previewUrl(parsed.pr, seed);
  log(url);
  if (!parsed.printOnly) await openBrowser(url, options);
  return url;
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isEntrypoint) {
  main().catch((error) => {
    console.error(error.message);
    console.error(HELP);
    process.exitCode = 1;
  });
}
