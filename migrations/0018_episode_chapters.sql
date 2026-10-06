-- Episode chapters (2026-10-06). Podcasting 2.0 feeds link a JSON chapters
-- file per episode (<podcast:chapters url>); others embed chapters in the
-- audio (ID3 CHAP in mp3, chpl/QuickTime chapters in m4a). Both are fetched
-- after the feed is stored (src/lib/podcasts.ts chapterPump) and written to
-- podcast_episodes.chapters, which the ABS shapes already serve.

ALTER TABLE podcast_episodes ADD COLUMN chapters_url TEXT;
-- When the chapters were last looked for. NULL = not yet. An episode that
-- turned up none is looked at again after a week (publishers add them late).
ALTER TABLE podcast_episodes ADD COLUMN chapters_checked_at INTEGER;
CREATE INDEX idx_episodes_chapters_due ON podcast_episodes(in_library, chapters_checked_at);

-- Bumped when the feed parser learns a field that stored episodes lack
-- (here chapters_url): the next poll re-reads the whole feed once instead of
-- stopping at the first known episodes.
ALTER TABLE podcasts ADD COLUMN parse_version INTEGER NOT NULL DEFAULT 0;
UPDATE podcasts SET next_check_at = 0;
