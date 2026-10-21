// Podcasts: subscribing to a feed, keeping it current, and (optionally)
// archiving episodes into the library's storage. ABS-shaped routes live in
// src/routes/podcasts.ts; the shapes in podcast-shapes.ts.
//
// The model, in one paragraph: a show is a library item (media_type
// 'podcast') with a `podcasts` row. Every episode the feed has ever listed is
// a `podcast_episodes` row, but only those with in_library = 1 are "on the
// show" (ABS calls them downloaded). They stream from the publisher through
// the Worker until archived; archiving asks pCloud to fetch the enclosure
// itself (the same downloadfileasync pull the fetch-from-URL flow uses) and
// the episode then plays from pCloud. Nothing about an episode's id, ino or
// progress changes when it's archived.

import type { Env } from '../types';
import { itemDeleteStatements, type LibraryFolderRow } from '../db/library';
import type { EpisodeRow, PodcastRow } from '../db/podcasts';
import { decodeFeedBytes, episodeKey, parseFeed, type FeedEpisode, type ParsedFeed, type TranscriptLink } from './rss';
import { cuesToServed, currentAnalysis, episodeExt, EPISODE_AUDIO_UA, hasDynamicAds } from './podcast-shapes';
import { parseTranscript, rankTranscripts, type Transcript, type TranscriptCue } from './transcript';
import { adoptAnalysisForSize, analysisPump, whisperTranscriptFor } from './episode-analysis';
import { announceArchiveDone, announceNewEpisodes } from './push';
import { followShow, isIdle } from '../db/podcast-follows';
import {
  pcloudDownloadFileAsync, pcloudEnsureFolder, pcloudStat, type PcloudProfile,
} from '../storage/pcloud';

export class PodcastError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ABS's user agent: some hosts (CBC among them) refuse unknown ones, and
// publishers already allow it because ABS polls them.
const FEED_UA = 'audiobookshelf (+https://audiobookshelf.org; like iTMS)';
// Decoded to a string (twice the bytes) inside a 128 MB isolate.
const FEED_MAX_BYTES = 32 * 1024 * 1024;
const POLL_EVERY_MS = 60 * 60 * 1000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
// What lands on a new show: an episodic feed's newest 500 (100 until
// 2026-10-21; migration 0034 did the same for existing shows), a serial
// feed's first 500 (serial shows are listened to from episode 1). The rest
// stay browsable and can be added. Each episode adds ~4 KB to the show item,
// so 500 is ~2 MB raw, ~250 KB gzipped; The Daily's 3,000 would be 12 MB.
const INITIAL_EPISODES = 500;
const SERIAL_CAP = 500;
const TICK_FEEDS = 5;
export const ARCHIVE_STARTS_PER_TICK = 3;
const ARCHIVE_POLLS_PER_TICK = 10;
const ARCHIVE_GIVE_UP_MS = 6 * 60 * 60 * 1000;
// Starting a pull (probe, stat, folder, downloadfileasync) takes seconds; a
// claim holds the row this long, so a second pump can't start another pull
// meanwhile, and a starter that died is retried after it.
const ARCHIVE_START_LEASE_MS = 5 * 60 * 1000;
// A pCloud file counts as landed once its size has held across two polls,
// at least this long after the pull started, and pCloud's own `modified`
// is at least ARCHIVE_SETTLE_MS old (2026-10-14, archivePump).
const ARCHIVE_MIN_FETCH_MS = 2 * 60 * 1000;
const ARCHIVE_SETTLE_MS = 60 * 1000;
// A settled file smaller than the source's size is accepted after this: an
// ad-inserting host the list doesn't know serves pCloud its own stitch.
const ARCHIVE_ANY_SIZE_AFTER_MS = 30 * 60 * 1000;
// Raise when the parser starts storing a field older rows lack: each show's
// next poll then re-reads its whole feed once (migration 0018: chapters_url;
// 2 = migration 0021: transcripts).
const PARSE_VERSION = 2;
const CHAPTERS_PER_TICK = 15;
const CHAPTERS_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

// ─── Fetching ────────────────────────────────────────────────────────────────

export function validFeedUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch { return null; }
}

type FeedFetch =
  | { notModified: true }
  | { notModified: false; xml: string; etag: string | null; lastModified: string | null };

export async function fetchFeed(url: string, cond?: { etag?: string | null; lastModified?: string | null }): Promise<FeedFetch> {
  const headers: Record<string, string> = {
    'User-Agent': FEED_UA,
    Accept: 'application/rss+xml, application/xhtml+xml, application/xml, */*;q=0.8',
  };
  if (cond?.etag) headers['If-None-Match'] = cond.etag;
  if (cond?.lastModified) headers['If-Modified-Since'] = cond.lastModified;
  let res: Response;
  try {
    res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(45_000) });
  } catch (e) {
    throw new PodcastError(502, `Couldn't reach the feed: ${(e as Error).message}`);
  }
  if (res.status === 304) return { notModified: true };
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new PodcastError(502, `The feed answered HTTP ${res.status}`);
  }
  const len = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(len) && len > FEED_MAX_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw new PodcastError(502, `The feed is ${Math.round(len / 1e6)} MB, over the ${FEED_MAX_BYTES / 1e6} MB limit`);
  }
  const bytes = await readCapped(res, FEED_MAX_BYTES);
  return {
    notModified: false,
    xml: decodeFeedBytes(bytes, res.headers.get('content-type')),
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
  };
}

export async function fetchAndParse(url: string): Promise<ParsedFeed> {
  const got = await fetchFeed(url);
  if (got.notModified) throw new PodcastError(502, 'The feed answered 304 to an unconditional request');
  const parsed = parseFeed(got.xml);
  if (!parsed) throw new PodcastError(400, "That URL doesn't serve a podcast RSS feed");
  return parsed;
}

// ─── iTunes search ───────────────────────────────────────────────────────────

export type ItunesPodcast = {
  id: number;
  artistId: number | null;
  title: string;
  artistName: string;
  description: string;
  descriptionPlain: string;
  releaseDate: string;
  genres: string[];
  cover: string;
  trackCount: number;
  feedUrl: string;
  pageUrl: string;
  explicit: boolean;
};

type ItunesRaw = Record<string, unknown> & {
  collectionId: number; artistId?: number; collectionName: string; artistName: string; description?: string;
  releaseDate: string; genres?: string[]; trackCount: number; feedUrl?: string; collectionViewUrl: string;
  trackExplicitness?: string; artworkUrl600?: string; artworkUrl100?: string;
};

// Same shape as ABS's iTunes.cleanPodcast, so clients that render ABS's
// /api/search/podcast render ours.
function cleanItunes(d: ItunesRaw): ItunesPodcast {
  return {
    id: d.collectionId,
    artistId: d.artistId ?? null,
    title: d.collectionName,
    artistName: d.artistName,
    description: d.description ?? '',
    descriptionPlain: d.description ?? '',
    releaseDate: d.releaseDate,
    genres: d.genres ?? [],
    cover: d.artworkUrl600 ?? d.artworkUrl100 ?? '',
    trackCount: d.trackCount,
    feedUrl: d.feedUrl ?? '',
    pageUrl: d.collectionViewUrl,
    explicit: d.trackExplicitness === 'explicit',
  };
}

// Apple rate-limits per IP (about 20 calls a minute), and a Worker's egress
// IPs are shared with everyone else's Workers, so from production this
// answers 403 or 429 as often as not (2026-10-06: 403 from the deployed
// Worker, 429 on the third call of a burst from a preview, 200 from a home
// IP). Pholia and /admin therefore search Apple from the browser, which
// sends CORS headers, and come here only for a pasted feed URL or when that
// fails; this route retries once and then falls back to fyyd.
export async function itunesSearch(term: string, country = 'us', limit = 25): Promise<ItunesPodcast[]> {
  const q = new URLSearchParams({ term, entity: 'podcast', media: 'podcast', country, limit: String(limit) });
  let res: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 700));
    res = await fetch(`https://itunes.apple.com/search?${q}`, {
      headers: { 'User-Agent': FEED_UA }, signal: AbortSignal.timeout(15_000),
    });
    if (res.ok || (res.status !== 403 && res.status !== 429)) break;
  }
  if (!res!.ok) throw new PodcastError(502, `iTunes search answered HTTP ${res!.status}`);
  const data = await res!.json() as { results?: ItunesRaw[] };
  // Results without a feed URL can't be subscribed to (Apple-only shows).
  return (data.results ?? []).filter((r) => r.feedUrl).map(cleanItunes);
}

