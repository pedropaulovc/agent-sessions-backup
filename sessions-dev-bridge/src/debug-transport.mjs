import { canonicalBytes, assertBase64url } from './canonical.mjs';

const DEFAULT_PATHS = Object.freeze({
  prepareExchange: '/api/v1/debug/prepare/exchange',
  jobs: '/api/v1/debug/jobs/',
  exchange: '/api/v1/debug/exchange',
  exchanges: '/api/v1/debug/exchanges/',
  imports: '/api/v1/debug/imports',
  prepareBrowser: '/debug/prepare',
});

export class DebugTransport {
  constructor({ apiBase = 'https://api.sessions.vza.net', browserBase = 'https://sessions.vza.net', fetchImpl = fetch, paths = {}, allowLoopback = false } = {}) {
    this.apiBase = requireOrigin(apiBase, allowLoopback);
    this.browserBase = requireOrigin(browserBase, allowLoopback);
    this.fetch = fetchImpl;
    this.paths = Object.freeze({ ...DEFAULT_PATHS, ...paths });
  }

  prepareBrowserUrl(request) {
    const encoded = canonicalBytes(request).toString('base64url');
    const url = new URL(this.paths.prepareBrowser, this.browserBase);
    url.searchParams.set('request', encoded);
    return url.href;
  }

  exchangePrepare(code, codeVerifier) {
    return this.#json(this.paths.prepareExchange, { method: 'POST', body: { code, codeVerifier } });
  }

  getPrepareJob(capability) {
    return this.#json(`${this.paths.jobs}${pathCapability(capability)}`, { method: 'GET' });
  }

  exchangeAuthorization(authorizationCode, codeVerifier) {
    return this.#json(this.paths.exchange, { method: 'POST', body: { authorizationCode, codeVerifier } });
  }

  async fetchCiphertext(exchangeCapability, object) {
    const expectedPath = `${this.paths.exchanges}${pathCapability(exchangeCapability)}/objects/${encodeURIComponent(object.objectId)}`;
    if (object.url !== expectedPath) throw new Error(`manifest object URL is not capability-bound: ${object.objectId}`);
    const response = await this.fetch(new URL(expectedPath, this.apiBase), { method: 'GET', headers: { accept: 'application/octet-stream' }, redirect: 'error', cache: 'no-store' });
    if (!response.ok) throw await responseError(response);
    if ((response.headers.get('content-type') ?? '').split(';')[0].trim() !== 'application/octet-stream') throw new Error('ciphertext response has invalid content type');
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength !== object.ciphertextSize) throw new Error('ciphertext content length mismatch');
    const bytes = await readExactly(response, object.ciphertextSize);
    return bytes;
  }

  createImport(assertion, manifest) {
    return this.#json(this.paths.imports, { method: 'POST', body: { assertion, manifest } });
  }

  async putImportObject(importCapability, object, plaintext) {
    const path = `${this.paths.imports}/${pathCapability(importCapability)}/objects/${encodeURIComponent(object.objectId)}`;
    const response = await this.fetch(new URL(path, this.apiBase), {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(plaintext.length), 'x-content-hash': `sha256:${object.sha256}` },
      body: plaintext,
      redirect: 'error',
      cache: 'no-store',
      duplex: 'half',
    });
    if (!response.ok) throw await responseError(response);
  }

  commitImport(importCapability) {
    return this.#json(`${this.paths.imports}/${pathCapability(importCapability)}/commit`, { method: 'POST', body: {} });
  }

  getImport(importCapability) {
    return this.#json(`${this.paths.imports}/${pathCapability(importCapability)}`, { method: 'GET' });
  }

  async #json(path, options) {
    const response = await this.fetch(new URL(path, this.apiBase), {
      method: options.method,
      headers: { accept: 'application/json', ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: 'error',
      cache: 'no-store',
    });
    if (!response.ok) throw await responseError(response);
    if ((response.headers.get('content-type') ?? '').split(';')[0].trim() !== 'application/json') throw new Error('debug protocol response has invalid content type');
    const text = await response.text();
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('debug protocol response is too large');
    return JSON.parse(text);
  }
}

export async function pollProgress(read, options = {}) {
  const terminal = new Set(options.terminal ?? ['complete']);
  const transient = new Set(options.transient ?? []);
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  for (;;) {
    const value = await read();
    if (!value || typeof value.status !== 'string') throw new Error('progress response lacks a status');
    options.onProgress?.(value);
    if (terminal.has(value.status)) return value;
    if (value.status === 'failed') throw new Error(value.error || 'asynchronous debug operation failed');
    if (value.status === 'expired') throw new Error('asynchronous debug operation expired');
    if (!transient.has(value.status)) return value;
    if (Date.now() - started >= timeoutMs) throw new Error('asynchronous debug operation timed out');
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 500));
  }
}

async function readExactly(response, expectedSize) {
  if (!response.body) throw new Error('ciphertext response has no body');
  const output = Buffer.allocUnsafe(expectedSize);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > expectedSize) throw new Error('ciphertext response exceeds declared size');
      Buffer.from(value).copy(output, offset);
      offset += value.length;
    }
  } catch (error) {
    output.fill(0);
    await reader.cancel().catch(() => {});
    throw error;
  }
  if (offset !== expectedSize) {
    output.fill(0);
    throw new Error('ciphertext response size mismatch');
  }
  return output;
}

function pathCapability(value) {
  return encodeURIComponent(assertBase64url(value, 'opaque capability'));
}

function requireOrigin(value, allowLoopback) {
  const url = new URL(value);
  const loopback = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !(allowLoopback && loopback))) throw new Error('debug protocol base must be an HTTPS origin');
  return url.origin;
}

async function responseError(response) {
  const text = (await response.text()).slice(0, 1000);
  return new Error(`debug protocol request failed (${response.status})${text ? `: ${text}` : ''}`);
}
