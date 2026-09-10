-- One bounded manual pass per job; a crashed attempt is failed, never silently rerun.
CREATE TABLE session_rollup_jobs (
  job_id TEXT PRIMARY KEY,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'complete', 'partial', 'failed')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  attempt_token TEXT,
  lease_until INTEGER,
  result_json TEXT,
  error TEXT,
  ms INTEGER,
  CHECK (status != 'running' OR (attempt_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (status NOT IN ('complete', 'partial') OR (result_json IS NOT NULL AND finished_at IS NOT NULL)),
  CHECK (status != 'failed' OR (error IS NOT NULL AND finished_at IS NOT NULL))
);
