// Aggregates behind the three stats endpoints real ABS clients read:
// GET /api/libraries/:id/stats (Absorb's library page), GET
// /api/me/listening-stats (Absorb's Stats tab, Pholia's stats page) and GET
// /api/me/stats/year/:year (year in review). None of these existed before
// 2026-09-06; Absorb rendered "0 books" and "couldn't load stats".
import type { Env } from '../types';
import { derivedId } from '../lib/ids';

function splitNames(s: string | null): string[] {
  return (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}

function parseGenres(s: string | null): string[] {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v.filter((g): g is string => typeof g === 'string' && g.trim() !== '') : [];
  } catch { return []; }
}

export async function libraryStats(env: Env, libraryId: string, tenantId: string) {
  const perItem = (await env.DB.prepare(
    `SELECT li.id, bm.title, bm.author_name, bm.genres,
            COALESCE(SUM(af.size_bytes), 0) AS size,
            COALESCE(SUM(af.duration_seconds), 0) AS duration,
            COUNT(af.id) AS tracks
     FROM library_items li
     LEFT JOIN book_metadata bm ON bm.library_item_id = li.id
     LEFT JOIN audio_files af ON af.library_item_id = li.id
     WHERE li.library_id = ? AND li.tenant_id = ?
     GROUP BY li.id`,
  ).bind(libraryId, tenantId).all<{ id: string; title: string | null; author_name: string | null; genres: string | null; size: number; duration: number; tracks: number }>()).results;

  const authorCounts = new Map<string, number>();
  const genreCounts = new Map<string, number>();
  let totalSize = 0, totalDuration = 0, numAudioTracks = 0;
  for (const it of perItem) {
    totalSize += it.size;
    totalDuration += it.duration;
    numAudioTracks += it.tracks;
    for (const a of splitNames(it.author_name)) authorCounts.set(a, (authorCounts.get(a) ?? 0) + 1);
    for (const g of parseGenres(it.genres)) genreCounts.set(g, (genreCounts.get(g) ?? 0) + 1);
  }
  const top = <T,>(arr: T[], key: (t: T) => number, n: number) => [...arr].sort((a, b) => key(b) - key(a)).slice(0, n);
  const authorsWithCount = await Promise.all(
    top([...authorCounts.entries()], ([, n]) => n, 10).map(async ([name, count]) => ({ id: await derivedId(libraryId, 'author', name), name, count })),
  );
  return {
    totalItems: perItem.length,
    totalAuthors: authorCounts.size,
    totalGenres: genreCounts.size,
    totalDuration,
    longestItems: top(perItem, (i) => i.duration, 10).map((i) => ({ id: i.id, title: i.title ?? '', duration: i.duration })),
    numAudioTracks,
    totalSize,
    largestItems: top(perItem, (i) => i.size, 10).map((i) => ({ id: i.id, title: i.title ?? '', size: i.size })),
    authorsWithCount,
    genresWithCount: top([...genreCounts.entries()], ([, n]) => n, 1000).map(([genre, count]) => ({ genre, count })),
  };
}

type SessionAgg = {
  id: string; user_id: string; library_item_id: string | null; display_title: string | null; display_author: string | null;
  duration_seconds: number; play_method: number; media_player: string | null; device_info: string; server_version: string | null;
  date_started: number; current_time_seconds: number; time_listening_seconds: number; start_time_seconds: number;
  closed_at: number | null; updated_at: number;
  meta_title: string | null; meta_author: string | null; meta_narrator: string | null; meta_genres: string | null; meta_series: string | null;
};

// Real ABS stamps each session with the server's local calendar date; a
// Worker has no local time, so the client may pass its IANA zone (Pholia
// does) and everything else falls back to UTC.
function calendar(ms: number, tz: string) {
  let f: Intl.DateTimeFormat;
  try {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long' });
  } catch {
    f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long' });
  }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, dayOfWeek: p.weekday ?? '', month: Number(p.month) - 1, year: Number(p.year) };
}

async function sessionsForUser(env: Env, userId: string): Promise<SessionAgg[]> {
  return (await env.DB.prepare(
    `SELECT s.*, bm.title AS meta_title, bm.author_name AS meta_author, bm.narrator_name AS meta_narrator,
            bm.genres AS meta_genres, bm.series_name AS meta_series
     FROM listening_sessions s
     LEFT JOIN book_metadata bm ON bm.library_item_id = s.library_item_id
     WHERE s.user_id = ?
     ORDER BY s.updated_at DESC`,
  ).bind(userId).all<SessionAgg>()).results;
}

function mediaMetadata(s: SessionAgg) {
  return {
    title: s.meta_title ?? s.display_title,
    authorName: s.meta_author ?? s.display_author,
    narratorName: s.meta_narrator,
    seriesName: s.meta_series,
    genres: parseGenres(s.meta_genres),
  };
}

function sessionJson(s: SessionAgg, tz: string) {
  const cal = calendar(s.date_started, tz);
  return {
    id: s.id,
    userId: s.user_id,
    libraryItemId: s.library_item_id,
    mediaType: 'book',
    mediaMetadata: mediaMetadata(s),
    displayTitle: s.display_title ?? s.meta_title,
    displayAuthor: s.display_author ?? s.meta_author,
    duration: s.duration_seconds,
    playMethod: s.play_method,
    mediaPlayer: s.media_player,
    deviceInfo: JSON.parse(s.device_info || '{}'),
    serverVersion: s.server_version,
    date: cal.date,
    dayOfWeek: cal.dayOfWeek,
    timeListening: s.time_listening_seconds,
    startTime: s.start_time_seconds,
    currentTime: s.current_time_seconds,
    startedAt: s.date_started,
    updatedAt: s.updated_at,
  };
}

