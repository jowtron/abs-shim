-- Storage providers + OAuth profiles.
--
-- Until now the only "storage backend" was a hard-coded filedn public URL on
-- each library_folder, with audio_files holding pre-built absolute URLs. That
-- works for one tenant on pCloud-public mode but rules out private storage and
-- automated scanning.
--
-- This migration generalises folders to talk to a StorageAdapter, of which
-- PublicUrlAdapter (back-compat with existing seed data) and PcloudOAuthAdapter
-- (private, scannable) are the first two. New providers (R2, B2, Dropbox, etc.)
-- only need an adapter implementation — no further schema changes.

PRAGMA foreign_keys = ON;

-- OAuth tokens shared across one or more library_folders. Separated out so a
-- single pCloud connection can back multiple libraries, and so we can track
-- account identity / verify state independent of folder config.
CREATE TABLE oauth_profiles (
  id                TEXT PRIMARY KEY,
  provider          TEXT NOT NULL,        -- 'pcloud' | 'dropbox' | 'google_drive' | 'onedrive'
  access_token      TEXT NOT NULL,
  refresh_token     TEXT,                 -- nullable: pCloud tokens don't expire by default
  api_host          TEXT,                 -- e.g. 'api.pcloud.com' or 'eapi.pcloud.com' (EU)
  account_label     TEXT,                 -- email or display name, for UI
  scope             TEXT,                 -- granted scopes, for diagnostics
  created_at        INTEGER NOT NULL,
  last_verified_at  INTEGER
);
CREATE INDEX idx_oauth_profiles_provider ON oauth_profiles(provider);

-- Short-lived rows tracking in-flight OAuth state tokens (CSRF). Cleaned up on
-- callback or on a periodic sweep.
CREATE TABLE oauth_state (
  state             TEXT PRIMARY KEY,
  provider          TEXT NOT NULL,
  redirect_target   TEXT,                 -- where to send the browser after success
  expires_at        INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
);

-- Library folders gain a provider + adapter-specific config. Existing rows
-- default to 'public_url' so the current seed continues to work unchanged.
ALTER TABLE library_folders ADD COLUMN provider TEXT NOT NULL DEFAULT 'public_url';
ALTER TABLE library_folders ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE library_folders ADD COLUMN profile_id TEXT REFERENCES oauth_profiles(id) ON DELETE SET NULL;

-- audio_files gain a relative path + provider-specific file id. The legacy
-- filedn_url stays for back-compat with the seed; for new (scanned) files it
-- can be NULL — the adapter resolves a fresh URL on each request.
ALTER TABLE audio_files ADD COLUMN rel_path TEXT;
ALTER TABLE audio_files ADD COLUMN provider_file_id TEXT;
