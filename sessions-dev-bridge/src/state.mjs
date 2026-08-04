import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertExactKeys } from './canonical.mjs';

export function defaultStateDirectory() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA;
    if (!base) throw new Error('LOCALAPPDATA is required for protected bridge state');
    return join(base, 'sessions-dev-bridge');
  }
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'sessions-dev-bridge');
}

export class StateStore {
  constructor(directory = defaultStateDirectory()) {
    this.directory = directory;
    this.enrollmentPath = join(directory, 'enrollment.json');
    this.lockPath = join(directory, '.lock');
  }

  async loadEnrollment() {
    let parsed;
    try { parsed = JSON.parse(await readFile(this.enrollmentPath, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error('device is not enrolled; run sessions-dev-bridge enroll');
      throw error;
    }
    validateEnrollment(parsed);
    return parsed;
  }

  async saveEnrollment(enrollment) {
    validateEnrollment(enrollment);
    await this.#withLock(async () => this.#write(enrollment));
  }

  async reserveCounter(expectedReleaseDigest) {
    return this.#withLock(async () => {
      const enrollment = await this.loadEnrollment();
      if (enrollment.releaseDigest !== expectedReleaseDigest) throw new Error('device enrollment is for a different bridge release');
      if (enrollment.expiresAt <= Date.now()) throw new Error('device enrollment has expired');
      if (!Number.isSafeInteger(enrollment.counter) || enrollment.counter < 0 || enrollment.counter === Number.MAX_SAFE_INTEGER) {
        throw new Error('invalid or exhausted device monotonic counter');
      }
      enrollment.counter += 1;
      await this.#write(enrollment);
      return structuredClone(enrollment);
    });
  }

  async #write(value) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.enrollment-${randomBytes(12).toString('hex')}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.enrollmentPath);
    } finally { await rm(temporary, { force: true }); }
  }

  async #withLock(operation) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const started = Date.now();
    for (;;) {
      try {
        await mkdir(this.lockPath, { mode: 0o700 });
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() - started > 10_000) throw new Error('another bridge process owns the device state lock');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    try { return await operation(); }
    finally { await rm(this.lockPath, { recursive: true, force: true }); }
  }
}

function validateEnrollment(value) {
  assertExactKeys(value, ['format', 'deviceId', 'deviceLabel', 'keyProvider', 'keyRef', 'publicKeyJwk', 'scope', 'releaseDigest', 'counter', 'expiresAt']);
  if (value.format !== 1 || value.scope !== 'local-destination-attest') throw new Error('invalid enrollment scope');
  for (const key of ['deviceId', 'deviceLabel', 'keyProvider', 'keyRef', 'releaseDigest']) {
    if (typeof value[key] !== 'string' || !value[key]) throw new Error(`invalid enrollment ${key}`);
  }
  if (!['windows-cng-tpm', 'tpm2-pkcs11'].includes(value.keyProvider)) throw new Error('invalid enrollment key provider');
  if (!value.publicKeyJwk || value.publicKeyJwk.kty !== 'EC' || value.publicKeyJwk.crv !== 'P-256' || typeof value.publicKeyJwk.x !== 'string' || typeof value.publicKeyJwk.y !== 'string' || value.publicKeyJwk.d !== undefined) throw new Error('invalid enrollment public key');
  if (!Number.isSafeInteger(value.counter) || value.counter < 0) throw new Error('invalid enrollment counter');
  if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) throw new Error('invalid enrollment expiry');
}
