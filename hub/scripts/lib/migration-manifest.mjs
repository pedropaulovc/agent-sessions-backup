import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const MIGRATION_NAME = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function canonicalMigrationBytes(bytes) {
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const text = value.toString('utf8');
  let state = 'code';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (state === 'code') {
      if (character === '-' && next === '-') { state = 'line-comment'; index += 1; }
      else if (character === '/' && next === '*') { state = 'block-comment'; index += 1; }
      else if (character === "'") state = 'single-quote';
      else if (character === '"') state = 'double-quote';
      else if (character === '`') state = 'backtick';
      else if (character === '[') state = 'bracket';
    } else if (state === 'line-comment') {
      if (character === '\n') state = 'code';
    } else if (state === 'block-comment') {
      if (character === '*' && next === '/') { state = 'code'; index += 1; }
    } else {
      if (character === '\r') throw new Error('migration has platform-dependent CRLF inside a quoted token');
      const delimiter = state === 'single-quote' ? "'" : state === 'double-quote' ? '"' : state === 'backtick' ? '`' : ']';
      if (character === delimiter) {
        if (next === delimiter) index += 1;
        else state = 'code';
      }
    }
  }
  const normalized = text.replaceAll('\r\n', '\n');
  if (normalized.includes('\r')) {
    throw new Error('migration contains a bare carriage return');
  }
  return Buffer.from(normalized, 'utf8');
}

function validateEntry(entry, index) {
  if (!entry || !Number.isSafeInteger(entry.sequence) || entry.sequence < 1) {
    throw new Error(`migration entry ${index} has an invalid sequence`);
  }
  const match = MIGRATION_NAME.exec(entry.filename ?? '');
  if (!match || Number(match[1]) !== entry.sequence) {
    throw new Error(`migration entry ${index} has an invalid filename/sequence pair`);
  }
  if (!SHA256.test(entry.sha256 ?? '')) {
    throw new Error(`migration ${entry.filename} has an invalid SHA-256`);
  }
}

export function validateManifestShape(manifest) {
  if (manifest?.formatVersion !== 1 || manifest.hashEncoding !== 'sha256-canonical-lf') {
    throw new Error('unsupported migration manifest format');
  }
  if (!Array.isArray(manifest.migrations) || manifest.migrations.length === 0) {
    throw new Error('migration manifest is empty');
  }
  const reserved = new Set(manifest.reservedSequences ?? []);
  const names = new Set();
  const sequences = new Set();
  for (const [index, entry] of manifest.migrations.entries()) {
    validateEntry(entry, index);
    if (names.has(entry.filename)) throw new Error(`duplicate migration filename: ${entry.filename}`);
    if (sequences.has(entry.sequence)) throw new Error(`duplicate migration sequence: ${entry.sequence}`);
    if (index > 0 && entry.sequence <= manifest.migrations[index - 1].sequence) {
      throw new Error(`migrations are not strictly ordered at ${entry.filename}`);
    }
    names.add(entry.filename);
    sequences.add(entry.sequence);
  }
  let previous = 0;
  for (const entry of manifest.migrations) {
    for (let missing = previous + 1; missing < entry.sequence; missing += 1) {
      if (!reserved.has(missing)) throw new Error(`unreserved migration sequence gap: ${missing}`);
    }
    previous = entry.sequence;
  }
  for (const sequence of reserved) {
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequences.has(sequence) || sequence > previous) {
      throw new Error(`invalid reserved migration sequence: ${sequence}`);
    }
  }
  if (!Number.isSafeInteger(manifest.ledgerStartsAt) || manifest.ledgerStartsAt < 1) {
    throw new Error('manifest has no valid ledgerStartsAt');
  }
  return manifest;
}

export async function buildMigrationManifest(migrationsDir, policy) {
  const filenames = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
  const migrations = [];
  for (const filename of filenames) {
    const match = MIGRATION_NAME.exec(filename);
    if (!match) throw new Error(`invalid migration filename: ${filename}`);
    const migrationPath = path.join(migrationsDir, filename);
    if (!(await lstat(migrationPath)).isFile()) throw new Error(`migration is not a regular file: ${filename}`);
    const bytes = canonicalMigrationBytes(await readFile(migrationPath));
    migrations.push({ sequence: Number(match[1]), filename, sha256: sha256(bytes) });
  }
  if (!policy) throw new Error('migration manifest validation requires independent policy evidence');
  return validateManifestShape({
    formatVersion: policy.formatVersion,
    hashEncoding: policy.hashEncoding,
    reservedSequences: policy.reservedSequences,
    ledgerStartsAt: policy.ledgerStartsAt,
    migrations,
  });
}

