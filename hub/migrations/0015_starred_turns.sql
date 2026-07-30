-- Owner annotations live outside the rebuildable transcript index so they survive reindexing.
CREATE TABLE starred_turns (
  session_id TEXT NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL CHECK (turn_index >= 0),
  starred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (session_id, turn_index)
) STRICT;