export async function userListeningStats(env: Env, userId: string, tz: string) {
  const sessions = await sessionsForUser(env, userId);
  const today = calendar(Date.now(), tz).date;
  const stats = {
    totalTime: 0,
    items: {} as Record<string, { id: string; timeListening: number; mediaMetadata: ReturnType<typeof mediaMetadata>; lastUpdate: number }>,
    days: {} as Record<string, number>,
    dayOfWeek: {} as Record<string, number>,
    today: 0,
    recentSessions: sessions.slice(0, 10).map((s) => sessionJson(s, tz)),
  };
  for (const s of sessions) {
    const t = Number(s.time_listening_seconds) || 0;
    const cal = calendar(s.date_started, tz);
    if (cal.dayOfWeek) stats.dayOfWeek[cal.dayOfWeek] = (stats.dayOfWeek[cal.dayOfWeek] ?? 0) + t;
    if (t > 0) {
      stats.days[cal.date] = (stats.days[cal.date] ?? 0) + t;
      if (cal.date === today) stats.today += t;
    }
    if (s.library_item_id) {
      const it = stats.items[s.library_item_id];
      if (!it) stats.items[s.library_item_id] = { id: s.library_item_id, timeListening: t, mediaMetadata: mediaMetadata(s), lastUpdate: s.updated_at };
      else { it.timeListening += t; if (s.updated_at > it.lastUpdate) it.lastUpdate = s.updated_at; }
    }
    stats.totalTime += t;
  }
  return stats;
}

// Same fields as ABS's userStats.getStatsForYear, so Absorb's year-in-review
// page renders unchanged; month is 0-based there too.
export async function userYearStats(env: Env, userId: string, year: number, tz: string) {
  const sessions = (await sessionsForUser(env, userId)).filter((s) => calendar(s.date_started, tz).year === year);
  const finished = (await env.DB.prepare(
    `SELECT mp.library_item_id, mp.duration_seconds, mp.finished_at, bm.title
     FROM media_progress mp LEFT JOIN book_metadata bm ON bm.library_item_id = mp.library_item_id
     WHERE mp.user_id = ? AND mp.is_finished = 1 AND mp.finished_at IS NOT NULL AND mp.episode_id IS NULL`,
  ).bind(userId).all<{ library_item_id: string; duration_seconds: number; finished_at: number; title: string | null }>()).results
    .filter((r) => calendar(r.finished_at, tz).year === year);

  const byAuthor = new Map<string, number>(), byGenre = new Map<string, number>(), byNarrator = new Map<string, number>(), byMonth = new Map<number, number>(), byBook = new Set<string>();
  let totalListeningTime = 0;
  for (const s of sessions) {
    const t = Number(s.time_listening_seconds) || 0;
    totalListeningTime += t;
    for (const a of splitNames(s.meta_author ?? s.display_author)) byAuthor.set(a, (byAuthor.get(a) ?? 0) + t);
    for (const g of parseGenres(s.meta_genres)) byGenre.set(g, (byGenre.get(g) ?? 0) + t);
    for (const n of splitNames(s.meta_narrator)) byNarrator.set(n, (byNarrator.get(n) ?? 0) + t);
    const m = calendar(s.date_started, tz).month;
    byMonth.set(m, (byMonth.get(m) ?? 0) + t);
    if (s.library_item_id) byBook.add(s.library_item_id);
  }
  const best = <K,>(m: Map<K, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0];
  const narr = best(byNarrator), month = best(byMonth);
  let longest: { id: string; title: string; duration: number; finishedAt: number } | null = null;
  for (const f of finished) {
    if (f.duration_seconds && (!longest || f.duration_seconds > longest.duration)) {
      longest = { id: f.library_item_id, title: f.title ?? '', duration: Math.round(f.duration_seconds), finishedAt: f.finished_at };
    }
  }
  const finishedIds = finished.map((f) => f.library_item_id);
  const finishedBooksWithCovers = [...new Set(finishedIds)].slice(0, 5);
  const booksWithCovers = [...byBook].filter((id) => !finishedBooksWithCovers.includes(id)).slice(0, 25);
  return {
    totalListeningSessions: sessions.length,
    totalListeningTime: Math.round(totalListeningTime),
    totalBookListeningTime: Math.round(totalListeningTime),
    totalPodcastListeningTime: 0,
    topAuthors: [...byAuthor.entries()].map(([name, time]) => ({ name, time: Math.round(time) })).sort((a, b) => b.time - a.time).slice(0, 3),
    topGenres: [...byGenre.entries()].map(([genre, time]) => ({ genre, time: Math.round(time) })).sort((a, b) => b.time - a.time).slice(0, 3),
    mostListenedNarrator: narr ? { name: narr[0], time: Math.round(narr[1]) } : null,
    mostListenedMonth: month ? { month: month[0], time: Math.round(month[1]) } : null,
    numBooksFinished: finished.length,
    numBooksListened: byBook.size,
    longestAudiobookFinished: longest,
    booksWithCovers,
    finishedBooksWithCovers,
  };
}
