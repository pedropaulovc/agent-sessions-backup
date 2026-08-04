import { chromium, type FullConfig } from '@playwright/test';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createPreviewStorageState, requiredCloudflareAccessHeaders } from './storage-state';

interface BootstrapEnvelope {
  bootstrapUrl?: unknown;
}

export default async function globalSetup(config: FullConfig): Promise<(() => Promise<void>) | void> {
  const bootstrapFile = process.env.PREVIEW_BOOTSTRAP_FILE?.trim();
  if (!bootstrapFile) return;

  const configuredBaseURL = process.env.BASE_URL?.trim();
  if (!configuredBaseURL) throw new Error('PREVIEW_BOOTSTRAP_FILE requires BASE_URL');
  const baseURL = new URL(configuredBaseURL);
  if (baseURL.protocol !== 'https:') throw new Error('A deployed preview BASE_URL must use HTTPS');
  if (baseURL.username || baseURL.password || baseURL.search || baseURL.hash) {
    throw new Error('BASE_URL must not contain credentials, query parameters, or a fragment');
  }

  const storageState = config.projects[0]?.use.storageState;
  if (typeof storageState !== 'string') throw new Error('Preview storage-state path is not configured');
  const sourcePath = path.resolve(process.env.GITHUB_WORKSPACE ?? process.cwd(), bootstrapFile);
  let envelope: BootstrapEnvelope;
  try {
    envelope = JSON.parse(await readFile(sourcePath, 'utf8')) as BootstrapEnvelope;
  } catch {
    await rm(sourcePath, { force: true }).catch(() => {});
    throw new Error('Could not read the preview bootstrap envelope');
  }
  await rm(sourcePath, { force: true });
  if (typeof envelope.bootstrapUrl !== 'string') throw new Error('Preview bootstrap envelope is malformed');

  let bootstrapURL: URL;
  try {
    bootstrapURL = new URL(envelope.bootstrapUrl);
  } catch {
    throw new Error('Preview bootstrap URL is malformed');
  }
  if (bootstrapURL.protocol !== 'https:' || bootstrapURL.origin !== baseURL.origin) {
    throw new Error('Preview bootstrap URL does not match BASE_URL');
  }

  let cleanupStorageState: () => Promise<void>;
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const accessHeaders = requiredCloudflareAccessHeaders(process.env);
    await context.route(`${baseURL.origin}/**`, async (route) => {
      await route.continue({ headers: { ...route.request().headers(), ...accessHeaders } });
    });
    const page = await context.newPage();
    let response;
    try {
      response = await page.goto(bootstrapURL.toString(), { waitUntil: 'domcontentloaded' });
    } catch {
      throw new Error('Preview bootstrap navigation failed');
    }
    if (!response?.ok() || new URL(page.url()).origin !== baseURL.origin) {
      throw new Error('Preview bootstrap was rejected');
    }
    const state = await context.storageState();
    await context.close();
    cleanupStorageState = await createPreviewStorageState(storageState, state);
  } finally {
    await browser.close();
  }

  return cleanupStorageState;
}
