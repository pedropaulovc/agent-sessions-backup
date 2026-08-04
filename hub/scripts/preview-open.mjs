#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const HELP = `Usage: npm --prefix hub run preview:open -- --pr <positive integer> [--print-only]

Options:
  --pr <number>  Pull request number
  --print-only   Print the URL without opening a browser
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

export function previewUrl(pr) {
  if (!Number.isSafeInteger(pr) || pr <= 0) throw new Error('PR number must be a safe positive integer');
  return `https://pr-${pr}-preview.sessions.vza.net`;
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
  const url = previewUrl(parsed.pr);
  (options.log ?? console.log)(url);
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
