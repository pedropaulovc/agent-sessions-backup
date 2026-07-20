-- The watchdog's 15-minute health snapshot groups every file by machine and
-- counts parse_state values. The existing UNIQUE(machine_id, store, relpath)
-- index can provide the grouping order, but parse_state then requires one table
-- lookup per file. Production evidence before this index: 147,899 rows read and
-- 1,063 ms SQL duration for a single read-only snapshot.
--
-- Keeping both columns in the index makes that aggregation a covering-index
-- scan. It also serves /api/v1/status and the viewer's /machines page, which
-- compute the same per-machine state counts.
CREATE INDEX IF NOT EXISTS idx_files_machine_state
  ON files(machine_id, parse_state);
