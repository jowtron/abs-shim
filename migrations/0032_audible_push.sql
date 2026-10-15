-- Audible delivery into S3 and WebDAV folders (2026-10-15).
--
-- pCloud pulls a staged title from a signed URL by itself; S3 and WebDAV
-- can't, so the Worker pushes it there in 64 MiB pieces on the cron
-- (src/lib/audible-delivery.ts), several ticks for a big book.

-- When anything was first asked to write this title into its path, never
-- cleared by a retry. A file found at the path is ours (safe to replace)
-- only if it appeared after this. Until now that test read
-- pull_requested_at, which every new claim clears, so a retry after a pull
-- that left half a file behind refused the half file as "someone else's".
ALTER TABLE audible_deliveries ADD COLUMN first_write_at INTEGER;
UPDATE audible_deliveries SET first_write_at = pull_requested_at WHERE pull_requested_at IS NOT NULL;

-- The R2 object's etag when the node handed it over. A push spread over
-- several ticks reads it only while it is still that object (the node
-- re-staging the title under the same key mid-push would otherwise splice
-- two files together), and the copy is deleted only if it is still that one.
ALTER TABLE audible_deliveries ADD COLUMN staged_etag TEXT;

-- The push in progress: S3's multipart UploadId, or for WebDAV `a:<tag>`
-- (appended pieces) or `s:<tag>` (one PUT), the tag naming the temporary
-- file, the mode fixed for the life of that upload; and for S3 the ETags of
-- the parts sent so far (JSON array, part 1 first).
ALTER TABLE audible_deliveries ADD COLUMN upload_id TEXT;
ALTER TABLE audible_deliveries ADD COLUMN upload_parts TEXT;

-- Held by the cron invocation pushing this row, so the next tick (every
-- 2 minutes, while this one may run for 10) leaves it alone.
ALTER TABLE audible_deliveries ADD COLUMN lease_until INTEGER;

-- The size of the file this attempt decided to replace at the path (one of
-- ours, unregistered), NULL when the path was free. Checked again just before
-- the upload is completed or moved into place: a file that appeared there
-- since is someone else's, and is left alone.
ALTER TABLE audible_deliveries ADD COLUMN replaces_size INTEGER;
