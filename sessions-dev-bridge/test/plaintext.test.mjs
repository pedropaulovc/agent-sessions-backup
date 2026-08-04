import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createPublicKey, publicEncrypt, randomBytes, constants } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, sha256 } from '../src/canonical.mjs';
import { decryptObject, generateDestinationKey } from '../src/snapshot.mjs';

test('decrypts directly to the destination consumer and zeroes transient plaintext/ciphertext', async () => {
  const emptyDirectory = await mkdtemp(join(tmpdir(), 'bridge-no-artifact-'));
  try {
    const destination = generateDestinationKey();
    const plaintext = Buffer.from('approved session bytes that must never become an artifact');
    const objectId = 'object-1';
    const inventoryDigest = 'a'.repeat(64);
    const plaintextDigest = sha256(plaintext);
    const aad = canonicalJson({ format: 1, jobId: 'job-1', objectId, inventoryDigest, sha256: plaintextDigest });
    const aesKey = randomBytes(32);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', aesKey, nonce);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    const publicKey = createPublicKey({ key: destination.publicKeyJwk, format: 'jwk' });
    const wrappedKey = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, aesKey);
    const object = {
      objectId,
      kind: 'source',
      store: 'claude-projects',
      relpath: 'approved/session.jsonl',
      size: plaintext.length,
      sha256: plaintextDigest,
      ciphertextSize: ciphertext.length,
      ciphertextSha256: sha256(ciphertext),
      wrappedKey: wrappedKey.toString('base64url'),
      nonce: nonce.toString('base64url'),
      url: '/api/v1/debug/exchanges/exchange/objects/object-1',
      aad,
    };
    let transientPlaintext;
    await decryptObject({ object, ciphertext, privateKey: destination.privateKey, consume: async (bytes) => {
      transientPlaintext = bytes;
      assert.equal(bytes.toString(), plaintext.toString());
      assert.deepEqual(await readdir(emptyDirectory), []);
    }});
    assert.equal(transientPlaintext.every((value) => value === 0), true);
    assert.equal(ciphertext.every((value) => value === 0), true);
    assert.deepEqual(await readdir(emptyDirectory), []);
    aesKey.fill(0);
    plaintext.fill(0);
  } finally { await rm(emptyDirectory, { recursive: true, force: true }); }
});
