import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';
import { assertIndexLayout, indexDbs } from '../src/index-shards';

type TestMigrations = Parameters<typeof applyD1Migrations>[1];
const testEnv = env as Env & {
  TEST_MIGRATIONS: TestMigrations;
  TEST_INDEX_MIGRATIONS: TestMigrations;
};
await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
for (const database of indexDbs(testEnv)) {
  await applyD1Migrations(database, testEnv.TEST_INDEX_MIGRATIONS);
}
// Initialize the layout baseline before per-test rollback snapshots are captured.
beforeAll(() => assertIndexLayout(testEnv));
