-- A private show (2026-10-21): left out of "On this server" and /admin's
-- Shows panel for everyone who doesn't follow it (the tenant owner still
-- sees it in /admin). For a paid feed whose address is the subscriber's
-- key: Supercast's "Incognito Mode" would otherwise sit in the other
-- member's "On this server" list, feed URL included. Set by a follower or
-- the owner with PUT /api/podcasts/:id/private.
ALTER TABLE podcasts ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
