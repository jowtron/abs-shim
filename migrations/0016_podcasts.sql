-- Podcasts (2026-10-06). A podcast is a library_items row with
-- media_type = 'podcast' in a library whose media_type is 'podcast', exactly
-- as in ABS, plus one `podcasts` row for the show and one `podcast_episodes`
-- row per feed episode.
--
-- Episodes stream straight from the publisher's enclosure URL (proxied by the
-- Worker) until they are archived; an archived episode plays from the
-- library's own storage instead. That is the only thing `archive_*` changes.

CREATE TABLE podcasts (
  library_item_id       TEXT PRIMARY KEY REFERENCES library_items(id) ON DELETE CASCADE,
  tenant_id             TEXT NOT NULL,
  feed_url              TEXT NOT NULL,
  title                 TEXT,
  author                TEXT,
  description           TEXT,
  release_date          TEXT,
  genres                TEXT NOT NULL DEFAULT '[]',
  image_url             TEXT,                      -- the feed's own artwork URL
  cover_url             TEXT,                      -- what the cover route fetches (Apple's resized copy when known)
  itunes_page_url       TEXT,
  itunes_id             TEXT,
  itunes_artist_id      TEXT,
  explicit              INTEGER NOT NULL DEFAULT 0,
  language              TEXT,
  podcast_type          TEXT,                      -- 'episodic' | 'serial'
  tags                  TEXT NOT NULL DEFAULT '[]',
  auto_download         INTEGER NOT NULL DEFAULT 1, -- ABS autoDownloadEpisodes: poll the feed for new episodes
  auto_download_schedule TEXT,                     -- echoed to clients; the poller runs on its own clock
  max_episodes_to_keep  INTEGER NOT NULL DEFAULT 0,
  max_new_episodes_to_download INTEGER NOT NULL DEFAULT 3,
  archive               INTEGER NOT NULL DEFAULT 0, -- 1: copy each new episode into the library's storage
  feed_etag             TEXT,
  feed_last_modified    TEXT,
  last_episode_check    INTEGER,
  next_check_at         INTEGER,
  check_failures        INTEGER NOT NULL DEFAULT 0,
  last_error            TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX idx_podcasts_next_check ON podcasts(next_check_at);
CREATE INDEX idx_podcasts_tenant_feed ON podcasts(tenant_id, feed_url);

CREATE TABLE podcast_episodes (
  id                    TEXT PRIMARY KEY,           -- ABS episode id
  library_item_id       TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  tenant_id             TEXT NOT NULL,
  ino                   TEXT NOT NULL,              -- the audio file's ino: /api/items/:id/file/:ino
  guid                  TEXT NOT NULL,              -- the feed's guid, or the enclosure URL when it has none
  idx                   INTEGER NOT NULL DEFAULT 0,
  season                TEXT,
  episode               TEXT,
  episode_type          TEXT,
  title                 TEXT,
  subtitle              TEXT,
  description           TEXT,
  pub_date              TEXT,
  published_at          INTEGER,
  enclosure_url         TEXT NOT NULL,
  enclosure_type        TEXT,
  enclosure_length      INTEGER,
  duration_seconds      REAL NOT NULL DEFAULT 0,
  size_bytes            INTEGER NOT NULL DEFAULT 0, -- verified bytes; 0 until a response told us
  chapters              TEXT NOT NULL DEFAULT '[]',
  archive_state         TEXT,                       -- NULL | 'queued' | 'fetching' | 'done' | 'error'
  archive_rel_path      TEXT,                       -- relative to the folder root
  archive_expected_size INTEGER,                    -- the source's size, when it said
  archive_seen_size     INTEGER,                    -- pCloud's size at the last poll (completion test when the source didn't say)
  archive_started_at    INTEGER,
  archive_error         TEXT,
  -- Every feed episode gets a row, but only these appear on the show (ABS's
  -- "downloaded" episodes): a 3,000-episode feed would otherwise put megabytes
  -- of show notes in every item fetch. The rest stay browsable and can be added.
  in_library            INTEGER NOT NULL DEFAULT 0,
  removed               INTEGER NOT NULL DEFAULT 0, -- taken off the show by a user: never re-added automatically
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_episodes_item_guid ON podcast_episodes(library_item_id, guid);
CREATE INDEX idx_episodes_item_published ON podcast_episodes(library_item_id, in_library, published_at DESC);
CREATE INDEX idx_episodes_tenant_published ON podcast_episodes(tenant_id, in_library, published_at DESC);
CREATE INDEX idx_episodes_ino ON podcast_episodes(library_item_id, ino);
CREATE INDEX idx_episodes_archive ON podcast_episodes(archive_state);

-- A playback session for an episode has to remember which episode, or the
-- position it syncs lands on the show instead.
ALTER TABLE listening_sessions ADD COLUMN episode_id TEXT;
