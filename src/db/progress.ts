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
  finished_position: number | null;   // migration 0024: where the listener was when it was marked played
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

// ── Played, and played again (podcast episodes) ──────────────────────────
//
// Two rules decide an episode's played mark when a write doesn't set it
// itself (an explicit isFinished, "Mark played" / "Mark unplayed", always
// wins, as in ABS; except that false inside the window below still counts
// as played, because Pholia's sessionless sync used to send false every 30 s):
//
// 1. A position inside the show's "played" window (episodeFinishRemaining:
//    the show's, else the library's markAsFinishedTimeRemaining) marks it
//    played, as ABS does.
// 2. A played episode is un-marked by a position outside that window when
//    the write is a REPLAY, the way Pocket Casts un-marks an episode you
//    play again:
//    a. the position is more than REPLAY_MARGIN before `finished_position`,
//       where the listener was when it was marked played (the listener
//       went back: a replay from the start, or a long rewind), or
//    b. it is a sync of a playback session that began after the mark
//       (playStartedAt > finished_at): someone pressed Play on a played
//       episode, which /play starts from 0.
//    What it must NOT do is fight a "Mark played" on the episode that is
//    still playing: that listen's next syncs carry on FORWARD from where
//    the mark found it (so not a), from a session opened before the mark
//    (so not b). ABS itself un-marks on any position outside the window,
//    which undoes such a mark within 30 s.
//
// The two can't fight near the end: one write is either inside the window
// (rule 1) or outside it (rule 2), and a write inside it after a replay just
// marks it played again. A rewind of under REPLAY_MARGIN from the end keeps
// the mark.
export const REPLAY_MARGIN = 60;

export type EpisodeRules = {
  // Seconds left at which an episode counts as played; asked lazily, only
  // a write that carries a position needs it.
  finishRemaining: () => Promise<number>;
  // A session sync: when that playback session began (rule 2b).
  playStartedAt?: number | null;
};

function isReplay(row: MediaProgressRow, t: number, playStartedAt: number | null | undefined): boolean {
  const at = row.finished_position ?? row.current_time_seconds;
  if (t < at - REPLAY_MARGIN) return true;
  return playStartedAt != null && row.finished_at != null && playStartedAt > row.finished_at;
}

