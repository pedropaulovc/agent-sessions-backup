import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: { ENVIRONMENT: 'development', TEST_MIGRATIONS: migrations },
          // The local queue simulator auto-delivers PARSE_QUEUE messages on its own real-time
          // timer (wrangler.jsonc sets no max_batch_timeout, so it falls back to a short local
          // default — observed firing well under 1.5s), independent of and in addition to this
          // suite's explicit drainQueue()/deliverOne() helpers. Every test that puts a file in a
          // deliberately-still-pending state (to test ordering against a LATER explicit delivery)
          // relies on that automatic delivery never firing mid-test — true almost always locally,
          // but a real, reproducible race under CI's extra scheduling latency (more test files,
          // more contention): a message queued early in a test can auto-deliver out from under an
          // assertion that expected it to still be pending. Push both auto-flush triggers (time
          // and batch size) to their config maximums so the local simulator never fires on its
          // own within a test's lifetime — delivery stays fully driven by the explicit test
          // helpers, matching what the whole suite already assumes.
          queueConsumers: { parse: { maxBatchTimeout: 60, maxBatchSize: 100 } },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
    },
  };
});
