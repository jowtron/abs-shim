import type { Env } from '../types';

// Rows of migration 0016. See src/lib/podcasts.ts for how they're filled.

export type PodcastRow = {
  library_item_id: string;
  tenant_id: string;
  feed_url: string;
  title: string | null;
  author: string | null;
  description: string | null;
  release_date: string | null;
  genres: string;
  image_url: string | null;
  cover_url: string | null;
  itunes_page_url: string | null;
  itunes_id: string | null;
  itunes_artist_id: string | null;
  explicit: number;
  language: string | null;
  podcast_type: string | null;
  tags: string;
  auto_download: number;
  auto_download_schedule: string | null;
  max_episodes_to_keep: number;
  max_new_episodes_to_download: number;
  archive: number;
  parse_version: number;           // migration 0018
  finish_remaining_seconds: number | null; // migration 0019; NULL = the library's setting
  feed_etag: string | null;
  feed_last_modified: string | null;
  last_episode_check: number | null;
  next_check_at: number | null;
  check_failures: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

export type EpisodeRow = {
  id: string;
  library_item_id: string;
  tenant_id: string;
  ino: string;
  guid: string;
  idx: number;
  season: string | null;
  episode: string | null;
  episode_type: string | null;
  title: string | null;
  subtitle: string | null;
  description: string | null;
  pub_date: string | null;
  published_at: number | null;
  enclosure_url: string;
  enclosure_type: string | null;
  enclosure_length: number | null;
  duration_seconds: number;
  size_bytes: number;
  chapters: string;
  archive_state: string | null;
  archive_rel_path: string | null;
  archive_expected_size: number | null;
  archive_seen_size: number | null;
  archive_started_at: number | null;
  archive_error: string | null;
  in_library: number;
  removed: number;
  chapters_url: string | null;     // migration 0018: <podcast:chapters url>
  chapters_checked_at: number | null;
  created_at: number;
  updated_at: number;
};

// Same chunking reason as loadItemBundles: D1 allows 100 bound parameters.
const IN_CHUNK = 90;

async function inChunks<T>(env: Env, ids: string[], sql: (marks: string) => string, extra: unknown[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const part = ids.slice(i, i + IN_CHUNK);
    const r = await env.DB.prepare(sql(part.map(() => '?').join(','))).bind(...part, ...extra).all<T>();
    out.push(...r.results);
  }
  return out;
}

// ABS's default for markAsFinishedTimeRemaining.
export const DEFAULT_FINISH_REMAINING = 10;

// The library setting, from libraries.settings (ABS's name for it).
export function libraryFinishRemaining(settingsJson: string | null | undefined): number {
  try {
    const v = (JSON.parse(settingsJson || '{}') as Record<string, unknown>)['markAsFinishedTimeRemaining'];
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : DEFAULT_FINISH_REMAINING;
  } catch { return DEFAULT_FINISH_REMAINING; }
}

// How close to its end an episode of this show counts as played: the show's
// own setting, else its library's. One indexed read, run on every episode
// session sync (every 30 s per listener).
export async function episodeFinishRemaining(env: Env, itemId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT p.finish_remaining_seconds AS own, l.settings AS settings
       FROM podcasts p
       JOIN library_items li ON li.id = p.library_item_id
       JOIN libraries l ON l.id = li.library_id
      WHERE p.library_item_id = ?`,
  ).bind(itemId).first<{ own: number | null; settings: string | null }>();
  if (row?.own != null) return row.own;
  return libraryFinishRemaining(row?.settings);
}

export async function getPodcast(env: Env, itemId: string, tenantId: string): Promise<PodcastRow | null> {
  return env.DB.prepare('SELECT * FROM podcasts WHERE library_item_id = ? AND tenant_id = ?')
    .bind(itemId, tenantId).first<PodcastRow>();
}

export async function getPodcasts(env: Env, itemIds: string[], tenantId: string): Promise<Map<string, PodcastRow>> {
  if (!itemIds.length) return new Map();
  const rows = await inChunks<PodcastRow>(env, itemIds,
    (m) => `SELECT * FROM podcasts WHERE library_item_id IN (${m}) AND tenant_id = ?`, [tenantId]);
  return new Map(rows.map((r) => [r.library_item_id, r]));
}

export type EpisodeCounts = { numEpisodes: number; size: number; duration: number };

// Per-show totals over the episodes on the show (in_library), for list
// shapes that carry numEpisodes but not the episodes themselves.
export async function getEpisodeCounts(env: Env, itemIds: string[], tenantId: string): Promise<Map<string, EpisodeCounts>> {
  if (!itemIds.length) return new Map();
  const rows = await inChunks<{ library_item_id: string; n: number; size: number; duration: number }>(env, itemIds,
    (m) => `SELECT library_item_id, COUNT(*) AS n, SUM(CASE WHEN size_bytes > 0 THEN size_bytes ELSE COALESCE(enclosure_length, 0) END) AS size,
                   SUM(duration_seconds) AS duration
              FROM podcast_episodes WHERE library_item_id IN (${m}) AND tenant_id = ? AND in_library = 1
             GROUP BY library_item_id`, [tenantId]);
  return new Map(rows.map((r) => [r.library_item_id, { numEpisodes: r.n, size: r.size ?? 0, duration: r.duration ?? 0 }]));
}

export async function listShowEpisodes(env: Env, itemId: string, tenantId: string): Promise<EpisodeRow[]> {
  const r = await env.DB.prepare(
    `SELECT * FROM podcast_episodes WHERE library_item_id = ? AND tenant_id = ? AND in_library = 1
      ORDER BY published_at DESC, idx DESC`,
  ).bind(itemId, tenantId).all<EpisodeRow>();
  return r.results;
}

export async function getEpisode(env: Env, itemId: string, episodeId: string, tenantId: string): Promise<EpisodeRow | null> {
  return env.DB.prepare('SELECT * FROM podcast_episodes WHERE id = ? AND library_item_id = ? AND tenant_id = ?')
    .bind(episodeId, itemId, tenantId).first<EpisodeRow>();
}

// The streaming route's lookup: ABS clients address an episode's audio by
// its ino (`/api/items/:id/file/:ino`). Accept the episode id as well.
export async function getEpisodeForFile(env: Env, itemId: string, fileId: string, tenantId: string): Promise<EpisodeRow | null> {
  return env.DB.prepare(
    `SELECT * FROM podcast_episodes WHERE library_item_id = ? AND tenant_id = ? AND (ino = ? OR id = ?) LIMIT 1`,
  ).bind(itemId, tenantId, fileId, fileId).first<EpisodeRow>();
}

export async function getEpisodesByIds(env: Env, ids: string[], tenantId: string): Promise<EpisodeRow[]> {
  if (!ids.length) return [];
  return inChunks<EpisodeRow>(env, ids, (m) => `SELECT * FROM podcast_episodes WHERE id IN (${m}) AND tenant_id = ?`, [tenantId]);
}
