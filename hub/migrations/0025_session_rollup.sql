-- Block-only snapshots: pricing remains on usage, independently invalidated.
CREATE TABLE session_rollup_state (
  session_id TEXT PRIMARY KEY,
  generation TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'building', 'ready')),
  completed_at TEXT,
  eligible INTEGER NOT NULL DEFAULT 1,
  finishing INTEGER NOT NULL DEFAULT 0,
  cursor_turn INTEGER NOT NULL DEFAULT -1,
  cursor_block INTEGER NOT NULL DEFAULT -1,
  cursor_id INTEGER NOT NULL DEFAULT 0,
  turn_state TEXT,
  last_attempt INTEGER NOT NULL DEFAULT 0,
  commit_token TEXT
) STRICT;
CREATE INDEX session_rollup_due ON session_rollup_state (eligible, last_attempt, session_id);

CREATE TABLE session_rollup (
  session_id TEXT NOT NULL REFERENCES session_rollup_state(session_id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  model TEXT NOT NULL,
  assistant_turns INTEGER NOT NULL DEFAULT 0,
  rewound_assistant_turns INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  tool_result_source_bytes INTEGER NOT NULL DEFAULT 0,
  repeated_tool_calls INTEGER NOT NULL DEFAULT 0,
  comparable_tool_calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, day, model)
) STRICT;
CREATE INDEX session_rollup_day ON session_rollup (day, model, session_id);

CREATE TABLE session_rollup_seen_calls (
  session_id TEXT NOT NULL REFERENCES session_rollup_state(session_id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (session_id, tool_name, text)
) STRICT;

-- Backfill old ready sessions without a corpus-wide blocks scan.
INSERT INTO session_rollup_state (session_id, eligible)
SELECT session_id, index_state = 'ready' FROM sessions;

-- Also cover cleanup paths outside writeSession, preserving their ownership guards.
CREATE TRIGGER session_rollup_session_deleted AFTER DELETE ON sessions BEGIN
  DELETE FROM session_rollup_state WHERE session_id = OLD.session_id;
END;
CREATE TRIGGER session_rollup_session_unready AFTER UPDATE OF index_state ON sessions
WHEN NEW.index_state != 'ready' BEGIN
  DELETE FROM session_rollup_state WHERE session_id = NEW.session_id;
END;
