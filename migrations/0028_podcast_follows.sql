-- Per-person podcast lists (2026-10-14). Joseph: "Build it and hide it
-- should be per person." A tenant's podcast library is shared by every
-- member, but each person now has their own list of shows: a FOLLOW. Every
-- show is still stored once (one poll, one set of episode rows, one pCloud
-- archive, one analysis); a member who adds a feed the library already has
-- follows that show instead of getting a 409 (src/lib/podcasts.ts
-- createPodcast). A show nobody follows stays stored but is idle: the poller,
-- automatic archiving, the analysis pump's "new" picks and push all skip it.
-- CLAUDE.md "Podcasts" has the rules.

CREATE TABLE podcast_follows (
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  library_item_id  TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  tenant_id        TEXT NOT NULL,            -- so leaving a tenant can drop its follows (removeMember)
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (user_id, library_item_id)
);
-- Followers of one show: the idle test (poller, archive, analysis), the
-- follower counts on show items, and the ON DELETE CASCADE from library_items.
CREATE INDEX idx_podcast_follows_item ON podcast_follows(library_item_id);

-- "Hide episode" is per person: the episode stays on the show for everyone
-- else (in_library and removed are untouched; those are the owner's ?hard=1).
-- No foreign key to podcast_episodes on purpose: episodes are only ever
-- deleted with their show, which the library_items cascade covers, and an
-- episode_id cascade would scan this table once per deleted episode (3,000
-- for The Daily) because nothing here leads with episode_id.
CREATE TABLE podcast_episode_hidden (
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  episode_id       TEXT NOT NULL,
  library_item_id  TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (user_id, episode_id)
);
-- One person's hidden episodes of some shows (episode counts on show lists).
CREATE INDEX idx_episode_hidden_user_item ON podcast_episode_hidden(user_id, library_item_id);

-- Everything that exists today was the owner's list: each tenant's owner
-- follows every show in that tenant. Nobody else follows anything yet (a
-- member's list starts empty, by design). removed = 1 episodes are left as
-- they are: prod had none on the day, and they stay the show-wide removal.
INSERT OR IGNORE INTO podcast_follows (user_id, library_item_id, tenant_id, created_at)
SELECT tm.user_id, p.library_item_id, p.tenant_id, CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM podcasts p
  JOIN tenant_members tm ON tm.tenant_id = p.tenant_id AND tm.role = 'owner';
