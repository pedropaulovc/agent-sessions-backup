import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLOUDFLARE_MINIMUM_REQUEST_INTERVAL_MS,
  createCloudflareApiPacer,
} from '../scripts/lib/cloudflare-api-budget.mjs';
import { PREVIEW_ACCOUNT_ID } from '../../infra/cf/preview-trust.mjs';
import { indexControlClient as currentIndexControlClient } from '../../infra/cf/index-control.mjs';

const { indexControlClient } = await import(process.env.INDEX_CONTROL_PATH
  ?? new URL('../../infra/cf/index-control.mjs', import.meta.url).href);
const WINDOW_MS = 300_000;
const MAXIMUM_REQUESTS_PER_WINDOW = 1200;
const TOKEN = 'synthetic-preview-api-budget-token';
const turn = () => new Promise((resolve) => setImmediate(resolve));

function createClock(initial = 0) {
  let timestamp = initial;
  const timers = [];
  const waits = [];
  return {
    now: () => timestamp,
    sleep(milliseconds) {
      waits.push({ started: timestamp, milliseconds });
      return new Promise((resolve) => timers.push({ deadline: timestamp + milliseconds, resolve }));
    },
    waits,
    get pending() { return timers.length; },
    nextWake() { return Math.min(...timers.map((timer) => timer.deadline)); },
    advanceTo(value) {
      timestamp = value;
      const ready = [];
      for (let index = timers.length - 1; index >= 0; index -= 1) {
        if (timers[index].deadline <= timestamp) ready.unshift(...timers.splice(index, 1));
      }
      for (const timer of ready) timer.resolve();
    },
    wakeNextAt(value) {
      timestamp = value;
      const index = timers.findIndex((timer) => timer.deadline === this.nextWake());
      assert.ok(index >= 0, 'a pending timer is required to simulate an early wake');
      timers.splice(index, 1)[0].resolve();
    },
  };
}

async function runWithClock(clock, work) {
  let outcome;
  const completed = Promise.resolve(work).then(
    (value) => { outcome = { value }; },
    (error) => { outcome = { error }; },
  );
  while (!outcome) {
    // Drain promise continuations before advancing a timer. A fake sleep that
    // changes time synchronously can itself make unrelated starts appear to burst.
    await turn();
    if (outcome) break;
    assert.ok(clock.pending > 0, 'work stalled without a pacing or retry timer');
    clock.advanceTo(Math.max(clock.now(), clock.nextWake()));
  }
  await completed;
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}

function assertRequestBudget(starts) {
  assert.ok(starts.length > MAXIMUM_REQUESTS_PER_WINDOW, 'exercise more than one full request budget');
  let left = 0;
  for (let right = 0; right < starts.length; right += 1) {
    // Count each half-open rolling window ending at an observed request. Counts
    // change only at starts/expirations, so these cover every possible window.
    while (starts[right] - starts[left] >= WINDOW_MS) left += 1;
    assert.ok(right - left + 1 <= MAXIMUM_REQUESTS_PER_WINDOW,
      `rolling ${WINDOW_MS}ms window at ${starts[right]} contains ${right - left + 1} requests`);
  }
  assert.ok(starts.at(-1) - starts[0] > WINDOW_MS, 'exercise rolling-window boundaries');
  for (let index = 1; index < starts.length; index += 1) {
    assert.ok(starts[index] - starts[index - 1] >= CLOUDFLARE_MINIMUM_REQUEST_INTERVAL_MS,
      `request ${index} started too close to its predecessor`);
  }
}

function previewClients(clock, count = 2) {
  const permit = createCloudflareApiPacer({ now: clock.now, sleep: clock.sleep });
  return Array.from({ length: count }, () => indexControlClient(PREVIEW_ACCOUNT_ID, TOKEN, {
    permit, wait: clock.sleep,
  }));
}

