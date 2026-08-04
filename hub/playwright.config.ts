import { defineConfig, devices } from '@playwright/test';
import { previewStorageStatePath } from './e2e/storage-state';

const previewBootstrapFile = process.env.PREVIEW_BOOTSTRAP_FILE?.trim();
const previewStorageState = previewStorageStatePath(previewBootstrapFile, process.env);

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  outputDir: 'test-results',
  reporter: process.env.CI
    ? [['line'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.BASE_URL,
    storageState: previewStorageState,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
