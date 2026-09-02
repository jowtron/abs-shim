-- Passkeys (WebAuthn) for shim accounts — the /admin sign-in and any client
-- that wants them. Ported from Pholia's functions/api/auth/webauthn (same
-- table shapes). A credential is bound to one users row; the RP ID is the
-- shim's hostname, so passkeys made on abs-shim.jderrick.app only work there.
CREATE TABLE webauthn_credentials (
  id           TEXT PRIMARY KEY,                -- credential id, base64url
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key   TEXT NOT NULL,                   -- COSE key, base64url
  sign_count   INTEGER NOT NULL DEFAULT 0,
  transports   TEXT NOT NULL DEFAULT '["internal"]',
  label        TEXT,                            -- "Joseph's iPhone" — from the UA at registration
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX webauthn_credentials_user ON webauthn_credentials(user_id);

-- One-shot ceremony challenges; rows expire after 5 minutes and are deleted
-- on use. user_id is set for registration (who the credential binds to).
CREATE TABLE webauthn_challenges (
  id         TEXT PRIMARY KEY,
  challenge  TEXT NOT NULL UNIQUE,
  user_id    TEXT,
  type       TEXT NOT NULL,                     -- 'register' | 'authenticate'
  expires_at INTEGER NOT NULL
);
