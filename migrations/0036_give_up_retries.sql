-- Two things that were retried for ever (2026-10-21).
--
-- Catalogue covers. The runner leaves a cover pending when its host doesn't
-- answer at all (a timeout is usually a blip), so a host that is simply gone
-- was handed out on every pass: 28 of them (old archive.org datanodes,
-- libgen mirrors, dead shop sites) timed out on every pass from both nodes
-- from mid-September on, ~9 minutes of every ~24 spent waiting on them. The
-- shim now counts handouts (coversPending) and records a cover as failed once
-- it has been handed out COVER_GIVE_UP_TRIES times over COVER_GIVE_UP_MS
-- without being stored or failed. "Retry cover errors" resets both columns.
ALTER TABLE abb_posts ADD COLUMN cover_tries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE abb_posts ADD COLUMN cover_first_try INTEGER;

-- Covers still pending a week after their post was first seen are those 28:
-- the node logs show every one of them timing out on every pass. Start them
-- at the threshold so the next handout retires them instead of three more
-- days of the same.
UPDATE abb_posts SET cover_tries = 12, cover_first_try = first_seen
 WHERE cover IS NOT NULL AND cover_r2 IS NULL AND cover_error IS NULL
   AND first_seen < (strftime('%s', 'now') - 7 * 86400) * 1000;

-- Podcast archives. pCloud answers downloadfileasync with result 0 whether
-- or not it can fetch the URL, and a pull it never starts leaves no file:
-- Incognito Mode's "America vs. China" (2026-10-21, one of 140 queued by
-- Archive all, the others from the same Megaphone host all landed) sat at
-- 0 bytes for the full 6 h and was then failed. archivePump now starts such
-- a pull again after ARCHIVE_NO_START_MS, ARCHIVE_MAX_ATTEMPTS in all.
ALTER TABLE podcast_episodes ADD COLUMN archive_attempts INTEGER NOT NULL DEFAULT 0;
