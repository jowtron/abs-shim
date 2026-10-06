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
import type { LibraryFolderRow } from '../db/library';
import type { EpisodeRow, PodcastRow } from '../db/podcasts';
import { decodeFeedBytes, episodeKey, parseFeed, type FeedEpisode, type ParsedFeed } from './rss';
import { episodeExt } from './podcast-shapes';
import {
  pcloudDownloadFileAsync, pcloudEnsureFolder, pcloudStat, type PcloudProfile,
} from '../storage/pcloud';

export class PodcastError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ABS's user agent: some hosts (CBC among them) refuse unknown ones, and
// publishers already allow it because ABS polls them.
const FEED_UA = 'audiobookshelf (+https://audiobookshelf.org; like iTMS)';
const FEED_MAX_BYTES = 60 * 1024 * 1024;
const POLL_EVERY_MS = 60 * 60 * 1000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
// What lands on a new show: an episodic feed's newest 100, a serial feed's
// whole run (serial shows are listened to from episode 1). The rest stay
// browsable and can be added.
const INITIAL_EPISODES = 100;
const SERIAL_CAP = 500;
const TICK_FEEDS = 5;
const ARCHIVE_STARTS_PER_TICK = 3;
const ARCHIVE_POLLS_PER_TICK = 10;
const ARCHIVE_GIVE_UP_MS = 6 * 60 * 60 * 1000;
// Raise when the parser starts storing a field older rows lack: each show's
// next poll then re-reads its whole feed once (migration 0018: chapters_url).
const PARSE_VERSION = 1;
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
  const bytes = await res.arrayBuffer();
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
};

function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 100) || 'Podcast';
}

export async function createPodcast(env: Env, a: CreateArgs): Promise<string> {
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
  if (dupe) throw new PodcastError(409, 'Podcast already exists');

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
  const taken = await env.DB.prepare('SELECT rel_path FROM library_items WHERE folder_id = ? AND (rel_path = ? OR rel_path LIKE ?)')
    .bind(folder.id, relPath, relPath + ' (%').all<{ rel_path: string }>();
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
         auto_download, max_new_episodes_to_download, archive, next_check_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      3,
      a.archive ? 1 : 0,
      a.deferFetch ? now : now + POLL_EVERY_MS,
      now, now,
    ),
  ]);

  if (feed) {
    const p = await env.DB.prepare('SELECT * FROM podcasts WHERE library_item_id = ?').bind(itemId).first<PodcastRow>();
    await storeEpisodes(env, p!, feed.episodes, { initial: true });
  }
  return itemId;
}

// ─── Episodes ────────────────────────────────────────────────────────────────

const EP_COLS = `id, library_item_id, tenant_id, ino, guid, idx, season, episode, episode_type, title, subtitle,
  description, pub_date, published_at, enclosure_url, enclosure_type, enclosure_length, duration_seconds,
  chapters, chapters_url, in_library, removed, created_at, updated_at`;

function lengthOf(s: string | null): number | null {
  const n = Number(s);
  return Number.isFinite(n) && n > 1000 ? n : null;
}

