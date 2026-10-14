-- Keys for the catalogue's wharf nodes (2026-10-14). Until now the abbcrawl
-- and abbcovers services signed in as the owner with his username and
-- password, which sat in plain text on two servers, opened everything, and
-- stopped both crawlers whenever the password changed (it did, that day).
-- A key opens only the catalogue's node routes (src/routes/abb.ts), names
-- the node it belongs to, and is stored only as its SHA-256: the key itself
-- is shown once, in /admin (Catalogue → Node keys). Revoked rows are kept.
CREATE TABLE node_keys (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,          -- the node, as /admin shows it (NODE_NAME)
  key_hash     TEXT NOT NULL UNIQUE,   -- hex SHA-256 of the key
  created_at   INTEGER NOT NULL,
  created_by   TEXT,                   -- the instance owner who made it
  last_used_at INTEGER,                -- touched at most once a minute
  revoked_at   INTEGER
);
