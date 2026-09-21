-- OMP's report row id is profile-local while install_id is machine-local, so it cannot
-- identify a report by itself. dedup_key hashes the complete client report identity:
-- retries collapse, but the same row id from another profile remains distinct. properties
-- is a validated JSON object reserved for future producer metadata without another schema
-- migration. received_at plus id provides deterministic newest-first pagination; the
-- tool-prefixed sibling index keeps exact-tool pages bounded. Daily pruning retains six months.

CREATE TABLE omp_qa_reports (
  id INTEGER PRIMARY KEY,
  install_id TEXT NOT NULL,
  entry_id INTEGER NOT NULL CHECK(entry_id > 0),
  properties TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(properties) AND json_type(properties) = 'object'),
  dedup_key TEXT NOT NULL UNIQUE,
  agent_name TEXT NOT NULL,
  agent_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  model TEXT NOT NULL,
  omp_version TEXT NOT NULL,
  tool TEXT NOT NULL,
  report TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX omp_qa_reports_received ON omp_qa_reports (received_at DESC, id DESC);
CREATE INDEX omp_qa_reports_tool_received ON omp_qa_reports (tool, received_at DESC, id DESC);

-- Keep anonymous intake from consuming the shared D1 database. At the 256 KiB request
-- ceiling, 5,000 rows remain well below D1's storage limit even in the pathological
-- one-report-per-request case. Exact retries do not fire this trigger because they do
-- not insert a row.
CREATE TRIGGER omp_qa_reports_cap
AFTER INSERT ON omp_qa_reports
BEGIN
  DELETE FROM omp_qa_reports
   WHERE id = (
     SELECT id
       FROM omp_qa_reports
      ORDER BY received_at DESC, id DESC
      LIMIT 1 OFFSET 5000
   );
END;
