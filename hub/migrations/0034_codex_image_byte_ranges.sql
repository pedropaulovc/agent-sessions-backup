-- Codex input images are base64 data URIs embedded in JSONL response_item messages.
-- Store their exact payload range so a blob GET never fetches/parses the entire image-rich line.
-- NULL on pre-migration rows deliberately fails closed until the session is reindexed from R2.
ALTER TABLE blocks ADD COLUMN media_byte_start INTEGER;
ALTER TABLE blocks ADD COLUMN media_byte_len INTEGER;
ALTER TABLE blocks ADD COLUMN media_type TEXT;
