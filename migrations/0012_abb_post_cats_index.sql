-- The single most expensive thing this database did (2026-09-05).
--
-- abb_post_cats' primary key is (cat, post_id) and its only other index
-- leads with cat, so `DELETE FROM abb_post_cats WHERE post_id = ?` — run
-- once per post on every listing pass, to rewrite that post's categories —
-- had to scan the whole table. At ~65k rows and ~59k calls that was 3.8
-- BILLION rows read, about 99% of the database's entire read volume, for
-- work that touches two or three rows.
CREATE INDEX IF NOT EXISTS abb_post_cats_post ON abb_post_cats(post_id);
