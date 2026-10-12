-- Feeds get an episode's length wrong (LINUX Unplugged: 1:20:33 for 1:14:00
-- of audio) and ad-inserting hosts serve every listener a different file, so
-- since 2026-10-12 the chapter pump always probes the audio and keeps the
-- file's own length. Re-check every episode on a show once.
UPDATE podcast_episodes SET chapters_checked_at = NULL WHERE in_library = 1;
