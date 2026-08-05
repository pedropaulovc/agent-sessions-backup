import { access, lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('runtime tree path is required');

let files = 0;
await scan(root);
await access(join(root, 'lib', 'node_modules', 'sessions-dev-bridge', 'src', 'cli.mjs'));
if (files === 0) throw new Error('sealed runtime tree is empty');

async function scan(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`sealed runtime contains a symbolic link: ${path}`);
    if (stat.isDirectory()) {
      await scan(path);
      continue;
    }
    if (!stat.isFile()) throw new Error(`sealed runtime contains a non-file entry: ${path}`);
    files += 1;
  }
}
