-- AudioBookBay catalogue: a slowly-built local copy of ABB's listings so
-- search works instantly (and while ABB is down), a release can be sent to
-- Real-Debrid without a live page fetch once its info hash is cached, and
-- the site can be browsed by category. Instance-wide (public data), filled
-- by the cron in src/lib/abb-catalog.ts.
--
-- One row per ABB *post* (url), never per title: the same book is often
-- posted more than once (different rip / narrator / format) under slugs
-- like `title-author-2`, each with its own torrent and hash.
CREATE TABLE abb_posts (
  id                INTEGER PRIMARY KEY,
  url               TEXT NOT NULL UNIQUE,   -- https://audiobookbay.lu/abss/<slug>/
  title             TEXT NOT NULL,
  cover             TEXT,
  categories        TEXT NOT NULL DEFAULT '[]',  -- JSON array, labels as ABB prints them
  keywords          TEXT NOT NULL DEFAULT '[]',  -- JSON array
  language          TEXT,
  format            TEXT,                   -- lower-case: m4b, mp3, ...
  bitrate           TEXT,
  size_bytes        INTEGER,
  posted            TEXT,                   -- "2 Sep 2026" verbatim
  posted_ts         INTEGER,                -- posted parsed to ms epoch (UTC midnight)
  -- From the detail page; NULL until the crawler (or a live resolve) gets there.
  info_hash         TEXT,
  author            TEXT,
  narrators         TEXT,                   -- JSON array
  length            TEXT,
  abridged          INTEGER,
  description       TEXT,
  first_seen        INTEGER NOT NULL,
  last_seen         INTEGER NOT NULL,
  detail_fetched_at INTEGER,
  detail_error      TEXT
);
CREATE INDEX abb_posts_recent  ON abb_posts(posted_ts DESC, id DESC);
CREATE INDEX abb_posts_pending ON abb_posts(posted_ts DESC, id DESC) WHERE detail_fetched_at IS NULL;
CREATE INDEX abb_posts_hash    ON abb_posts(info_hash);

-- Category membership, one row per (category, post), for the browse view.
CREATE TABLE abb_post_cats (
  post_id   INTEGER NOT NULL REFERENCES abb_posts(id) ON DELETE CASCADE,
  cat       TEXT NOT NULL,
  posted_ts INTEGER,
  PRIMARY KEY (cat, post_id)
);
CREATE INDEX abb_post_cats_recent ON abb_post_cats(cat, posted_ts DESC, post_id DESC);

-- Full-text index over the post (external-content FTS5 kept in sync by the
-- triggers below). Column order matters: bm25() weights in catalogSearch
-- are positional (title, author, narrators, description).
CREATE VIRTUAL TABLE abb_posts_fts USING fts5(
  title, author, narrators, description,
  content='abb_posts', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER abb_posts_ai AFTER INSERT ON abb_posts BEGIN
  INSERT INTO abb_posts_fts(rowid, title, author, narrators, description)
    VALUES (new.id, new.title, new.author, new.narrators, new.description);
END;
CREATE TRIGGER abb_posts_ad AFTER DELETE ON abb_posts BEGIN
  INSERT INTO abb_posts_fts(abb_posts_fts, rowid, title, author, narrators, description)
    VALUES ('delete', old.id, old.title, old.author, old.narrators, old.description);
END;
CREATE TRIGGER abb_posts_au AFTER UPDATE ON abb_posts BEGIN
  INSERT INTO abb_posts_fts(abb_posts_fts, rowid, title, author, narrators, description)
    VALUES ('delete', old.id, old.title, old.author, old.narrators, old.description);
  INSERT INTO abb_posts_fts(rowid, title, author, narrators, description)
    VALUES (new.id, new.title, new.author, new.narrators, new.description);
END;

-- Crawler state: `stats` plus one `listing:<path>` row per ABB listing
-- (home + every category/language page) holding its backfill cursor.
CREATE TABLE abb_crawl (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,   -- JSON
  updated_at INTEGER NOT NULL
);