export function migrationDigest(manifest) {
  validateManifestShape(manifest);
  return sha256(`${canonicalJson({
    formatVersion: manifest.formatVersion,
    hashEncoding: manifest.hashEncoding,
    reservedSequences: manifest.reservedSequences,
    ledgerStartsAt: manifest.ledgerStartsAt,
    migrations: manifest.migrations,
  })}\n`);
}

export function immutableSourceDigest(manifest, throughSequence = manifest.ledgerStartsAt - 1) {
  validateManifestShape(manifest);
  const migrations = manifest.migrations.filter((entry) => entry.sequence <= throughSequence);
  if (migrations.length === 0 || migrations.at(-1).sequence !== throughSequence) {
    throw new Error(`immutable source range does not end at migration ${throughSequence}`);
  }
  return sha256(`${canonicalJson({
    formatVersion: manifest.formatVersion,
    hashEncoding: manifest.hashEncoding,
    reservedSequences: manifest.reservedSequences,
    throughSequence,
    migrations,
  })}\n`);
}

export function assertManifestMatches(expected, actual) {
  validateManifestShape(expected);
  validateManifestShape(actual);
  const expectedCanonical = canonicalJson(expected);
  const actualCanonical = canonicalJson(actual);
  if (expectedCanonical !== actualCanonical) {
    const maximum = Math.max(expected.migrations.length, actual.migrations.length);
    for (let index = 0; index < maximum; index += 1) {
      const left = expected.migrations[index];
      const right = actual.migrations[index];
      if (canonicalJson(left) !== canonicalJson(right)) {
        throw new Error(`migration manifest mismatch at position ${index + 1}: expected ${left?.filename ?? '<none>'}, found ${right?.filename ?? '<none>'}`);
      }
    }
    throw new Error('migration manifest metadata mismatch');
  }
}

export function assertImmutableBase(base, candidate) {
  validateManifestShape(base);
  validateManifestShape(candidate);
  const basePolicy = {
    formatVersion: base.formatVersion,
    hashEncoding: base.hashEncoding,
    reservedSequences: base.reservedSequences,
    ledgerStartsAt: base.ledgerStartsAt,
  };
  const candidatePolicy = {
    formatVersion: candidate.formatVersion,
    hashEncoding: candidate.hashEncoding,
    reservedSequences: candidate.reservedSequences,
    ledgerStartsAt: candidate.ledgerStartsAt,
  };
  if (canonicalJson(basePolicy) !== canonicalJson(candidatePolicy)) {
    throw new Error('candidate changes the immutable migration policy');
  }
  if (candidate.migrations.length < base.migrations.length) {
    throw new Error('candidate removes an immutable base migration');
  }
  for (let index = 0; index < base.migrations.length; index += 1) {
    const expected = base.migrations[index];
    const actual = candidate.migrations[index];
    if (canonicalJson(expected) !== canonicalJson(actual)) {
      throw new Error(`immutable base migration changed or reordered: ${expected.filename}`);
    }
  }
  const lastBase = base.migrations.at(-1).sequence;
  for (const migration of candidate.migrations.slice(base.migrations.length)) {
    if (migration.sequence <= lastBase) {
      throw new Error(`new migration does not append after the immutable base: ${migration.filename}`);
    }
  }
}

function git(repositoryRoot, args) {
  const result = spawnSync('git', args, {
    cwd: repositoryRoot,
    encoding: null,
    windowsHide: true,
  });
  if (result.error) throw new Error(`cannot execute git: ${result.error.message}`);
  return result;
}

function jsonAtRef(repositoryRoot, ref, repositoryPath) {
  const result = git(repositoryRoot, ['show', `${ref}:${repositoryPath}`]);
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout.toString('utf8'));
  } catch (error) {
    throw new Error(`cannot parse ${repositoryPath} from migration base ${ref}: ${error.message}`);
  }
}

