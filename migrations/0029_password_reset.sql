-- Passwords: change, forget, reset (2026-10-14). Until now nobody could
-- change a password, there was no "forgot password" and an email could only
-- be set at signup; the only way to recover an account was to write a new
-- hash into this table by hand. Joseph: "there is no mechanism for a user to
-- reset their password". src/lib/password-reset.ts has the rules.

-- Access tokens are stateless 30-day JWTs, so "sign out everywhere" is a
-- stamp: the ms time of the last one. Every token carries the stamp it was
-- issued under (claim `gen`, 0 for NULL) and requireAuth refuses a mismatch.
-- NULL = never. Set by every reset and by a password change that asks to
-- sign out other devices.
ALTER TABLE users ADD COLUMN tokens_valid_after INTEGER;

-- One-time reset links, from "Forgot password?" (emailed, 1 hour) or made by
-- the instance owner in /admin to hand over by text (24 hours). Only the
-- SHA-256 of the link's secret is stored. A user's unused links are deleted
-- when a new one is made by the same route and when their password changes.
CREATE TABLE password_resets (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by  TEXT,                 -- NULL = asked for by email; else the owner who made the link
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);
CREATE INDEX idx_password_resets_user ON password_resets(user_id);
