import { test as base, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

interface WorkerFixtures {
  environmentURL: string;
}

interface TestFixtures {
  appURL: (pathname?: string) => string;
  browserDiagnostics: void;
}

interface StartedEnvironment {
  child: ChildProcess;
  isReady: () => boolean;
}

const LOOPBACK = '127.0.0.1';
const START_TIMEOUT_MS = 180_000;
const STOP_TIMEOUT_MS = 15_000;

export const test = base.extend<TestFixtures, WorkerFixtures>({
  environmentURL: [
    async ({}, use, workerInfo) => {
      const deployedURL = process.env.BASE_URL?.trim();
      if (deployedURL) {
        const parsed = new URL(deployedURL);
        if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== LOOPBACK) {
          throw new Error('BASE_URL must use HTTPS unless it targets loopback');
        }
        if (parsed.username || parsed.password || parsed.search || parsed.hash) {
          throw new Error('BASE_URL must not contain credentials, query parameters, or a fragment');
        }
        await use(parsed.toString());
        return;
      }

      const port = await reservePort();
      const baseURL = `http://${LOOPBACK}:${port}`;
      const diagnosticsDir = path.resolve('test-results', `environment-${workerInfo.workerIndex}`);
      mkdirSync(diagnosticsDir, { recursive: true });
      const log = createWriteStream(path.join(diagnosticsDir, 'harness.log'), { flags: 'a' });
      const { child, isReady } = startEnvironment(port, diagnosticsDir, log);
      const closed = closeResult(child);

      try {
        await waitForHealth(baseURL, child, closed, isReady);
        await use(baseURL);
      } finally {
        await stopEnvironment(child, closed);
        await closeLog(log);
      }
    },
    { scope: 'worker', timeout: START_TIMEOUT_MS + 30_000 },
  ],

  appURL: async ({ environmentURL }, use) => {
    await use((pathname = '/') => new URL(pathname, environmentURL).toString());
  },

  browserDiagnostics: [
    async ({ page }, use, testInfo) => {
      const entries: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning') {
          entries.push(`console.${message.type()}: ${message.text()}`);
        }
      });
      page.on('pageerror', (error) => entries.push(`pageerror: ${error.message}`));
      page.on('requestfailed', (request) => {
        entries.push(`requestfailed: ${safeRequestURL(request.url())} (${request.failure()?.errorText ?? 'unknown'})`);
      });
      page.on('response', (response) => {
        if (response.status() >= 500) entries.push(`response: ${response.status()} ${safeRequestURL(response.url())}`);
      });

      await use();

      if (testInfo.status !== testInfo.expectedStatus && entries.length) {
        await testInfo.attach('browser-diagnostics', {
          body: Buffer.from(`${entries.join('\n')}\n`, 'utf8'),
          contentType: 'text/plain',
        });
      }
    },
    { auto: true },
  ],
});

export { expect };

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, LOOPBACK, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a loopback port'));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function startEnvironment(port: number, diagnosticsDir: string, log: WriteStream): StartedEnvironment {
  const home = path.join(diagnosticsDir, 'home');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  const xdgConfig = path.join(home, '.config');
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  mkdirSync(xdgConfig, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? process.env.Path,
    PATHEXT: process.env.PATHEXT,
    SystemRoot: process.env.SystemRoot,
    COMSPEC: process.env.COMSPEC,
    WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    CI: process.env.CI,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    XDG_CONFIG_HOME: xdgConfig,
    NO_COLOR: '1',
    WRANGLER_SEND_METRICS: 'false',
    DEV_DIAGNOSTICS_DIR: diagnosticsDir,
  };

  const child = spawn(process.execPath, ['scripts/environment.mjs', 'e2e', '--port', String(port)], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  let ready = false;
  let stdout = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout = `${stdout}${chunk.toString('utf8')}`.slice(-2_048);
    if (stdout.includes(`Local hub ready: http://${LOOPBACK}:${port}`)) ready = true;
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  return { child, isReady: () => ready };
}

function closeResult(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
}

async function waitForHealth(
  baseURL: string,
  child: ChildProcess,
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  isReady: () => boolean,
): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const result = await closed;
      throw new Error(`Local e2e environment exited before readiness (code=${result.code}, signal=${result.signal})`);
    }
    try {
      const response = await fetch(`${baseURL}/healthz`, { signal: AbortSignal.timeout(2_000) });
      const body = await response.json() as { ok?: unknown; environment?: unknown };
      if (response.ok && body.ok === true && body.environment === 'development' && isReady()) return;
    } catch {
      // The owned server has not bound the selected port yet.
    }
    await delay(250);
  }
  throw new Error(`Local e2e environment was not seeded and healthy within ${START_TIMEOUT_MS / 1_000}s`);
}

async function stopEnvironment(
  child: ChildProcess,
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    await closed;
    return;
  }
  if (child.connected) {
    try {
      child.send({ type: 'shutdown' }, () => {
        // A callback consumes an asynchronous channel-close error from a concurrent child exit.
      });
    } catch {
      // The process exited between the connected check and the send.
    }
  }
  await Promise.race([closed, delay(STOP_TIMEOUT_MS)]);
  if (child.exitCode !== null || child.signalCode !== null) {
    await closed;
    return;
  }
  child.kill('SIGTERM');
  await Promise.race([closed, delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await closed;
}

function closeLog(log: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    log.once('error', onError);
    log.end(() => {
      log.off('error', onError);
      resolve();
    });
  });
}

function safeRequestURL(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '<invalid URL>';
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
