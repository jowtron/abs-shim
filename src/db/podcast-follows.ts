import type { Env } from '../types';

// Per-person podcast lists (migration 0028). A show is stored once per
// library; each person FOLLOWS the shows on their list, and every list of
// shows or episodes in a podcast library is the caller's follows minus the
// episodes they have hidden. A show nobody follows is idle (isIdle): the
// poller, automatic archiving, the analysis pump's "new" picks and push all
// pass it by, and its episodes, archives, analyses and everyone's progress
// stay put, so following it again is instant.

// D1 allows 100 bound parameters per statement.
const IN_CHUNK = 90;

export type FollowInfo = { following: boolean; followers: number };

// The caller's follow and the follower count of each show, in one indexed
// read per 90 shows (idx_podcast_follows_item). A show with no row is
// { following: false, followers: 0 }.
export async function followInfo(env: Env, userId: string, itemIds: string[]): Promise<Map<string, FollowInfo>> {
  const out = new Map<string, FollowInfo>();
  const uniq = [...new Set(itemIds)];
  for (let i = 0; i < uniq.length; i += IN_CHUNK) {
    const part = uniq.slice(i, i + IN_CHUNK);
    const r = await env.DB.prepare(
      `SELECT library_item_id, COUNT(*) AS n, MAX(user_id = ?) AS mine FROM podcast_follows
        WHERE library_item_id IN (${part.map(() => '?').join(',')}) GROUP BY library_item_id`,
    ).bind(userId, ...part).all<{ library_item_id: string; n: number; mine: number }>();
    for (const row of r.results) out.set(row.library_item_id, { following: row.mine === 1, followers: row.n });
  }
  for (const id of uniq) if (!out.has(id)) out.set(id, { following: false, followers: 0 });
  return out;
}

// The shows one person follows in one tenant: the filter every podcast list
// applies. A primary-key prefix read (user_id).
export async function followedShowIds(env: Env, userId: string, tenantId: string): Promise<Set<string>> {
  const r = await env.DB.prepare('SELECT library_item_id FROM podcast_follows WHERE user_id = ? AND tenant_id = ?')
    .bind(userId, tenantId).all<{ library_item_id: string }>();
  return new Set(r.results.map((x) => x.library_item_id));
}

export async function isIdle(env: Env, itemId: string): Promise<boolean> {
  const r = await env.DB.prepare('SELECT 1 AS x FROM podcast_follows WHERE library_item_id = ? LIMIT 1').bind(itemId).first();
  return !r;
}

// Follow a show. Idempotent: `added` says whether this call made the follow.
// A show that was idle has gone unpolled, so its feed is made due at once
// (the next 2-minute tick catches it up); the episodes stored meanwhile were
// kept, so the list is there before that.
export async function followShow(env: Env, userId: string, itemId: string, tenantId: string): Promise<{ added: boolean }> {
  const now = Date.now();
  const wasIdle = await isIdle(env, itemId);
  const r = await env.DB.prepare(
    'INSERT OR IGNORE INTO podcast_follows (user_id, library_item_id, tenant_id, created_at) VALUES (?, ?, ?, ?)',
  ).bind(userId, itemId, tenantId, now).run();
  const added = (r.meta.changes ?? 0) > 0;
  // A show only ever looked at (migration 0033) is an ordinary one from its
  // first follow: listed in "On this server", never pruned.
  if (added && wasIdle) {
    await env.DB.prepare('UPDATE podcasts SET next_check_at = ?, previewed_at = NULL WHERE library_item_id = ?').bind(now, itemId).run();
  }
  return { added };
}

// Unfollow: the show leaves the caller's list and their bell for it goes
// off (a notification for a show you don't follow would be a surprise; the
// trigger also requires the follow). Their progress and hidden episodes
// stay, so following again puts everything back. When that was the last
// follower the show parks: next_check_at NULL keeps it out of the poller's
// range scan altogether (the due query's follower test is the guarantee;
// this keeps idle shows from being read every tick), and followShow sets it
// again.
export async function unfollowShow(env: Env, userId: string, itemId: string): Promise<{ removed: boolean }> {
  const r = await env.DB.prepare('DELETE FROM podcast_follows WHERE user_id = ? AND library_item_id = ?').bind(userId, itemId).run();
  await env.DB.prepare('UPDATE push_show_prefs SET notify = 0, updated_at = ? WHERE user_id = ? AND library_item_id = ? AND notify = 1')
    .bind(Date.now(), userId, itemId).run();
  if (await isIdle(env, itemId)) {
    await env.DB.prepare('UPDATE podcasts SET next_check_at = NULL WHERE library_item_id = ?').bind(itemId).run();
  }
  return { removed: (r.meta.changes ?? 0) > 0 };
}

// SQL fragments for a list query over podcast_episodes aliased `e`: keep
// shows the user follows and drop the episodes they hid. Both are
// primary-key probes per row. Bind `userId` twice, in this order.
export const FOLLOWED_AND_VISIBLE =
  ` AND EXISTS (SELECT 1 FROM podcast_follows f WHERE f.user_id = ? AND f.library_item_id = e.library_item_id)
    AND NOT EXISTS (SELECT 1 FROM podcast_episode_hidden h WHERE h.user_id = ? AND h.episode_id = e.id)`;
// Only the hidden test, for lists that aren't limited to followed shows
// (smart playlists, a show's own episodes). Bind `userId` once.
export const NOT_HIDDEN = ` AND NOT EXISTS (SELECT 1 FROM podcast_episode_hidden h WHERE h.user_id = ? AND h.episode_id = e.id)`;

// Which of these episodes the user has hidden.
export async function hiddenAmong(env: Env, userId: string, episodeIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < episodeIds.length; i += IN_CHUNK) {
    const part = episodeIds.slice(i, i + IN_CHUNK);
    const r = await env.DB.prepare(
      `SELECT episode_id FROM podcast_episode_hidden WHERE user_id = ? AND episode_id IN (${part.map(() => '?').join(',')})`,
    ).bind(userId, ...part).all<{ episode_id: string }>();
    for (const row of r.results) out.add(row.episode_id);
  }
  return out;
}

export async function hideEpisode(env: Env, userId: string, itemId: string, episodeId: string): Promise<void> {
  await env.DB.prepare(
    'INSERT OR IGNORE INTO podcast_episode_hidden (user_id, episode_id, library_item_id, created_at) VALUES (?, ?, ?, ?)',
  ).bind(userId, episodeId, itemId, Date.now()).run();
}

export async function unhideEpisodes(env: Env, userId: string, episodeIds: string[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < episodeIds.length; i += IN_CHUNK) {
    const part = episodeIds.slice(i, i + IN_CHUNK);
    const r = await env.DB.prepare(
      `DELETE FROM podcast_episode_hidden WHERE user_id = ? AND episode_id IN (${part.map(() => '?').join(',')})`,
    ).bind(userId, ...part).run();
    n += r.meta.changes ?? 0;
  }
  return n;
}
