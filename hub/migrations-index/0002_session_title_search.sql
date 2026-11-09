-- Titles are session metadata, not transcript blocks. Every shard already mirrors the entire
-- session catalog; index those replicas so existing titles become searchable without raw reparse.
-- Query title hits only on shard zero and use the other replicas to deduplicate facet sessions.
-- Keep the `text` column and tokenizer compatible with blocks_fts MATCH syntax.
-- The additional first-interaction field is searchable only when it is the displayed title:
-- sessionDisplayTitle prefers a nonempty stored title for OMP, derived-first for other harnesses.
CREATE VIEW session_title_content AS
SELECT rowid, session_id, title AS text,
       CASE WHEN harness = 'omp' AND coalesce(title, '') <> '' THEN NULL
            WHEN first_interaction_title IS title THEN NULL
            ELSE first_interaction_title END AS first_interaction_title
  FROM sessions;

CREATE VIRTUAL TABLE session_titles_fts USING fts5 (
  text,
  first_interaction_title,
  content = 'session_title_content',
  content_rowid = 'rowid',
  tokenize = "unicode61 remove_diacritics 2 tokenchars '_-.'"
);

-- Catalog replication uses guarded UPSERTs, not REPLACE. These triggers run in the same atomic
-- shard batch as the catalog version fence, including frozen-copy seeds and deletion tombstones.
CREATE TRIGGER sessions_title_search_insert AFTER INSERT ON sessions BEGIN
  INSERT INTO session_titles_fts (rowid, text, first_interaction_title)
  SELECT rowid, text, first_interaction_title FROM session_title_content WHERE rowid = new.rowid;
END;

CREATE TRIGGER sessions_title_search_delete BEFORE DELETE ON sessions BEGIN
  INSERT INTO session_titles_fts (session_titles_fts, rowid, text, first_interaction_title)
  SELECT 'delete', rowid, text, first_interaction_title FROM session_title_content WHERE rowid = old.rowid;
END;

CREATE TRIGGER sessions_title_search_before_update BEFORE UPDATE OF title, first_interaction_title, harness ON sessions
WHEN old.title IS NOT new.title OR old.first_interaction_title IS NOT new.first_interaction_title OR old.harness IS NOT new.harness BEGIN
  INSERT INTO session_titles_fts (session_titles_fts, rowid, text, first_interaction_title)
  SELECT 'delete', rowid, text, first_interaction_title FROM session_title_content WHERE rowid = old.rowid;
END;

CREATE TRIGGER sessions_title_search_after_update AFTER UPDATE OF title, first_interaction_title, harness ON sessions
WHEN old.title IS NOT new.title OR old.first_interaction_title IS NOT new.first_interaction_title OR old.harness IS NOT new.harness BEGIN
  INSERT INTO session_titles_fts (rowid, text, first_interaction_title)
  SELECT rowid, text, first_interaction_title FROM session_title_content WHERE rowid = new.rowid;
END;

-- Backfill the already-replicated metadata. No blocks, byte offsets, usage or raw R2 files change.
INSERT INTO session_titles_fts (session_titles_fts) VALUES ('rebuild');
