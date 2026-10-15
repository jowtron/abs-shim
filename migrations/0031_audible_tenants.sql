-- Audible import for every library, not only the instance owner's (2026-10-15).
--
-- audible_accounts: which library each account on the audible wharf node
-- belongs to. The node keeps one instance-wide list of auth files
-- (data/cli/<node_name>.json), so a library's own name for an account ("mum")
-- maps to a node name that can't collide with anyone else's. Accounts linked
-- before this keep their name on the node (node_name = name).
CREATE TABLE audible_accounts (
  node_name  TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_audible_accounts_tenant_name ON audible_accounts(tenant_id, name);

-- The old per-tenant owner map ({account: userId}), from the instance
-- owner's library only: before 2026-10-15 any library's owner could claim
-- any name, so another library's map can't be trusted with his accounts.
-- Accounts with no entry (linked before members could) are adopted by his
-- library on its next accounts listing.
INSERT OR IGNORE INTO audible_accounts (node_name, tenant_id, user_id, name, created_at)
  SELECT j.key, s.tenant_id, j.value, j.key, CAST(strftime('%s', 'now') AS INTEGER) * 1000
    FROM tenant_settings s
    JOIN tenants t ON t.id = s.tenant_id
    JOIN users u ON u.id = t.owner_user_id AND u.type IN ('root', 'admin'),
         json_each(s.value) j
   WHERE s.key = 'audible_account_owners';

-- The accounts snapshot was the node's whole instance-wide list (Amazon
-- customer names included); the routes now keep a per-library one under a
-- new key.
DELETE FROM tenant_settings WHERE key = 'audible_accounts';

-- One row per sync job. The node stages each finished m4b in R2 and posts it
-- to /api/audible-node/staged with this sync's token (only its SHA-256 is
-- kept); Rhapsode then copies it into the library's own storage.
CREATE TABLE audible_syncs (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  node_name  TEXT NOT NULL,
  account    TEXT NOT NULL,
  library_id TEXT NOT NULL,
  folder_id  TEXT NOT NULL,
  job_id     TEXT,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audible_syncs_job ON audible_syncs(job_id);

-- One row per staged title: queued → fetching (pCloud is pulling it) → done
-- (registered, staged copy deleted) or error.
CREATE TABLE audible_deliveries (
  id              TEXT PRIMARY KEY,
  sync_id         TEXT NOT NULL REFERENCES audible_syncs(id) ON DELETE CASCADE,
  asin            TEXT NOT NULL,
  title           TEXT,
  staged_key      TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  rel_path        TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'queued',
  error           TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  started_at      INTEGER,
  library_item_id TEXT,
  -- When pCloud accepted this attempt's pull, and when it first fetched the
  -- signed URL: a file at the path is ours only if created after the first,
  -- and a pull nobody fetched is retried without waiting hours.
  pull_requested_at INTEGER,
  first_fetch_at    INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_audible_deliveries_sync_asin ON audible_deliveries(sync_id, asin);
CREATE INDEX idx_audible_deliveries_state ON audible_deliveries(state, updated_at);
CREATE INDEX idx_audible_deliveries_path ON audible_deliveries(rel_path);
