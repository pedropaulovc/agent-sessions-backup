-- Track in-flight R2 multipart uploads so a dangling one (collector died between
-- create and complete/abort) can be aborted by the daily prune cron. The R2 Workers
-- binding has NO "list incomplete multipart uploads" call (only the S3 API does), so
-- the pending uploadIds MUST be recorded here to be prunable — R2 keeps the parts (and
-- bills for them) until the upload is completed or aborted.
--
-- One row per create; deleted on complete (success OR checksum-mismatch cleanup) and on
-- abort. content_hash/mtime/size are the values the collector declared at create time and
-- are the source of truth at complete (the client never re-sends them), so a complete can
-- verify the reassembled object against the SAME hash the upload was opened for.
CREATE TABLE multipart_uploads (
  upload_id TEXT PRIMARY KEY,           -- R2's opaque multipart upload id
  machine_id TEXT NOT NULL REFERENCES machines (machine_id),
  store TEXT NOT NULL,
  relpath TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,           -- sha256 hex the whole object must hash to
  mtime TEXT,                           -- source file mtime (ISO), carried to the files row
  size INTEGER NOT NULL,                -- declared whole-file size (bytes)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE INDEX multipart_uploads_created ON multipart_uploads (created_at);
