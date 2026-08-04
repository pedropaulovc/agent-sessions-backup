import { canonicalBytes, assertBase64url } from './canonical.mjs';

const DEFAULT_PATHS = Object.freeze({
  prepareExchange: '/api/v1/debug/prepare/exchange',
  jobs: '/api/v1/debug/jobs/',
  exchange: '/api/v1/debug/exchange',
  exchanges: '/api/v1/debug/exchanges/',
  imports: '/api/v1/debug/imports',
  prepareBrowser: '/debug/prepare',
});

const JSON_RESPONSE_LIMIT = 2 * 1024 * 1024;
const ERROR_RESPONSE_LIMIT = 1000;

export class DebugTransport {
  constructor({
    apiBase = 'https://api.sessions.vza.net',
    browserBase = 'https://sessions.vza.net',
    fetchImpl = fetch,
    paths = {},
    allowLoopback = false,
    timeoutMs = 30_000,
    transferTimeoutMs = 10 * 60_000,
  } = {}) {
    this.apiBase = requireOrigin(apiBase, allowLoopback);
    this.browserBase = requireOrigin(browserBase, allowLoopback);
    this.fetch = fetchImpl;
    this.paths = Object.freeze({ ...DEFAULT_PATHS, ...paths });
    this.timeoutMs = requireTimeout(timeoutMs, 'request timeout');
    this.transferTimeoutMs = requireTimeout(transferTimeoutMs, 'transfer timeout');
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
    const deadline = createDeadline(this.transferTimeoutMs);
    try {
      const response = await this.fetch(new URL(expectedPath, this.apiBase), { method: 'GET', headers: { accept: 'application/octet-stream' }, redirect: 'error', cache: 'no-store', signal: deadline.signal });
      if (!response.ok) throw await responseError(response, deadline.signal);
      if ((response.headers.get('content-type') ?? '').split(';')[0].trim() !== 'application/octet-stream') {
        cancelBody(response);
        throw new Error('ciphertext response has invalid content type');
      }
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength !== object.ciphertextSize) {
        cancelBody(response);
        throw new Error('ciphertext content length mismatch');
      }
      return await readExactly(response, object.ciphertextSize, deadline.signal);
    } finally {
      deadline.clear();
    }
  }

  createImport(assertion, manifest) {
    return this.#json(this.paths.imports, { method: 'POST', body: { assertion, manifest } });
  }

  async putImportObject(importCapability, object, plaintext) {
    const path = `${this.paths.imports}/${pathCapability(importCapability)}/objects/${encodeURIComponent(object.objectId)}`;
    const deadline = createDeadline(this.transferTimeoutMs);
    try {
      const response = await this.fetch(new URL(path, this.apiBase), {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(plaintext.length), 'x-content-hash': `sha256:${object.sha256}` },
        body: plaintext,
        redirect: 'error',
        cache: 'no-store',
        duplex: 'half',
        signal: deadline.signal,
      });
      if (!response.ok) throw await responseError(response, deadline.signal);
    } finally {
      deadline.clear();
    }
  }

  commitImport(importCapability) {
    return this.#json(`${this.paths.imports}/${pathCapability(importCapability)}/commit`, { method: 'POST', body: {} });
  }

  getImport(importCapability) {
    return this.#json(`${this.paths.imports}/${pathCapability(importCapability)}`, { method: 'GET' });
  }

  async #json(path, options) {
    const deadline = createDeadline(this.timeoutMs);
    try {
      const response = await this.fetch(new URL(path, this.apiBase), {
        method: options.method,
        headers: { accept: 'application/json', ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: 'error',
        cache: 'no-store',
        signal: deadline.signal,
      });
      if (!response.ok) throw await responseError(response, deadline.signal);
      if ((response.headers.get('content-type') ?? '').split(';')[0].trim() !== 'application/json') {
        cancelBody(response);
        throw new Error('debug protocol response has invalid content type');
      }
      return JSON.parse(await readBounded(response, JSON_RESPONSE_LIMIT, deadline.signal));
    } finally {
      deadline.clear();
    }
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
    if (!transient.has(value.status)) throw new Error(`unexpected asynchronous debug operation status: ${value.status}`);
    if (Date.now() - started >= timeoutMs) throw new Error('asynchronous debug operation timed out');
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 500));
  }
}

async function readExactly(response, expectedSize, signal) {
  if (!response.body) throw new Error('ciphertext response has no body');
  const output = Buffer.allocUnsafe(expectedSize);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await readChunk(reader, signal);
      if (done) break;
      if (offset + value.length > expectedSize) throw new Error('ciphertext response exceeds declared size');
      Buffer.from(value).copy(output, offset);
      offset += value.length;
    }
  } catch (error) {
    output.fill(0);
    cancelReader(reader);
    throw error;
  }
  if (offset !== expectedSize) {
    output.fill(0);
    throw new Error('ciphertext response size mismatch');
  }
  return output;
}

async function readBounded(response, limit, signal) {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) {
    cancelBody(response);
    throw new Error('debug protocol response is too large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await readChunk(reader, signal);
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('debug protocol response is too large');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    cancelReader(reader);
    throw error;
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

async function readPrefix(response, limit, signal) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await readChunk(reader, signal);
      if (done) break;
      const remaining = limit - size;
      const chunk = value.length > remaining ? value.subarray(0, remaining) : value;
      chunks.push(Buffer.from(chunk));
      size += chunk.length;
      if (value.length > remaining) break;
    }
  } catch (error) {
    cancelReader(reader);
    throw error;
  }
  cancelReader(reader);
  return Buffer.concat(chunks, size).toString('utf8');
}

function readChunk(reader, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    signal.addEventListener('abort', aborted, { once: true });
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

function cancelReader(reader) {
  try { reader.cancel().catch(() => {}); } catch {}
}

function cancelBody(response) {
  if (!response.body) return;
  try { response.body.cancel().catch(() => {}); } catch {}
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

function createDeadline(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('The operation timed out', 'TimeoutError')), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function requireTimeout(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

async function responseError(response, signal) {
  const text = await readPrefix(response, ERROR_RESPONSE_LIMIT, signal);
  return new Error(`debug protocol request failed (${response.status})${text ? `: ${text}` : ''}`);
}
