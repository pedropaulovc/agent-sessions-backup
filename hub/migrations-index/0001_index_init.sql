-- Index shard schema. Every IDXnn database applies these same migrations.
--
-- Main keeps authoritative metadata, usage, rollups, stars and auth. A shard holds the blocks and
-- external-content FTS of the sessions that hash to it (src/index-layout.mjs), plus a catalog copy
-- of EVERY session and star so search filters, facets and subagent cost sorts stay shard-local SQL.

-- Same DDL as main 0021: the migration runner records each applied shard migration here.
CREATE TABLE migration_checksum_ledger (
  sequence INTEGER PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (
    length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  artifact_sha256 TEXT NOT NULL CHECK (
    length(artifact_sha256) = 64 AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  deployment_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL
) STRICT;

-- Shard identity, written once on first use (src/index-shards.ts assertIndexLayout) and compared on
-- every later use: a binding pointing at the wrong database fails closed. next_block_id is the block
-- id allocator, starting at (shard_index + 1) * 2**40 and bounded below (shard_index + 2) * 2**40,
-- so new ids never collide across shards or with copied legacy ids (all below 2**40).
CREATE TABLE shard_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  shard_index INTEGER NOT NULL CHECK (shard_index >= 0),
  shard_count INTEGER NOT NULL CHECK (shard_count >= 1),
  layout TEXT NOT NULL,
  next_block_id INTEGER NOT NULL
) STRICT;

-- Durable checkpoints for the protected-CI legacy copy (used on IDX00) and other one-off index
-- operations, keyed by operation name.
CREATE TABLE index_migration_state (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- Mirrors main's `blocks` column for column (0001, 0002, 0014, 0034), in main's column order. Ids are
-- always bound explicitly: copied legacy ids, or ids from shard_meta.next_block_id.
CREATE TABLE blocks (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  file_id INTEGER NOT NULL,
  turn_index INTEGER NOT NULL,
  block_index INTEGER NOT NULL,
  role TEXT,
  btype TEXT NOT NULL,
  tool_name TEXT,
  ts TEXT,
  byte_start INTEGER,
  byte_len INTEGER,
  truncated INTEGER NOT NULL DEFAULT 0,
  text TEXT,
  on_main_path INTEGER NOT NULL DEFAULT 1,
  row_hash INTEGER NOT NULL DEFAULT 0,
  media_byte_start INTEGER,
  media_byte_len INTEGER,
  media_type TEXT
) STRICT;
CREATE INDEX blocks_session ON blocks (session_id, turn_index, block_index);
-- Verbatim predicate from main 0032; viewer/reports.ts repeats it so SQLite selects this index.
CREATE INDEX blocks_issue_reports ON blocks (ts DESC, id DESC)
  WHERE btype = 'tool_use' AND text LIKE '%xd://report_issue%';

-- External-content FTS with main's exact tokenizer, maintained by the writer in the same shard batch
-- as the blocks rows it indexes (no triggers).
CREATE VIRTUAL TABLE blocks_fts USING fts5 (
  text,
  content = 'blocks',
  content_rowid = 'id',
  tokenize = "unicode61 remove_diacritics 2 tokenchars '_-.'"
);

-- Catalog copy of main's `sessions` (every column, main's order), written only by
-- src/session-catalog.ts. No foreign key (shards have no `files`) and no triggers (main's rollup
-- triggers stay on main). All of main's sessions indexes, including sessions_parent for the subagent
-- subtree walk in search.
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  machine_id TEXT,
  os TEXT,
  canonical_file_id INTEGER,
  cwd TEXT,
  repo_url TEXT,
  git_branch TEXT,
  models TEXT,
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
  index_state TEXT NOT NULL DEFAULT 'ready',
  updated_at TEXT,
  project_name TEXT,
  first_interaction_title TEXT,
  cost_usd REAL,
  cost_calls INTEGER NOT NULL DEFAULT 0,
  cost_priced_calls INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX sessions_facets ON sessions (harness, machine_id, os, started_at);
CREATE INDEX sessions_started ON sessions (started_at);
CREATE INDEX sessions_repo ON sessions (repo_url);
CREATE INDEX sessions_parent ON sessions (parent_session_id);
CREATE INDEX idx_sessions_canonical_file ON sessions (canonical_file_id, session_id);
CREATE INDEX sessions_project ON sessions (project_name);

-- Catalog copy of main's `starred_turns`, same shape and index.
CREATE TABLE starred_turns (
  session_id TEXT NOT NULL,
  turn_key TEXT NOT NULL,
  starred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (session_id, turn_key)
) STRICT;
CREATE INDEX starred_turns_session ON starred_turns (session_id);

-- Highest main catalog version (main session_catalog_versions.version) applied to this shard's
-- catalog copy per session. presence 'deleted' is a tombstone: the session row is absent on main. A
-- late, older sync can neither degrade a newer row nor resurrect a deleted one.
CREATE TABLE catalog_versions (
  session_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  presence TEXT NOT NULL CHECK (presence IN ('present', 'deleted'))
) STRICT;

-- Block write fence on the session's home shard: the main catalog version captured in the same main
-- batch that committed the writer's sessions-row change. Every blocks/blocks_fts mutation requires
-- its writer to still hold the fence, so a superseded concurrent writer cannot clobber newer blocks.
CREATE TABLE index_write_versions (
  session_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL
) STRICT;
