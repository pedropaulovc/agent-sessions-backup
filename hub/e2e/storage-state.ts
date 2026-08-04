import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const STORAGE_STATE_RUN_ID = 'SESSIONS_HUB_PLAYWRIGHT_RUN_ID';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Environment = Record<string, string | undefined>;
type StorageState = {
  cookies: unknown[];
  origins: unknown[];
};
interface StorageStateFileSystem {
  create(path: string, contents: string): Promise<void>;
  remove(path: string): Promise<void>;
}

const nodeStorageStateFileSystem: StorageStateFileSystem = {
  async create(storageStatePath, contents) {
    await writeFile(storageStatePath, contents, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  },
  async remove(storageStatePath) {
    await rm(storageStatePath, { force: true });
  },
};

export function requiredCloudflareAccessHeaders(environment: Environment): Record<string, string> {
  const clientId = environment.CF_ACCESS_CLIENT_ID?.trim();
  const clientSecret = environment.CF_ACCESS_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error('Cloudflare Access service credentials are required');
  return {
    'cf-access-client-id': clientId,
    'cf-access-client-secret': clientSecret,
  };
}


export function previewStorageStatePath(
  bootstrapFile: string | undefined,
  environment: Environment,
  temporaryDirectory = tmpdir(),
  createRunId: () => string = randomUUID,
): string | undefined {
  if (!bootstrapFile) return undefined;

  let runId = environment[STORAGE_STATE_RUN_ID];
  if (runId === undefined) {
    runId = createRunId();
    environment[STORAGE_STATE_RUN_ID] = runId;
  }
  if (!UUID.test(runId)) throw new Error(`${STORAGE_STATE_RUN_ID} must be a UUID`);

  return path.join(temporaryDirectory, `sessions-hub-playwright-${runId}.json`);
}

export async function createPreviewStorageState(
  storageStatePath: string,
  state: StorageState,
  fileSystem: StorageStateFileSystem = nodeStorageStateFileSystem,
): Promise<() => Promise<void>> {
  await fileSystem.create(storageStatePath, `${JSON.stringify(state)}\n`);
  return () => fileSystem.remove(storageStatePath);
}
