-- Multi-tenancy. Until now the shim was single-tenant: one root user owned one
-- shared library. This migration introduces tenants (an org/household that owns
-- libraries) and tenant membership (multiple user logins can share one tenant),
-- then denormalizes tenant_id onto the content tables so query scoping is a
-- single indexed predicate — NOT a JOIN on the streaming hot path or the
-- cover-id resolution scan.
--
-- The denormalized tenant_id columns are added nullable (SQLite can't add a
-- NOT NULL column to a populated table without a default), then backfilled.
-- Code treats them as required from here on.

PRAGMA foreign_keys = ON;

CREATE TABLE tenants (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- A user's membership in a tenant. role = 'owner' | 'member'. is_default marks
-- the tenant a user lands in when they don't explicitly switch.
CREATE TABLE tenant_members (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'member',
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX idx_tenant_members_user ON tenant_members(user_id);

-- Signup invites. tenant_id NULL => redeeming the code creates a brand-new
-- tenant owned by the new user; non-NULL => the new user joins that tenant.
CREATE TABLE invites (
  code        TEXT PRIMARY KEY,
  tenant_id   TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  email       TEXT,
  role        TEXT NOT NULL DEFAULT 'member',
  expires_at  INTEGER,
  created_by  TEXT REFERENCES users(id),
  used_by     TEXT REFERENCES users(id),
  used_at     INTEGER,
  created_at  INTEGER NOT NULL
);

-- Approval gate for self-serve signup. is_active stays the hard on/off switch;
-- signup_status distinguishes 'pending' (awaiting owner approval) from 'active'.
ALTER TABLE users ADD COLUMN signup_status TEXT NOT NULL DEFAULT 'active';

-- Denormalized tenant ownership on the content tables.
ALTER TABLE libraries       ADD COLUMN tenant_id TEXT REFERENCES tenants(id);
ALTER TABLE library_folders ADD COLUMN tenant_id TEXT REFERENCES tenants(id);
ALTER TABLE library_items   ADD COLUMN tenant_id TEXT REFERENCES tenants(id);
ALTER TABLE audio_files     ADD COLUMN tenant_id TEXT REFERENCES tenants(id);
ALTER TABLE book_metadata   ADD COLUMN tenant_id TEXT REFERENCES tenants(id);
ALTER TABLE oauth_profiles  ADD COLUMN tenant_id TEXT REFERENCES tenants(id);

CREATE INDEX idx_libraries_tenant  ON libraries(tenant_id);
CREATE INDEX idx_folders_tenant    ON library_folders(tenant_id);
CREATE INDEX idx_items_tenant      ON library_items(tenant_id);
CREATE INDEX idx_items_tenant_lib  ON library_items(tenant_id, library_id);
CREATE INDEX idx_audio_tenant      ON audio_files(tenant_id);
CREATE INDEX idx_book_meta_tenant  ON book_metadata(tenant_id);
CREATE INDEX idx_oauth_tenant      ON oauth_profiles(tenant_id);

-- ── Backfill existing data into a default tenant owned by the root user ──────
INSERT INTO tenants (id, name, owner_user_id, created_at, updated_at)
SELECT 'tnt_default', 'Default', id, 1782140800000, 1782140800000
FROM users WHERE type = 'root' ORDER BY created_at ASC LIMIT 1;

INSERT INTO tenant_members (tenant_id, user_id, role, is_default, created_at)
SELECT 'tnt_default', id,
       CASE WHEN type = 'root' THEN 'owner' ELSE 'member' END,
       1, 1782140800000
FROM users;

UPDATE libraries       SET tenant_id = 'tnt_default' WHERE tenant_id IS NULL;
UPDATE library_folders SET tenant_id = 'tnt_default' WHERE tenant_id IS NULL;
UPDATE library_items   SET tenant_id = 'tnt_default' WHERE tenant_id IS NULL;
UPDATE audio_files     SET tenant_id = 'tnt_default' WHERE tenant_id IS NULL;
UPDATE book_metadata   SET tenant_id = 'tnt_default' WHERE tenant_id IS NULL;
UPDATE oauth_profiles  SET tenant_id = 'tnt_default' WHERE tenant_id IS NULL;