export async function upsertProgress(env: Env, args: {
  userId: string;
  itemId: string;
  episodeId?: string | null;
  patch: ProgressUpdate;
  // Podcast episodes only: the played rules above. Books are left alone.
  episode?: EpisodeRules;
}): Promise<MediaProgressRow> {
  const now = Date.now();
  const existing = await getProgress(env, args.userId, args.itemId, args.episodeId ?? null);
  const patch: ProgressUpdate = { ...args.patch };

  let byWindow = false;
  const t = patch.currentTime;
  if (args.episode && args.episodeId && t != null && patch.isFinished !== true) {
    const dur = patch.duration && patch.duration > 0 ? patch.duration : existing?.duration_seconds ?? 0;
    if (dur > 0) {
      if (t >= dur - await args.episode.finishRemaining()) { patch.isFinished = true; byWindow = true; }
      else if (patch.isFinished == null && existing?.is_finished === 1 && isReplay(existing, t, args.episode.playStartedAt)) {
        patch.isFinished = false;
      }
    }
  }
  // As ABS does, un-marking an episode without saying where starts it over:
  // the bundled web UI's "Mark as not finished" sends isFinished:false
  // alone, and the row kept the end as its position, so the next play
  // resumed there and was marked played again at once.
  if (args.episodeId && patch.isFinished === false && existing?.is_finished === 1 && patch.currentTime == null) {
    patch.currentTime = 0;
    patch.progress = 0;
  }

  if (existing) {
    const wasFinished = existing.is_finished === 1;
    const isFinished = patch.isFinished == null ? existing.is_finished : (patch.isFinished ? 1 : 0);
    const merged: MediaProgressRow = {
      ...existing,
      duration_seconds:        patch.duration ?? existing.duration_seconds,
      progress:                patch.progress ?? existing.progress,
      current_time_seconds:    patch.currentTime ?? existing.current_time_seconds,
      is_finished:             isFinished,
      hide_from_continue_listening: patch.hideFromContinueListening == null
        ? existing.hide_from_continue_listening
        : (patch.hideFromContinueListening ? 1 : 0),
      ebook_progress:          patch.ebookProgress ?? existing.ebook_progress,
      last_update:             now,
      // An explicit mark is stamped now; one already played that a sync
      // keeps inside the window keeps its time (rule 2b compares a
      // session's start against it). Unplayed has none, as in ABS.
      finished_at:             !isFinished ? null
        : patch.isFinished === true && !(byWindow && wasFinished) ? now : existing.finished_at,
      // Where the listener was when it became played: this write's position
      // for the window, the last one heard for an explicit mark (the mark
      // itself says "the end", which is not where the listener is).
      finished_position:       !isFinished ? null
        : wasFinished ? existing.finished_position
        : byWindow ? t! : existing.current_time_seconds,
    };
    await env.DB.prepare(
      `UPDATE media_progress SET
         duration_seconds = ?, progress = ?, current_time_seconds = ?,
         is_finished = ?, hide_from_continue_listening = ?, ebook_progress = ?,
         last_update = ?, finished_at = ?, finished_position = ?
       WHERE id = ?`,
    ).bind(
      merged.duration_seconds, merged.progress, merged.current_time_seconds,
      merged.is_finished, merged.hide_from_continue_listening, merged.ebook_progress,
      merged.last_update, merged.finished_at, merged.finished_position, merged.id,
    ).run();
    return merged;
  }

  const row: MediaProgressRow = {
    id: 'mp_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24),
    user_id: args.userId,
    library_item_id: args.itemId,
    episode_id: args.episodeId ?? null,
    duration_seconds: patch.duration ?? 0,
    progress: patch.progress ?? 0,
    current_time_seconds: patch.currentTime ?? 0,
    is_finished: patch.isFinished ? 1 : 0,
    hide_from_continue_listening: patch.hideFromContinueListening ? 1 : 0,
    ebook_progress: patch.ebookProgress ?? null,
    last_update: now,
    started_at: now,
    finished_at: patch.isFinished ? now : null,
    // No position heard before an explicit mark: 0, so only a new session
    // (rule 2b) un-marks it, never the listen that may be under way.
    finished_position: patch.isFinished ? (byWindow ? t! : 0) : null,
  };
  await env.DB.prepare(
    `INSERT INTO media_progress (
       id, user_id, library_item_id, episode_id, duration_seconds,
       progress, current_time_seconds, is_finished, hide_from_continue_listening,
       ebook_progress, last_update, started_at, finished_at, finished_position
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    row.id, row.user_id, row.library_item_id, row.episode_id, row.duration_seconds,
    row.progress, row.current_time_seconds, row.is_finished, row.hide_from_continue_listening,
    row.ebook_progress, row.last_update, row.started_at, row.finished_at, row.finished_position,
  ).run();
  return row;
}

// What /api/me (and /login, /api/authorize) carry. Every row a user ever
// had grew without bound, and Pholia fetched it for every show page. Kept:
// every book row (one per book, bounded by the library), every episode row
// not marked played (Continue Listening), and played episode rows while the
// episode is still on its show, the newest ME_PLAYED_EPISODES of them.
// Dropped: rows of episodes that no longer exist or have left their show
// (no client lists those), and played episodes beyond that count. Lists of
// episodes carry the caller's progress for each one themselves
// (`mediaProgress` on the episode, progressForShows), so Pholia's played
// marks never depend on this window; another ABS app may show an episode
// played longer ago than that as unplayed.
export const ME_PLAYED_EPISODES = 200;

export async function listProgressForMe(env: Env, userId: string): Promise<MediaProgressRow[]> {
  const r = await env.DB.prepare(
    `SELECT mp.* FROM media_progress mp
       LEFT JOIN podcast_episodes e ON e.id = mp.episode_id
      WHERE mp.user_id = ?
        AND (mp.episode_id IS NULL OR (e.id IS NOT NULL AND (mp.is_finished = 0 OR e.in_library = 1)))
      ORDER BY mp.last_update DESC`,
  ).bind(userId).all<MediaProgressRow>();
  let played = 0;
  return r.results.filter((p) => !(p.episode_id && p.is_finished === 1 && ++played > ME_PLAYED_EPISODES));
}

// The caller's progress on every episode of these shows, ABS-shaped and
// keyed by episode id, for lists that carry it inline.
export async function progressForShows(env: Env, userId: string, itemIds: string[]): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  for (let i = 0; i < itemIds.length; i += 90) {
    const part = itemIds.slice(i, i + 90);
    const r = await env.DB.prepare(
      `SELECT * FROM media_progress WHERE user_id = ? AND library_item_id IN (${part.map(() => '?').join(',')}) AND episode_id IS NOT NULL`,
    ).bind(userId, ...part).all<MediaProgressRow>();
    for (const p of r.results) out.set(p.episode_id!, await progressToAbs(env, p));
  }
  return out;
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
    // ABS: an episode's progress belongs to the episode (mediaItemId is the
    // episode id, mediaItemType 'podcastEpisode'), a book's to the book.
    mediaItemId: row.episode_id ?? await derivedId(row.library_item_id, 'media'),
    mediaItemType: row.episode_id ? 'podcastEpisode' : 'book',
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
