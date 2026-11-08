-- Held copies of episodes (2026-11-08): "Play without ads, I'll wait".
--
-- A listen run ("analysis/run" with {listen: true}) keeps the exact bytes
-- its analysis job downloaded in R2 (COVERS bucket, held/<episodeId>/<size>),
-- and while a row here exists every stream of the episode is served from
-- that copy, so the analysis always matches what is played. See
-- src/lib/episode-holds.ts.
--
-- held_until: 3 days past the last play (bumped at most hourly by the stream
-- route); the 2-minute cron deletes expired rows and their objects. `ino` and
-- library_item_id let the stream route look a hold up beside the episode
-- (it is addressed by ino). No foreign keys, like video_progress:
-- itemDeleteStatements clears a deleted show's rows by library_item_id.
CREATE TABLE episode_holds (
  episode_id TEXT PRIMARY KEY,
  library_item_id TEXT NOT NULL,
  ino TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  held_until INTEGER NOT NULL
);
CREATE INDEX episode_holds_item ON episode_holds(library_item_id, ino);
CREATE INDEX episode_holds_until ON episode_holds(held_until);

-- A listen run: picked before every other queued or automatic candidate,
-- never held back for a pCloud archive, and its download is held.
ALTER TABLE episode_analysis ADD COLUMN listen INTEGER NOT NULL DEFAULT 0;
