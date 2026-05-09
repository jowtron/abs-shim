-- ABS_shim initial schema.
-- Convention: IDs are TEXT (UUIDs or ABS-style prefixed cuids like 'li_…', 'mp_…').
-- Timestamps are INTEGER ms-epoch to match the JS `Date.now()` convention used by ABS.
-- JSON-shaped columns are stored as TEXT and queried via SQLite JSON1 when needed.

PRAGMA foreign_keys = ON;

-------------------------------------------------------------------------------
-- USERS
-------------------------------------------------------------------------------
CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  username        TEXT NOT NULL UNIQUE,
  email           TEXT,
  type            TEXT NOT NULL DEFAULT 'user',          -- 'root' | 'admin' | 'user' | 'guest'
  password_hash   TEXT,                                  -- argon2id (or PBKDF2 fallback) of the ABS app-password
  google_sub      TEXT UNIQUE,                           -- Google OIDC subject when linked
  is_active       INTEGER NOT NULL DEFAULT 1,
  is_locked       INTEGER NOT NULL DEFAULT 0,
  permissions     TEXT NOT NULL DEFAULT '{}',            -- ABS permission bag (download, update, etc.)
  libraries_accessible TEXT NOT NULL DEFAULT '[]',       -- empty array means "all"
  item_tags_selected   TEXT NOT NULL DEFAULT '[]',
  created_at      INTEGER NOT NULL,
  last_seen       INTEGER
);
CREATE INDEX idx_users_google_sub ON users(google_sub);

