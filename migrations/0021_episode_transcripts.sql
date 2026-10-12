-- Episode transcripts (2026-10-12). Podcasting 2.0 feeds list transcript
-- files per episode (<podcast:transcript url type language rel>); LINUX
-- Unplugged gives a WebVTT and an SRT, Linux & Open Source News an SRT,
-- Linux Matters plain text. The links are kept as a JSON array; the file is
-- fetched and parsed only when a client opens it
-- (GET /api/podcasts/:id/episode/:episodeId/transcript). NULL = none listed.
ALTER TABLE podcast_episodes ADD COLUMN transcripts TEXT;

-- PARSE_VERSION 2: each show's next poll re-reads its whole feed once so the
-- stored episodes gain their links; run that poll on the next cron tick.
UPDATE podcasts SET next_check_at = 0;
