-- Author images and biographies from Audnexus (2026-09-06).
--
-- Authors are derived from book_metadata.author_name rather than being
-- records of their own, so this is the only row an author has, keyed by the
-- derived author id (stable for a name within a library). checked_at is set
-- after an Audnexus lookup whether or not it found anything, so a name
-- Audnexus has never heard of isn't looked up again on every request; a miss
-- is retried after 30 days. image_r2 records the copy of the image kept in
-- the COVERS bucket (authors/<author_id>), fetched on the first request for
-- /api/authors/:id/image.
CREATE TABLE IF NOT EXISTS author_meta (
  author_id   TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  library_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  asin        TEXT,
  description TEXT,
  image_url   TEXT,
  image_r2    TEXT,
  checked_at  INTEGER,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_author_meta_library ON author_meta(library_id);
