import type { Env } from '../types';

export type MediaProgressRow = {
  id: string;
  user_id: string;
  library_item_id: string;
  episode_id: string | null;
  duration_seconds: number;
  progress: number;
  current_time_seconds: number;
  is_finished: number;
  hide_from_continue_listening: number;
  ebook_progress: string | null;
  last_update: number;
  started_at: number;
  finished_at: number | null;
};

export async function getProgress(env: Env, userId: string, itemId: string, episodeId: string | null = null): Promise<MediaProgressRow | null> {
  return env.DB.prepare(
    `SELECT * FROM media_progress
       WHERE user_id = ? AND library_item_id = ?
         AND ((? IS NULL AND episode_id IS NULL) OR episode_id = ?)`,
  ).bind(userId, itemId, episodeId, episodeId).first<MediaProgressRow>();
}

export async function listProgressByUser(env: Env, userId: string): Promise<MediaProgressRow[]> {
  const r = await env.DB.prepare(
    'SELECT * FROM media_progress WHERE user_id = ? ORDER BY last_update DESC',
  ).bind(userId).all<MediaProgressRow>();
  return r.results;
}

export type ProgressUpdate = {
  duration?: number;
  progress?: number;
  currentTime?: number;
  isFinished?: boolean;
  hideFromContinueListening?: boolean;
  ebookProgress?: string;
  ebookLocation?: string | null;
};

export async function upsertProgress(env: Env, args: {
  userId: string;
  itemId: string;
  episodeId?: string | null;
  patch: ProgressUpdate;
}): Promise<MediaProgressRow> {
  const now = Date.now();
  const existing = await getProgress(env, args.userId, args.itemId, args.episodeId ?? null);

  if (existing) {
    const merged: MediaProgressRow = {
      ...existing,
      duration_seconds:        args.patch.duration ?? existing.duration_seconds,
      progress:                args.patch.progress ?? existing.progress,
      current_time_seconds:    args.patch.currentTime ?? existing.current_time_seconds,
      is_finished:             args.patch.isFinished == null ? existing.is_finished : (args.patch.isFinished ? 1 : 0),
      hide_from_continue_listening: args.patch.hideFromContinueListening == null
        ? existing.hide_from_continue_listening
        : (args.patch.hideFromContinueListening ? 1 : 0),
      ebook_progress:          args.patch.ebookProgress ?? existing.ebook_progress,
      last_update:             now,
      finished_at:             args.patch.isFinished ? now : existing.finished_at,
    };
    await env.DB.prepare(
      `UPDATE media_progress SET
         duration_seconds = ?, progress = ?, current_time_seconds = ?,
         is_finished = ?, hide_from_continue_listening = ?, ebook_progress = ?,
         last_update = ?, finished_at = ?
       WHERE id = ?`,
    ).bind(
      merged.duration_seconds, merged.progress, merged.current_time_seconds,
      merged.is_finished, merged.hide_from_continue_listening, merged.ebook_progress,
      merged.last_update, merged.finished_at, merged.id,
    ).run();
    return merged;
  }

  const row: MediaProgressRow = {
    id: 'mp_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24),
    user_id: args.userId,
    library_item_id: args.itemId,
    episode_id: args.episodeId ?? null,
    duration_seconds: args.patch.duration ?? 0,
    progress: args.patch.progress ?? 0,
    current_time_seconds: args.patch.currentTime ?? 0,
    is_finished: args.patch.isFinished ? 1 : 0,
    hide_from_continue_listening: args.patch.hideFromContinueListening ? 1 : 0,
    ebook_progress: args.patch.ebookProgress ?? null,
    last_update: now,
    started_at: now,
    finished_at: args.patch.isFinished ? now : null,
  };
  await env.DB.prepare(
    `INSERT INTO media_progress (
       id, user_id, library_item_id, episode_id, duration_seconds,
       progress, current_time_seconds, is_finished, hide_from_continue_listening,
       ebook_progress, last_update, started_at, finished_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    row.id, row.user_id, row.library_item_id, row.episode_id, row.duration_seconds,
    row.progress, row.current_time_seconds, row.is_finished, row.hide_from_continue_listening,
    row.ebook_progress, row.last_update, row.started_at, row.finished_at,
  ).run();
  return row;
}

// ABS-shaped progress payload for API responses.
export async function progressToAbs(env: Env, row: MediaProgressRow): Promise<unknown> {
  // Imported lazily to avoid a cycle.
  const { derivedId } = await import('../lib/ids');
  // ABS's wire `id` = libraryItemId for books, or `${libraryItemId}-${episodeId}`
  // for podcast episodes. Plappa (and the bundled web UI) match progress to
  // items by this id — emitting our internal DB id (mp_<rand>) breaks the
  // lookup, leaving books showing as unplayed even when progress exists.
  const wireId = row.episode_id
    ? `${row.library_item_id}-${row.episode_id}`
    : row.library_item_id;
  return {
    id: wireId,
    userId: row.user_id,
    libraryItemId: row.library_item_id,
    episodeId: row.episode_id,
    mediaItemId: await derivedId(row.library_item_id, 'media'),
    mediaItemType: row.episode_id ? 'episode' : 'book',
    duration: row.duration_seconds,
    progress: row.progress,
    currentTime: row.current_time_seconds,
    isFinished: row.is_finished === 1,
    hideFromContinueListening: row.hide_from_continue_listening === 1,
    ebookLocation: null,
    ebookProgress: row.ebook_progress ? Number(row.ebook_progress) : 0,
    lastUpdate: row.last_update,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}
