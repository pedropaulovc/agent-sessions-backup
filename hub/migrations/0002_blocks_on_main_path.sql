-- Persist each turn's main-path membership at index time so the viewer never has to
-- recompute it from a partial (per-page) parse — a rewind crossing a page boundary
-- can't be resolved from the page's byte window alone.
ALTER TABLE blocks ADD COLUMN on_main_path INTEGER NOT NULL DEFAULT 1;
