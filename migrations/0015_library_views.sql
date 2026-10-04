-- Library views (2026-10-04): extra libraries that are filters over a real
-- one, so a client can show "Liz's Audible" or "everything except Audible"
-- without the books being moved or scanned twice. A view lists as an
-- ordinary library in /api/libraries; its routes read the real library's
-- items narrowed by these columns (all optional, ANDed together):
--   folder_id      only books on this storage backend
--   include_prefix only books whose rel_path starts with this
--   exclude_prefix leave out books whose rel_path starts with this
-- Author and series ids stay salted with the REAL library id (see
-- src/lib/ids.ts), so an author opened from a view is the same author.
CREATE TABLE IF NOT EXISTS library_views (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  library_id     TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  folder_id      TEXT,
  include_prefix TEXT,
  exclude_prefix TEXT,
  display_order  INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_library_views_tenant ON library_views(tenant_id);
