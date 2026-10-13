-- Durable propagation of the authoritative session catalog to the index shards.
--
-- Every index shard keeps a copy of `sessions` and `starred_turns` so search filters, facets and
-- subagent cost sorts run as shard-local SQL. Main stays authoritative; src/session-catalog.ts pushes
-- changes to every shard.
--
-- Triggers rather than writer discipline, because the catalog copy must reflect EVERY change to
-- these rows: ingest metadata, index_state, pricing-pass cost refreshes, export cleanup deletes and
-- star edits alike. Each change appends the session id to the outbox and stamps the session's
-- catalog version with that outbox seq, so versions strictly increase per session. Writers sync the
-- ids they changed right after committing; the outbox is the durable backstop that a bounded drain
-- empties, and search refuses to serve while it is non-empty.
--
-- The trigger bodies never carry a conflict clause: an outer `INSERT OR IGNORE` (starred_turns in
-- consumer.ts) would override one. The outbox insert cannot conflict (AUTOINCREMENT), and the
-- version upsert is an UPDATE plus a guarded INSERT that only runs when no row exists.

CREATE TABLE session_catalog_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL
) STRICT;
-- A sync retires one session's entries up to its synced version without scanning the outbox.
CREATE INDEX session_catalog_outbox_session ON session_catalog_outbox (session_id, seq);

-- Latest catalog version per session id, kept after a delete so a later sync records a tombstone.
CREATE TABLE session_catalog_versions (
  session_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL
) STRICT;

-- Seed: one outbox entry and version for every session and every starred session, so the first
-- drain copies the complete catalog to every shard before the active revision serves search.
INSERT INTO session_catalog_outbox (session_id)
SELECT session_id FROM sessions
UNION
SELECT session_id FROM starred_turns
ORDER BY 1;

INSERT INTO session_catalog_versions (session_id, version)
SELECT session_id, seq FROM session_catalog_outbox;

CREATE TRIGGER session_catalog_sessions_insert AFTER INSERT ON sessions BEGIN
  INSERT INTO session_catalog_outbox (session_id) VALUES (NEW.session_id);
  UPDATE session_catalog_versions SET version = (SELECT max(seq) FROM session_catalog_outbox)
   WHERE session_id = NEW.session_id;
  INSERT INTO session_catalog_versions (session_id, version)
  SELECT NEW.session_id, (SELECT max(seq) FROM session_catalog_outbox)
   WHERE NOT EXISTS (SELECT 1 FROM session_catalog_versions WHERE session_id = NEW.session_id);
END;

-- Pricing refreshes also match rows whose stored totals did not change. Only a changed catalog
-- value needs replication; IS NOT compares native SQLite values and includes NULL transitions.
-- Keep this predicate complete with SESSION_CATALOG_COLUMNS in src/index-layout.mjs.
CREATE TRIGGER session_catalog_sessions_update AFTER UPDATE ON sessions
WHEN OLD.session_id IS NOT NEW.session_id
  OR OLD.harness IS NOT NEW.harness
  OR OLD.machine_id IS NOT NEW.machine_id
  OR OLD.os IS NOT NEW.os
  OR OLD.canonical_file_id IS NOT NEW.canonical_file_id
  OR OLD.cwd IS NOT NEW.cwd
  OR OLD.repo_url IS NOT NEW.repo_url
  OR OLD.git_branch IS NOT NEW.git_branch
  OR OLD.models IS NOT NEW.models
  OR OLD.primary_model IS NOT NEW.primary_model
  OR OLD.title IS NOT NEW.title
  OR OLD.started_at IS NOT NEW.started_at
  OR OLD.ended_at IS NOT NEW.ended_at
  OR OLD.parent_session_id IS NOT NEW.parent_session_id
  OR OLD.parent_tool_use_id IS NOT NEW.parent_tool_use_id
  OR OLD.is_sidechain IS NOT NEW.is_sidechain
  OR OLD.turn_count IS NOT NEW.turn_count
  OR OLD.block_count IS NOT NEW.block_count
  OR OLD.tokens_in IS NOT NEW.tokens_in
  OR OLD.tokens_out IS NOT NEW.tokens_out
  OR OLD.tokens_reasoning IS NOT NEW.tokens_reasoning
  OR OLD.tokens_cached IS NOT NEW.tokens_cached
  OR OLD.index_state IS NOT NEW.index_state
  OR OLD.updated_at IS NOT NEW.updated_at
  OR OLD.project_name IS NOT NEW.project_name
  OR OLD.first_interaction_title IS NOT NEW.first_interaction_title
  OR OLD.cost_usd IS NOT NEW.cost_usd
  OR OLD.cost_calls IS NOT NEW.cost_calls
  OR OLD.cost_priced_calls IS NOT NEW.cost_priced_calls
