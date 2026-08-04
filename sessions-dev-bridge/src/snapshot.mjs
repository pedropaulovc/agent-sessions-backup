import { createDecipheriv, createPublicKey, generateKeyPairSync, privateDecrypt, constants, verify as verifySignature } from 'node:crypto';
import { canonicalBytes, canonicalJson, sha256, assertBase64url, assertExactKeys, assertHex } from './canonical.mjs';
import { zero } from './secure.mjs';
const MAX_OBJECTS = 256;
const MAX_OBJECT_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;


export function generateDestinationKey() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072, publicExponent: 0x10001 });
  return Object.freeze({ publicKeyJwk: publicKey.export({ format: 'jwk' }), privateKey });
}

export class SnapshotVerifier {
  constructor(publicJwks, clock = () => Date.now()) {
    if (!Array.isArray(publicJwks) || publicJwks.length === 0) throw new Error('no protected production manifest verification keys are packaged');
    this.keys = publicJwks.map((jwk) => createPublicKey({ key: jwk, format: 'jwk' }));
    this.clock = clock;
  }

  verifyManifest(manifest, expected) {
    assertExactKeys(manifest, ['format', 'sessionIds', 'inventoryDigest', 'totalSize', 'objectCount', 'expiresAt', 'objects', 'signature']);
    if (manifest.format !== 1) throw new Error('unsupported snapshot manifest');
    if (!Array.isArray(manifest.sessionIds) || manifest.sessionIds.length !== 1 || manifest.sessionIds[0] !== expected.sessionId) throw new Error('snapshot session scope mismatch');
    assertHex(manifest.inventoryDigest, 64, 'inventory digest');
    if (manifest.inventoryDigest !== expected.inventoryDigest) throw new Error('snapshot inventory digest mismatch');
    if (manifest.totalSize !== expected.totalSize || !Number.isSafeInteger(manifest.totalSize) || manifest.totalSize < 0 || manifest.totalSize > MAX_TOTAL_BYTES) throw new Error('snapshot total size mismatch');
    if (!Number.isSafeInteger(manifest.objectCount) || manifest.objectCount < 1 || manifest.objectCount > MAX_OBJECTS || manifest.objectCount !== expected.objectCount || !Array.isArray(manifest.objects) || manifest.objects.length !== manifest.objectCount) throw new Error('snapshot object count mismatch');
    if (!Number.isSafeInteger(manifest.expiresAt) || manifest.expiresAt <= this.clock() || manifest.expiresAt > this.clock() + 15 * 60_000) throw new Error('snapshot manifest expiry is invalid');
    assertExactKeys(manifest.signature, ['alg', 'value']);
    if (manifest.signature.alg !== 'ES256') throw new Error('unsupported snapshot signature');
    const signature = Buffer.from(assertBase64url(manifest.signature.value, 'manifest signature'), 'base64url');
    if (signature.length !== 64) throw new Error('invalid snapshot signature length');
    const unsigned = { ...manifest };
    delete unsigned.signature;
    if (!this.keys.some((key) => verifySignature('sha256', canonicalBytes(unsigned), { key, dsaEncoding: 'ieee-p1363' }, signature))) throw new Error('invalid snapshot manifest signature');

    let previous = '';
    let total = 0;
    let jobId;
    for (const object of manifest.objects) {
      const objectJobId = validateObject(object, manifest);
      if (jobId === undefined) jobId = objectJobId;
      else if (objectJobId !== jobId) throw new Error('snapshot object jobs do not match');
      if (object.objectId <= previous) throw new Error('snapshot objects are not strictly sorted');
      previous = object.objectId;
      total += object.size;
      if (!Number.isSafeInteger(total)) throw new Error('snapshot size overflow');
    }
    if (total !== manifest.totalSize) throw new Error('snapshot plaintext size sum mismatch');
    return Object.freeze(unsigned);
  }
}

export async function decryptObject({ object, ciphertext, privateKey, consume }) {
  const encrypted = Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(ciphertext);
  let wrappedKey;
  let aesKey;
  let plaintext;
  try {
    if (encrypted.length !== object.ciphertextSize || sha256(encrypted) !== object.ciphertextSha256) throw new Error(`ciphertext integrity mismatch for ${object.objectId}`);
    if (encrypted.length < 16) throw new Error(`ciphertext too short for ${object.objectId}`);
    wrappedKey = Buffer.from(object.wrappedKey, 'base64url');
    aesKey = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, wrappedKey);
    if (aesKey.length !== 32) throw new Error('wrapped destination key is not AES-256');
    const nonce = Buffer.from(object.nonce, 'base64url');
    if (nonce.length !== 12) throw new Error('AES-GCM nonce must be 96 bits');
    const body = encrypted.subarray(0, encrypted.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', aesKey, nonce, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(object.aad, 'utf8'));
    decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
    plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
    if (plaintext.length !== object.size || sha256(plaintext) !== object.sha256) throw new Error(`plaintext integrity mismatch for ${object.objectId}`);
    await consume(plaintext);
  } finally {
    zero(plaintext, aesKey, wrappedKey, encrypted);
  }
}

function validateObject(object, manifest) {
  assertExactKeys(object, ['objectId', 'kind', 'store', 'relpath', 'size', 'sha256', 'sessionIds', 'ciphertextSize', 'ciphertextSha256', 'wrappedKey', 'nonce', 'url', 'aad']);
  if (typeof object.objectId !== 'string' || !/^[A-Za-z0-9._:@/-]{1,256}$/.test(object.objectId)) throw new Error('invalid snapshot object id');
  if (object.kind !== 'source' && object.kind !== 'externalAsset') throw new Error('invalid snapshot object kind');
  if (typeof object.store !== 'string' || !/^[a-z0-9-]{1,64}$/.test(object.store)) throw new Error('invalid snapshot object store');
  if (typeof object.relpath !== 'string' || object.relpath.startsWith('/') || object.relpath.includes('\\') || object.relpath.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('invalid snapshot object relative path');
  if (!Array.isArray(object.sessionIds) || object.sessionIds.length < 1 || object.sessionIds.some((id) => !manifest.sessionIds.includes(id))) throw new Error('snapshot object session allowlist mismatch');
  if (!Number.isSafeInteger(object.size) || object.size < 0 || object.size > MAX_OBJECT_BYTES || !Number.isSafeInteger(object.ciphertextSize) || object.ciphertextSize !== object.size + 16) throw new Error('invalid snapshot object size');
  assertHex(object.sha256, 64, 'object plaintext digest');
  assertHex(object.ciphertextSha256, 64, 'object ciphertext digest');
  assertBase64url(object.wrappedKey, 'wrapped key');
  assertBase64url(object.nonce, 'nonce');
  if (Buffer.from(object.nonce, 'base64url').length !== 12) throw new Error('invalid snapshot nonce');
  if (typeof object.url !== 'string' || !object.url.startsWith('/api/v1/debug/exchanges/')) throw new Error('invalid snapshot object URL');
  let aad;
  try { aad = JSON.parse(object.aad); } catch { throw new Error('snapshot object AAD is not JSON'); }
  assertExactKeys(aad, ['format', 'jobId', 'objectId', 'inventoryDigest', 'sha256']);
  if (aad.format !== 1 || typeof aad.jobId !== 'string' || !aad.jobId || aad.objectId !== object.objectId || aad.inventoryDigest !== manifest.inventoryDigest || aad.sha256 !== object.sha256 || object.aad !== canonicalJson(aad)) throw new Error('snapshot object AAD mismatch');
  return aad.jobId;
}
