-- One library item per (folder, path). Two concurrent registrations of the
-- same file (fetch-url/finish racing a library scan, observed 2026-08-23 with
-- three Real-Debrid grabs finishing together) each passed their "already
-- exists?" pre-check and both inserted. The index makes the second insert
-- fail atomically (the whole probe batch rolls back); the scanner treats
-- that failure as "already in library".
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_folder_relpath ON library_items(folder_id, rel_path);
