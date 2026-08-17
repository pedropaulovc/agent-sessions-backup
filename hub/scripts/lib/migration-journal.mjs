import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, sha256 } from './migration-manifest.mjs';

const PHASES = ['intended', 'wrangler-applied', 'checksum-recorded', 'committed'];
const DIGEST = /^[0-9a-f]{64}$/;

export class AmbiguousJournalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AmbiguousJournalError';
    this.code = 'ERR_AMBIGUOUS_MIGRATION_JOURNAL';
  }
}

function journalChecksum(record) {
  const { checksum: _checksum, ...unsigned } = record;
  return sha256(`${canonicalJson(unsigned)}\n`);
}

function validateIdentity(identity) {
  if (!identity || !['local', 'e2e', 'preview', 'production'].includes(identity.target)) {
    throw new Error('invalid migration journal target');
  }
  if (typeof identity.deploymentId !== 'string' || identity.deploymentId.length < 1 || identity.deploymentId.length > 256) {
    throw new Error('invalid migration deployment ID');
  }
  if (!DIGEST.test(identity.artifactDigest ?? '') || !DIGEST.test(identity.migrationDigest ?? '')) {
    throw new Error('invalid migration journal digest');
  }
}

function assertJournal(record) {
  if (record?.formatVersion !== 1 || !PHASES.includes(record.phase)) {
    throw new AmbiguousJournalError('migration journal has an unknown format or phase');
  }
  try {
    validateIdentity(record.identity);
  } catch (error) {
    throw new AmbiguousJournalError(`migration journal identity is invalid: ${error.message}`);
  }
  if (!Number.isSafeInteger(record.revision) || record.revision < 0 || record.revision !== PHASES.indexOf(record.phase)) {
    throw new AmbiguousJournalError('migration journal phase/revision is inconsistent');
  }
  if (!DIGEST.test(record.checksum ?? '') || record.checksum !== journalChecksum(record)) {
    throw new AmbiguousJournalError('migration journal checksum is invalid');
  }
  return record;
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'EPERM', 'EISDIR'].includes(error.code)) throw error;
  } finally {
    await handle?.close();
  }
}

async function atomicWrite(filePath, value) {
  const directory = path.dirname(filePath);
  const temporary = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, filePath);
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function sameIdentity(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

export async function openMigrationJournal(filePath, identity, now = () => new Date().toISOString()) {
  validateIdentity(identity);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    const record = assertJournal(JSON.parse(await readFile(filePath, 'utf8')));
    if (!sameIdentity(record.identity, identity)) {
      throw new AmbiguousJournalError('migration journal belongs to a different immutable artifact or deployment');
    }
    return record;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      if (error instanceof AmbiguousJournalError) throw error;
      throw new AmbiguousJournalError(`migration journal cannot be recovered unambiguously: ${error.message}`);
    }
  }
  const record = {
    formatVersion: 1,
    identity,
    phase: 'intended',
    revision: 0,
    updatedAt: now(),
  };
  record.checksum = journalChecksum(record);
  await atomicWrite(filePath, record);
  return record;
}

export async function advanceMigrationJournal(filePath, record, nextPhase, now = () => new Date().toISOString()) {
  assertJournal(record);
  const expected = PHASES[PHASES.indexOf(record.phase) + 1];
  if (nextPhase !== expected) {
    throw new AmbiguousJournalError(`invalid migration journal transition ${record.phase} -> ${nextPhase}`);
  }
  const current = await openMigrationJournal(filePath, record.identity, now);
  if (current.checksum !== record.checksum) {
    throw new AmbiguousJournalError('migration journal changed concurrently');
  }
  const next = {
    ...record,
    phase: nextPhase,
    revision: record.revision + 1,
    updatedAt: now(),
  };
  next.checksum = journalChecksum(next);
  await atomicWrite(filePath, next);
  return next;
}

export async function runJournaledMigration({ journalPath, identity, apply, recordChecksums, verify, now }) {
  let journal = await openMigrationJournal(journalPath, identity, now);
  if (journal.phase === 'intended') {
    await apply();
    journal = await advanceMigrationJournal(journalPath, journal, 'wrangler-applied', now);
  }
  if (journal.phase === 'wrangler-applied') {
    await recordChecksums();
    journal = await advanceMigrationJournal(journalPath, journal, 'checksum-recorded', now);
  }
  if (journal.phase === 'checksum-recorded') {
    const result = await verify();
    journal = await advanceMigrationJournal(journalPath, journal, 'committed', now);
    return { journal, result };
  }
  if (journal.phase === 'committed') {
    return { journal, result: await verify() };
  }
  throw new AmbiguousJournalError(`unrecoverable migration journal phase: ${journal.phase}`);
}
