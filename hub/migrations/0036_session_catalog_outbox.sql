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

CREATE TRIGGER session_catalog_sessions_update AFTER UPDATE ON sessions BEGIN
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
