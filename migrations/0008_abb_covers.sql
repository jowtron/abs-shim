-- Locally-resized catalogue covers. The source images live on free image
-- hosts (phototourl, ibb, Amazon) and die over time, and Workers can't
-- resize images themselves, so scripts/abb-covers.mjs pulls each cover
-- to a Mac, squeezes it to a small webp, and PUTs it back to the shim,
-- which stores it in R2 under abbcovers/<id>.webp.
--   cover_r2 = ms-epoch when the webp was stored (NULL = not yet)
--   cover_error = why the script couldn't (dead host, not an image, …)
ALTER TABLE abb_posts ADD COLUMN cover_r2 INTEGER;
ALTER TABLE abb_posts ADD COLUMN cover_error TEXT;
CREATE INDEX abb_posts_cover_pending ON abb_posts(posted_ts DESC, id DESC) WHERE cover IS NOT NULL AND cover_r2 IS NULL AND cover_error IS NULL;
