import { applyD1Migrations, env } from 'cloudflare:test';

const testEnv = env as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