function requestId(input, init) {
  const url = new URL(input);
  assert.equal(url.origin, 'https://api.cloudflare.com');
  const prefix = `/client/v4/accounts/${PREVIEW_ACCOUNT_ID}/d1/database/`;
  assert.ok(url.pathname.startsWith(prefix), 'only synthetic preview-account requests are permitted');
  assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${TOKEN}`);
  return url.pathname.slice(prefix.length);
}

const success = (result) => Response.json({ success: true, errors: [], result });

test('concurrent permits are FIFO and obey the external rolling five-minute budget', async () => {
  const clock = createClock(WINDOW_MS - 17);
  const permit = createCloudflareApiPacer({ now: clock.now, sleep: clock.sleep });
  const starts = [];
  const count = 2505;
  await runWithClock(clock, Promise.all(Array.from({ length: count }, async (_, id) => {
    assert.equal(await permit(), undefined, 'a permit returns no semantic state');
    starts.push({ id, at: clock.now() });
  })));
  assert.deepEqual(starts.map(({ id }) => id), Array.from({ length: count }, (_, id) => id));
  assertRequestBudget(starts.map(({ at }) => at));
  assert.ok(starts.at(-1).at - starts[0].at > 2 * WINDOW_MS, 'cross multiple window boundaries');
});

test('a late event-loop wake never releases a backlog into expired slots', async () => {
  const clock = createClock(1000);
  const permit = createCloudflareApiPacer({ now: clock.now, sleep: clock.sleep });
  const starts = [];
  const work = Promise.all(Array.from({ length: 4 }, async (_, id) => {
    await permit();
    starts.push({ id, at: clock.now() });
  }));
  await turn();
  assert.deepEqual(starts.map(({ id }) => id), [0]);
  assert.equal(clock.pending, 1, 'only the FIFO head waits for a permit');
  clock.advanceTo(3 * WINDOW_MS);
  await turn();
  assert.deepEqual(starts.map(({ id }) => id), [0, 1], 'late wake permits only the current head');
  assert.equal(clock.pending, 1);
  assert.ok(clock.nextWake() >= starts[1].at + CLOUDFLARE_MINIMUM_REQUEST_INTERVAL_MS);
  await runWithClock(clock, work);
  assert.deepEqual(starts.map(({ id }) => id), [0, 1, 2, 3]);
  for (let index = 1; index < starts.length; index += 1) {
    assert.ok(starts[index].at - starts[index - 1].at >= CLOUDFLARE_MINIMUM_REQUEST_INTERVAL_MS);
  }
});

test('early timer wakes and a backward clock preserve the previous permit deadline', async () => {
  const clock = createClock(10_000);
  const permit = createCloudflareApiPacer({ now: clock.now, sleep: clock.sleep });
  const starts = [];
  await permit();
  starts.push(clock.now());
  const deadline = starts[0] + CLOUDFLARE_MINIMUM_REQUEST_INTERVAL_MS;
  const second = permit().then(() => starts.push(clock.now()));
  await turn();
  clock.wakeNextAt(starts[0] - 5000);
  await turn();
  assert.deepEqual(starts, [10_000], 'rollback must not grant an early permit');
  assert.equal(clock.nextWake(), deadline, 'the original deadline survives rollback');
  const third = permit().then(() => starts.push(clock.now()));
  clock.advanceTo(deadline - 1);
  await turn();
  assert.equal(starts.length, 1);
  clock.advanceTo(deadline);
  await turn();
  assert.equal(starts.length, 2);
  await runWithClock(clock, Promise.all([second, third]));
  assert.ok(starts[2] - starts[1] >= CLOUDFLARE_MINIMUM_REQUEST_INTERVAL_MS);
});

test('a rejected sleep reaches its caller without poisoning the FIFO tail', async () => {
  const clock = createClock();
  const failure = new Error('synthetic sleep failure');
  let remainingFailures = 1;
  const permit = createCloudflareApiPacer({ now: clock.now, sleep(milliseconds) {
    if (remainingFailures-- > 0) throw failure;
    return clock.sleep(milliseconds);
  } });
  await permit();
  const rejected = assert.rejects(permit(), (error) => error === failure);
  const recovered = permit();
  await runWithClock(clock, Promise.all([rejected, recovered]));
  assert.equal(await recovered, undefined);
  assert.ok(clock.now() >= CLOUDFLARE_MINIMUM_REQUEST_INTERVAL_MS);
  assert.equal(clock.waits.length, 1, 'a failed sleep is not retried for its original caller');
});

test('a rejected clock read reaches its caller while later callers retain FIFO order', async () => {
  const clock = createClock();
  const failure = new Error('synthetic clock failure');
  let remainingFailures = 1;
  const permit = createCloudflareApiPacer({ now() {
    if (remainingFailures-- > 0) throw failure;
    return clock.now();
  }, sleep: clock.sleep });
  const rejected = assert.rejects(permit(), (error) => error === failure);
  const starts = [];
  const later = Array.from({ length: 3 }, async (_, id) => {
    await permit();
    starts.push({ id, at: clock.now() });
  });
  await runWithClock(clock, Promise.all([rejected, ...later]));
  assert.deepEqual(starts.map(({ id }) => id), [0, 1, 2]);
  assert.equal(clock.waits.length, 2);
});

test('actual controller clients share a request-start budget including concurrent 429 replays', async (t) => {
  const clock = createClock(WINDOW_MS - 23);
  const clients = previewClients(clock);
  const requests = [];
  const attempts = new Map();
  const count = 1301;
  // Historical controllers ignore the injected wait argument and call their
  // module's setTimeout-based sleep. Keep that exact code on the same virtual
  // clock so INDEX_CONTROL_PATH controls reach the external rate assertion.
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) => {
    clock.sleep(milliseconds).then(() => callback(...args));
    return 0;
  });
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const id = Number(requestId(input, init));
    const attempt = (attempts.get(id) ?? 0) + 1;
    attempts.set(id, attempt);
    requests.push({ id, attempt, at: clock.now() });
    if (id % 4 === 0 && attempt === 1) {
      return new Response(null, { status: 429, headers: { 'retry-after': '1' } });
    }
    return success({ id });
  });
  const results = await runWithClock(clock, Promise.all(Array.from({ length: count }, (_, id) =>
    clients[id % clients.length].cf(`d1/database/${id}`))));
  assert.deepEqual(results, Array.from({ length: count }, (_, id) => ({ id })));
  assert.equal(requests.length, count + Math.ceil(count / 4));
  assert.deepEqual(requests.filter(({ attempt }) => attempt === 1).map(({ id }) => id),
    Array.from({ length: count }, (_, id) => id));
  assertRequestBudget(requests.map(({ at }) => at));
  for (const request of requests.filter(({ attempt }) => attempt === 2)) {
    const initial = requests.find(({ id, attempt }) => id === request.id && attempt === 1);
    assert.ok(request.at - initial.at >= 1000, '429 replay also honors retry-after');
  }
  assert.equal(clock.waits.filter(({ milliseconds }) => milliseconds === 1000).length,
    Math.ceil(count / 4));
});

test('canonical controller rejects unknown response formats before HTTP', async (t) => {
  // Keep this new API contract on the canonical module even when the pacing
  // tests execute an older controller through INDEX_CONTROL_PATH.
  const clock = createClock();
  const permit = createCloudflareApiPacer({ now: clock.now, sleep: clock.sleep });
  const client = currentIndexControlClient(PREVIEW_ACCOUNT_ID, TOKEN, { permit, wait: clock.sleep });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    requestId(input, init);
    requests += 1;
    assert.fail('invalid response formats must not reach HTTP');
  });
  await assert.rejects(client.cf('d1/database/formats', { responseFormat: 'unknown' }),
    /response format must be result or envelope/);
  assert.equal(requests, 0, 'invalid formats do not issue an HTTP request');
});

test('controller permits do not serialize HTTP response completion', async (t) => {
  const clock = createClock();
  const clients = previewClients(clock);
  const requests = [];
  let finishSlow;
  const slowResponse = new Promise((resolve) => { finishSlow = resolve; });
  t.after(() => finishSlow(success('slow')));
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const id = requestId(input, init);
    requests.push({ id, at: clock.now() });
    return id === 'slow' ? slowResponse : success('fast');
  });
  let slowFinished = false;
  const slow = clients[0].cf('d1/database/slow').then((result) => {
    slowFinished = true;
    return result;
  });
  await turn();
  const fast = clients[1].cf('d1/database/fast');
  assert.equal(await runWithClock(clock, fast), 'fast');
  assert.equal(slowFinished, false, 'the next request starts before the previous response resolves');
  assert.deepEqual(requests.map(({ id }) => id), ['slow', 'fast']);
  assert.ok(requests[1].at - requests[0].at >= CLOUDFLARE_MINIMUM_REQUEST_INTERVAL_MS);
  finishSlow(success('slow'));
  assert.equal(await slow, 'slow');
});

test('controller does not add network, 5xx, envelope, or response-shape retries', async (t) => {
  const networkFailure = new Error('synthetic network failure');
  const scenarios = [
    { name: 'network rejection', reply: () => { throw networkFailure; }, expected: (error) => error === networkFailure },
    { name: 'HTTP 503', reply: () => Response.json({ success: false, errors: [{ code: 1000 }] }, { status: 503 }), expected: /HTTP 503/ },
    { name: 'non-JSON response', reply: () => new Response('not JSON'), expected: /non-JSON HTTP 200/ },
    { name: 'unsuccessful envelope', reply: () => Response.json({ success: false, errors: [{ code: 1000 }] }), expected: /HTTP 200/ },
    { name: 'unexpected D1 result shape', reply: () => success([{ success: true, results: {} }]), operation: (client) => client.db('failure').query('SELECT 1') },
    { name: '429 without retry-after', reply: () => new Response(null, { status: 429 }), expected: /valid retry-after/ },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async (child) => {
      const clock = createClock();
      const [client] = previewClients(clock, 1);
      let requests = 0;
      child.mock.method(globalThis, 'fetch', async (input, init) => {
        requestId(input, init);
        requests += 1;
        return scenario.reply();
      });
      const operation = scenario.operation ?? ((api) => api.cf('d1/database/failure'));
      await assert.rejects(runWithClock(clock, operation(client)), scenario.expected);
      assert.equal(requests, 1, 'ambiguous failures must not cause another HTTP attempt');
      assert.equal(clock.waits.length, 0, 'no speculative backoff is introduced');
    });
  }
});
