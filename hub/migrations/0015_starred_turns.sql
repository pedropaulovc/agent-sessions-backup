-- Owner annotations are keyed independently from rebuildable session rows so export cleanup,
-- sibling recovery, and turn reordering cannot detach them from their content.
CREATE TABLE starred_turns (
  session_id TEXT NOT NULL,
  turn_key TEXT NOT NULL,
  starred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (session_id, turn_key)
) STRICT;
CREATE INDEX starred_turns_session ON starred_turns (session_id);
