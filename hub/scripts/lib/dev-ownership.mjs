import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const OWNER_FILE = 'owner.json';
const RUNTIME_FILE = 'runtime.json';
const LOCK_DIR = '.owner.lock';

function parseRecord(text, label) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is corrupt; refusing an unsafe ownership decision`);
  }
  if (!value || !Number.isInteger(value.pid) || value.pid <= 0 || typeof value.nonce !== 'string' || !value.nonce || typeof value.processStartIdentity !== 'string' || !value.processStartIdentity) {
    throw new Error(`${label} has an invalid ownership record; refusing an unsafe ownership decision`);
  }
  return value;
}

export function createEnvironmentNonce() {
  return randomBytes(24).toString('hex');
}

function linuxProcessIdentity(pid) {
  try {
    const boot = spawnSync('cat', ['/proc/sys/kernel/random/boot_id'], { encoding: 'utf8', windowsHide: true });
    if (boot.error || boot.status !== 0) throw boot.error ?? new Error(boot.stderr);
    const proc = spawnSync('cat', [`/proc/${pid}/stat`], { encoding: 'utf8', windowsHide: true });
    if (proc.status !== 0) return null;
    if (proc.error) throw proc.error;
    const close = proc.stdout.lastIndexOf(')');
    if (close < 0) throw new Error(`unexpected /proc/${pid}/stat format`);
    const fields = proc.stdout.slice(close + 2).trim().split(/\s+/);
    const startTicks = fields[19];
    if (!startTicks) throw new Error(`missing process start time for pid ${pid}`);
    return `linux:${boot.stdout.trim()}:${startTicks}`;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`cannot inspect process ${pid}: ${error.message}`);
  }
}

function windowsProcessIdentity(pid) {
  const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop;if($null -ne $p){$p.CreationDate.ToUniversalTime().ToString('O')}`;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw new Error(`cannot inspect process ${pid}: ${result.error.message}`);
  if (result.status !== 0) {
    if (/not found|no instance/i.test(result.stderr)) return null;
    throw new Error(`cannot inspect process ${pid}: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  const created = result.stdout.trim();
  return created ? `windows:${created}` : null;
}

function posixProcessIdentity(pid) {
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', windowsHide: true });
  if (result.error) throw new Error(`cannot inspect process ${pid}: ${result.error.message}`);
  if (result.status !== 0 || !result.stdout.trim()) return null;
  return `${process.platform}:${result.stdout.trim()}`;
}

export function processStartIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') return linuxProcessIdentity(pid);
  if (process.platform === 'win32') return windowsProcessIdentity(pid);
  return posixProcessIdentity(pid);
}

export function recordMatchesLiveProcess(record, inspectProcess = processStartIdentity) {
  const current = inspectProcess(record.pid);
  return current !== null && current === record.processStartIdentity;
}

async function readOptionalRecord(path, label) {
  try {
    return parseRecord(await readFile(path, 'utf8'), label);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function acquireOwnership(stateDir, nonce, options = {}) {
  const inspectProcess = options.inspectProcess ?? processStartIdentity;
  const lockDir = join(stateDir, LOCK_DIR);
  const ownerPath = join(lockDir, OWNER_FILE);
  const runtimePath = join(stateDir, RUNTIME_FILE);
  await mkdir(stateDir, { recursive: true });

  for (;;) {
    try {
      await mkdir(lockDir);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const owner = await readOptionalRecord(ownerPath, 'environment owner');
      const runtime = await readOptionalRecord(runtimePath, 'environment runtime');
      if (owner && recordMatchesLiveProcess(owner, inspectProcess)) {
        throw new Error(`environment is owned by live process ${owner.pid}; nonce ${owner.nonce}`);
      }
      if (runtime && recordMatchesLiveProcess(runtime, inspectProcess)) {
        throw new Error(`environment has live Wrangler process ${runtime.pid}; nonce ${runtime.nonce}`);
      }
      if (owner && runtime && owner.nonce !== runtime.nonce) {
        throw new Error('stale environment owner and runtime records have mismatched nonces');
      }
      if (!owner) {
        let lockStat;
        try {
          lockStat = await stat(lockDir);
        } catch (statError) {
          if (statError?.code === 'ENOENT') continue;
          throw statError;
        }
        const age = Date.now() - lockStat.mtimeMs;
        if (age < 30_000) throw new Error(`environment ownership is being acquired: ${stateDir}`);
      }
      const staleLock = `${lockDir}.stale-${nonce}`;
      try {
        await rename(lockDir, staleLock);
      } catch (renameError) {
        if (renameError?.code === 'ENOENT' || renameError?.code === 'EEXIST') continue;
        throw renameError;
      }
      await rm(staleLock, { recursive: true, force: false });
      continue;
    }

    try {
      const runtime = await readOptionalRecord(runtimePath, 'environment runtime');
      if (runtime && recordMatchesLiveProcess(runtime, inspectProcess)) {
        throw new Error(`environment has live Wrangler process ${runtime.pid}; nonce ${runtime.nonce}`);
      }
      if (runtime) await rm(runtimePath, { force: true });
      const processStart = inspectProcess(process.pid);
      if (!processStart) throw new Error(`cannot establish the current process start identity for pid ${process.pid}`);
      const owner = {
        version: 1,
        pid: process.pid,
        nonce,
        processStartIdentity: processStart,
        acquiredAt: new Date().toISOString(),
      };
      await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      return owner;
    } catch (error) {
      await rm(lockDir, { recursive: true, force: true });
      throw error;
    }
  }
}

export async function recordRuntime(stateDir, owner, childPid, inspectProcess = processStartIdentity) {
  const childStart = inspectProcess(childPid);
  if (!childStart) throw new Error(`cannot establish Wrangler process start identity for pid ${childPid}`);
  const runtime = {
    version: 1,
    pid: childPid,
    nonce: owner.nonce,
    processStartIdentity: childStart,
    ownerPid: owner.pid,
    ownerProcessStartIdentity: owner.processStartIdentity,
    startedAt: new Date().toISOString(),
  };
  await writeFile(join(stateDir, RUNTIME_FILE), `${JSON.stringify(runtime, null, 2)}\n`, 'utf8');
  return runtime;
}

export async function releaseOwnership(stateDir, owner) {
  const lockDir = join(stateDir, LOCK_DIR);
  const current = await readOptionalRecord(join(lockDir, OWNER_FILE), 'environment owner');
  if (!current) return;
  if (current.nonce !== owner.nonce || current.pid !== owner.pid || current.processStartIdentity !== owner.processStartIdentity) {
    throw new Error('environment ownership changed; refusing to release another owner lock');
  }
  await rm(lockDir, { recursive: true, force: false });
}
async function readEnvironmentManifest(stateDir) {
  const path = join(stateDir, 'environment-manifest.json');
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`${path} is corrupt; refusing an unsafe ownership decision`);
  }
  if (value?.host !== '127.0.0.1' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
      typeof value.environmentNonce !== 'string' || !value.environmentNonce) {
    throw new Error(`${path} has invalid runtime diagnostics; refusing an unsafe ownership decision`);
  }
  return value;
}

async function matchingLiveNonce(stateDir, runtime) {
  const manifest = await readEnvironmentManifest(stateDir);
  if (!manifest) return null;
  if (runtime && runtime.nonce !== manifest.environmentNonce) {
    throw new Error('refusing reset: runtime record and environment manifest have mismatched nonces');
  }
  try {
    const response = await fetch(`http://127.0.0.1:${manifest.port}/healthz`, { signal: AbortSignal.timeout(750) });
    if (!response.ok) return null;
    const body = await response.json();
    return body?.environmentNonce === manifest.environmentNonce ? manifest.environmentNonce : null;
  } catch {
    return null;
  }
}


async function assertOwnedForReset(stateDir, owner, inspectProcess = processStartIdentity) {
  const current = await readOptionalRecord(join(stateDir, LOCK_DIR, OWNER_FILE), 'environment owner');
  if (!current || current.nonce !== owner.nonce || current.pid !== owner.pid ||
      current.processStartIdentity !== owner.processStartIdentity) {
    throw new Error('reset ownership changed before deletion');
  }
  const runtime = await readOptionalRecord(join(stateDir, RUNTIME_FILE), 'environment runtime');
  if (runtime && recordMatchesLiveProcess(runtime, inspectProcess)) {
    throw new Error(`refusing reset: Wrangler process ${runtime.pid} is active (nonce ${runtime.nonce})`);
  }
  const liveNonce = await matchingLiveNonce(stateDir, runtime);
  if (liveNonce) throw new Error(`refusing reset: matching live environment nonce ${liveNonce} is active`);
}

export async function removeOwnedState(stateDir, owner, options = {}) {
  await assertOwnedForReset(stateDir, owner, options.inspectProcess);
  const quarantine = join(dirname(stateDir), `.${owner.nonce}.reset`);
  await rename(stateDir, quarantine);
  await rm(quarantine, { recursive: true, force: false });
}