// fyyd.de: an open podcast directory with no key and no per-IP wall, used
// when Apple refuses the Worker. Smaller than Apple's catalogue but has the
// big shows; mapped into the same shape.
async function fyydSearch(term: string, limit = 25): Promise<ItunesPodcast[]> {
  const q = new URLSearchParams({ title: term, count: String(limit) });
  const res = await fetch(`https://api.fyyd.de/0.2/search/podcast?${q}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new PodcastError(502, `fyyd search answered HTTP ${res.status}`);
  const data = await res.json() as { data?: Array<Record<string, unknown>> };
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  return (data.data ?? []).filter((p) => s(p['xmlURL'])).map((p) => ({
    id: 0,
    artistId: null,
    title: s(p['title']),
    artistName: s(p['author']),
    description: s(p['description']),
    descriptionPlain: s(p['description']),
    releaseDate: s(p['lastpub']),
    genres: [],
    // No artwork: fyyd's thumbnails refuse requests without a fyyd Referer
    // (hotlink protection), so they'd only ever show as broken images. A show
    // subscribed from here takes its feed's own image.
    cover: '',
    trackCount: Number(p['episode_count']) || 0,
    feedUrl: s(p['xmlURL']),
    pageUrl: s(p['htmlURL']),
    explicit: false,
  }));
}

// Apple's directory sometimes lists one feed twice under two ids ("Linux
// Matters" is 1682797246 and 976672924, both linuxmatters.sh's feed), which
// reads as two shows. One result per feed, in Apple's order.
export function onePerFeed<T extends { feedUrl: string }>(results: T[]): T[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    const k = feedKey(r.feedUrl);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function searchPodcasts(term: string, country = 'us'): Promise<ItunesPodcast[]> {
  try {
    return onePerFeed(await itunesSearch(term, country));
  } catch (e) {
    console.warn(`[podcasts] iTunes search failed (${(e as Error).message}); trying fyyd`);
    return onePerFeed(await fyydSearch(term));
  }
}

const feedKey = (u: string) => u.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');

// Apple's copy of a show's artwork is resized on request (the 600x600bb in
// artworkUrl600), where a feed's own image is often a 3000 px PNG of several
// MB — the same problem the author photos had. Find the show by title and
// match on the feed URL; no match is fine, the feed image is the fallback.
//
// A show Apple lists under a different feed URL (an old one still being
// served, as with The Daily's) can't match that way; then an exact title +
// author match lends its artwork only — not its iTunes ids, which would
// claim more certainty than a name match has.
async function itunesForFeed(title: string, feedUrl: string, author: string | null): Promise<ItunesPodcast | null> {
  try {
    const want = feedKey(feedUrl);
    const hits = await itunesSearch(title, 'us', 15);
    const exact = hits.find((h) => feedKey(h.feedUrl) === want);
    if (exact) return exact;
    const norm = (s: string | null) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const named = author ? hits.filter((h) => norm(h.title) === norm(title) && norm(h.artistName) === norm(author)) : [];
    return named.length === 1
      ? { ...named[0]!, id: 0, artistId: null, pageUrl: '', feedUrl: '' }
      : null;
  } catch { return null; }
}

// ─── Subscribing ─────────────────────────────────────────────────────────────

export type CreateArgs = {
  tenantId: string;
  // Who is subscribing: they follow the show, new or already stored.
  userId: string;
  libraryId: string;
  folderId?: string | null;
  feedUrl: string;
  // ABS's media.metadata from the client, used where the feed says nothing.
  metadata?: Record<string, unknown>;
  autoDownload?: boolean;
  archive?: boolean;
  // Skip the feed fetch: OPML imports insert the show and let the poller
  // fill it, so a 60-feed import doesn't fetch 60 feeds in one request.
  deferFetch?: boolean;
  titleHint?: string;
  // false: store the show without following it, so it can be looked at
  // (Pholia opens a podcast-directory search result this way). It is idle
  // like any show nobody follows, marked `previewed_at`, kept out of "On
  // this server", and deleted after 30 days unused (prunePreviews).
  follow?: boolean;
};

function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 100) || 'Podcast';
}

// `existing`: the library already had this feed, so the caller now follows
// that show (no fetch, no second copy); `followed`: this call added the
// caller's follow (false when they already followed it, or asked not to).
export type CreateResult = { itemId: string; existing: boolean; followed: boolean };

export async function createPodcast(env: Env, a: CreateArgs): Promise<CreateResult> {
  const lib = await env.DB.prepare('SELECT id, media_type FROM libraries WHERE id = ? AND tenant_id = ?')
    .bind(a.libraryId, a.tenantId).first<{ id: string; media_type: string }>();
  if (!lib) throw new PodcastError(404, 'Library not found');
  if (lib.media_type !== 'podcast') throw new PodcastError(400, 'That library is not a podcast library');

  const folder = a.folderId
    ? await env.DB.prepare('SELECT * FROM library_folders WHERE id = ? AND library_id = ? AND tenant_id = ?')
      .bind(a.folderId, a.libraryId, a.tenantId).first<LibraryFolderRow>()
    : await env.DB.prepare('SELECT * FROM library_folders WHERE library_id = ? AND tenant_id = ? ORDER BY added_at ASC LIMIT 1')
      .bind(a.libraryId, a.tenantId).first<LibraryFolderRow>();
  if (!folder) throw new PodcastError(404, 'The library has no folder to put the podcast in');

  const dupe = await env.DB.prepare(
    `SELECT p.library_item_id FROM podcasts p JOIN library_items li ON li.id = p.library_item_id
      WHERE p.tenant_id = ? AND li.library_id = ? AND p.feed_url = ?`,
  ).bind(a.tenantId, a.libraryId, a.feedUrl).first<{ library_item_id: string }>();
  // A show is stored once per library and each person follows it (migration
  // 0028). Until 2026-10-14 this was a 409 "Podcast already exists", which
  // was right while the library was one shared list; now the second person
  // to add a feed follows the stored show: same episodes, same archive, same
  // analysis, no second poll.
  if (dupe) {
    if (a.follow === false) {
      // Looking at a show the library has: nothing to store. A show only
      // ever looked at counts this as use, so it isn't pruned while wanted.
      await env.DB.prepare('UPDATE podcasts SET previewed_at = ? WHERE library_item_id = ? AND previewed_at IS NOT NULL')
        .bind(Date.now(), dupe.library_item_id).run();
      return { itemId: dupe.library_item_id, existing: true, followed: false };
    }
    const { added } = await followShow(env, a.userId, dupe.library_item_id, a.tenantId);
    return { itemId: dupe.library_item_id, existing: true, followed: added };
  }
  const follow = a.follow !== false;

  const feed = a.deferFetch ? null : await fetchAndParse(a.feedUrl);
  const m = a.metadata ?? {};
  const str = (k: string) => (typeof m[k] === 'string' && (m[k] as string).trim() ? (m[k] as string).trim() : null);
  const title = feed?.metadata.title || str('title') || a.titleHint || a.feedUrl;
  const itunes = (str('itunesId') && str('imageUrl')) || a.deferFetch ? null
    : await itunesForFeed(title, a.feedUrl, feed?.metadata.author || str('author'));

  const now = Date.now();
  const itemId = 'li_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  // One folder per show, named after it, like ABS. Archived episodes go in it.
  let relPath = safeName(title);
  // A prefix compare, not `LIKE '<name> (%'`: D1 refuses a LIKE pattern over
  // 50 bytes, so every show with a title longer than ~47 bytes failed to add
  // with a 500 (found 2026-10-21), and a % or _ in a title was a wildcard.
  // length() in SQL, because SQLite counts characters where JS counts UTF-16.
  const taken = await env.DB.prepare(
    'SELECT rel_path FROM library_items WHERE folder_id = ? AND (rel_path = ? OR substr(rel_path, 1, length(?)) = ?)',
  ).bind(folder.id, relPath, relPath + ' (', relPath + ' (').all<{ rel_path: string }>();
  if (taken.results.length) {
    const names = new Set(taken.results.map((r) => r.rel_path));
    let n = 2;
    while (names.has(`${relPath} (${n})`)) n++;
    relPath = `${relPath} (${n})`;
  }
  const ino = String(Math.floor(Math.random() * 0xffffffff));
  const genres = feed?.metadata.categories.length ? feed.metadata.categories
    : Array.isArray(m['genres']) ? (m['genres'] as unknown[]).filter((g): g is string => typeof g === 'string')
      : itunes?.genres ?? [];
  const explicit = feed?.metadata.explicit ? /^(yes|true|explicit)$/i.test(feed.metadata.explicit) : m['explicit'] === true;
  const imageUrl = feed?.metadata.image || str('imageUrl');
  // ABS clients send Apple's artwork (artworkUrl600) as imageUrl when the
  // show came from a search; that's the small copy, so it wins for covers.
  const coverUrl = itunes?.cover || str('imageUrl') || imageUrl;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO library_items (id, library_id, folder_id, tenant_id, ino, rel_path, is_file, media_type, is_missing, is_invalid, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'podcast', 0, 0, ?, ?)`,
    ).bind(itemId, a.libraryId, folder.id, a.tenantId, ino, relPath, now, now),
    env.DB.prepare(
      `INSERT INTO podcasts (library_item_id, tenant_id, feed_url, title, author, description, release_date, genres,
         image_url, cover_url, itunes_page_url, itunes_id, itunes_artist_id, explicit, language, podcast_type,
         auto_download, max_new_episodes_to_download, archive, next_check_at, parse_version, created_at, updated_at,
         previewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      itemId, a.tenantId, a.feedUrl, title,
      feed?.metadata.author || str('author') || itunes?.artistName || null,
      feed?.metadata.description || str('description'),
      str('releaseDate') ?? itunes?.releaseDate ?? null,
      JSON.stringify(genres),
      imageUrl,
      coverUrl,
      str('itunesPageUrl') ?? (itunes?.pageUrl || null),
      str('itunesId') ?? (itunes?.id ? String(itunes.id) : null),
      str('itunesArtistId') ?? (itunes?.artistId != null ? String(itunes.artistId) : null),
      explicit ? 1 : 0,
      feed?.metadata.language || str('language'),
      feed?.metadata.type || str('type'),
      a.autoDownload === false ? 0 : 1,
      0,   // max_new_episodes_to_download: 0 = every new episode lands on the show (migration 0023)
      a.archive && follow ? 1 : 0,
      // A show nobody follows is parked (unfollowShow does the same);
      // followShow makes it due the moment someone follows.
      !follow ? null : a.deferFetch ? now : now + POLL_EVERY_MS,
      // The feed was just read by this parser, so its first poll is an
      // ordinary one. Left at 0 (as it was until 2026-10-13) that poll was a
      // full re-read, and one that counts as a reparse can't announce a new
      // episode (refreshPodcast). A deferred OPML show hasn't been read: 0.
      feed ? PARSE_VERSION : 0,
      now, now,
      follow ? null : now,
    ),
    // Whoever adds a show follows it, or it would be idle from birth;
    // unless they only wanted to look at it.
    ...(follow ? [env.DB.prepare('INSERT INTO podcast_follows (user_id, library_item_id, tenant_id, created_at) VALUES (?, ?, ?, ?)')
      .bind(a.userId, itemId, a.tenantId, now)] : []),
  ]);

  if (feed) {
    const p = await env.DB.prepare('SELECT * FROM podcasts WHERE library_item_id = ?').bind(itemId).first<PodcastRow>();
    await storeEpisodes(env, p!, feed.episodes, { initial: true });
  }
  return { itemId, existing: false, followed: follow };
}

// ─── Episodes ────────────────────────────────────────────────────────────────

const EP_COLS = `id, library_item_id, tenant_id, ino, guid, idx, season, episode, episode_type, title, subtitle,
  description, pub_date, published_at, enclosure_url, enclosure_type, enclosure_length, duration_seconds,
  chapters, chapters_url, transcripts, in_library, removed, created_at, updated_at`;

function lengthOf(s: string | null): number | null {
  const n = Number(s);
  return Number.isFinite(n) && n > 1000 ? n : null;
}

// Upsert a parse's episodes. New ones are inserted; a known episode whose
// enclosure URL or text changed is updated (publishers rotate tracking
// prefixes and signed URLs, and a stale URL is an episode that won't play).
// Returns the ids of the rows that are new.
//
// The feed's itunes:duration only fills a length nobody has measured
// (duration_measured, migration 0025). Until 2026-10-13 every poll that
// listed an episode wrote it back over the probed length: LINUX Unplugged
// 688 went from a probed 4440.555 s back to the feed's 4833 s on the next
// poll, and the transcript cache key, "played with N left" and Pholia's
// time left all followed the wrong number.
async function upsertEpisodes(env: Env, p: PodcastRow, eps: FeedEpisode[], startIdx: number, now: number): Promise<Array<{ id: string; published_at: number | null }>> {
  await rekeyMovedEpisodes(env, p, eps, now);
  const added: Array<{ id: string; published_at: number | null }> = [];
  // Oldest first, so idx increases with publication.
  const ordered = [...eps].sort((x, y) => (x.publishedAt ?? 0) - (y.publishedAt ?? 0));
  const stmts = ordered.map((e, i) => env.DB.prepare(
    `INSERT INTO podcast_episodes (${EP_COLS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
     ON CONFLICT(library_item_id, guid) DO UPDATE SET
       enclosure_url = excluded.enclosure_url, enclosure_type = excluded.enclosure_type,
       enclosure_length = excluded.enclosure_length, title = excluded.title, subtitle = excluded.subtitle,
       description = excluded.description,
       duration_seconds = CASE WHEN excluded.duration_seconds > 0 AND podcast_episodes.duration_measured = 0
         THEN excluded.duration_seconds ELSE podcast_episodes.duration_seconds END,
       chapters_url = excluded.chapters_url,
       chapters_checked_at = CASE WHEN podcast_episodes.chapters_url IS NOT excluded.chapters_url THEN NULL ELSE podcast_episodes.chapters_checked_at END,
       transcripts = excluded.transcripts,
       updated_at = excluded.updated_at
     WHERE podcast_episodes.enclosure_url IS NOT excluded.enclosure_url
        OR podcast_episodes.title IS NOT excluded.title
        OR podcast_episodes.description IS NOT excluded.description
        OR (excluded.duration_seconds > 0 AND podcast_episodes.duration_measured = 0 AND podcast_episodes.duration_seconds IS NOT excluded.duration_seconds)
        OR podcast_episodes.chapters_url IS NOT excluded.chapters_url
        OR podcast_episodes.transcripts IS NOT excluded.transcripts
     RETURNING id, published_at, created_at`,
  ).bind(
    crypto.randomUUID(), p.library_item_id, p.tenant_id, String(Math.floor(Math.random() * 0xffffffff)),
    episodeKey(e), startIdx + i + 1, e.season || null, e.episode || null, e.episodeType || null,
    e.title || null, e.subtitle || null, e.description || null, e.pubDate || null, e.publishedAt,
    e.enclosure.url, e.enclosure.type, lengthOf(e.enclosure.length), e.durationSeconds ?? 0,
    JSON.stringify(e.chapters), e.chaptersUrl, e.transcripts.length ? JSON.stringify(e.transcripts) : null, now, now,
  ));
  for (let i = 0; i < stmts.length; i += 100) {
    const res = await env.DB.batch<{ id: string; published_at: number | null; created_at: number }>(stmts.slice(i, i + 100));
    for (const r of res) for (const row of r.results ?? []) if (row.created_at === now) added.push(row);
  }
  return added;
}

// ── Episodes whose guid changed ──────────────────────────────────────────
//
// Episodes are keyed by guid (idx_episodes_item_guid), so a feed that
// changes its guids (a move to another host, a CMS that regenerates them)
// would add its whole back catalogue a second time, and the listener's
// progress, archived copies and playlist entries would stay on the old,
// orphaned rows. Before the upsert, an incoming episode with an unknown guid
// is matched to a stored one, whose guid is then rewritten in place (id,
// ino, progress and archive state untouched; the upsert then refreshes the
// rest of the row):
//   1. by enclosure URL (enclosureKey: no scheme, query or tracking
//      prefix), when exactly one stored episode and one incoming one have
//      it and their dates are within a week (a rerun of an old episode with
//      the same file is a new episode, months later); else
//   2. by title (case, spacing and punctuation ignored) and publication
//      time within 36 hours (a host move can shift the time zone), again
//      only when that pair is unique on both sides.
// Only stored episodes whose guid this parse does NOT list are candidates:
// one the feed still lists is a different episode.
const REKEY_ENCLOSURE_WINDOW_MS = 7 * 86400_000;
const REKEY_TITLE_WINDOW_MS = 36 * 3600_000;

// An enclosure URL without what changes when nothing about the audio does:
// the scheme, the query (signed and tracking parameters) and any tracking
// prefix, found as the last path segment that looks like a host name
// ("op3.dev/e,pg=…/podcast.thelinuxexp.com/audio/x.mp3",
// "dts.podtrac.com/redirect.mp3/traffic.libsyn.com/show/x.mp3").
export function enclosureKey(url: string): string {
  const bare = (url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[?#]/)[0] ?? '').toLowerCase();
  const parts = bare.split('/');
  let start = 0;
  for (let i = 0; i < parts.length - 1; i++) {
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?$/.test(parts[i]!)) start = i;
  }
  return parts.slice(start).join('/');
}

function titleKey(t: string | null | undefined): string {
  return (t ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function within(a: number | null | undefined, b: number | null | undefined, ms: number): boolean {
  return a != null && b != null && Math.abs(a - b) <= ms;
}

type StoredKey = { id: string; guid: string; title: string | null; published_at: number | null; enclosure_url: string };

async function rekeyMovedEpisodes(env: Env, p: PodcastRow, eps: FeedEpisode[], now: number): Promise<number> {
  // The incoming episodes, once per guid (a feed can repeat one).
  const incoming = new Map<string, FeedEpisode>();
  for (const e of eps) if (!incoming.has(episodeKey(e))) incoming.set(episodeKey(e), e);
  if (!incoming.size) return 0;

  // Which incoming guids are stored already: indexed lookups for an
  // ordinary poll (a handful of items), one scan of the show's guids for a
  // whole-feed parse.
  const keys = [...incoming.keys()];
  const known = new Set<string>();
  if (keys.length <= 180) {
    for (let i = 0; i < keys.length; i += 90) {
      const part = keys.slice(i, i + 90);
      const r = await env.DB.prepare(
        `SELECT guid FROM podcast_episodes WHERE library_item_id = ? AND guid IN (${part.map(() => '?').join(',')})`,
      ).bind(p.library_item_id, ...part).all<{ guid: string }>();
      for (const row of r.results) known.add(row.guid);
    }
  } else {
    const r = await env.DB.prepare('SELECT guid FROM podcast_episodes WHERE library_item_id = ?')
      .bind(p.library_item_id).all<{ guid: string }>();
    for (const row of r.results) if (incoming.has(row.guid)) known.add(row.guid);
  }
  const fresh = [...incoming.entries()].filter(([k]) => !known.has(k));
  if (!fresh.length) return 0;

  const stored = (await env.DB.prepare(
    'SELECT id, guid, title, published_at, enclosure_url FROM podcast_episodes WHERE library_item_id = ?',
  ).bind(p.library_item_id).all<StoredKey>()).results.filter((r) => !incoming.has(r.guid));
  if (!stored.length) return 0;

  const group = <T>(rows: T[], key: (r: T) => string) => {
    const m = new Map<string, T[]>();
    for (const r of rows) { const k = key(r); if (k) m.set(k, [...(m.get(k) ?? []), r]); }
    return m;
  };
  const storedByEnc = group(stored, (r) => enclosureKey(r.enclosure_url));
  const storedByTitle = group(stored, (r) => titleKey(r.title));
  const incomingByEnc = group([...incoming.values()], (e) => enclosureKey(e.enclosure.url));
  const freshByTitle = group(fresh.map(([, e]) => e), (e) => titleKey(e.title));

  const used = new Set<string>();
  const rekeys: Array<{ id: string; guid: string; from: string }> = [];
  for (const [guid, e] of fresh) {
    let match: StoredKey | undefined;
    const ek = enclosureKey(e.enclosure.url);
    const byEnc = storedByEnc.get(ek);
    if (byEnc?.length === 1 && incomingByEnc.get(ek)?.length === 1 && !used.has(byEnc[0]!.id)
      && (byEnc[0]!.published_at == null || e.publishedAt == null || within(byEnc[0]!.published_at, e.publishedAt, REKEY_ENCLOSURE_WINDOW_MS))) {
      match = byEnc[0];
    }
    if (!match) {
      const tk = titleKey(e.title);
      const near = (storedByTitle.get(tk) ?? []).filter((r) => !used.has(r.id) && within(r.published_at, e.publishedAt, REKEY_TITLE_WINDOW_MS));
      const twins = (freshByTitle.get(tk) ?? []).filter((f) => within(f.publishedAt, e.publishedAt, REKEY_TITLE_WINDOW_MS));
      if (tk && near.length === 1 && twins.length === 1) match = near[0];
    }
    if (match) { used.add(match.id); rekeys.push({ id: match.id, guid, from: match.guid }); }
  }
  if (!rekeys.length) return 0;
  const stmts = rekeys.map((r) => env.DB.prepare(
    'UPDATE podcast_episodes SET guid = ?, updated_at = ? WHERE id = ? AND library_item_id = ?',
  ).bind(r.guid, now, r.id, p.library_item_id));
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  console.log(`podcast ${p.library_item_id}: ${rekeys.length} episode(s) changed guid, kept in place (first: ${rekeys[0]!.from} -> ${rekeys[0]!.guid})`);
  return rekeys.length;
}

async function storeEpisodes(env: Env, p: PodcastRow, eps: FeedEpisode[], opts: { initial: boolean }): Promise<string[]> {
  const now = Date.now();
  const maxIdx = await env.DB.prepare('SELECT COALESCE(MAX(idx), 0) AS m FROM podcast_episodes WHERE library_item_id = ?')
    .bind(p.library_item_id).first<{ m: number }>();
  const added = await upsertEpisodes(env, p, eps, maxIdx?.m ?? 0, now);
  if (!added.length) return [];

  let onShow: string[];
  const newestFirst = [...added].sort((x, y) => (y.published_at ?? 0) - (x.published_at ?? 0));
  if (opts.initial) {
    onShow = p.podcast_type === 'serial'
      ? [...newestFirst].reverse().slice(0, SERIAL_CAP).map((e) => e.id)
      : newestFirst.slice(0, INITIAL_EPISODES).map((e) => e.id);
  } else if (p.auto_download === 1) {
    const cap = p.max_new_episodes_to_download > 0 ? p.max_new_episodes_to_download : newestFirst.length;
    onShow = newestFirst.slice(0, cap).map((e) => e.id);
  } else {
    onShow = [];
  }
  // Archive only what arrives after subscribing: a whole back catalogue
  // queued on day one is a job for "archive all", asked for explicitly. Nor
  // for a show nobody follows (an owner's "Check now" on an idle show still
  // stores what's new, but copies nothing into pCloud for no listener).
  const archive = !opts.initial && p.archive === 1 && !await isIdle(env, p.library_item_id);
  for (let i = 0; i < onShow.length; i += 90) {
    const part = onShow.slice(i, i + 90);
    await env.DB.prepare(
      `UPDATE podcast_episodes SET in_library = 1${archive ? ", archive_state = COALESCE(archive_state, 'queued')" : ''}
        WHERE id IN (${part.map(() => '?').join(',')})`,
    ).bind(...part).run();
  }
  if (p.max_episodes_to_keep > 0) await trimShow(env, p);
  return onShow;
}

// ABS's maxEpisodesToKeep: the oldest episodes beyond the limit leave the
// show. Archived files are kept — keeping them is what archiving is for.
async function trimShow(env: Env, p: PodcastRow): Promise<void> {
  await env.DB.prepare(
    `UPDATE podcast_episodes SET in_library = 0
      WHERE library_item_id = ? AND in_library = 1 AND id NOT IN (
        SELECT id FROM podcast_episodes WHERE library_item_id = ? AND in_library = 1
         ORDER BY published_at DESC, idx DESC LIMIT ?)`,
  ).bind(p.library_item_id, p.library_item_id, p.max_episodes_to_keep).run();
}

// ─── Polling ─────────────────────────────────────────────────────────────────

export type RefreshResult = { notModified: boolean; added: string[]; error?: string };

export async function refreshPodcast(env: Env, p: PodcastRow, opts: { force?: boolean } = {}): Promise<RefreshResult> {
  const now = Date.now();
  const have = await env.DB.prepare('SELECT COUNT(*) AS n FROM podcast_episodes WHERE library_item_id = ?')
    .bind(p.library_item_id).first<{ n: number }>();
  const firstFill = !have?.n;
  // A show stored by an older parser re-reads its whole feed once, so
  // every stored episode gains the new field (no conditional GET, no early
  // stop).
  const reparse = (p.parse_version ?? 0) < PARSE_VERSION;
  try {
    const got = await fetchFeed(p.feed_url, opts.force || firstFill || reparse ? undefined : { etag: p.feed_etag, lastModified: p.feed_last_modified });
    if (got.notModified) {
      await env.DB.prepare(
        'UPDATE podcasts SET last_episode_check = ?, next_check_at = ?, check_failures = 0, last_error = NULL WHERE library_item_id = ?',
      ).bind(now, now + POLL_EVERY_MS, p.library_item_id).run();
      return { notModified: true, added: [] };
    }
    const known = new Set((await env.DB.prepare(
      'SELECT guid FROM podcast_episodes WHERE library_item_id = ? ORDER BY published_at DESC LIMIT 30',
    ).bind(p.library_item_id).all<{ guid: string }>()).results.map((r) => r.guid));
    const feed = parseFeed(got.xml, firstFill || reparse ? {} : { known, stopAfterKnown: 5 });
    if (!feed) throw new PodcastError(502, "The feed no longer parses as podcast RSS");

    const md = feed.metadata;
    const newUrl = md.feedUrl && validFeedUrl(md.feedUrl);
    // Only itunes:new-feed-url moves a subscription; atom:link self is often
    // a stale or proxy URL.
    const moved = newUrl && /itunes:new-feed-url/i.test(got.xml.slice(0, 20000)) && newUrl !== p.feed_url ? newUrl : null;
    await env.DB.prepare(
      `UPDATE podcasts SET title = COALESCE(?, title), author = COALESCE(?, author), description = COALESCE(?, description),
         image_url = COALESCE(?, image_url), cover_url = CASE WHEN cover_url IS NULL OR cover_url = image_url THEN COALESCE(?, cover_url) ELSE cover_url END,
         language = COALESCE(?, language), podcast_type = COALESCE(?, podcast_type),
         genres = CASE WHEN ? = '[]' THEN genres ELSE ? END, feed_url = COALESCE(?, feed_url),
         last_episode_check = ?, next_check_at = ?, check_failures = 0, last_error = NULL, updated_at = ?
       WHERE library_item_id = ?`,
    ).bind(
      md.title, md.author, md.description, md.image, md.image, md.language, md.type,
      JSON.stringify(md.categories), JSON.stringify(md.categories), moved,
      now, now + POLL_EVERY_MS, now, p.library_item_id,
    ).run();
    // OPML imports skip the iTunes match at creation; do it on the first fill.
    if (firstFill && !p.itunes_id && md.title) {
      const it = await itunesForFeed(md.title, p.feed_url, md.author);
      if (it) {
        await env.DB.prepare(
          `UPDATE podcasts SET cover_url = ?, itunes_id = COALESCE(?, itunes_id), itunes_artist_id = COALESCE(?, itunes_artist_id),
             itunes_page_url = COALESCE(?, itunes_page_url) WHERE library_item_id = ?`,
        ).bind(it.cover || md.image, it.id ? String(it.id) : null, it.artistId != null ? String(it.artistId) : null,
          it.pageUrl || null, p.library_item_id).run();
      }
    }
    const fresh = await env.DB.prepare('SELECT * FROM podcasts WHERE library_item_id = ?').bind(p.library_item_id).first<PodcastRow>();
    const added = await storeEpisodes(env, fresh ?? p, feed.episodes, { initial: firstFill });
    // Only now is this feed version "seen": written earlier, a failure in
    // storeEpisodes would leave the next poll getting 304 for episodes
    // that were never stored (and a reparse marked done that wasn't).
    await env.DB.prepare('UPDATE podcasts SET feed_etag = ?, feed_last_modified = ?, parse_version = ? WHERE library_item_id = ?')
      .bind(got.etag, got.lastModified, PARSE_VERSION, p.library_item_id).run();
    if (added.length) {
      await env.DB.prepare('UPDATE library_items SET updated_at = ? WHERE id = ?').bind(now, p.library_item_id).run();
    }
    // New-episode push notifications (src/lib/push.ts). `added` is what this
    // check INSERTED and put on the show, newest first: a guid re-key is an
    // update and never in it, and episodes/add and play-to-add don't come
    // through here. A check counts only when this parser had read the feed
    // before: not a PARSE_VERSION re-read and not an OPML show's first fetch
    // (both have a stale parse_version), whose inserts are the back
    // catalogue, not news. A show first fetched by createPodcast never gets
    // here for its initial episodes, and one subscribed while its feed was
    // still empty does count, rightly: its first episodes are new. The
    // three-day publication window is applied in announceNewEpisodes.
    // Awaited, so it runs inside the cron's or the request's lifetime; a
    // failure must not be recorded as the feed's.
    if (added.length && !reparse) {
      try {
        const line = await announceNewEpisodes(env, fresh ?? p, added);
        if (line) console.log('[push] ' + line);
      } catch (e) {
        console.error(`[push] ${p.library_item_id}: ${(e as Error).message}`);
      }
    }
    return { notModified: false, added };
  } catch (e) {
    const failures = p.check_failures + 1;
    const wait = Math.min(POLL_EVERY_MS * 2 ** Math.min(failures - 1, 5), MAX_BACKOFF_MS);
    const msg = (e as Error).message;
    await env.DB.prepare(
      'UPDATE podcasts SET last_episode_check = ?, next_check_at = ?, check_failures = ?, last_error = ? WHERE library_item_id = ?',
    ).bind(now, now + wait, failures, msg.slice(0, 300), p.library_item_id).run();
    return { notModified: false, added: [], error: msg };
  }
}

// Cron: a few due feeds, then the archive queue. Every 2 minutes (the ABB
// catalogue's cron), so up to 150 feed checks an hour. Only shows someone
// follows (migration 0028): an idle show isn't polled. unfollowShow parks a
// show that loses its last follower (next_check_at NULL) so it isn't even
// read here; the EXISTS is what guarantees it when follows vanish another
// way (a deleted user, leaving the tenant).
export async function runPodcastTick(env: Env): Promise<string[]> {
  const log: string[] = [];
  const due = await env.DB.prepare(
    `SELECT * FROM podcasts p WHERE p.next_check_at IS NOT NULL AND p.next_check_at <= ?
        AND EXISTS (SELECT 1 FROM podcast_follows f WHERE f.library_item_id = p.library_item_id)
      ORDER BY p.next_check_at ASC LIMIT ?`,
  ).bind(Date.now(), TICK_FEEDS).all<PodcastRow>();
  for (const p of due.results) {
    const r = await refreshPodcast(env, p);
    log.push(`${p.title ?? p.library_item_id}: ${r.error ? 'error ' + r.error : r.notModified ? '304' : `+${r.added.length}`}`);
  }
  log.push(...await archivePump(env));
  log.push(...await chapterPump(env));
  // After the chapter pump: an episode is analysed only once its chapters
  // have been looked up (the analysis needs to know whether there are any).
  try {
    log.push(...await analysisPump(env));
  } catch (e) {
    log.push(`analysis pump: ${(e as Error).message}`);
  }
  log.push(...await prunePreviews(env));
  return log;
}

// A show stored only so someone could look at it (createPodcast's
// `follow: false`, migration 0033) and then left: nobody followed it, and
// for 30 days nobody opened it from search (previewed_at) or played any of
// it. Its rows go, as the owner's delete would take them. Kept, whatever
// its age, while anything of it is in pCloud or on its way there (deleting
// rows would orphan the files), or on a playlist. A few per tick; the scan
// is of the podcasts table alone, which holds tens of rows.
const PREVIEW_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export async function prunePreviews(env: Env): Promise<string[]> {
  const cutoff = Date.now() - PREVIEW_KEEP_MS;
  const stale = await env.DB.prepare(
    `SELECT p.library_item_id, p.title FROM podcasts p
      WHERE p.previewed_at IS NOT NULL AND p.previewed_at < ?
        AND NOT EXISTS (SELECT 1 FROM podcast_follows f WHERE f.library_item_id = p.library_item_id)
        AND NOT EXISTS (SELECT 1 FROM media_progress mp WHERE mp.library_item_id = p.library_item_id AND mp.last_update > ?)
        AND NOT EXISTS (SELECT 1 FROM podcast_episodes e WHERE e.library_item_id = p.library_item_id
                          AND e.archive_state IN ('done', 'queued', 'fetching'))
        AND NOT EXISTS (SELECT 1 FROM playlist_items pi WHERE pi.library_item_id = p.library_item_id)
      LIMIT 3`,
  ).bind(cutoff, cutoff).all<{ library_item_id: string; title: string | null }>();
  const log: string[] = [];
  for (const r of stale.results) {
    await env.DB.batch(itemDeleteStatements(env, r.library_item_id));
    try { await env.COVERS.delete(`covers/${r.library_item_id}`); } catch { /* non-fatal */ }
    log.push(`preview pruned: ${r.title ?? r.library_item_id}`);
  }
  return log;
}

// ─── Chapters ────────────────────────────────────────────────────────────────
//
// Two sources, in order: the feed's <podcast:chapters> JSON (Podcasting 2.0;
// Linux & Open Source News and LINUX Unplugged publish one per episode), then
// chapters embedded in the audio (ID3 CHAP frames in an mp3, chpl/QuickTime
// chapters in an m4a), read with the book probers over a few Range requests.
// The mp3 probe also yields a duration, which fills in episodes whose feed
// gave no itunes:duration (without one, resume can't place the playhead).

type Chapter = { id: number; start: number; end: number; title: string };

// JSON chapters per podcastindex.org's spec: {version, chapters: [{startTime,
// endTime?, title?, toc?}]}. Some publishers write the numbers as strings
// (LINUX Unplugged does); `toc: false` marks a silent chapter (an image or
// link change) that isn't a navigation point.
export function parseJsonChapters(data: unknown, duration: number): Chapter[] {
  const raw = (data as { chapters?: unknown })?.chapters;
  if (!Array.isArray(raw)) return [];
  const items = raw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && (c as Record<string, unknown>)['toc'] !== false)
    .map((c) => ({ start: Number(c['startTime']), end: Number(c['endTime']), title: typeof c['title'] === 'string' ? c['title'].trim() : '' }))
    .filter((c) => Number.isFinite(c.start) && c.start >= 0)
    .sort((a, b) => a.start - b.start);
  return items.map((c, i) => {
    const next = items[i + 1]?.start;
    const end = Number.isFinite(c.end) && c.end > c.start ? c.end : next ?? (duration > c.start ? duration : c.start);
    return { id: i, start: c.start, end, title: c.title || `Chapter ${i + 1}` };
  });
}

async function chaptersFromJson(url: string, duration: number): Promise<Chapter[]> {
  const res = await fetch(url, { headers: { 'User-Agent': FEED_UA, Accept: 'application/json+chapters, application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`chapters JSON answered HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(len) && len > 2_000_000) throw new Error('chapters JSON too large');
  return parseJsonChapters(await res.json(), duration);
}

async function chaptersFromAudio(e: EpisodeRow): Promise<{ chapters: Chapter[]; duration: number | null }> {
  const ext = episodeExt(e);
  if (ext === 'mp3') {
    const { probeMp3 } = await import('../prober/mp3');
    const p = await probeMp3(e.enclosure_url, e.size_bytes || undefined, { 'User-Agent': EPISODE_AUDIO_UA });
    return { chapters: p.chapters.map((c, i) => ({ id: i, start: c.start, end: c.end, title: c.title || `Chapter ${i + 1}` })), duration: p.durationSeconds };
  }
  if (ext === 'm4a' || ext === 'mp4' || ext === 'm4b' || ext === 'aac') {
    const { probeM4b } = await import('../prober/m4b');
    const p = await probeM4b(e.enclosure_url, { 'User-Agent': EPISODE_AUDIO_UA });
    const dur = p.durationSeconds ?? e.duration_seconds;
    return {
      chapters: p.chapters.map((c, i, all) => ({ id: i, start: c.start, end: all[i + 1]?.start ?? dur, title: c.title || `Chapter ${i + 1}` })),
      duration: p.durationSeconds ?? null,
    };
  }
  return { chapters: [], duration: null };
}

// An episode's transcript, parsed (src/lib/transcript.ts), trying the
// feed's links best format first until one parses. Kept at the edge for a
// week under the publisher's URL: a transcript doesn't change once out, and
// the next client to open it shouldn't wait on the publisher again. The
// episode's length goes into the key because the hour-offset fix uses it.
//
// With an analysis of the file served now (src/lib/episode-analysis.ts):
// the publisher's cues are shifted onto that file (and the key names the
// analysis, whose offsets they followed), or, for a show that publishes no
// transcript, the speech-recognition one the analysis made comes from R2.
export async function episodeTranscript(env: Env, e: EpisodeRow): Promise<Transcript> {
  const analysis = currentAnalysis(e);
  if (analysis?.transcript === 'whisper') {
    const t = await whisperTranscriptFor(env, e);
    if (t) return t;
  }
  const links = rankTranscripts(JSON.parse(e.transcripts || '[]') as TranscriptLink[]);
  if (!links.length) throw new PodcastError(404, 'This episode has no transcript');
  const mapped = analysis && analysis.offsets.length ? analysis : null;
  const toServed = mapped ? (cues: TranscriptCue[]) => cuesToServed(cues, mapped.offsets, mapped.cuts) : undefined;
  const mapKey = mapped ? `a${mapped.size}-${shortHash(JSON.stringify([mapped.offsets, mapped.cuts]))}/` : '';
  const cache = caches.default;
  let lastError = 'no transcript could be read';
  for (const l of links) {
    const key = new Request(`https://transcripts.abs-shim.internal/v1/${e.duration_seconds || 0}/${mapKey}${encodeURIComponent(l.url)}`);
    const hit = await cache.match(key);
    if (hit) return await hit.json() as Transcript;
    try {
      const res = await fetch(l.url, { headers: { 'User-Agent': FEED_UA }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) { lastError = `the publisher answered HTTP ${res.status}`; continue; }
      const len = Number(res.headers.get('content-length') ?? '');
      if (Number.isFinite(len) && len > 8_000_000) { lastError = 'the transcript file is too large'; continue; }
      const body = await res.text();
      if (body.length > 8_000_000) { lastError = 'the transcript file is too large'; continue; }
      const t = parseTranscript(l.kind, body, e.duration_seconds, toServed);
      if (!t) { lastError = `the ${l.kind} file had nothing in it to show`; continue; }
      await cache.put(key, new Response(JSON.stringify(t), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=604800' },
      }));
      return t;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new PodcastError(502, `Transcript unavailable: ${lastError}`);
}

// FNV-1a, for cache keys.
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

// Look one episode's chapters up and store them. Chapters already in the
// row (psc:chapters inline in the feed) are kept. A failure is retried the
// next day, an episode without any a week later, but only while it's under
// 30 days old: publishers add chapters to new episodes, not old ones, and a
// show without any (Linux Matters) would otherwise re-read every episode's
// mp3 header every week.
export async function ensureEpisodeChapters(env: Env, e: EpisodeRow): Promise<Chapter[]> {
  const now = Date.now();
  const have = JSON.parse(e.chapters || '[]') as Chapter[];
  let chapters: Chapter[] = have;
  let duration: number | null = null;
  try {
    if (!have.length && e.chapters_url) chapters = await chaptersFromJson(e.chapters_url, e.duration_seconds);
    // The audio is always probed (one small Range read): besides embedded
    // chapters it gives the file's real length, and feeds get that wrong.
    // LINUX Unplugged says 1:20:33 for a file that is 1:14:00, and hosts
    // that stitch ads in at download time (art19, Audioboom, Megaphone)
    // serve a different length to every listener, so the number that
    // matters is the one this Worker is handed, which is what it streams.
    // The "played with N left" rule and Pholia's time-left both come from
    // it. A probe that only estimates (CBR size/bitrate) can be wrong for
    // an odd VBR file, so a disagreement of more than a quarter is not
    // believed.
    const fromAudio = await chaptersFromAudio(e).catch(() => ({ chapters: [] as Chapter[], duration: null }));
    if (!chapters.length) chapters = fromAudio.chapters;
    // Except an archived episode on such a host: this probe reads the
    // enclosure, a different stitch from the pCloud copy that is played, so
    // its length isn't the played file's (that file's analysis sets it).
    // Without this, the weekly re-check of an episode with no chapters put
    // the streamed stitch's length back.
    const otherStitch = e.archive_state === 'done' && !!e.archive_rel_path && hasDynamicAds(e.enclosure_url);
    const probed = otherStitch ? null : fromAudio.duration;
    let measured = false;
    if (probed && probed > 0) {
      const feed = e.duration_seconds || 0;
      measured = !feed || Math.abs(probed - feed) < feed / 4;
      if (measured && (!feed || Math.abs(probed - feed) > 2)) duration = probed;
    }
    // A believed probe marks the length measured, so the next poll's feed
    // duration can't put the feed's number back (see upsertEpisodes).
    await env.DB.prepare(
      `UPDATE podcast_episodes SET chapters = ?, chapters_checked_at = ?${duration ? ', duration_seconds = ?' : ''}${measured ? ', duration_measured = 1' : ''} WHERE id = ?`,
    ).bind(JSON.stringify(chapters), now, ...(duration ? [Math.round(duration * 1000) / 1000] : []), e.id).run();
    return chapters;
  } catch (err) {
    await env.DB.prepare('UPDATE podcast_episodes SET chapters_checked_at = ? WHERE id = ?')
      .bind(now - CHAPTERS_RECHECK_MS + 24 * 60 * 60 * 1000, e.id).run();
    console.warn(`[podcasts] chapters for ${e.id}: ${(err as Error).message}`);
    return have;
  }
}

// Only shows someone follows: a show stored just to be looked at (migration
// 0033) arrives with up to 500 unchecked episodes, and probing each one's
// audio at its publisher would be work for nobody. Playing one still looks
// its chapters up (the play route's ensureEpisodeChapters).
export async function chapterPump(env: Env): Promise<string[]> {
  const due = await env.DB.prepare(
    `SELECT * FROM podcast_episodes
      WHERE in_library = 1 AND (chapters_checked_at IS NULL
         OR (chapters = '[]' AND chapters_checked_at < ? AND published_at > ?))
        AND EXISTS (SELECT 1 FROM podcast_follows f WHERE f.library_item_id = podcast_episodes.library_item_id)
      ORDER BY chapters_checked_at IS NOT NULL, published_at DESC LIMIT ?`,
  ).bind(Date.now() - CHAPTERS_RECHECK_MS, Date.now() - 30 * 86400_000, CHAPTERS_PER_TICK).all<EpisodeRow>();
  let found = 0;
  for (const e of due.results) if ((await ensureEpisodeChapters(env, e)).length) found++;
  return due.results.length ? [`chapters: ${due.results.length} checked, ${found} with chapters`] : [];
}

// ─── Archiving ───────────────────────────────────────────────────────────────

type PcloudTarget = { profile: PcloudProfile; rootPath: string };

async function pcloudFor(env: Env, folder: LibraryFolderRow): Promise<PcloudTarget | null> {
  if (folder.provider !== 'pcloud_oauth' || !folder.profile_id) return null;
  const row = await env.DB.prepare('SELECT access_token, api_host FROM oauth_profiles WHERE id = ? AND tenant_id = ?')
    .bind(folder.profile_id, folder.tenant_id).first<{ access_token: string; api_host: string | null }>();
  if (!row) return null;
  let rootPath = '/';
  try { rootPath = (JSON.parse(folder.config_json ?? '{}') as { rootPath?: string }).rootPath ?? '/'; } catch { /* default */ }
  return { profile: { accessToken: row.access_token, apiHost: row.api_host ?? 'api.pcloud.com' }, rootPath };
}

export async function canArchive(env: Env, folder: LibraryFolderRow): Promise<boolean> {
  return (await pcloudFor(env, folder)) != null;
}

const join = (root: string, rel: string) => (root.replace(/\/+$/, '') || '') + '/' + rel.replace(/^\/+/, '');

// `YYYY-MM-DD_E042_Title.ext`, Murmur's naming for podcast downloads
// (murmur/src/main.ts feedFilename): the date leads so the folder sorts
// chronologically, the episode number only when the feed publishes one.
function archiveName(e: EpisodeRow): string {
  const parts = [e.published_at ? new Date(e.published_at).toISOString().slice(0, 10) : ''];
  const num = Number(e.episode);
  if (e.episode && Number.isInteger(num) && num >= 0) parts.push(`E${String(num).padStart(3, '0')}`);
  parts.push(safeName(e.title ?? 'Episode'));
  return parts.filter(Boolean).join('_') + '.' + episodeExt(e);
}

// Where the enclosure really is, and how big. Podcast enclosures are usually
// a chain of tracking redirects (podtrac → chartable → the host CDN); pCloud
// gets the end of the chain, so its own fetch is one hop.
async function probeEnclosure(url: string): Promise<{ url: string; size: number | null; html: boolean }> {
  const headers = { 'User-Agent': FEED_UA };
  try {
    let res = await fetch(url, { method: 'HEAD', redirect: 'follow', headers, signal: AbortSignal.timeout(15_000) });
    let size = Number(res.headers.get('content-length') ?? '');
    if (!res.ok || !(size > 0)) {
      res = await fetch(url, { headers: { ...headers, Range: 'bytes=0-0' }, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
      const m = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '');
      size = m ? Number(m[1]) : NaN;
      await res.body?.cancel().catch(() => undefined);
    }
    const html = /^text\/html/i.test(res.headers.get('content-type') ?? '');
    return { url: res.url || url, size: res.ok && size > 0 ? size : null, html };
  } catch {
    return { url, size: null, html: false };
  }
}

// A chunked response has no Content-Length to check against the cap, so
// the body is counted as it arrives.
async function readCapped(res: Response, cap: number): Promise<ArrayBuffer> {
  const reader = res.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new PodcastError(502, `The feed is over the ${cap / 1e6} MB limit`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of parts) { out.set(part, off); off += part.byteLength; }
  return out.buffer as ArrayBuffer;
}

type ArchiveRow = EpisodeRow & { folder_id: string; show_path: string };

// Whether a pull has landed. Until 2026-10-14 it was the FIRST stat that
// reached the source's size (the Worker's own HEAD of the enclosure), which
// went wrong on NSTAAF's "Peanut Podcast" (2026-10-13): a stat 14 s after
// the start found a 31,840,334 B file, the size the Worker's stitch had, and
// the episode was marked done at that size; pCloud's metadata says the file
// at that path now was created 9 s later, 30,219,072 B with other ads (a
// second pull into the same name: the claim race described in
// archivePump). The analysis submitted in between read the first file, so
// it matched size_bytes and went on being served against the second, which
// nothing ever re-measured. And the source's size is no measure for a host
// that stitches ads per download: pCloud is handed a stitch of its own.
//
// So a pull has landed when pCloud's size held across two polls (the
// previous poll left it in archive_seen_size), at least ARCHIVE_MIN_FETCH_MS
// after the start, with pCloud's own `modified` ARCHIVE_SETTLE_MS old; and
// the size then recorded is pCloud's (archiveLanded). Reaching the source's
// size is still required, except on an ad-inserting host, or once the file
// has sat unchanged ARCHIVE_ANY_SIZE_AFTER_MS into the pull.
export function archiveSettled(
  e: Pick<EpisodeRow, 'archive_seen_size' | 'archive_started_at' | 'archive_expected_size' | 'enclosure_url'>,
  size: number, modified: string | undefined, now: number,
): boolean {
  if (!(size > 0) || size !== e.archive_seen_size) return false;
  const since = now - (e.archive_started_at ?? now);
  if (since < ARCHIVE_MIN_FETCH_MS) return false;
  const m = modified ? Date.parse(modified) : NaN;
  if (Number.isFinite(m) && now - m < ARCHIVE_SETTLE_MS) return false;
  const expected = e.archive_expected_size;
  return !expected || size >= expected || hasDynamicAds(e.enclosure_url) || since >= ARCHIVE_ANY_SIZE_AFTER_MS;
}

// A pull has landed (or the file was already there): the episode plays from
// pCloud from now on, and its size is what pCloud holds. When that differs
// from the size recorded so far (the streamed stitch's, on a host that
// inserts ads), an analysis of the old size stops being served
// (currentAnalysis compares sizes), the analysis pump sees the archived file
// as unanalysed, and an analysis made earlier of this very size is taken up
// again. Only a row still being archived: one hidden with its files deleted
// meanwhile stays as it is.
async function archiveLanded(env: Env, e: EpisodeRow, rel: string, size: number): Promise<void> {
  const r = await env.DB.prepare(
    `UPDATE podcast_episodes SET archive_state = 'done', archive_rel_path = ?, size_bytes = ?, archive_error = NULL, updated_at = ?
      WHERE id = ? AND archive_state IN ('queued', 'fetching')`,
  ).bind(rel, size, Date.now(), e.id).run();
  if (r.meta.changes && size !== e.size_bytes) await adoptAnalysisForSize(env, e.id, size).catch(() => undefined);
}

export async function archivePump(env: Env): Promise<string[]> {
  const log: string[] = [];
  const now = Date.now();
  const folderCache = new Map<string, LibraryFolderRow | null>();
  const folderOf = async (id: string) => {
    if (!folderCache.has(id)) {
      folderCache.set(id, await env.DB.prepare('SELECT * FROM library_folders WHERE id = ?').bind(id).first<LibraryFolderRow>());
    }
    return folderCache.get(id) ?? null;
  };
  const fail = (e: EpisodeRow, msg: string) => env.DB.prepare(
    "UPDATE podcast_episodes SET archive_state = 'error', archive_error = ?, updated_at = ? WHERE id = ?",
  ).bind(msg.slice(0, 300), Date.now(), e.id).run();

  const leaseCutoff = now - ARCHIVE_START_LEASE_MS;
  const queued = await env.DB.prepare(
    `SELECT e.*, li.folder_id, li.rel_path AS show_path FROM podcast_episodes e JOIN library_items li ON li.id = e.library_item_id
      WHERE e.archive_state = 'queued' AND (e.archive_started_at IS NULL OR e.archive_started_at < ?)
      ORDER BY e.updated_at ASC LIMIT ?`,
  ).bind(leaseCutoff, ARCHIVE_STARTS_PER_TICK).all<ArchiveRow>();
  for (const e of queued.results) {
    // Two pumps can run at once (the archive route's waitUntil and the
    // cron), so a row is claimed before its pull is started, and the claim
    // is a lease: archive_started_at, which the row keeps until 'fetching'
    // overwrites it. Until 2026-10-14 the claim was a compare-and-set on
    // updated_at alone, which left the row 'queued' with a NEW updated_at
    // while the pull was being started: a second pump that read the row
    // after the first one's claim matched that new value and started a
    // second pull into the same file name. That is the likeliest way
    // Peanut got two pCloud files 9 s apart, with the archive route's pump
    // and the 05:12 UTC cron tick overlapping (archiveSettled, below).
    const claim = await env.DB.prepare(
      `UPDATE podcast_episodes SET updated_at = ?, archive_started_at = ?
        WHERE id = ? AND archive_state = 'queued' AND updated_at = ? AND (archive_started_at IS NULL OR archive_started_at < ?)`,
    ).bind(Math.max(now, (e.updated_at ?? 0) + 1), now, e.id, e.updated_at, leaseCutoff).run();
    if (!claim.meta.changes) continue;
    const folder = await folderOf(e.folder_id);
    const target = folder ? await pcloudFor(env, folder) : null;
    if (!target) { await fail(e, 'Archiving needs the library to be on pCloud'); continue; }
    try {
      const src = await probeEnclosure(e.enclosure_url);
      if (src.html) { await fail(e, 'The enclosure URL serves a web page, not audio'); continue; }
      const name = archiveName(e);
      const rel = `${e.show_path}/${name}`;
      const abs = join(target.rootPath, rel);
      const existing = await pcloudStat(target.profile, abs);
      if (existing?.size && (src.size == null || existing.size === src.size)) {
        await archiveLanded(env, e, rel, existing.size);
        log.push(`archive ${name}: already there`);
        continue;
      }
      const folderId = await pcloudEnsureFolder(target.profile, join(target.rootPath, e.show_path));
      await pcloudDownloadFileAsync(target.profile, { url: src.url, folderId, name });
      await env.DB.prepare(
        `UPDATE podcast_episodes SET archive_state = 'fetching', archive_rel_path = ?, archive_expected_size = ?,
           archive_seen_size = NULL, archive_started_at = ?, archive_error = NULL, updated_at = ? WHERE id = ?`,
      ).bind(rel, src.size, now, now, e.id).run();
      log.push(`archive ${name}: started`);
    } catch (err) {
      await fail(e, (err as Error).message);
    }
  }

  const fetching = await env.DB.prepare(
    `SELECT e.*, li.folder_id, li.rel_path AS show_path FROM podcast_episodes e JOIN library_items li ON li.id = e.library_item_id
      WHERE e.archive_state = 'fetching' ORDER BY e.archive_started_at ASC LIMIT ?`,
  ).bind(ARCHIVE_POLLS_PER_TICK).all<ArchiveRow>();
  for (const e of fetching.results) {
    const folder = await folderOf(e.folder_id);
    const target = folder ? await pcloudFor(env, folder) : null;
    if (!target || !e.archive_rel_path) { await fail(e, 'Lost track of the archive target'); continue; }
    try {
      const st = await pcloudStat(target.profile, join(target.rootPath, e.archive_rel_path));
      const size = st?.size ?? 0;
      if (archiveSettled(e, size, st?.modified, now)) {
        await archiveLanded(env, e, e.archive_rel_path, size);
        log.push(`archive ${e.archive_rel_path}: done (${size} bytes${e.archive_expected_size && size !== e.archive_expected_size ? `, the source said ${e.archive_expected_size}` : ''})`);
      } else if (now - (e.archive_started_at ?? now) > ARCHIVE_GIVE_UP_MS) {
        await fail(e, `pCloud stopped at ${size} bytes${e.archive_expected_size ? ` of ${e.archive_expected_size}` : ''}`);
      } else {
        await env.DB.prepare('UPDATE podcast_episodes SET archive_seen_size = ? WHERE id = ?').bind(size, e.id).run();
      }
    } catch (err) {
      // A stat that keeps failing (a revoked token) must not hold its row
      // in 'fetching' for ever, ahead of everything queued after it.
      if (now - (e.archive_started_at ?? now) > ARCHIVE_GIVE_UP_MS) await fail(e, `Couldn't check pCloud: ${(err as Error).message}`);
      else log.push(`archive poll ${e.id}: ${(err as Error).message}`);
    }
  }
  // Whoever asked for "Archive all" hears when it's over (migration 0034).
  try { log.push(...await announceArchiveDone(env)); }
  catch (err) { log.push(`archive done notice: ${(err as Error).message}`); }
  return log;
}

// Roughly how long until `ahead` queued copies (everything queued on the
// instance: the pump is one FIFO for all shows) have all landed, in seconds:
// ARCHIVE_STARTS_PER_TICK start per 2-minute tick, and the last one then
// needs a few minutes to settle (ARCHIVE_MIN_FETCH_MS + ARCHIVE_SETTLE_MS
// and a poll). An estimate for "about N left", not a promise.
export function archiveEtaSeconds(ahead: number, fetching: number): number {
  if (!ahead && !fetching) return 0;
  return Math.ceil(ahead / ARCHIVE_STARTS_PER_TICK) * 120 + 240;
}

// "Archive all" (2026-10-21): every episode the feed has listed that isn't
// on pCloud or on its way, on the show or not (it used to be the show's own
// episodes only, 100 of Incognito Mode's 140), minus the owner's removed
// ones; `retryFailed` requeues only the ones that failed. The request is
// recorded for the caller so they get a push when the show's copying is
// over (announceArchiveDone). Returns how many were queued.
export async function queueArchiveAll(env: Env, itemId: string, userId: string, opts: { retryFailed?: boolean } = {}): Promise<number> {
  const now = Date.now();
  // A request covers what it queues plus what was already on its way for
  // the show (a press while an earlier "Archive all" runs, as Joseph's
  // Incognito Mode was when this shipped): the notice reports every copy
  // that ends while it waits. A press while the caller's request is still
  // open adds only episodes never tried: the failed ones it requeues were
  // counted when it began, and counting them again would report "88 copied"
  // where 85 were.
  const before = await env.DB.prepare(
    `SELECT SUM(archive_state IS NULL) AS fresh, SUM(archive_state IN ('queued', 'fetching')) AS inflight
       FROM podcast_episodes WHERE library_item_id = ? AND removed = 0`,
  ).bind(itemId).first<{ fresh: number | null; inflight: number | null }>();
  const fresh = opts.retryFailed ? 0 : before?.fresh ?? 0;
  const r = await env.DB.prepare(
    `UPDATE podcast_episodes SET archive_state = 'queued', archive_error = NULL, updated_at = ?
      WHERE library_item_id = ? AND removed = 0 AND ${opts.retryFailed ? "archive_state = 'error'" : "(archive_state IS NULL OR archive_state = 'error')"}`,
  ).bind(now, itemId).run();
  const n = r.meta.changes ?? 0;
  const covers = n + (before?.inflight ?? 0);
  if (covers) {
    await env.DB.prepare(
      `INSERT INTO archive_requests (library_item_id, user_id, requested_at, queued) VALUES (?, ?, ?, ?)
       ON CONFLICT (library_item_id, user_id) DO UPDATE SET queued = queued + ?`,
    ).bind(itemId, userId, now, covers, Math.min(fresh, n)).run();
  }
  return n;
}

export type ArchiveStatus = {
  now: number;
  total: number;
  done: number;
  queued: number;
  fetching: number;
  error: number;
  toCopy: number;
  toCopyNotOnShow: number;
  queueAhead: number;
  etaSeconds: number;
  requested: boolean;
  errors: Array<{ id: string; title: string | null; error: string | null }>;
  changed?: Array<{ id: string; archiveState: string | null; archiveError: string | null }>;
};

// GET /api/podcasts/:id/archive: where a show's copying to pCloud stands,
// over every episode in the feed (not removed). `since` (the previous
// answer's `now`) adds the episodes whose archive state moved since, so a
// show page redraws just those rows. Polled every 20 s while a show page
// with copying under way is open: one grouped read of the show's rows.
export async function archiveStatus(env: Env, itemId: string, userId: string, since: number | null): Promise<ArchiveStatus> {
  const now = Date.now();
  // The pump is one queue for every show, oldest updated_at first: this
  // show is done once everything up to its own last queued row has gone, so
  // its estimate counts only those (a show queued after it doesn't slow it).
  // `queueAhead` (all queued) is what a new "Archive all" would wait behind.
  const [counts, errors, ahead, mine, changed, upTo] = await Promise.all([
    env.DB.prepare(
      `SELECT archive_state AS s, in_library AS on_show, COUNT(*) AS n FROM podcast_episodes
        WHERE library_item_id = ? AND removed = 0 GROUP BY archive_state, in_library`,
    ).bind(itemId).all<{ s: string | null; on_show: number; n: number }>(),
    env.DB.prepare(
      `SELECT id, title, archive_error FROM podcast_episodes
        WHERE library_item_id = ? AND removed = 0 AND archive_state = 'error' ORDER BY published_at DESC LIMIT 20`,
    ).bind(itemId).all<{ id: string; title: string | null; archive_error: string | null }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM podcast_episodes WHERE archive_state = 'queued'").first<{ n: number }>(),
    env.DB.prepare('SELECT 1 AS x FROM archive_requests WHERE library_item_id = ? AND user_id = ?').bind(itemId, userId).first<{ x: number }>(),
    since != null && Number.isFinite(since)
      ? env.DB.prepare(
        `SELECT id, archive_state, archive_error FROM podcast_episodes
          WHERE library_item_id = ? AND updated_at > ? AND archive_state IS NOT NULL LIMIT 600`,
      // 10 s of overlap: a pump stamps updated_at with its own clock and may
      // commit just after this read; a row sent twice is harmless (the page
      // compares states), a row missed would stay stale until reopened.
      ).bind(itemId, since - 10_000).all<{ id: string; archive_state: string | null; archive_error: string | null }>()
      : Promise.resolve(null),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM podcast_episodes WHERE archive_state = 'queued'
          AND updated_at <= (SELECT MAX(updated_at) FROM podcast_episodes WHERE library_item_id = ? AND archive_state = 'queued')`,
    ).bind(itemId).first<{ n: number }>(),
  ]);
  const by = (s: string | null) => counts.results.filter((r) => r.s === s).reduce((a, r) => a + r.n, 0);
  const total = counts.results.reduce((a, r) => a + r.n, 0);
  const queued = by('queued');
  const fetching = by('fetching');
  const toCopyRows = counts.results.filter((r) => r.s === null || r.s === 'error');
  const queueAhead = ahead?.n ?? 0;
  return {
    now, total, done: by('done'), queued, fetching, error: by('error'),
    toCopy: toCopyRows.reduce((a, r) => a + r.n, 0),
    toCopyNotOnShow: toCopyRows.filter((r) => r.on_show !== 1).reduce((a, r) => a + r.n, 0),
    queueAhead,
    etaSeconds: queued || fetching ? archiveEtaSeconds(queued ? upTo?.n ?? queued : 0, fetching) : 0,
    requested: !!mine,
    errors: errors.results.map((e) => ({ id: e.id, title: e.title, error: e.archive_error })),
    ...(changed ? { changed: changed.results.map((e) => ({ id: e.id, archiveState: e.archive_state, archiveError: e.archive_error })) } : {}),
  };
}
