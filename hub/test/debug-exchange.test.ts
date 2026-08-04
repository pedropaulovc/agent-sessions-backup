import { env } from 'cloudflare:test';
import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  canonicalDebugJson,
  consumeDebugExchangeMessage,
  debugApiRoute,
  debugBrowserRoute,
  debugCapabilityHash,
  sanitizeDebugObject,
} from '../src/api/debug-exchange';

const testEnv = env as unknown as Env;
const encoder = new TextEncoder();

function b64u(bytes: ArrayBuffer | Uint8Array): string {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function digest(bytes: ArrayBuffer | Uint8Array | string): Promise<string> {
  const value = typeof bytes === 'string' ? encoder.encode(bytes) : bytes;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', value))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function signingKey(): Promise<{ privateKey: CryptoKey; publicJwk: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  ) as CryptoKeyPair;
  return {
    privateKey: pair.privateKey,
    publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey,
  };
}

async function encryptionJwk(): Promise<JsonWebKey> {
  const pair = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']) as CryptoKeyPair;
  return await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey;
}

async function signed(privateKey: CryptoKey, payload: Record<string, unknown>) {
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey,
    encoder.encode(canonicalDebugJson(payload)));
  return { payload, signature: b64u(signature) };
}

function browserRequest(path: string, body: unknown): Request {
  return new Request(`https://sessions.vza.net${path}`, {
    method: 'POST', headers: { origin: 'https://sessions.vza.net', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function insertPreparingJob(jobId: string, sessions: string[]): Promise<void> {
  const token = `${jobId}-prepare-capability-token-000000`;
  await testEnv.DB.prepare(
    `INSERT INTO debug_export_jobs
     (job_id,user_id,selected_session_ids,destination_json,destination_hash,pkce_challenge,
      prepare_code_hash,capability_hash,status,created_at,expires_at)
     VALUES (?1,'owner',?2,'{}',?3,?4,?5,?6,'preparing',?7,?8)`,
  ).bind(jobId, canonicalDebugJson(sessions), 'a'.repeat(64), 'B'.repeat(43),
    await debugCapabilityHash(`${token}-code`), await debugCapabilityHash(token), Date.now(), Date.now() + 600_000).run();
}

describe('production debug exchange boundaries', () => {
  it('removes forbidden privilege state recursively without rewriting approved transcript fields', () => {
    const cleaned = sanitizeDebugObject({
      sessionId: 'selected',
      message: { text: 'keep', credential: 'drop', machineCert: 'drop', nested: [{ oauthToken: 'drop', value: 1 }] },
      alerts: [{ secret: 'drop' }], isAdmin: true,
      tool: { authorization: 'Bearer production', result: 'keep' },
    });
    expect(cleaned).toEqual({ sessionId: 'selected', message: { text: 'keep', nested: [{ value: 1 }] }, tool: { result: 'keep' } });
    expect(JSON.stringify(cleaned)).not.toMatch(/credential|machineCert|alerts|isAdmin|Bearer production/);
  });

  it('isolates one conversation from a shared raw export and never snapshots the unselected session', async () => {
    const suffix = crypto.randomUUID(); const selected = `selected-${suffix}`; const unselected = `unselected-${suffix}`;
    const archive = zipSync({ 'conversations.json': strToU8(JSON.stringify([
      { uuid: selected, name: 'selected title', credential: 'must-not-export', chat_messages: [{ uuid: `m-selected-${suffix}`, sender: 'human', text: 'selected text' }] },
      { uuid: unselected, name: 'unselected title', chat_messages: [{ uuid: `m-unselected-${suffix}`, sender: 'human', text: 'UNSELECTED SECRET' }] },
    ])) });
    const machine = `archive-machine-${suffix}`; const r2Key = `raw/${machine}/export-inbox/${suffix}.zip`; const hash = await digest(archive);
    await testEnv.RAW.put(r2Key, archive, { sha256: hash });
    await testEnv.DB.prepare("INSERT INTO machines (machine_id,os) VALUES (?1,'test')").bind(machine).run();
    const file = await testEnv.DB.prepare(
      "INSERT INTO files (machine_id,store,relpath,r2_key,size,content_hash,harness,parse_state) VALUES (?1,'export-inbox',?2,?3,?4,?5,'unknown','parsed') RETURNING id",
    ).bind(machine, `${suffix}.zip`, r2Key, archive.byteLength, hash).first<{ id: number }>();
    for (const id of [selected, unselected]) {
      await testEnv.DB.prepare("INSERT INTO sessions (session_id,harness,canonical_file_id,index_state) VALUES (?1,'claude-web',?2,'ready')").bind(id, file!.id).run();
      await testEnv.DB.prepare("INSERT INTO blocks (session_id,file_id,turn_index,block_index,btype,text) VALUES (?1,?2,0,0,'text','indexed')").bind(id, file!.id).run();
    }
    const jobId = `shared-${suffix}`; await insertPreparingJob(jobId, [selected]);
    await consumeDebugExchangeMessage({ debug: 'export-snapshot', job_id: jobId }, testEnv);
    const sharedJob = await testEnv.DB.prepare(
      'SELECT status,error FROM debug_export_jobs WHERE job_id=?1',
    ).bind(jobId).first<{ status: string; error: string | null }>();
    expect(sharedJob).toEqual({ status: 'awaiting_consent', error: null });
    const rows = await testEnv.DB.prepare('SELECT snapshot_r2_key,session_ids FROM debug_export_objects WHERE job_id=?1')
      .bind(jobId).all<{ snapshot_r2_key: string; session_ids: string }>();
    expect(rows.results).toHaveLength(1); expect(JSON.parse(rows.results[0]!.session_ids)).toEqual([selected]);
    const raw = await (await testEnv.RAW.get(rows.results[0]!.snapshot_r2_key))!.text();
    expect(raw).toContain('selected text'); expect(raw).not.toContain('UNSELECTED SECRET');
    expect(raw).not.toContain(unselected); expect(raw).not.toContain('credential');
    await testEnv.DB.prepare(
      "UPDATE debug_export_jobs SET status='expired' WHERE job_id=?1",
    ).bind(jobId).run();
  });

  it('includes the complete externalAsset closure and no unrelated R2 object', async () => {
    const suffix = crypto.randomUUID(); const sessionId = `asset-${suffix}`; const machine = `asset-machine-${suffix}`;
    const relpath = `project/${sessionId}.jsonl`; const assetDigest = 'b'.repeat(64);
    const source = [
      JSON.stringify({ parentUuid: null, isSidechain: false, sessionId, type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool', name: 'read', input: {} }] }, uuid: `call-${suffix}`, timestamp: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({ parentUuid: `call-${suffix}`, isSidechain: false, sessionId, type: 'user', message: { role: 'user', details: { meta: { source: { value: 'C:\\safe\\image.png' } } }, content: [{ type: 'tool_result', tool_use_id: 'tool', content: [{ type: 'image', data: `blob:sha256:${assetDigest}` }] }] }, uuid: `result-${suffix}`, timestamp: '2026-01-01T00:00:01.000Z' }),
    ].join('\n');
    const sourceHash = await digest(source); const sourceKey = `raw/${machine}/claude-projects/${relpath}`;
    const assetRelpath = `${relpath}.assets/${assetDigest}/image.png`; const assetKey = `raw/${machine}/claude-projects/${assetRelpath}`;
    const assetBytes = encoder.encode('asset bytes only'); const assetHash = await digest(assetBytes);
    await testEnv.RAW.put(sourceKey, source, { sha256: sourceHash }); await testEnv.RAW.put(assetKey, assetBytes, { sha256: assetHash });
    await testEnv.RAW.put(`raw/${machine}/credentials.json`, 'forbidden unrelated object');
    await testEnv.DB.prepare("INSERT INTO machines (machine_id,os) VALUES (?1,'test')").bind(machine).run();
    const file = await testEnv.DB.prepare(
      "INSERT INTO files (machine_id,store,relpath,r2_key,size,content_hash,harness,session_id,parse_state) VALUES (?1,'claude-projects',?2,?3,?4,?5,'claude-code',?6,'parsed') RETURNING id",
    ).bind(machine, relpath, sourceKey, source.length, sourceHash, sessionId).first<{ id: number }>();
    await testEnv.DB.prepare(
      "INSERT INTO files (machine_id,store,relpath,r2_key,size,content_hash,harness,parse_state) VALUES (?1,'claude-projects',?2,?3,?4,?5,'unknown','skipped')",
    ).bind(machine, assetRelpath, assetKey, assetBytes.byteLength, assetHash).run();
    await testEnv.DB.prepare("INSERT INTO sessions (session_id,harness,canonical_file_id,index_state) VALUES (?1,'claude-code',?2,'ready')").bind(sessionId, file!.id).run();
    await testEnv.DB.prepare("INSERT INTO blocks (session_id,file_id,turn_index,block_index,btype,text) VALUES (?1,?2,0,0,'text','indexed')").bind(sessionId, file!.id).run();
    const jobId = `asset-job-${suffix}`; await insertPreparingJob(jobId, [sessionId]);
    await consumeDebugExchangeMessage({ debug: 'export-snapshot', job_id: jobId }, testEnv);
    const assetJob = await testEnv.DB.prepare(
      'SELECT status,error FROM debug_export_jobs WHERE job_id=?1',
    ).bind(jobId).first<{ status: string; error: string | null }>();
    expect(assetJob).toEqual({ status: 'awaiting_consent', error: null });
    const objects = await testEnv.DB.prepare('SELECT kind,relpath,sha256 FROM debug_export_objects WHERE job_id=?1 ORDER BY kind')
      .bind(jobId).all<{ kind: string; relpath: string; sha256: string }>();
    expect(objects.results).toHaveLength(2);
    expect(objects.results).toContainEqual({ kind: 'externalAsset', relpath: assetRelpath, sha256: assetHash });
    expect(JSON.stringify(objects.results)).not.toContain('credentials.json');
    await testEnv.DB.prepare(
      "UPDATE debug_export_jobs SET status='expired' WHERE job_id=?1",
    ).bind(jobId).run();
  });

  it('exchanges only ciphertext and a signed manifest, never a production viewer/search bearer', async () => {
    const suffix = crypto.randomUUID();
    const jobId = `cipher-${suffix}`;
    const sessionId = `cipher-session-${suffix}`;
    const verifier = 'ciphertext-pkce-verifier-with-more-than-forty-three-characters-123';
    const challenge = b64u(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)));
    const grantCode = `grant-code-${suffix}-long-enough`;
    const rsa = await crypto.subtle.generateKey({
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    }, true, ['encrypt', 'decrypt']) as CryptoKeyPair;
    const encryptionPublicJwk = await crypto.subtle.exportKey('jwk', rsa.publicKey) as JsonWebKey;
    const manifestSigner = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
    ) as CryptoKeyPair;
    const manifestPrivateJwk = await crypto.subtle.exportKey('jwk', manifestSigner.privateKey) as JsonWebKey;
    const plaintext = encoder.encode('production transcript plaintext');
    const plaintextHash = await digest(plaintext);
    const objectId = await digest(`object-${suffix}`);
    const snapshotKey = `debug-export/snapshots/${jobId}/${objectId}`;
    await testEnv.RAW.put(snapshotKey, plaintext, { sha256: plaintextHash });
    const destination = {
      payload: { encryptionPublicJwk, exp: Date.now() + 600_000 },
      signature: 'already-validated-by-final-consent',
    };
    const now = Date.now();
    await testEnv.DB.prepare(
      `INSERT INTO debug_export_jobs
       (job_id,user_id,selected_session_ids,destination_json,destination_hash,pkce_challenge,
        prepare_code_hash,capability_hash,status,inventory_digest,inventory_size,inventory_count,
        final_destination_json,final_destination_hash,grant_code_hash,grant_jti,grant_expires_at,
        created_at,expires_at)
       VALUES (?1,'owner',?2,'{}',?3,?4,?5,?6,'authorized',?7,?8,1,?9,?10,?11,?12,?13,?14,?15)`,
    ).bind(jobId, canonicalDebugJson([sessionId]), '1'.repeat(64), challenge,
      await debugCapabilityHash(`prepare-${suffix}`), await debugCapabilityHash(`cap-${suffix}`),
      '2'.repeat(64), plaintext.byteLength, canonicalDebugJson(destination), '3'.repeat(64),
      await debugCapabilityHash(grantCode), `grant-jti-${suffix}`, now + 300_000, now, now + 600_000).run();
    await testEnv.DB.prepare(
      `INSERT INTO debug_export_objects
       (job_id,object_id,kind,store,relpath,snapshot_r2_key,size,sha256,session_ids)
       VALUES (?1,?2,'source','claude-projects',?3,?4,?5,?6,?7)`,
    ).bind(jobId, objectId, `project/${sessionId}.jsonl`, snapshotKey, plaintext.byteLength,
      plaintextHash, canonicalDebugJson([sessionId])).run();
    const exchangeUrl = new URL('https://api.sessions.vza.net/api/v1/debug/exchange');
    const response = await debugApiRoute(new Request(exchangeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ authorizationCode: grantCode, codeVerifier: verifier }),
    }), exchangeUrl, {
      ...testEnv,
      DEBUG_EXPORT_MANIFEST_SIGNING_PRIVATE_JWK: JSON.stringify(manifestPrivateJwk),
    });
    expect(response?.status).toBe(200);
    const exchanged = await response!.json() as {
      exchangeCapability: string;
      manifest: { signature: { alg: string; value: string }; objects: Array<{ url: string; ciphertextSize: number }> };
    };
    expect(exchanged).not.toHaveProperty('viewerToken');
    expect(exchanged).not.toHaveProperty('searchToken');
    expect(exchanged.manifest.signature.alg).toBe('ES256');
    const objectUrl = new URL(exchanged.manifest.objects[0]!.url, 'https://api.sessions.vza.net');
    const ciphertext = await debugApiRoute(new Request(objectUrl), objectUrl, testEnv);
    expect(ciphertext?.status).toBe(200);
    const ciphertextBytes = new Uint8Array(await ciphertext!.arrayBuffer());
    expect(ciphertextBytes.byteLength).toBe(plaintext.byteLength + 16);
    expect(new TextDecoder().decode(ciphertextBytes)).not.toContain('production transcript plaintext');
    expect(await testEnv.RAW.get(snapshotKey)).toBeNull();
  });

  it('rejects wrong, replayed, expired, revoked-device, session, inventory, artifact, and PKCE grants', async () => {
    const suffix = crypto.randomUUID(); const sessionId = `grant-session-${suffix}`;
    await testEnv.DB.prepare("INSERT INTO sessions (session_id,harness,index_state) VALUES (?1,'claude-code','ready')").bind(sessionId).run();
    const signer = await signingKey(); const rsa = await encryptionJwk(); const deviceId = `device-${suffix}`; const releaseDigest = 'c'.repeat(64);
    await testEnv.DB.prepare("INSERT INTO debug_export_devices (device_id,user_id,label,public_jwk,release_digest,key_protection,scope,enrolled_at,expires_at) VALUES (?1,'owner','test',?2,?3,'windows-cng-tpm','local-destination-attest',?4,?5)")
      .bind(deviceId, canonicalDebugJson(signer.publicJwk), releaseDigest, Date.now(), Date.now() + 600_000).run();
    const verifier = 'verifier-value-that-is-at-least-forty-three-characters-long-123';
    const pkce = b64u(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)));
    const payload = (counter: number, overrides: Record<string, unknown> = {}) => ({
      format: 1,
      scope: 'local-destination-attest',
      kind: 'local',
      jti: `attestation-${suffix}-${counter}`,
      iat: Date.now(),
      exp: Date.now() + 300_000,
      inventoryDigest: null,
      encryptionPublicJwk: rsa,
      environmentNonce: `environment-${suffix}`,
      buildInputDigest: '8'.repeat(64),
      artifactDigest: 'd'.repeat(64),
      deviceId,
      deviceCounter: counter,
      releaseDigest,
      keyProtection: 'windows-cng-tpm',
      ...overrides,
    });
    const initial = await signed(signer.privateKey, payload(1));
    const tamperedDestination = {
      ...initial,
      payload: { ...initial.payload, artifactDigest: '7'.repeat(64) },
    };
    const tamperedResponse = await debugBrowserRoute(browserRequest('/debug/prepare', {
      sessionIds: [sessionId],
      destinationAttestation: tamperedDestination,
      pkceChallenge: pkce,
      callback: 'http://127.0.0.1:43123/callback',
    }), new URL('https://sessions.vza.net/debug/prepare'), testEnv);
    expect(tamperedResponse?.status).toBe(403);
    const wrongRelease = await signed(signer.privateKey, payload(1, { releaseDigest: '0'.repeat(64) }));
    const wrongReleaseResponse = await debugBrowserRoute(browserRequest('/debug/prepare', {
      sessionIds: [sessionId],
      destinationAttestation: wrongRelease,
      pkceChallenge: pkce,
      callback: 'http://127.0.0.1:43123/callback',
    }), new URL('https://sessions.vza.net/debug/prepare'), testEnv);
    expect(wrongReleaseResponse?.status).toBe(403);
    const prepared = await debugBrowserRoute(browserRequest('/debug/prepare', { sessionIds: [sessionId], destinationAttestation: initial, pkceChallenge: pkce, callback: 'http://127.0.0.1:43123/callback' }), new URL('https://sessions.vza.net/debug/prepare'), testEnv);
    expect(prepared?.status).toBe(303); const location = new URL(prepared!.headers.get('location')!); const code = location.searchParams.get('code')!; const jobId = location.searchParams.get('state')!;
    const replay = await debugBrowserRoute(browserRequest('/debug/prepare', { sessionIds: [sessionId], destinationAttestation: initial, pkceChallenge: pkce, callback: 'http://127.0.0.1:43123/callback' }), new URL('https://sessions.vza.net/debug/prepare'), testEnv);
    expect(replay?.status).toBe(403);
    const exchangeUrl = new URL('https://api.sessions.vza.net/api/v1/debug/prepare/exchange');
    const wrongPkce = await debugApiRoute(new Request(exchangeUrl, { method: 'POST', body: JSON.stringify({ code, codeVerifier: `${verifier}wrong` }), headers: { 'content-type': 'application/json' } }), exchangeUrl, testEnv);
    expect(wrongPkce?.status).toBe(400);
    const goodPkce = await debugApiRoute(new Request(exchangeUrl, { method: 'POST', body: JSON.stringify({ code, codeVerifier: verifier }), headers: { 'content-type': 'application/json' } }), exchangeUrl, testEnv);
    expect(goodPkce?.status).toBe(200);
    const replayedCode = await debugApiRoute(new Request(exchangeUrl, { method: 'POST', body: JSON.stringify({ code, codeVerifier: verifier }), headers: { 'content-type': 'application/json' } }), exchangeUrl, testEnv);
    expect(replayedCode?.status).toBe(400);
    const exchanged = await goodPkce!.json() as { jobCapability: string };
    expect(exchanged).not.toHaveProperty('viewerToken'); expect(exchanged).not.toHaveProperty('searchToken');
    await testEnv.DB.prepare("UPDATE debug_export_jobs SET status='awaiting_consent',inventory_digest=?2,inventory_size=10,inventory_count=1 WHERE job_id=?1").bind(jobId, 'e'.repeat(64)).run();
    const wrongInventory = await signed(signer.privateKey, payload(2, { inventoryDigest: 'f'.repeat(64) }));
    const wrongInventoryPath = `/debug/jobs/${exchanged.jobCapability}/consent/options`;
    const wrongInventoryResponse = await debugBrowserRoute(browserRequest(wrongInventoryPath, { destinationAttestation: wrongInventory }), new URL(`https://sessions.vza.net${wrongInventoryPath}`), testEnv);
    expect(wrongInventoryResponse?.status).toBe(403);
    const wrongArtifact = await signed(signer.privateKey, payload(3, { inventoryDigest: 'e'.repeat(64), artifactDigest: '9'.repeat(64) }));
    const wrongArtifactResponse = await debugBrowserRoute(browserRequest(wrongInventoryPath, { destinationAttestation: wrongArtifact }), new URL(`https://sessions.vza.net${wrongInventoryPath}`), testEnv);
    expect(wrongArtifactResponse?.status).toBe(403);
    const missingSession = await signed(signer.privateKey, payload(4, { jti: `missing-session-${suffix}` }));
    const wrongSessionResponse = await debugBrowserRoute(browserRequest('/debug/prepare', { sessionIds: [`missing-${suffix}`], destinationAttestation: missingSession, pkceChallenge: pkce, callback: 'http://127.0.0.1:43123/callback' }), new URL('https://sessions.vza.net/debug/prepare'), testEnv);
    expect(wrongSessionResponse?.status).toBe(404);
    await testEnv.DB.prepare('UPDATE debug_export_devices SET revoked_at=?2 WHERE device_id=?1').bind(deviceId, Date.now()).run();
    const revoked = await signed(signer.privateKey, payload(5, { jti: `revoked-device-${suffix}` }));
    const revokedResponse = await debugBrowserRoute(browserRequest('/debug/prepare', { sessionIds: [sessionId], destinationAttestation: revoked, pkceChallenge: pkce, callback: 'http://127.0.0.1:43123/callback' }), new URL('https://sessions.vza.net/debug/prepare'), testEnv);
    expect(revokedResponse?.status).toBe(403);
    const expired = await signed(signer.privateKey, payload(6, { jti: `expired-device-${suffix}`, iat: Date.now() - 600_000, exp: Date.now() - 1 }));
    const expiredResponse = await debugBrowserRoute(browserRequest('/debug/prepare', { sessionIds: [sessionId], destinationAttestation: expired, pkceChallenge: pkce, callback: 'http://127.0.0.1:43123/callback' }), new URL('https://sessions.vza.net/debug/prepare'), testEnv);
    expect(expiredResponse?.status).toBe(403);
  });
});
