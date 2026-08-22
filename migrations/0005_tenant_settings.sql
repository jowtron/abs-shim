-- Per-tenant key/value settings. server_settings (0001) is instance-wide;
-- ABB / Real-Debrid credentials are per tenant (each household brings its
-- own accounts), so they get their own table. Values are plaintext JSON or
-- strings, same posture as library_folders.config_json.
CREATE TABLE tenant_settings (
  tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
