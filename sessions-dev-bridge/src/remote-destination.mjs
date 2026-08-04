import { createServer } from 'node:http';
import { canonicalBytes, canonicalJson, randomId, assertBase64url, assertExactKeys, assertHex } from './canonical.mjs';
import { createPkce, zero } from './secure.mjs';
import { openSystemBrowser } from './browser-authorization.mjs';

const MAX_BYTES = 512 * 1024 * 1024;
const JSON_RESPONSE_LIMIT = 2 * 1024 * 1024;
const ERROR_RESPONSE_LIMIT = 500;

export class RemoteDestinationTransport {
  constructor({
    fetchImpl = fetch,
    openBrowser = openSystemBrowser,
    timeoutMs = 10 * 60_000,
    requestTimeoutMs = 30_000,
    transferTimeoutMs = 10 * 60_000,
  } = {}) {
    this.fetch = fetchImpl;
    this.openBrowser = openBrowser;
    this.timeoutMs = requireTimeout(timeoutMs, 'authorization timeout');
    this.requestTimeoutMs = requireTimeout(requestTimeoutMs, 'request timeout');
    this.transferTimeoutMs = requireTimeout(transferTimeoutMs, 'transfer timeout');
  }

  async create({ pr, sessionIds, maxBytes = MAX_BYTES }) {
    const resolved = await this.#browserOperation(pr, 'resolve', {});
    validateResolution(resolved, pr);
    const result = await this.#browserOperation(pr, 'attest', {
      head: resolved.live.head,
      generation: resolved.live.generation,
      artifactDigest: resolved.live.artifactDigest,
      inventoryDigest: null,
      sessionIds: [...sessionIds].sort(),
      maxBytes,
    });
    const destination = { pr, target: `pr-${pr}`, sessionIds: [...sessionIds].sort(), maxBytes, route: resolved.live, ...result };
    validateRemoteResult(destination, null);
    return Object.freeze(destination);
  }

  async extend(destination, inventoryDigest) {
    assertHex(inventoryDigest, 64, 'remote inventory digest');
    const result = await this.#browserOperation(destination.pr, 'extend', { destinationId: destination.destinationId, inventoryDigest });
    validateRemoteResult({ ...destination, ...result }, inventoryDigest);
    if (canonicalJson(result.encryptionPublicJwk) !== canonicalJson(destination.encryptionPublicJwk)) throw new Error('remote destination encryption key changed during extension');
    return result.attestation;
  }

  async transfer({ destination, attestation, manifest, exchangeCapability, source, onProgress = () => {} }) {
    const origin = destinationOrigin(destination.pr);
    const created = await this.#json(new URL('/_destination/imports', origin), { method: 'POST', body: { attestation, manifest } });
    if (created.importId !== destination.destinationId) throw new Error('remote importer changed destination id');
    const base = new URL(created.uploadBaseUrl);
    if (base.origin !== origin || base.pathname !== `/_destination/imports/${destination.destinationId}` || base.search || base.hash) throw new Error('remote importer returned an untrusted upload URL');
    assertRequired(created.requiredObjectIds, manifest.objects);
    for (const object of manifest.objects) {
      const ciphertext = await source.fetchCiphertext(exchangeCapability, object);
      try {
        const deadline = createDeadline(this.transferTimeoutMs);
        try {
          const response = await this.fetch(new URL(`${base.pathname}/objects/${encodeURIComponent(object.objectId)}`, origin), {
            method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'content-length': String(ciphertext.length) }, body: ciphertext, redirect: 'error', cache: 'no-store', duplex: 'half', signal: deadline.signal,
          });
          if (!response.ok) throw await responseError(response, deadline.signal);
        } finally {
          deadline.clear();
        }
      } finally { zero(ciphertext); }
    }
    const commitDeadline = createDeadline(this.transferTimeoutMs);
    try {
      const committed = await this.fetch(base, { method: 'POST', redirect: 'error', cache: 'no-store', signal: commitDeadline.signal });
      if (!committed.ok) throw await responseError(committed, commitDeadline.signal);
    } finally {
      commitDeadline.clear();
    }
    const started = Date.now();
    for (;;) {
      const status = await this.#json(base, { method: 'GET' });
      onProgress(status);
      if (status.status === 'complete') return status;
      if (status.status === 'failed' || status.status === 'expired') throw new Error(`remote import ${status.status}`);
      if (!['uploading', 'queued', 'validating', 'promoting'].includes(status.status)) throw new Error('remote importer returned an invalid status');
      if (Date.now() - started > 30 * 60_000) throw new Error('remote import timed out');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  async #browserOperation(pr, operation, body) {
    const callback = await LoopbackCode.start(this.timeoutMs);
    const pkce = createPkce();
    const state = randomId(24);
    try {
      const request = { operation, pr, body, callback: callback.url, pkceChallenge: pkce.challenge, state };
      await this.openBrowser(`${destinationOrigin(pr)}/_destination/authorize#${canonicalBytes(request).toString('base64url')}`);
      const result = await callback.wait();
      if (result.state !== state) throw new Error('remote destination callback state mismatch');
      return await this.#json(new URL('/_destination/exchange', 'https://preview-control.sessions.vza.net'), { method: 'POST', body: { pr, code: result.code, verifier: pkce.verifier } });
    } finally { await callback.close(); }
  }

  async #json(url, { method, body }) {
    const deadline = createDeadline(this.requestTimeoutMs);
    try {
      const response = await this.fetch(url, { method, headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', cache: 'no-store', signal: deadline.signal });
      if (!response.ok) throw await responseError(response, deadline.signal);
      if ((response.headers.get('content-type') ?? '').split(';')[0].trim() !== 'application/json') {
        cancelBody(response);
        throw new Error('remote destination response is not JSON');
      }
      return JSON.parse(await readBounded(response, JSON_RESPONSE_LIMIT, deadline.signal));
    } finally {
      deadline.clear();
    }
  }
}

