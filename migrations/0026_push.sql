-- New-episode push notifications (2026-10-13). The shim is the Web Push
-- sender: it polls the feeds, so it knows when an episode lands. Pholia is
-- the receiver (its service worker shows the notification). See
-- src/lib/push.ts and src/routes/push.ts, and CLAUDE.md "Push notifications".

-- One row per browser subscription (a phone's installed Pholia, a desktop
-- browser). The endpoint is the push service's URL for that subscription and
-- the upsert key: a phone that signs in as someone else moves with its new
-- user. Keys are what the payload is encrypted to (RFC 8291, aesgcm).
CREATE TABLE push_subscriptions (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint            TEXT NOT NULL UNIQUE,
  p256dh              TEXT NOT NULL,          -- the browser's ECDH public key, base64url
  auth                TEXT NOT NULL,          -- the browser's 16-byte auth secret, base64url
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,       -- the last re-POST (Pholia re-posts on every start)
  last_success_at     INTEGER,                -- the push service's last 201/202
  last_failure_at     INTEGER,                -- the last answer that was neither (404/410 delete the row instead)
  last_failure_status INTEGER                 -- its HTTP status; NULL when the fetch itself threw
);
CREATE INDEX idx_push_subs_user ON push_subscriptions(user_id);

-- Which shows each user wants a notification for. The poller looks recipients
-- up by show, hence the second index.
CREATE TABLE push_show_prefs (
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  notify          INTEGER NOT NULL DEFAULT 1,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, library_item_id)
);
CREATE INDEX idx_push_show_prefs_item ON push_show_prefs(library_item_id, notify);

-- What was sent, one row per recipient per event, kept 30 days (the cron
-- deletes older rows). For "I didn't get a notification": did the shim try,
-- and what did the push service say.
CREATE TABLE push_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  user_id TEXT,
  kind    TEXT NOT NULL,                      -- 'episode' | 'test'
  title   TEXT,
  status  TEXT NOT NULL                       -- '1 sent' | '1 sent, 1 failed (503)' | 'no subscription' ...
);
CREATE INDEX idx_push_log_ts ON push_log(ts);
