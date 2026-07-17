-- Core schema. R2 is the source of truth; everything here is rebuildable from raw objects.

CREATE TABLE machines (
  machine_id TEXT PRIMARY KEY,
  os TEXT NOT NULL,
  hostname TEXT,
  cert_fp_sha256 TEXT UNIQUE,
  key_protection TEXT NOT NULL DEFAULT 'software', -- tpm | software
  is_admin INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 100,           -- lower wins canonical-copy dedupe
  collector_version TEXT,
  last_seen_at TEXT,
  last_upload_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines (machine_id),
  store TEXT NOT NULL,
  relpath TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime TEXT,
  content_hash TEXT NOT NULL,
  harness TEXT,
  session_id TEXT,
  parse_state TEXT NOT NULL DEFAULT 'pending', -- pending|parsed|error|skipped|superseded
  parse_error TEXT,
  parsed_at TEXT,
  parsed_size INTEGER,
  uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (machine_id, store, relpath)
) STRICT;
CREATE INDEX files_session ON files (session_id);
CREATE INDEX files_state ON files (parse_state);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  machine_id TEXT,
  os TEXT,
  canonical_file_id INTEGER REFERENCES files (id),
  cwd TEXT,
  repo_url TEXT,
  git_branch TEXT,
  models TEXT, -- JSON array
  primary_model TEXT,
  title TEXT,
  started_at TEXT,
  ended_at TEXT,
  parent_session_id TEXT,
  parent_tool_use_id TEXT,
  is_sidechain INTEGER NOT NULL DEFAULT 0,
  turn_count INTEGER,
  block_count INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER,
  tokens_reasoning INTEGER,
  tokens_cached INTEGER,
  index_state TEXT NOT NULL DEFAULT 'ready', -- parsing|ready|error
  updated_at TEXT
) STRICT;
CREATE INDEX sessions_facets ON sessions (harness, machine_id, os, started_at);
CREATE INDEX sessions_started ON sessions (started_at);
CREATE INDEX sessions_repo ON sessions (repo_url);
CREATE INDEX sessions_parent ON sessions (parent_session_id);

CREATE TABLE blocks (
  id INTEGER PRIMARY KEY, -- rowid, referenced by FTS external content
  session_id TEXT NOT NULL,
  file_id INTEGER NOT NULL,
  turn_index INTEGER NOT NULL,
  block_index INTEGER NOT NULL,
  role TEXT,
  btype TEXT NOT NULL, -- text|thinking|tool_use|tool_result|image|document|prompt
  tool_name TEXT,
  ts TEXT,
  byte_start INTEGER,
  byte_len INTEGER,
  truncated INTEGER NOT NULL DEFAULT 0,
  text TEXT -- capped: 16KB text/thinking, 2KB tool_use, 4KB tool_result; NULL for image/document
) STRICT;
CREATE INDEX blocks_session ON blocks (session_id, turn_index, block_index);

-- External-content FTS: text stored once (in blocks); snippet()/highlight() work.
-- Maintained explicitly in application code alongside blocks writes (no triggers).
CREATE VIRTUAL TABLE blocks_fts USING fts5 (
  text,
  content = 'blocks',
  content_rowid = 'id',
  tokenize = "unicode61 remove_diacritics 2 tokenchars '_-.'"
);

-- One row per assistant turn / API call: the statistical-analysis substrate.
CREATE TABLE usage (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  ts TEXT,
  model TEXT,
  service_tier TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  cache_creation_5m_tokens INTEGER,
  cache_creation_1h_tokens INTEGER,
  cache_read_tokens INTEGER,
  inference_geo TEXT,
  request_id TEXT,
  UNIQUE (session_id, turn_index)
) STRICT;
CREATE INDEX usage_session ON usage (session_id);
CREATE INDEX usage_ts ON usage (ts);
CREATE INDEX usage_model ON usage (model);

CREATE TABLE heartbeats (
  id INTEGER PRIMARY KEY,
  machine_id TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  collector_version TEXT,
  stats TEXT -- JSON: per-store {seen,uploaded,bytes}, events[]
) STRICT;
CREATE INDEX heartbeats_machine ON heartbeats (machine_id, received_at);

CREATE TABLE credentials (
  credential_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'owner',
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT
) STRICT;

CREATE TABLE alerts (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  machine_id TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  resolved_at TEXT
) STRICT;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT) STRICT;
INSERT INTO meta (key, value) VALUES ('schema_version', '1');
