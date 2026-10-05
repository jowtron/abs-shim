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

export async function itunesSearch(term: string, country = 'us', limit = 25): Promise<ItunesPodcast[]> {
  const q = new URLSearchParams({ term, entity: 'podcast', media: 'podcast', country, limit: String(limit) });
  const res = await fetch(`https://itunes.apple.com/search?${q}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new PodcastError(502, `iTunes search answered HTTP ${res.status}`);
  const data = await res.json() as { results?: ItunesRaw[] };
  // Results without a feed URL can't be subscribed to (Apple-only shows).
  return (data.results ?? []).filter((r) => r.feedUrl).map(cleanItunes);
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
  chapters, in_library, removed, created_at, updated_at`;

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
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
     ON CONFLICT(library_item_id, guid) DO UPDATE SET
       enclosure_url = excluded.enclosure_url, enclosure_type = excluded.enclosure_type,
       enclosure_length = excluded.enclosure_length, title = excluded.title, subtitle = excluded.subtitle,
       description = excluded.description, duration_seconds = excluded.duration_seconds, updated_at = excluded.updated_at
     WHERE podcast_episodes.enclosure_url IS NOT excluded.enclosure_url
        OR podcast_episodes.title IS NOT excluded.title
        OR podcast_episodes.description IS NOT excluded.description
        OR podcast_episodes.duration_seconds IS NOT excluded.duration_seconds
     RETURNING id, published_at, created_at`,
  ).bind(
    crypto.randomUUID(), p.library_item_id, p.tenant_id, String(Math.floor(Math.random() * 0xffffffff)),
    episodeKey(e), startIdx + i + 1, e.season || null, e.episode || null, e.episodeType || null,
    e.title || null, e.subtitle || null, e.description || null, e.pubDate || null, e.publishedAt,
    e.enclosure.url, e.enclosure.type, lengthOf(e.enclosure.length), e.durationSeconds ?? 0,
    JSON.stringify(e.chapters), now, now,
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
  try {
    const got = await fetchFeed(p.feed_url, opts.force || firstFill ? undefined : { etag: p.feed_etag, lastModified: p.feed_last_modified });
    if (got.notModified) {
      await env.DB.prepare(
        'UPDATE podcasts SET last_episode_check = ?, next_check_at = ?, check_failures = 0, last_error = NULL WHERE library_item_id = ?',
      ).bind(now, now + POLL_EVERY_MS, p.library_item_id).run();
      return { notModified: true, added: [] };
    }
    const known = new Set((await env.DB.prepare(
      'SELECT guid FROM podcast_episodes WHERE library_item_id = ? ORDER BY published_at DESC LIMIT 30',
    ).bind(p.library_item_id).all<{ guid: string }>()).results.map((r) => r.guid));
    const feed = parseFeed(got.xml, firstFill ? {} : { known, stopAfterKnown: 5 });
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
         check_failures = 0, last_error = NULL, updated_at = ?
       WHERE library_item_id = ?`,
    ).bind(
      md.title, md.author, md.description, md.image, md.image, md.language, md.type,
      JSON.stringify(md.categories), JSON.stringify(md.categories), moved,
      got.etag, got.lastModified, now, now + POLL_EVERY_MS, now, p.library_item_id,
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
  return log;
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