-------------------------------------------------------------------------------
-- LIBRARIES
-------------------------------------------------------------------------------
CREATE TABLE libraries (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  display_order   INTEGER NOT NULL DEFAULT 1,
  media_type      TEXT NOT NULL DEFAULT 'book',          -- 'book' | 'podcast'
  icon            TEXT NOT NULL DEFAULT 'audiobookshelf',
  provider        TEXT NOT NULL DEFAULT 'audible',
  settings        TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- A library is composed of one or more "folders". For ABS_shim a folder is a
-- pCloud filedn base URL pointing at a directory of audiobooks.
CREATE TABLE library_folders (
  id              TEXT PRIMARY KEY,
  library_id      TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  filedn_base_url TEXT NOT NULL,                         -- e.g. https://filedn.com/<token>/audiobooks/
  added_at        INTEGER NOT NULL
);
CREATE INDEX idx_folders_library ON library_folders(library_id);

-------------------------------------------------------------------------------
-- LIBRARY ITEMS (audiobooks)
-------------------------------------------------------------------------------
CREATE TABLE library_items (
  id              TEXT PRIMARY KEY,                      -- 'li_' + cuid
  library_id      TEXT NOT NULL REFERENCES libraries(id)        ON DELETE CASCADE,
  folder_id       TEXT NOT NULL REFERENCES library_folders(id)  ON DELETE CASCADE,
  ino             TEXT,                                  -- ABS uses inode-style ids; we synthesise
  rel_path        TEXT NOT NULL,                         -- path relative to folder's base URL
  is_file         INTEGER NOT NULL DEFAULT 0,            -- 1 if single-file book, 0 if folder
  media_type      TEXT NOT NULL DEFAULT 'book',
  is_missing      INTEGER NOT NULL DEFAULT 0,
  is_invalid      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_items_library ON library_items(library_id);
CREATE INDEX idx_items_folder  ON library_items(folder_id);

-- Book-side metadata. One row per library_item where media_type = 'book'.
CREATE TABLE book_metadata (
  library_item_id TEXT PRIMARY KEY REFERENCES library_items(id) ON DELETE CASCADE,
  title           TEXT,
  title_ignore_prefix TEXT,                              -- title with sortingPrefixes stripped, for sorting
  subtitle        TEXT,
  author_name     TEXT,
  narrator_name   TEXT,
  series_name     TEXT,
  series_sequence TEXT,
  description     TEXT,
  isbn            TEXT,
  asin            TEXT,
  language        TEXT,
  publish_year    INTEGER,
  publisher       TEXT,
  genres          TEXT NOT NULL DEFAULT '[]',
  tags            TEXT NOT NULL DEFAULT '[]',
  explicit        INTEGER NOT NULL DEFAULT 0,
  abridged        INTEGER NOT NULL DEFAULT 0,
  cover_url       TEXT                                   -- absolute filedn URL or relative path
);
CREATE INDEX idx_book_meta_title ON book_metadata(title_ignore_prefix);

-- Audio files. Single-file books have one row; multi-part books have several.
CREATE TABLE audio_files (
  id              TEXT PRIMARY KEY,
  library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  index_no        INTEGER NOT NULL,                      -- 1-based order
  filedn_url      TEXT NOT NULL,                         -- absolute URL we 302-redirect clients to
  ino             TEXT,
  duration_seconds REAL NOT NULL DEFAULT 0,
  size_bytes      INTEGER NOT NULL DEFAULT 0,
  mime_type       TEXT,
  format          TEXT,                                  -- 'm4b' | 'm4a' | 'mp3' | 'opus'
  codec           TEXT,
  bitrate         INTEGER,
  sample_rate     INTEGER,
  channels        INTEGER,
  added_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_audio_files_item_idx ON audio_files(library_item_id, index_no);

-- Chapters extracted from moov atom (m4b) or derived from track boundaries.
CREATE TABLE chapters (
  library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  chapter_index   INTEGER NOT NULL,
  title           TEXT NOT NULL,
  start_seconds   REAL NOT NULL,
  end_seconds     REAL NOT NULL,
  PRIMARY KEY (library_item_id, chapter_index)
);

-------------------------------------------------------------------------------
-- PER-USER STATE
-------------------------------------------------------------------------------
CREATE TABLE media_progress (
  id                          TEXT PRIMARY KEY,           -- 'mp_' + cuid
  user_id                     TEXT NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  library_item_id             TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  episode_id                  TEXT,                       -- podcasts only; NULL for books
  duration_seconds            REAL NOT NULL DEFAULT 0,
  progress                    REAL NOT NULL DEFAULT 0,    -- 0..1 fraction
  current_time_seconds        REAL NOT NULL DEFAULT 0,
  is_finished                 INTEGER NOT NULL DEFAULT 0,
  hide_from_continue_listening INTEGER NOT NULL DEFAULT 0,
  ebook_progress              TEXT,
  last_update                 INTEGER NOT NULL,
  started_at                  INTEGER NOT NULL,
  finished_at                 INTEGER,
  -- Compound uniqueness: one progress row per (user, item, episode-or-null).
  -- SQLite treats NULLs as distinct in UNIQUE — fine for books since episode_id is always NULL there.
  UNIQUE (user_id, library_item_id, episode_id)
);
CREATE INDEX idx_progress_user ON media_progress(user_id, last_update DESC);

CREATE TABLE bookmarks (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  time_seconds    REAL NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_bookmarks_user_item ON bookmarks(user_id, library_item_id);

CREATE TABLE listening_sessions (
  id                      TEXT PRIMARY KEY,               -- 'play_' + cuid
  user_id                 TEXT NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  library_item_id         TEXT          REFERENCES library_items(id) ON DELETE SET NULL,
  display_title           TEXT,
  display_author          TEXT,
  duration_seconds        REAL NOT NULL DEFAULT 0,
  play_method             INTEGER NOT NULL DEFAULT 0,     -- 0=DirectPlay, 1=DirectStream, 2=Transcode, 3=Local
  media_player            TEXT,
  device_info             TEXT NOT NULL DEFAULT '{}',
  server_version          TEXT,
  date_started            INTEGER NOT NULL,
  current_time_seconds    REAL NOT NULL DEFAULT 0,
  time_listening_seconds  INTEGER NOT NULL DEFAULT 0,
  start_time_seconds      REAL NOT NULL DEFAULT 0,
  closed_at               INTEGER,
  updated_at              INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user_date ON listening_sessions(user_id, date_started DESC);

-------------------------------------------------------------------------------
-- AUTH PERSISTENCE
-------------------------------------------------------------------------------
-- Refresh tokens. Store SHA-256 hash, never the raw token.
CREATE TABLE refresh_tokens (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE,
  expires_at      INTEGER NOT NULL,
  device_info     TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL,
  last_used       INTEGER
);
CREATE INDEX idx_refresh_user ON refresh_tokens(user_id, expires_at);

-------------------------------------------------------------------------------
-- SERVER-WIDE SETTINGS (singleton KV)
-------------------------------------------------------------------------------
CREATE TABLE server_settings (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL
);
