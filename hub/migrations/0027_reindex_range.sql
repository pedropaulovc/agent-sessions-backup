-- Frozen date-range selection and a retryable queue-acceptance checkpoint per session.
-- Deliberately no foreign keys to sessions/files: deletion must remain observable as an error.
CREATE TABLE reindex_range_jobs (
  job_id TEXT PRIMARY KEY,
  from_at TEXT NOT NULL,
  to_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('dispatching', 'complete', 'partial', 'failed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  unsupported_count INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER
) STRICT;

CREATE TABLE reindex_range_targets (
  job_id TEXT NOT NULL REFERENCES reindex_range_jobs (job_id),
  session_id TEXT NOT NULL,
  file_id INTEGER,
  content_hash TEXT,
  baseline_parsed_at TEXT,
  baseline_updated_at TEXT,
  dispatch_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (dispatch_state IN ('pending', 'sending', 'enqueued', 'blocked', 'ready', 'error')),
  dispatched_at TEXT,
  enqueued_at TEXT,
  completed_at TEXT,
  ready_parsed_at TEXT,
  ready_updated_at TEXT,
  attempt_token TEXT,
  last_attempt_at INTEGER NOT NULL DEFAULT 0,
  reason TEXT CHECK (reason IN ('reindex', 'recover', 'upload')),
  error_code TEXT,
  PRIMARY KEY (job_id, session_id)
) STRICT;
CREATE INDEX reindex_range_targets_dispatch ON reindex_range_targets (job_id, dispatch_state, session_id);
