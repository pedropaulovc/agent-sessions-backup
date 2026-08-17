import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { parseUploadArguments, readExportZip, uploadTarget } from '../scripts/preview-upload-session.mjs';

function exportZip(overrides = {}) {
  const manifest = {
    format: 'agent-sessions-export/v1',
    session_id: 'abc-123',
    entries: [
      { machine: 'amet', store: 'claude-projects', relpath: '-home-p/abc-123.jsonl', role: 'canonical', mtime: '2026-07-01T00:00:00Z' },
    ],
    ...overrides,
  };
  const files = { 'manifest.json': strToU8(JSON.stringify(manifest)) };
  for (const entry of manifest.entries) {
    files[`${entry.machine}/${entry.store}/${entry.relpath}`] = strToU8('{"line":1}\n');
  }
  return zipSync(files);
}

test('argument parsing requires --pr and --zip', () => {
  assert.deepEqual(parseUploadArguments(['--pr', '42', '--zip', 's.zip']), { pr: 42, zip: 's.zip' });
  assert.throws(() => parseUploadArguments(['--zip', 's.zip']), /missing required option: --pr/);
  assert.throws(() => parseUploadArguments(['--pr', '42']), /missing required option: --zip/);
  assert.throws(() => parseUploadArguments(['--pr', '0', '--zip', 's.zip']), /--pr must be a positive integer/);
  assert.throws(() => parseUploadArguments(['--nope', 'x']), /unknown option/);
});

test('reads a viewer export zip and pairs manifest entries with their bytes', () => {
  const { manifest, entries } = readExportZip(exportZip());
  assert.equal(manifest.session_id, 'abc-123');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'amet/claude-projects/-home-p/abc-123.jsonl');
  assert.equal(Buffer.from(entries[0].body).toString('utf8'), '{"line":1}\n');
});

test('rejects foreign zips and manifests that lie about their entries', () => {
  assert.throws(() => readExportZip(zipSync({ 'readme.txt': strToU8('hi') })), /no manifest\.json/);
  assert.throws(() => readExportZip(exportZip({ format: 'other/v9' })), /unsupported export format/);
  assert.throws(() => readExportZip(exportZip({ entries: [] })), /no entries/);
  const missingBody = zipSync({
    'manifest.json': strToU8(JSON.stringify({
      format: 'agent-sessions-export/v1',
      session_id: 'x',
      entries: [{ machine: 'm', store: 's', relpath: 'r.jsonl' }],
    })),
  });
  assert.throws(() => readExportZip(missingBody), /missing the entry its manifest lists/);
});

test('rejects manifest entries whose paths could traverse to another machine or store', () => {
  // fetch() normalizes `.`/`..` in the URL before the hub routes it, so a crafted
  // manifest could otherwise redirect an upload — reject at parse, never at upload.
  const traversals = [
    { machine: 'amet', store: 'claude-projects', relpath: '../../other-machine/other-store/file' },
    { machine: 'amet', store: 'claude-projects', relpath: 'a/../file' },
    { machine: 'amet', store: 'claude-projects', relpath: './file' },
    { machine: 'amet', store: 'claude-projects', relpath: 'a//file' },
    { machine: '..', store: 'claude-projects', relpath: 'file' },
    { machine: 'amet', store: '.', relpath: 'file' },
  ];
  for (const entry of traversals) {
    assert.throws(() => readExportZip(exportZip({ entries: [entry] })), /not normalized/, JSON.stringify(entry));
  }
  const multiSegment = [
    { machine: 'a/b', store: 'claude-projects', relpath: 'file' },
    { machine: 'amet', store: 's/t', relpath: 'file' },
  ];
  for (const entry of multiSegment) {
    assert.throws(() => readExportZip(exportZip({ entries: [entry] })), /multi-segment/, JSON.stringify(entry));
  }
});

test('rejects an unsafe --pr before deriving anything from it', () => {
  assert.throws(() => parseUploadArguments(['--pr', '9007199254740993', '--zip', 's.zip']), /safe positive integer/);
});

test('builds the collector upload URL with per-segment encoding', () => {
  const target = uploadTarget('https://pr-42.sessions-ppe.workers.dev', {
    machine: 'amet',
    store: 'export-inbox',
    relpath: 'a dir/export.abc#1.zip',
  });
  assert.equal(
    target,
    'https://pr-42.sessions-ppe.workers.dev/api/v1/files/amet/export-inbox/a%20dir/export.abc%231.zip',
  );
});
