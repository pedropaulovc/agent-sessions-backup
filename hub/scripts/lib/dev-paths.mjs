import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HUB_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const DEV_ROOT = resolve(HUB_ROOT, '.dev');

function isDescendant(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function assertNoEscapingSymlink(candidate) {
  await mkdir(DEV_ROOT, { recursive: true });
  const realDevRoot = await realpath(DEV_ROOT);
  if (!isDescendant(HUB_ROOT, realDevRoot)) {
    throw new Error(`unsafe .dev root resolves outside the hub: ${realDevRoot}`);
  }

  const rel = relative(DEV_ROOT, candidate);
  let cursor = DEV_ROOT;
  for (const segment of rel.split(sep)) {
    cursor = resolve(cursor, segment);
    try {
      const entry = await lstat(cursor);
      if (!entry.isSymbolicLink()) continue;
      const target = await realpath(cursor);
      if (target !== realDevRoot && !isDescendant(realDevRoot, target)) {
        throw new Error(`unsafe state path crosses an escaping symlink: ${cursor} -> ${target}`);
      }
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
}

export async function resolveStatePath(input) {
  if (typeof input !== 'string' || input.trim() === '') throw new Error('state path must be non-empty');
  const candidate = resolve(HUB_ROOT, input);
  if (!isDescendant(DEV_ROOT, candidate)) {
    throw new Error(`unsafe state path is outside ${DEV_ROOT}: ${candidate}`);
  }
  await assertNoEscapingSymlink(candidate);
  return candidate;
}

export async function localStatePath(name, explicit) {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(name)) {
    throw new Error('environment name must match [a-z0-9][a-z0-9-]{0,47}');
  }
  if (!explicit) return resolveStatePath(resolve(DEV_ROOT, 'local', name));
  const candidate = await resolveStatePath(explicit);
  const localRelative = relative(resolve(DEV_ROOT, 'local'), candidate);
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(localRelative)) {
    throw new Error(`local persistence must be exactly .dev/local/<name>: ${candidate}`);
  }
  return candidate;
}

export async function assertSafeExistingStatePath(candidate) {
  const resolved = await resolveStatePath(candidate);
  const realDevRoot = await realpath(DEV_ROOT);
  try {
    const realCandidate = await realpath(resolved);
    if (!isDescendant(realDevRoot, realCandidate)) {
      throw new Error(`unsafe state path resolves outside ${realDevRoot}: ${realCandidate}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return resolved;
}
