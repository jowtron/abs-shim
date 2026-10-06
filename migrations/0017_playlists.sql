-- Playlists (2026-10-06): ABS's per-user, per-library playlists, which the
-- shim answered with an empty stub until now. An item is a book
-- (episode_id NULL) or one podcast episode.
--
-- `rules` is a shim extra: a smart playlist, in the manner of Pocket Casts'
-- filters, whose items are not stored but computed on every read from
-- {podcastIds, include, sort, limit, days} (src/routes/playlists.ts). ABS
-- clients see an ordinary playlist that keeps itself current.

CREATE TABLE playlists (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  library_id    TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  rules         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_playlists_user ON playlists(user_id, library_id);

CREATE TABLE playlist_items (
  playlist_id     TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  episode_id      TEXT,
  added_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_playlist_items_unique ON playlist_items(playlist_id, library_item_id, COALESCE(episode_id, ''));
CREATE INDEX idx_playlist_items_position ON playlist_items(playlist_id, position);