// Upsert a parse's episodes. New ones are inserted; a known episode whose
// enclosure URL or text changed is updated (publishers rotate tracking
// prefixes and signed URLs, and a stale URL is an episode that won't play).
// Returns the ids of the rows that are new.
async function upsertEpisodes(env: Env, p: PodcastRow, eps: FeedEpisode[], startIdx: number, now: number): Promise<Array<{ id: string; published_at: number | null }>> {
  const added: Array<{ id: string; published_at: number | null }> = [];
  // Oldest first, so idx increases with publication.
  const ordered = [...eps].sort((x, y) => (x.publishedAt ?? 0) - (y.publishedAt ?? 0));
  const stmts = ordered.map((e, i) => env.DB.prepare(
    `INSERT INTO podcast_episodes (${EP_COLS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
     ON CONFLICT(library_item_id, guid) DO UPDATE SET
       enclosure_url = excluded.enclosure_url, enclosure_type = excluded.enclosure_type,
       enclosure_length = excluded.enclosure_length, title = excluded.title, subtitle = excluded.subtitle,
       description = excluded.description,
       duration_seconds = CASE WHEN excluded.duration_seconds > 0 THEN excluded.duration_seconds ELSE podcast_episodes.duration_seconds END,
       chapters_url = excluded.chapters_url,
       chapters_checked_at = CASE WHEN podcast_episodes.chapters_url IS NOT excluded.chapters_url THEN NULL ELSE podcast_episodes.chapters_checked_at END,
       updated_at = excluded.updated_at
     WHERE podcast_episodes.enclosure_url IS NOT excluded.enclosure_url
        OR podcast_episodes.title IS NOT excluded.title
        OR podcast_episodes.description IS NOT excluded.description
        OR (excluded.duration_seconds > 0 AND podcast_episodes.duration_seconds IS NOT excluded.duration_seconds)
        OR podcast_episodes.chapters_url IS NOT excluded.chapters_url
     RETURNING id, published_at, created_at`,
  ).bind(
    crypto.randomUUID(), p.library_item_id, p.tenant_id, String(Math.floor(Math.random() * 0xffffffff)),
    episodeKey(e), startIdx + i + 1, e.season || null, e.episode || null, e.episodeType || null,
    e.title || null, e.subtitle || null, e.description || null, e.pubDate || null, e.publishedAt,
    e.enclosure.url, e.enclosure.type, lengthOf(e.enclosure.length), e.durationSeconds ?? 0,
    JSON.stringify(e.chapters), e.chaptersUrl, now, now,
  ));
  for (let i = 0; i < stmts.length; i += 100) {
    const res = await env.DB.batch<{ id: string; published_at: number | null; created_at: number }>(stmts.slice(i, i + 100));
    for (const r of res) for (const row of r.results ?? []) if (row.created_at === now) added.push(row);
  }
  return added;
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
  // queued on day one is a job for "archive all", asked for explicitly.
  const archive = !opts.initial && p.archive === 1;
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
         feed_etag = ?, feed_last_modified = ?, last_episode_check = ?, next_check_at = ?,
         check_failures = 0, last_error = NULL, parse_version = ?, updated_at = ?
       WHERE library_item_id = ?`,
    ).bind(
      md.title, md.author, md.description, md.image, md.image, md.language, md.type,
      JSON.stringify(md.categories), JSON.stringify(md.categories), moved,
      got.etag, got.lastModified, now, now + POLL_EVERY_MS, PARSE_VERSION, now, p.library_item_id,
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
    if (added.length) {
      await env.DB.prepare('UPDATE library_items SET updated_at = ? WHERE id = ?').bind(now, p.library_item_id).run();
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
// catalogue's cron), so up to 150 feed checks an hour.
export async function runPodcastTick(env: Env): Promise<string[]> {
  const log: string[] = [];
  const due = await env.DB.prepare(
    'SELECT * FROM podcasts WHERE next_check_at IS NOT NULL AND next_check_at <= ? ORDER BY next_check_at ASC LIMIT ?',
  ).bind(Date.now(), TICK_FEEDS).all<PodcastRow>();
  for (const p of due.results) {
    const r = await refreshPodcast(env, p);
    log.push(`${p.title ?? p.library_item_id}: ${r.error ? 'error ' + r.error : r.notModified ? '304' : `+${r.added.length}`}`);
  }
  log.push(...await archivePump(env));
  log.push(...await chapterPump(env));
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
    const p = await probeMp3(e.enclosure_url, e.size_bytes || undefined);
    return { chapters: p.chapters.map((c, i) => ({ id: i, start: c.start, end: c.end, title: c.title || `Chapter ${i + 1}` })), duration: p.durationSeconds };
  }
  if (ext === 'm4a' || ext === 'mp4' || ext === 'm4b' || ext === 'aac') {
    const { probeM4b } = await import('../prober/m4b');
    const p = await probeM4b(e.enclosure_url);
    const dur = p.durationSeconds ?? e.duration_seconds;
    return {
      chapters: p.chapters.map((c, i, all) => ({ id: i, start: c.start, end: all[i + 1]?.start ?? dur, title: c.title || `Chapter ${i + 1}` })),
      duration: p.durationSeconds ?? null,
    };
  }
  return { chapters: [], duration: null };
}

// Look one episode's chapters up and store them. Chapters already in the
// row (psc:chapters inline in the feed) are kept. A failure is retried the
// next day, an episode without any a week later.
export async function ensureEpisodeChapters(env: Env, e: EpisodeRow): Promise<Chapter[]> {
  const now = Date.now();
  const have = JSON.parse(e.chapters || '[]') as Chapter[];
  let chapters: Chapter[] = have;
  let duration: number | null = null;
  try {
    if (!have.length && e.chapters_url) chapters = await chaptersFromJson(e.chapters_url, e.duration_seconds);
    if (!chapters.length || !e.duration_seconds) {
      const fromAudio = await chaptersFromAudio(e).catch(() => ({ chapters: [] as Chapter[], duration: null }));
      if (!chapters.length) chapters = fromAudio.chapters;
      if (!e.duration_seconds && fromAudio.duration) duration = fromAudio.duration;
    }
    await env.DB.prepare(
      `UPDATE podcast_episodes SET chapters = ?, chapters_checked_at = ?${duration ? ', duration_seconds = ?' : ''} WHERE id = ?`,
    ).bind(JSON.stringify(chapters), now, ...(duration ? [Math.round(duration * 1000) / 1000] : []), e.id).run();
    return chapters;
  } catch (err) {
    await env.DB.prepare('UPDATE podcast_episodes SET chapters_checked_at = ? WHERE id = ?')
      .bind(now - CHAPTERS_RECHECK_MS + 24 * 60 * 60 * 1000, e.id).run();
    console.warn(`[podcasts] chapters for ${e.id}: ${(err as Error).message}`);
    return have;
  }
}

export async function chapterPump(env: Env): Promise<string[]> {
  const due = await env.DB.prepare(
    `SELECT * FROM podcast_episodes
      WHERE in_library = 1 AND (chapters_checked_at IS NULL OR (chapters = '[]' AND chapters_checked_at < ?))
      ORDER BY chapters_checked_at IS NOT NULL, published_at DESC LIMIT ?`,
  ).bind(Date.now() - CHAPTERS_RECHECK_MS, CHAPTERS_PER_TICK).all<EpisodeRow>();
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

type ArchiveRow = EpisodeRow & { folder_id: string; show_path: string };

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

  const queued = await env.DB.prepare(
    `SELECT e.*, li.folder_id, li.rel_path AS show_path FROM podcast_episodes e JOIN library_items li ON li.id = e.library_item_id
      WHERE e.archive_state = 'queued' ORDER BY e.updated_at ASC LIMIT ?`,
  ).bind(ARCHIVE_STARTS_PER_TICK).all<ArchiveRow>();
  for (const e of queued.results) {
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
        await env.DB.prepare(
          `UPDATE podcast_episodes SET archive_state = 'done', archive_rel_path = ?, size_bytes = ?, archive_error = NULL, updated_at = ? WHERE id = ?`,
        ).bind(rel, existing.size, Date.now(), e.id).run();
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
      // With the source's size known, done is "pCloud has all of it". Without
      // it, done is a size that hasn't moved between two ticks (2+ minutes).
      const done = e.archive_expected_size
        ? size >= e.archive_expected_size
        : size > 0 && size === e.archive_seen_size && now - (e.archive_started_at ?? now) > 2 * 60 * 1000;
      if (done) {
        await env.DB.prepare(
          `UPDATE podcast_episodes SET archive_state = 'done', size_bytes = ?, archive_error = NULL, updated_at = ? WHERE id = ?`,
        ).bind(size, Date.now(), e.id).run();
        log.push(`archive ${e.archive_rel_path}: done`);
      } else if (now - (e.archive_started_at ?? now) > ARCHIVE_GIVE_UP_MS) {
        await fail(e, `pCloud stopped at ${size} bytes${e.archive_expected_size ? ` of ${e.archive_expected_size}` : ''}`);
      } else {
        await env.DB.prepare('UPDATE podcast_episodes SET archive_seen_size = ? WHERE id = ?').bind(size, e.id).run();
      }
    } catch (err) {
      log.push(`archive poll ${e.id}: ${(err as Error).message}`);
    }
  }
  return log;
}
