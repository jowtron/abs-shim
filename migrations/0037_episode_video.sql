-- Video episodes (2026-10-22).
--
-- Two kinds turned up in Joseph's shows:
--   * LINUX Unplugged lists a 1080p mp4 beside the mp3 on every episode since
--     Feb 2026, as a Podcasting 2.0 <podcast:alternateEnclosure type="video/…">.
--     The parser ignored it. `videos` keeps those alternatives (video only),
--     JSON [{url, type, length, height, bitrate, title}], filled on each show's
--     next poll by the PARSE_VERSION 3 re-read.
--   * Incognito Mode's "The State of Search Engine 2025" IS a video (a 3.2 GB
--     1080p mp4) whose enclosure says type="audio/mpeg" length="0". It was
--     served to players as an mp3 and archived to pCloud as ".mp3".
--     `file_type` is what the enclosure really is, read from its first bytes
--     (sniffEpisodeFile): 'audio/mpeg', 'audio/mp4', 'video/mp4', 'audio/ogg',
--     …, '' when nothing was recognised, NULL until looked at. The feed poll
--     never writes it, so a feed's label can't undo it.
ALTER TABLE podcast_episodes ADD COLUMN videos TEXT;
ALTER TABLE podcast_episodes ADD COLUMN file_type TEXT;
-- The sniff pump's queue: empty once every on-show episode has been looked at,
-- so its query then reads nothing.
CREATE INDEX podcast_episodes_unsniffed ON podcast_episodes(published_at DESC) WHERE file_type IS NULL AND in_library = 1;

-- Where each person is in an episode's VIDEO. A separate edit from the audio
-- (LINUX Unplugged's video runs minutes shorter or longer than the mp3, which
-- has art19's ads stitched in), so it can't share the listening position.
-- "Played" is still the one in media_progress: finishing either marks it.
-- No foreign keys, like podcast_episode_hidden: itemDeleteStatements clears
-- a deleted show's rows by library_item_id.
CREATE TABLE video_progress (
  user_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  library_item_id TEXT NOT NULL,
  position REAL NOT NULL,
  duration REAL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, episode_id)
);
CREATE INDEX video_progress_item ON video_progress(library_item_id);
