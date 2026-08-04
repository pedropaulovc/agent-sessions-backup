import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProductionManifestKeys } from '../src/production-keys.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await loadProductionManifestKeys(join(root, 'src', 'production-manifest-key.json'));
