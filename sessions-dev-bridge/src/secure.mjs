import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const MAX_OUTPUT = 1024 * 1024;

export async function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    const collect = (chunks, kind) => (chunk) => {
      if (kind === 'stdout') stdoutSize += chunk.length;
      else stderrSize += chunk.length;
      if (stdoutSize > MAX_OUTPUT || stderrSize > MAX_OUTPUT) {
        child.kill();
        reject(new Error(`${command} emitted excessive output`));
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', collect(stdout, 'stdout'));
    child.stderr.on('data', collect(stderr, 'stderr'));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      const out = Buffer.concat(stdout);
      const err = Buffer.concat(stderr);
      if (code !== 0) {
        const detail = err.toString('utf8').trim().slice(0, 1000);
        reject(new Error(`${command} failed (${signal ?? code})${detail ? `: ${detail}` : ''}`));
      } else resolve({ stdout: out, stderr: err });
    });
    if (options.stdin) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

export function createPkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

export async function openLoopbackAuthorization({ createRequest, openBrowser, timeoutMs = 5 * 60_000 }) {
  let settle;
  let fail;
  const callback = new Promise((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const server = createServer((request, response) => {
    try {
      if (request.method !== 'GET' || request.headers.host !== `127.0.0.1:${server.address().port}`) {
        response.writeHead(400, { 'cache-control': 'no-store', connection: 'close' }).end('Invalid callback');
        return;
      }
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (url.pathname !== '/callback') {
        response.writeHead(404, { 'cache-control': 'no-store', connection: 'close' }).end('Not found');
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code || !state || [...url.searchParams.keys()].some((key) => key !== 'code' && key !== 'state')) {
        response.writeHead(400, { 'cache-control': 'no-store', connection: 'close' }).end('Invalid callback');
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
        'x-frame-options': 'DENY',
        connection: 'close',
      }).end('Authorization received. You may close this tab.');
      settle({ code, state });
    } catch (error) {
      fail(error);
    }
  });
  server.maxConnections = 2;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
  });
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const timer = setTimeout(() => fail(new Error('browser authorization timed out')), timeoutMs);
  timer.unref?.();
  try {
    const { url, expectedState } = await createRequest(redirectUri);
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('authorization URL must use HTTPS');
    await openBrowser(parsed.href);
    const result = await callback;
    if (result.state !== expectedState) throw new Error('authorization callback state mismatch');
    return result.code;
  } finally {
    clearTimeout(timer);
    await new Promise((resolve) => server.close(resolve));
  }
}

export function zero(...buffers) {
  for (const value of buffers) if (Buffer.isBuffer(value) || value instanceof Uint8Array) value.fill(0);
}
