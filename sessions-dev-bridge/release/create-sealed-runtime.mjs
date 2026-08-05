import { cp, lstat, mkdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'release', 'runtime');
const modules = join(output, 'lib', 'node_modules');
const packageRoot = join(modules, 'sessions-dev-bridge');

await rm(output, { recursive: true, force: true });
await mkdir(join(output, 'lib'), { recursive: true, mode: 0o700 });
await copyTree(join(root, 'node_modules'), modules);
await mkdir(packageRoot, { mode: 0o700 });
await Promise.all([
  copyTree(join(root, 'package.json'), join(packageRoot, 'package.json')),
  copyTree(join(root, 'release-provenance.json'), join(packageRoot, 'release-provenance.json')),
  copyTree(join(root, 'src'), join(packageRoot, 'src')),
]);

async function copyTree(source, destination) {
  await cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
    filter: async (path) => {
      if (basename(path) === '.bin') return false;
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`sealed runtime source contains a symbolic link: ${path}`);
      if (!stat.isDirectory() && !stat.isFile()) throw new Error(`sealed runtime source contains a non-file entry: ${path}`);
      return true;
    },
  });
}