class LoopbackCode {
  static async start(timeoutMs) { const value = new LoopbackCode(timeoutMs); await value.listen(); return value; }
  constructor(timeoutMs) { this.timeoutMs = timeoutMs; this.server = createServer((request, response) => this.request(request, response)); }
  async listen() { await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve); }); this.port = this.server.address().port; this.url = `http://127.0.0.1:${this.port}/callback`; }
  wait() { if (this.received) return Promise.resolve(this.received); return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('remote destination authorization timed out')), this.timeoutMs); timer.unref?.(); this.resolve = (value) => { clearTimeout(timer); resolve(value); }; }); }
  request(request, response) {
    try {
      if (request.method !== 'GET' || request.headers.host !== `127.0.0.1:${this.port}`) throw new Error();
      const url = new URL(request.url, this.url);
      if (url.pathname !== '/callback' || [...url.searchParams.keys()].some((key) => key !== 'code' && key !== 'state')) throw new Error();
      const code = assertBase64url(url.searchParams.get('code'), 'destination code');
      const state = assertBase64url(url.searchParams.get('state'), 'destination state');
      const value = { code, state };
      if (this.resolve) this.resolve(value); else this.received = value;
      response.writeHead(200, secureHeaders()).end('Authorization received. You may close this tab.');
    } catch { response.writeHead(400, secureHeaders()).end('Invalid callback.'); }
  }
  async close() { await new Promise((resolve) => this.server.close(resolve)); }
}

function validateResolution(value, pr) {
  if (
    !value
    || value.pr !== pr
    || !value.live
    || !/^[0-9a-f]{40}$/.test(value.live.head)
    || !/^[0-9a-f]{64}$/.test(value.live.artifactDigest)
    || !/^[0-9a-f]{64}$/.test(value.live.buildInputDigest)
    || typeof value.live.generation !== 'string'
    || value.live.generation.length === 0
    || !/^[A-Za-z0-9_-]{16,128}$/.test(value.live.environmentNonce)
  ) throw new Error('trusted front door returned invalid live route provenance');
}
function validateRemoteResult(value, inventoryDigest) {
  const payload = value.attestation?.payload;
  if (!payload || typeof value.attestation.signature !== 'string' || payload.scope !== 'remote-destination-attest' || payload.kind !== 'remote' || payload.prNumber !== value.pr || payload.inventoryDigest !== inventoryDigest || payload.destinationId !== value.destinationId || payload.headSha !== value.route.head || payload.generation !== value.route.generation || payload.artifactDigest !== value.route.artifactDigest || payload.buildInputDigest !== value.route.buildInputDigest || payload.environmentNonce !== value.route.environmentNonce || payload.maxBytes !== value.maxBytes || canonicalJson(payload.sessionIds) !== canonicalJson(value.sessionIds) || canonicalJson(payload.encryptionPublicJwk) !== canonicalJson(value.encryptionPublicJwk)) throw new Error('trusted front door returned invalid destination attestation');
}
function assertRequired(required, objects) { const expected = objects.map((item) => item.objectId).sort(); const actual = Array.isArray(required) ? [...required].sort() : []; if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) throw new Error('remote importer requested an unexpected object set'); }
function destinationOrigin(pr) { if (!Number.isSafeInteger(pr) || pr < 1) throw new Error('invalid PR number'); return `https://pr-${pr}-preview.sessions.vza.net`; }
function secureHeaders() { return { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', connection: 'close' }; }
function requireTimeout(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

async function readBounded(response, limit, signal) {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) {
    cancelBody(response);
    throw new Error('remote destination response is too large');
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
      if (size > limit) throw new Error('remote destination response is too large');
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
function createDeadline(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('The operation timed out', 'TimeoutError')), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function responseError(response, signal) {
  const text = await readPrefix(response, ERROR_RESPONSE_LIMIT, signal);
  return new Error(`remote destination request failed (${response.status})${text ? `: ${text}` : ''}`);
}