export function migrationManifestAtRef({
  ref,
  repositoryRoot,
  migrationsPath = 'hub/migrations',
}) {
  if (typeof ref !== 'string' || ref.trim() === '') {
    throw new Error('migration base ref is required');
  }
  let manifest = jsonAtRef(repositoryRoot, ref, `${migrationsPath}/manifest.json`);
  if (manifest) return validateManifestShape(manifest);

  let tree = git(repositoryRoot, ['ls-tree', '-r', '--name-only', ref, '--', migrationsPath]);
  if (tree.status !== 0) {
    const fetched = git(repositoryRoot, ['fetch', '--no-tags', '--depth=1', 'origin', ref]);
    if (fetched.status !== 0) {
      throw new Error(`cannot fetch migration base ${ref}: ${fetched.stderr.toString('utf8')}`);
    }
    manifest = jsonAtRef(repositoryRoot, ref, `${migrationsPath}/manifest.json`);
    if (manifest) return validateManifestShape(manifest);
    tree = git(repositoryRoot, ['ls-tree', '-r', '--name-only', ref, '--', migrationsPath]);
  }
  if (tree.status !== 0) {
    throw new Error(`cannot read migration base ${ref}: ${tree.stderr.toString('utf8')}`);
  }

  const policy = jsonAtRef(repositoryRoot, ref, `${migrationsPath}/source-baseline.json`);
  if (!policy) {
    throw new Error(`migration base ${ref} contains no manifest or independent policy evidence`);
  }
  validateManifestShape(policy);
  const prefix = `${migrationsPath}/`;
  const filenames = tree.stdout.toString('utf8').split(/\r?\n/)
    .filter((name) => name.startsWith(prefix) && MIGRATION_NAME.test(name.slice(prefix.length)))
    .map((name) => name.slice(prefix.length))
    .sort();
  const migrations = filenames.map((filename) => {
    const blob = git(repositoryRoot, ['show', `${ref}:${prefix}${filename}`]);
    if (blob.status !== 0) throw new Error(`cannot read ${filename} from migration base ${ref}`);
    return {
      sequence: Number(filename.slice(0, 4)),
      filename,
      sha256: sha256(canonicalMigrationBytes(blob.stdout)),
    };
  });
  const base = validateManifestShape({
    formatVersion: policy.formatVersion,
    hashEncoding: policy.hashEncoding,
    reservedSequences: policy.reservedSequences,
    ledgerStartsAt: policy.ledgerStartsAt,
    migrations,
  });
  assertManifestMatches(policy, base);
  return base;
}

export async function loadAndValidateManifest({
  migrationsDir,
  manifestPath,
  baseManifestPath,
  trustedBaseManifest,
}) {
  if (!baseManifestPath && !trustedBaseManifest) {
    throw new Error('migration manifest validation requires independent policy evidence');
  }
  const expected = JSON.parse(await readFile(manifestPath, 'utf8'));
  const base = trustedBaseManifest
    ? validateManifestShape(trustedBaseManifest)
    : validateManifestShape(JSON.parse(await readFile(baseManifestPath, 'utf8')));
  const actual = await buildMigrationManifest(migrationsDir, base);
  assertManifestMatches(expected, actual);
  assertImmutableBase(base, actual);
  return { manifest: expected, digest: migrationDigest(expected) };
}

export function verifySignedCanonicalPayload(envelope, publicKeyPem, label = 'signed payload') {
  if (envelope?.formatVersion !== 1 || typeof envelope.payload !== 'object' || typeof envelope.signature !== 'string') {
    throw new Error(`invalid ${label} envelope`);
  }
  const signature = Buffer.from(envelope.signature, 'base64');
  const payload = Buffer.from(`${canonicalJson(envelope.payload)}\n`);
  const publicKey = publicKeyPem?.type === 'public' ? publicKeyPem : createPublicKey(publicKeyPem);
  const valid = verifySignature(null, payload, publicKey, signature);
  if (!valid) throw new Error(`${label} signature is invalid`);
  return envelope.payload;
}

export function verifySignedReleaseManifest(envelope, publicKeyPem) {
  const manifest = verifySignedCanonicalPayload(envelope, publicKeyPem, 'release manifest');
  validateManifestShape(manifest);
  return manifest;
}

export function validateHistoricalBaseline(history, manifest) {
  if (history?.formatVersion !== 1 || history.throughSequence !== manifest.ledgerStartsAt - 1) {
    throw new Error('historical baseline does not cover the complete pre-ledger range');
  }
  if (history.sourceImmutability?.throughSequence !== history.throughSequence
      || history.sourceImmutability.digest !== immutableSourceDigest(manifest, history.throughSequence)) {
    throw new Error('pre-ledger repository source changed from the immutable baseline');
  }
  if (history.deploymentHistory?.status !== 'baselined-not-hash-verified'
      || history.deploymentHistory.approved !== false
      || history.deploymentHistory.requiresSignedProductionAttestation !== true) {
    throw new Error('historical deployment hashes must not be inferred from current source');
  }
  const divergence = history.knownDivergence;
  const current = manifest.migrations.find((entry) => entry.filename === divergence?.filename);
  if (!current || current.sha256 !== divergence.currentSourceSha256) {
    throw new Error('known migration divergence does not match the current source manifest');
  }
  if (!Array.isArray(divergence.priorRepositorySourceRevisions) || divergence.priorRepositorySourceRevisions.length === 0) {
    throw new Error('known migration divergence has no source-revision evidence');
  }
  if (divergence.priorRepositorySourceRevisions.some((entry) => !SHA256.test(entry.sha256) || entry.sha256 === current.sha256)) {
    throw new Error('known migration divergence evidence is invalid');
  }
  return history;
}
