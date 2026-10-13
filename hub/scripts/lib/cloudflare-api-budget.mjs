export const CLOUDFLARE_MINIMUM_REQUEST_INTERVAL_MS = 300;
export const CLOUDFLARE_REQUEST_RATE_PER_SECOND = 1000 / CLOUDFLARE_MINIMUM_REQUEST_INTERVAL_MS;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createCloudflareApiPacer({ now = Date.now, sleep: wait = sleep } = {}) {
  let tail = Promise.resolve();
  let nextPermit = -Infinity;

  return function permit() {
    const pending = tail.then(async () => {
      let timestamp = now();
      while (timestamp < nextPermit) {
        await wait(nextPermit - timestamp);
        timestamp = now();
      }
      // Reserve from the actual wake time, not an expired slot: late timers must not
      // release a backlog together. A clock rollback keeps the existing deadline.
      nextPermit = timestamp + CLOUDFLARE_MINIMUM_REQUEST_INTERVAL_MS;
    });
    // Only the queue tail recovers. The caller still receives its own clock/sleep
    // error, and later permits remain usable without retrying that failed call.
    tail = pending.catch(() => {});
    return pending;
  };
}

export const sharedCloudflareApiPermit = createCloudflareApiPacer();
