import test from 'node:test';
import assert from 'node:assert/strict';
import { DebugTransport, pollProgress } from '../src/debug-transport.mjs';
import { RemoteDestinationTransport } from '../src/remote-destination.mjs';

const digest = (character) => character.repeat(64);
const jsonResponse = (value, init = {}) => new Response(JSON.stringify(value), {
  ...init,
  headers: { 'content-type': 'application/json', ...init.headers },
});

test('pollProgress fails closed on an unknown asynchronous status', async () => {
  await assert.rejects(
    pollProgress(async () => ({ status: 'compelete' }), { transient: ['running'] }),
    /unexpected asynchronous debug operation status: compelete/,
  );
});

test('DebugTransport attaches deadlines to JSON and object transfers', async () => {
  const requests = [];
  const responses = [
    jsonResponse({ ok: true }),
    new Response(Uint8Array.of(1, 2, 3), { headers: { 'content-type': 'application/octet-stream', 'content-length': '3' } }),
    new Response(null, { status: 204 }),
  ];
  const transport = new DebugTransport({
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return responses.shift();
    },
    timeoutMs: 1000,
    transferTimeoutMs: 2000,
  });

  await transport.exchangePrepare('code', 'verifier');
  assert.deepEqual(await transport.fetchCiphertext('Y2Fw', {
    objectId: 'object-1',
    url: '/api/v1/debug/exchanges/Y2Fw/objects/object-1',
    ciphertextSize: 3,
  }), Buffer.from([1, 2, 3]));
  await transport.putImportObject('aW1wb3J0', { objectId: 'object-1', sha256: digest('a') }, Buffer.from('plain'));

  assert.equal(requests.length, 3);
  for (const { init } of requests) {
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
  }
});

test('DebugTransport accepts exact streamed ciphertext without content length and enforces declared and streamed sizes', async () => {
  const response = (chunks, headers = {}) => new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
      controller.close();
    },
  }), { headers: { 'content-type': 'application/octet-stream', ...headers } });
  const responses = [
    response([[1], [2, 3]]),
    response([[1, 2, 3]], { 'content-length': '4' }),
    response([[1, 2]]),
    response([[1, 2], [3, 4]]),
  ];
  const transport = new DebugTransport({ fetchImpl: async () => responses.shift() });
  const object = {
    objectId: 'object-1',
    url: '/api/v1/debug/exchanges/Y2Fw/objects/object-1',
    ciphertextSize: 3,
  };

  assert.deepEqual(await transport.fetchCiphertext('Y2Fw', object), Buffer.from([1, 2, 3]));
  await assert.rejects(transport.fetchCiphertext('Y2Fw', object), /content length mismatch/);
  await assert.rejects(transport.fetchCiphertext('Y2Fw', object), /size mismatch/);
  await assert.rejects(transport.fetchCiphertext('Y2Fw', object), /exceeds declared size/);
});

test('DebugTransport stops streaming a JSON response as soon as its size bound is crossed', async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls > 20) controller.close();
      else controller.enqueue(new Uint8Array(1024 * 1024));
    },
    cancel() { cancelled = true; },
  });
  const transport = new DebugTransport({
    fetchImpl: async () => new Response(body, { headers: { 'content-type': 'application/json' } }),
  });

  await assert.rejects(transport.getPrepareJob('am9i'), /response is too large/);
  assert.ok(pulls <= 4, `bounded reader pulled ${pulls} chunks`);
  assert.equal(cancelled, true);
});

test('DebugTransport aborts a stalled response body at its request deadline', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() { cancelled = true; },
  });
  const transport = new DebugTransport({
    fetchImpl: async (_url, init) => {
      assert.ok(init.signal instanceof AbortSignal);
      return new Response(body, { headers: { 'content-type': 'application/json' } });
    },
    timeoutMs: 20,
  });

  await assert.rejects(transport.getPrepareJob('am9i'), (error) => error?.name === 'TimeoutError');
  assert.equal(cancelled, true);
});

test('RemoteDestinationTransport rejects missing, empty, or malformed route freshness fields', async (t) => {
  const base = {
    pr: 42,
    live: {
      head: 'a'.repeat(40),
      generation: 'g1-aaaaaaaaaaaa',
      artifactDigest: digest('b'),
      buildInputDigest: digest('c'),
      environmentNonce: 'environment_nonce_42',
    },
  };
  const cases = [
    ['empty generation', { ...base, live: { ...base.live, generation: '' } }],
    ['omitted generation', { ...base, live: { ...base.live, generation: undefined } }],
    ['omitted nonce', { ...base, live: { ...base.live, environmentNonce: undefined } }],
    ['malformed nonce', { ...base, live: { ...base.live, environmentNonce: 'not a nonce!' } }],
  ];

  for (const [name, resolution] of cases) {
    await t.test(name, async () => {
      const transport = new RemoteDestinationTransport({
        fetchImpl: async (_url, init) => {
          assert.ok(init.signal instanceof AbortSignal);
          return jsonResponse(resolution);
        },
        openBrowser: completeLoopback,
      });
      await assert.rejects(transport.create({ pr: 42, sessionIds: ['session-1'] }), /invalid live route provenance/);
    });
  }
});

test('RemoteDestinationTransport bounds JSON bodies and deadlines every transfer request', async () => {
  let pulls = 0;
  const oversized = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls > 20) controller.close();
      else controller.enqueue(new Uint8Array(1024 * 1024));
    },
  });
  const rejecting = new RemoteDestinationTransport({
    fetchImpl: async () => new Response(oversized, { headers: { 'content-type': 'application/json' } }),
    openBrowser: completeLoopback,
  });
  await assert.rejects(rejecting.create({ pr: 42, sessionIds: ['session-1'] }), /response is too large/);
  assert.ok(pulls <= 4, `bounded reader pulled ${pulls} chunks`);

  const requests = [];
  const transport = new RemoteDestinationTransport({
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      if (init.method === 'POST' && String(url).endsWith('/_destination/imports')) {
        return jsonResponse({
          importId: 'destination_id_123456',
          uploadBaseUrl: 'https://pr-42-preview.sessions.vza.net/_destination/imports/destination_id_123456',
          requiredObjectIds: [],
        });
      }
      if (init.method === 'GET') return jsonResponse({ status: 'complete' });
      return new Response(null, { status: 204 });
    },
  });
  await transport.transfer({
    destination: { pr: 42, destinationId: 'destination_id_123456' },
    attestation: {},
    manifest: { objects: [] },
    exchangeCapability: 'ZXhjaGFuZ2U',
    source: {},
  });
  assert.equal(requests.length, 3);
  for (const { init } of requests) assert.ok(init.signal instanceof AbortSignal);
});

async function completeLoopback(browserUrl) {
  const url = new URL(browserUrl);
  assert.equal(url.hash, '');
  assert.deepEqual([...url.searchParams.keys()], ['request']);
  const encoded = url.searchParams.get('request');
  const request = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  const callback = new URL(request.callback);
  callback.searchParams.set('code', 'Y29kZQ');
  callback.searchParams.set('state', request.state);
  const response = await fetch(callback);
  assert.equal(response.status, 200);
}
