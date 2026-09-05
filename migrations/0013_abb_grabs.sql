-- Where each AudioBookBay release was put (2026-09-06).
--
-- A grab that doesn't land every track leaves a partial book, and the fix is
-- to run it again from the "On Real-Debrid" panel. That second pass has to
-- put the missing tracks in the SAME folder as the first, or the library
-- gains a second, differently-partial copy of the book — which is exactly
-- how three copies of Dawnlands appeared, none of them complete.
--
-- The destination used to be recomputed from Real-Debrid's torrent name,
-- which changes between passes because RD renames a torrent to whichever
-- file you selected. Keyed on the info hash instead, this table remembers
-- the folder the release first went to, so every later pass tops up that
-- folder no matter what RD is calling it today.
CREATE TABLE abb_grabs (
  tenant_id  TEXT NOT NULL,
  hash       TEXT NOT NULL,          -- lower-case info hash
  dest       TEXT NOT NULL,          -- top folder under the library root
  title      TEXT,
  folder_id  TEXT,                   -- the library_folders row it landed in
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, hash)
);
