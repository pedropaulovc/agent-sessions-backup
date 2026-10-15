import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { writeLocalConfig } from './scripts/lib/local-config.mjs';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  const indexMigrations = await readD1Migrations('./migrations-index');
  const hubRoot = fileURLToPath(new URL('.', import.meta.url));
  const { configPath } = await writeLocalConfig({
    stateDir: fileURLToPath(new URL('./.dev/vitest/', import.meta.url)),
    hubRoot,
    revision: 'test',
  });
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath },
        miniflare: {
          bindings: {
            ENVIRONMENT: 'development',
            SETUP_TOKEN: 'test-setup-token',
            TEST_MIGRATIONS: migrations,
            TEST_INDEX_MIGRATIONS: indexMigrations,
            CF_OAUTH_CLIENT_ID: 'test-oauth-client',
          },
          // The local queue simulator auto-delivers parse and rollup messages on its own real-time
          // timer (the base Wrangler config sets no max_batch_timeout, so it falls back to a short local
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
          queueConsumers: {
            parse: { maxBatchTimeout: 60, maxBatchSize: 100 },
            'session-rollup': { maxBatchTimeout: 60, maxBatchSize: 100 },
          },
        },
      }),
    ],
    test: {
      // Suites that run under `node --test` (own npm script each) carry a `.node.test.mjs`
      // suffix so this stays ONE pattern. It used to be a hand-maintained list of filenames,
      // and adding a file without adding its line handed it to the wrong runner: vitest loaded
      // it, found no vitest `test()` registration, and failed the hub job with "0 test". A
      // per-file list also cannot be relaxed to `*.test.mjs`, because `.mjs` alone does not
      // imply the runner — `preview-control-trust.test.mjs` is a real vitest suite.
      exclude: [...configDefaults.exclude, 'e2e/**', 'test/**/*.node.test.mjs'],
      setupFiles: ['./test/apply-migrations.ts'],
      // Bound integration-test workerd/R2/D1 RPC fan-out, preserving Vitest's
      // lower run-mode default on small hosts. A full-suite control observed
      // the two ~16s cases at ~2s with four workers; fixtures, storage isolation
      // and the 15s deadline were unchanged.
      // Reproduce on a 16-thread host with --maxWorkers=15 versus 4:
      // npm exec -- vitest run --maxWorkers=4 --reporter=verbose
      maxWorkers: Math.min(4, Math.max(availableParallelism() - 1, 1)),
      testTimeout: 15000,
      // Hooks need a larger integration bound: vitest's 10s default is below
      // even testTimeout, yet the fixture-heaviest hooks do MORE round-trips than any single
      // test — viewer.test.ts's beforeAll pushes six sessions through the full upload+ingest
      // path (one ~190KB/450-turn), and timed out at 10s on a contended CI runner (run
      // 31673596635) with zero hub changes in the diff. Sized above testTimeout because setup
      // legitimately batches many round-trips; still bounded.
      hookTimeout: 30000,
    },
  };
});