BEGIN
  INSERT INTO session_catalog_outbox (session_id) VALUES (NEW.session_id);
  UPDATE session_catalog_versions SET version = (SELECT max(seq) FROM session_catalog_outbox)
   WHERE session_id = NEW.session_id;
  INSERT INTO session_catalog_versions (session_id, version)
  SELECT NEW.session_id, (SELECT max(seq) FROM session_catalog_outbox)
   WHERE NOT EXISTS (SELECT 1 FROM session_catalog_versions WHERE session_id = NEW.session_id);
END;

-- A primary-key change also moves the old id out of the catalog.
CREATE TRIGGER session_catalog_sessions_rekey AFTER UPDATE OF session_id ON sessions
WHEN OLD.session_id IS NOT NEW.session_id BEGIN
  INSERT INTO session_catalog_outbox (session_id) VALUES (OLD.session_id);
  UPDATE session_catalog_versions SET version = (SELECT max(seq) FROM session_catalog_outbox)
   WHERE session_id = OLD.session_id;
  INSERT INTO session_catalog_versions (session_id, version)
  SELECT OLD.session_id, (SELECT max(seq) FROM session_catalog_outbox)
   WHERE NOT EXISTS (SELECT 1 FROM session_catalog_versions WHERE session_id = OLD.session_id);
END;

CREATE TRIGGER session_catalog_sessions_delete AFTER DELETE ON sessions BEGIN
  INSERT INTO session_catalog_outbox (session_id) VALUES (OLD.session_id);
  UPDATE session_catalog_versions SET version = (SELECT max(seq) FROM session_catalog_outbox)
   WHERE session_id = OLD.session_id;
  INSERT INTO session_catalog_versions (session_id, version)
  SELECT OLD.session_id, (SELECT max(seq) FROM session_catalog_outbox)
   WHERE NOT EXISTS (SELECT 1 FROM session_catalog_versions WHERE session_id = OLD.session_id);
END;

CREATE TRIGGER session_catalog_stars_insert AFTER INSERT ON starred_turns BEGIN
  INSERT INTO session_catalog_outbox (session_id) VALUES (NEW.session_id);
  UPDATE session_catalog_versions SET version = (SELECT max(seq) FROM session_catalog_outbox)
   WHERE session_id = NEW.session_id;
  INSERT INTO session_catalog_versions (session_id, version)
  SELECT NEW.session_id, (SELECT max(seq) FROM session_catalog_outbox)
   WHERE NOT EXISTS (SELECT 1 FROM session_catalog_versions WHERE session_id = NEW.session_id);
END;

CREATE TRIGGER session_catalog_stars_update AFTER UPDATE ON starred_turns BEGIN
  INSERT INTO session_catalog_outbox (session_id) VALUES (NEW.session_id);
  UPDATE session_catalog_versions SET version = (SELECT max(seq) FROM session_catalog_outbox)
   WHERE session_id = NEW.session_id;
  INSERT INTO session_catalog_versions (session_id, version)
  SELECT NEW.session_id, (SELECT max(seq) FROM session_catalog_outbox)
   WHERE NOT EXISTS (SELECT 1 FROM session_catalog_versions WHERE session_id = NEW.session_id);
END;

CREATE TRIGGER session_catalog_stars_rekey AFTER UPDATE OF session_id ON starred_turns
WHEN OLD.session_id IS NOT NEW.session_id BEGIN
  INSERT INTO session_catalog_outbox (session_id) VALUES (OLD.session_id);
  UPDATE session_catalog_versions SET version = (SELECT max(seq) FROM session_catalog_outbox)
   WHERE session_id = OLD.session_id;
  INSERT INTO session_catalog_versions (session_id, version)
  SELECT OLD.session_id, (SELECT max(seq) FROM session_catalog_outbox)
   WHERE NOT EXISTS (SELECT 1 FROM session_catalog_versions WHERE session_id = OLD.session_id);
END;

CREATE TRIGGER session_catalog_stars_delete AFTER DELETE ON starred_turns BEGIN
  INSERT INTO session_catalog_outbox (session_id) VALUES (OLD.session_id);
  UPDATE session_catalog_versions SET version = (SELECT max(seq) FROM session_catalog_outbox)
   WHERE session_id = OLD.session_id;
  INSERT INTO session_catalog_versions (session_id, version)
  SELECT OLD.session_id, (SELECT max(seq) FROM session_catalog_outbox)
   WHERE NOT EXISTS (SELECT 1 FROM session_catalog_versions WHERE session_id = OLD.session_id);
END;
