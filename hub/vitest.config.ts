import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: { ENVIRONMENT: 'development', SETUP_TOKEN: 'test-setup-token', TEST_MIGRATIONS: migrations },
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
      // These are workers-pool INTEGRATION tests: a single `it` routinely drives several full
      // miniflare round-trips (HTTP PUT -> R2 -> D1, then a queue-consumer parse writing blocks +
      // FTS5 + sessions + usage). A clean local run of the heaviest of them (e.g. the subagent
      // meta-linking pair: 2x putFile + 2x drainQueue) is ~1.7s. vitest's 5s default is a
      // UNIT-test budget: under the CPU contention of CI (or many test files running in parallel
      // in the shared pool) those round-trips fan out and the same test spikes past 5s, timing out
      // nondeterministically — whichever heavy test happens to land in the contention window, not
      // any one test in particular (reproduced: 5/6 full-suite runs under load timed out, on two
      // different subagent tests). Give the whole integration suite a budget sized for that
      // contention rather than peppering `}, N)` onto individual heavy tests (which only moves the
      // flake to the next-heaviest one). Still bounded, so a genuinely hung test fails in time.
      testTimeout: 15000,
    },
  };
});
