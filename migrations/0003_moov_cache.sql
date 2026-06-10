-- Record where each m4b's moov atom lives in the source file so the streaming
-- route can cache that byte range to R2 and short-circuit pCloud round-trips
-- on iOS Safari's seek-to-moov requests. NULL until backfilled (the scanner
-- writes them on probe; older rows get filled in on first /play).
ALTER TABLE audio_files ADD COLUMN moov_offset INTEGER;
ALTER TABLE audio_files ADD COLUMN moov_size INTEGER;
