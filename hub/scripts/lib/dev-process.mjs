import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

export function runCaptured(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    options.tracker?.track(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${options.label ?? command} exited with ${code ?? signal}: ${stderr || stdout}`));
    });
  });
}



export function createProcessTracker(terminate = terminateProcessTree) {
  const children = new Set();
  let terminating = null;
  return {
    track(child) {
      children.add(child);
      child.once('exit', () => children.delete(child));
      child.once('error', () => children.delete(child));
      return child;
    },
    async terminateAll(signal = 'SIGTERM') {
      if (!terminating) {
        terminating = (async () => {
          const active = [...children];
          const results = await Promise.allSettled(active.map((child) => terminate(child, signal)));
          for (let index = 0; index < active.length; index += 1) {
            if (results[index].status === 'fulfilled') children.delete(active[index]);
          }
          const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
          if (failures.length) throw new AggregateError(failures, 'failed to terminate owned process trees');
        })();
      }
      try {
        await terminating;
      } finally {
        terminating = null;
      }
    },
    get size() {
      return children.size;
    },
  };
}

export async function reservePort(requested) {
  const port = Number(requested);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port: ${requested}`);
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', (error) => reject(new Error(`127.0.0.1:${port} is unavailable: ${error.message}`)));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      const address = server.address();
      const selected = typeof address === 'object' && address ? address.port : port;
      server.close((error) => (error ? reject(error) : resolve(selected)));
    });
  });
}
export function isPortBindCollision(output) {
  return /EADDRINUSE|address already in use|address.*in use/i.test(String(output));
}

export async function retryPortSelection(requested, launch, options = {}) {
  const attempts = options.attempts ?? 5;
  const reserve = options.reserve ?? reservePort;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const port = await reserve(requested);
    try {
      return await launch(port, attempt);
    } catch (error) {
      const retryable = Number(requested) === 0 && isPortBindCollision(error?.processOutput);
      if (!retryable || attempt === attempts) throw error;
      await options.onRetry?.(error, port, attempt);
    }
  }
  throw new Error('port selection retry exhausted');
}


function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref();
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

export async function terminateProcessTree(child, signal = 'SIGTERM') {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      encoding: 'utf8',
    });
    if (result.error && result.error.code !== 'ENOENT') throw result.error;
    if (result.status !== 0 && !(await waitForExit(child, 250))) {
      throw new Error(`taskkill failed for process tree ${child.pid}: ${result.stderr?.trim() || `exit ${result.status}`}`);
    }
    if (!(await waitForExit(child, 5000))) throw new Error(`process tree ${child.pid} did not exit after taskkill`);
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  if (await waitForExit(child, 5000)) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  if (!(await waitForExit(child, 5000))) throw new Error(`process group ${child.pid} did not exit after SIGKILL`);
}

export function spawnOwned(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  options.tracker?.track(child);
  return child;
}
