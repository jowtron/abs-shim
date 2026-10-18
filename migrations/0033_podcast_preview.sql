-- A show stored only so someone could look at it (2026-10-18): Pholia's
-- search opens a podcast-directory result as an ordinary show page, which
-- needs the show stored, but nobody follows it yet. `previewed_at` is the
-- last time someone opened it that way; NULL for every show anyone ever
-- followed (followShow clears it), so existing rows are untouched.
--
-- While set, the show is left out of "On this server", and one nobody has
-- followed, played or opened for 30 days is deleted (prunePreviews).
ALTER TABLE podcasts ADD COLUMN previewed_at INTEGER;
