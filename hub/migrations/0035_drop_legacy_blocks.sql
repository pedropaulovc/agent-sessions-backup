-- Transcript blocks and their FTS now live on the index shards (hub/migrations-index).
--
-- Production applies this only through the protected cutover: under the maintenance revision, after
-- every legacy block row has been copied to its shard with its original id and verified by exact
-- canonical readback and FTS probes, and after the verified source rows were deleted. R2 remains the
-- source of truth and the verified shards retain every row; nothing here is recoverable from main.
-- Fresh local, test and preview databases have no blocks to move.
--
-- Fail closed even if a caller bypasses the protected copier. As with the copier's native
-- SQLite writer guards, RAISE aborts before any row can be deleted. On an empty table this
-- statement does nothing. The runner owns the transaction; do not nest BEGIN/COMMIT here.
CREATE TRIGGER legacy_blocks_retirement_guard BEFORE DELETE ON blocks BEGIN
  SELECT RAISE(ABORT, 'legacy_blocks_not_empty');
END;
DELETE FROM blocks;
DROP TRIGGER legacy_blocks_retirement_guard;

-- The external-content FTS index goes first: it references `blocks` as its content table.
DROP TABLE blocks_fts;
DROP TABLE blocks;
-- Dropping blocks also removes the temporary legacy-writer guard triggers.
DROP TABLE IF EXISTS index_migration_freeze;
