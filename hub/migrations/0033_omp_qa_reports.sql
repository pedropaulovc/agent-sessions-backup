CREATE TABLE omp_qa_reports (
  id INTEGER PRIMARY KEY,
  install_id TEXT NOT NULL,
  entry_id INTEGER NOT NULL CHECK(entry_id > 0),
  agent_name TEXT NOT NULL,
  agent_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  model TEXT NOT NULL,
  omp_version TEXT NOT NULL,
  tool TEXT NOT NULL,
  report TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(install_id, entry_id)
) STRICT;

CREATE INDEX omp_qa_reports_received ON omp_qa_reports (received_at DESC,id DESC);
