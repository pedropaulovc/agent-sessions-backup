import { createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { assertExactKeys } from './canonical.mjs';

export async function loadProductionManifestKeys(path) {
  return validateProductionManifestKeys(JSON.parse(await readFile(path, 'utf8')));
}

export function validateProductionManifestKeys(value) {
  assertExactKeys(value, ['keys']);
  if (!Array.isArray(value.keys) || value.keys.length === 0) {
    throw new Error('no protected production manifest verification keys are packaged');
  }
  const activeKeys = [];
  for (const jwk of value.keys) {
    if (
      !jwk
      || jwk.kty !== 'EC'
      || jwk.crv !== 'P-256'
      || typeof jwk.x !== 'string'
      || typeof jwk.y !== 'string'
      || typeof jwk.revoked !== 'boolean'
      || jwk.d !== undefined
    ) throw new Error('production manifest verification keys must be public P-256 JWKs with explicit revocation state');
    createPublicKey({ key: jwk, format: 'jwk' });
    if (!jwk.revoked) activeKeys.push(jwk);
  }
  if (activeKeys.length === 0) {
    throw new Error('no protected production manifest verification keys are packaged');
  }
  return Object.freeze({ keys: Object.freeze(activeKeys) });
}
