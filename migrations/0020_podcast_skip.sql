-- Per-show intro and outro skipping (2026-10-09). The player (Pholia) does
-- the skipping; the shim only keeps the setting, so it follows the listener
-- to every device. JSON, NULL = no skipping:
--   {"startChapters":1} or {"startSeconds":30}, plus
--   {"endChapters":1}   or {"endSeconds":20}
-- normalised by normalizeSkip() in src/lib/podcast-shapes.ts.
ALTER TABLE podcasts ADD COLUMN skip_json TEXT;
