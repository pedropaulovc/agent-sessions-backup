import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { canonicalBytes } from './canonical.mjs';
import { createPkce } from './secure.mjs';

export class BrowserAuthorization {
  constructor({ openBrowser = openSystemBrowser, timeoutMs = 10 * 60_000 } = {}) {
    this.openBrowser = openBrowser;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
  }

  async enroll({ request, enrollment }) {
    const callback = await LoopbackCallbacks.start(this.timeoutMs);
    try {
      const url = await enrollment.browserUrl(request, callback.url('/enroll'));
      await this.openBrowser(requireHttps(url));
      const result = await callback.wait('/enroll');
      if (result.deviceId !== request.deviceId) throw new Error('enrollment callback device mismatch');
      return { deviceId: result.deviceId, scope: 'local-destination-attest', expiresAt: request.expiresAt, counter: 0 };
    } finally { await callback.close(); }
  }

  async prepare({ sessionId, destinationAttestation, production }) {
    const callbacks = await LoopbackCallbacks.start(this.timeoutMs);
    const pkce = createPkce();
    try {
      const request = {
        sessionIds: [sessionId],
        destinationAttestation,
        pkceChallenge: pkce.challenge,
        callback: callbacks.url('/prepare'),
      };
      await this.openBrowser(production.prepareBrowserUrl(request));
      const result = await callbacks.wait('/prepare');
      const exchanged = await production.exchangePrepare(result.code, pkce.verifier);
      this.pending.set(exchanged.jobCapability, { callbacks, codeVerifier: pkce.verifier, browserOrigin: production.browserBase });
      return { ...exchanged, codeVerifier: pkce.verifier };
    } catch (error) {
      await callbacks.close();
      throw error;
    }
  }

  async abort(jobCapability) {
    const pending = this.pending.get(jobCapability);
    if (!pending) return;
    this.pending.delete(jobCapability);
    await pending.callbacks.close();
  }

  async finalize({ approvalUrl, jobCapability, destinationAttestation }) {
    const pending = this.pending.get(jobCapability);
    if (!pending) throw new Error('no pending loopback authorization for debug job');
    this.pending.delete(jobCapability);
    try {
      const url = new URL(approvalUrl, pending.browserOrigin);
      requireHttps(url.href);
      if (url.origin !== pending.browserOrigin) throw new Error('approval URL is not on the trusted production origin');
      url.searchParams.set('attestation', canonicalBytes(destinationAttestation).toString('base64url'));
      url.searchParams.set('callback', pending.callbacks.url('/final'));
      await this.openBrowser(url.href);
      const result = await pending.callbacks.wait('/final');
      if (result.state !== jobCapability) throw new Error('final authorization callback job mismatch');
      return { authorizationCode: result.code };
    } finally { await pending.callbacks.close(); }
  }
}

class LoopbackCallbacks {
  static async start(timeoutMs) {
    const instance = new LoopbackCallbacks(timeoutMs);
    await instance.listen();
    return instance;
  }
  constructor(timeoutMs) {
    this.timeoutMs = timeoutMs;
    this.waiters = new Map();
    this.received = new Map();
    this.server = createServer((request, response) => this.#request(request, response));
    this.server.maxConnections = 4;
    this.closed = false;
  }
  async listen() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
    });
    this.port = this.server.address().port;
  }
  url(path) { return `http://127.0.0.1:${this.port}${path}`; }
  wait(path) {
    if (this.received.has(path)) {
      const result = this.received.get(path);
      this.received.delete(path);
      return Promise.resolve(result);
    }
    if (this.waiters.has(path)) throw new Error(`already waiting for ${path}`);
    return new Promise((resolve, reject) => {
      const complete = (settle, value) => {
        clearTimeout(timer);
        this.waiters.delete(path);
        settle(value);
      };
      const timer = setTimeout(() => complete(reject, new Error('browser authorization timed out')), this.timeoutMs);
      timer.unref?.();
      this.waiters.set(path, {
        resolve: (value) => complete(resolve, value),
        reject: (error) => complete(reject, error),
      });
    });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.values()) waiter.reject(new Error('authorization callback closed'));
    this.waiters.clear();
    this.received.clear();
    const closed = new Promise((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
    this.server.closeAllConnections();
    await closed;
  }
  #request(request, response) {
    const headers = {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'x-frame-options': 'DENY',
      connection: 'close',
    };
    try {
      if (request.method !== 'GET' || request.headers.host !== `127.0.0.1:${this.port}`) throw new Error('invalid loopback request');
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (!['/prepare', '/final', '/enroll'].includes(url.pathname)) throw new Error('invalid loopback callback path');
      let value;
      if (url.pathname === '/enroll') {
        if ([...url.searchParams.keys()].some((key) => key !== 'device_id')) throw new Error('unexpected loopback callback parameter');
        const deviceId = url.searchParams.get('device_id');
        if (!deviceId || !/^[A-Za-z0-9_-]+$/.test(deviceId)) throw new Error('invalid enrolled device id');
        value = { deviceId };
      } else {
        if ([...url.searchParams.keys()].some((key) => key !== 'code' && key !== 'state')) throw new Error('unexpected loopback callback parameter');
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (!code || !/^[A-Za-z0-9_-]+$/.test(code) || (state !== null && !/^[A-Za-z0-9_-]+$/.test(state))) throw new Error('invalid loopback authorization code');
        value = { code, state };
      }
      const waiter = this.waiters.get(url.pathname);
      if (waiter) { this.waiters.delete(url.pathname); waiter.resolve(value); }
      else if (!this.received.has(url.pathname)) this.received.set(url.pathname, value);
      else throw new Error('duplicate loopback callback');
      response.writeHead(200, headers).end('Authorization received. You may close this tab.');
    } catch {
      response.writeHead(400, headers).end('Invalid callback.');
    }
  }
}

export async function openSystemBrowser(url, {
  platform = process.platform,
  launcher = spawn,
  launchProbeMs = 1_000,
} = {}) {
  requireHttps(url);
  const command = platform === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : platform === 'darwin'
      ? ['/usr/bin/open', [url]]
      : ['/usr/bin/xdg-open', [url]];
  await new Promise((resolve, reject) => {
    const child = launcher(command[0], command[1], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      shell: false,
    });
    let timer;
    const complete = (error) => {
      clearTimeout(timer);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error) => complete(error);
    const onExit = (code, signal) => complete(
      code === 0
        ? null
        : new Error(`browser launcher exited before handoff (${signal ?? `code ${code}`})`),
    );
    child.once('error', onError);
    child.once('exit', onExit);
    child.once('spawn', () => {
      child.unref();
      timer = setTimeout(complete, launchProbeMs);
    });
  });
}

function requireHttps(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('authorization page must use HTTPS');
  return url.href;
}
