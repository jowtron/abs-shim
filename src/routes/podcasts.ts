import { Hono, type Context } from 'hono';
import type { Env } from '../types';
import { canAddBooks, requireAuth, requireCanAdd, requireTenantOwner, type AuthVars } from '../auth/middleware';
import { getFolderById, getItem, type LibraryFolderRow, type LibraryItemRow } from '../db/library';
import { getEpisode, getPodcast, listShowEpisodes, type EpisodeRow, type PodcastRow } from '../db/podcasts';
import { progressForShows } from '../db/progress';
import { followInfo, followShow, hideEpisode, hiddenAmong, unfollowShow, unhideEpisodes } from '../db/podcast-follows';
import { resolveLibraryScope } from '../db/library-views';
import { buildEpisode, buildEpisodeExpanded, buildPodcastItemExpanded, hasDynamicAds } from '../lib/podcast-shapes';
import {
  archivePump, canArchive, createPodcast, ensureEpisodeChapters, episodeTranscript, fetchAndParse, PodcastError, refreshPodcast, searchPodcasts, validFeedUrl,
} from '../lib/podcasts';
import { AnalysisInputError, analysisOrigin, analysisPump, analysisStatus, queueAnalysis, storeResult, waitsForArchive } from '../lib/episode-analysis';
import { wharfConfigured } from '../lib/wharf';
import { parseOpml, sanitizeHtml, type TranscriptLink } from '../lib/rss';

// ABS's podcast routes (server/routers/ApiRouter.js "Podcast Routes"), plus a
// few shim-only ones marked as such. ABS gates writes on admin. Here a
// podcast list is personal (migration 0028): subscribing (to a new feed or
// one the library already has, OPML too), following, unfollowing and hiding
// or unhiding episodes are open to any member of the tenant. What changes a
// show for everyone (archiving, analysis, editing, ABS's download routes)
// takes the same tier as adding books (requireCanAdd); reads are open to
// anyone in the tenant.

type C = Context<{ Bindings: Env; Variables: AuthVars }>;

export const podcastRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>();
podcastRoutes.use('*', requireAuth);

function fail(c: C, e: unknown) {
  if (e instanceof PodcastError) return c.json({ error: e.message }, e.status as 400);
  throw e;
}

// POST /api/podcasts — ABS's create body is {path, folderId, libraryId,
// media: {metadata: {...feedUrl...}, autoDownloadEpisodes}}. `path` is a
// filesystem path in ABS; here the show's folder is named from its title,
// so it is ignored. Shim extra: media.archive (canAdd only: it spends the
// library's pCloud). A feed the library already has is followed instead
// (createPodcast): no fetch, and the answer is that show's item, as a
// create's would be, with the shim extra `followedExisting: true`. Any
// member: a podcast list is personal. Shim extra `follow: false` (top
// level): store the show to look at without following it (Pholia opens a
// podcast-directory result this way; createPodcast's `follow`), or answer
// the stored one; `followedExisting` is then false.
podcastRoutes.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const media = (body['media'] ?? {}) as Record<string, unknown>;
  const metadata = (media['metadata'] ?? {}) as Record<string, unknown>;
  const feedUrl = validFeedUrl(metadata['feedUrl'] ?? body['feedUrl']);
  if (!feedUrl) return c.json({ error: 'media.metadata.feedUrl must be an http(s) URL' }, 400);
  const libraryId = String(body['libraryId'] ?? '');
  if (!libraryId) return c.json({ error: 'libraryId required' }, 400);
  const tenantId = c.get('tenantId');
  const follow = body['follow'] !== false;
  try {
    const r = await createPodcast(c.env, {
      tenantId, userId: c.get('userId'), libraryId, feedUrl, metadata,
      folderId: typeof body['folderId'] === 'string' ? body['folderId'] : null,
      autoDownload: media['autoDownloadEpisodes'] !== false,
      archive: media['archive'] === true && await canAddBooks(c),
      follow,
    });
    return c.json({ ...await expandedItem(c, r.itemId), followedExisting: r.existing && follow });
  } catch (e) { return fail(c, e); }
});

// POST /api/podcasts/feed {rssFeed} → {podcast: {metadata, episodes}}, the
// parsed feed as ABS's podcastUtils returns it.
// canAdd: it makes the Worker fetch any URL a member names.
podcastRoutes.post('/feed', requireCanAdd, async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const url = validFeedUrl(body['rssFeed']);
  if (!url) return c.json({ error: '"rssFeed" must be a valid URL' }, 400);
  try {
    const feed = await fetchAndParse(url);
    return c.json({ podcast: { metadata: { ...feed.metadata, feedUrl: url }, episodes: feed.episodes } });
  } catch (e) { return fail(c, e); }
});

podcastRoutes.post('/opml/parse', async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof body['opmlText'] !== 'string') return c.json({ error: 'opmlText required' }, 400);
  return c.json({ feeds: parseOpml(body['opmlText']) });
});

// Bulk subscribe. Each show is inserted without fetching its feed; the cron
// poller fills them (5 feeds per 2-minute tick), so a big OPML file doesn't
// try to fetch every feed inside one request. A feed the library already
// has is followed (`followed`); one the caller already follows is skipped.
podcastRoutes.post('/opml/create', async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const feeds = Array.isArray(body['feeds']) ? body['feeds'] : [];
  const libraryId = String(body['libraryId'] ?? '');
  if (!feeds.length || !libraryId) return c.json({ error: 'feeds and libraryId required' }, 400);
  const created: string[] = [];
  let followed = 0;
  const skipped: Array<{ feedUrl: string; reason: string }> = [];
  for (const f of feeds) {
    const raw = typeof f === 'string' ? f : (f as Record<string, unknown>)?.['feedUrl'];
    const title = typeof f === 'object' && f ? String((f as Record<string, unknown>)['title'] ?? '') : '';
    const url = validFeedUrl(raw);
    if (!url) { skipped.push({ feedUrl: String(raw), reason: 'not a URL' }); continue; }
    try {
      const r = await createPodcast(c.env, {
        tenantId: c.get('tenantId'), userId: c.get('userId'), libraryId, feedUrl: url, deferFetch: true, titleHint: title || undefined,
        folderId: typeof body['folderId'] === 'string' ? body['folderId'] : null,
        autoDownload: body['autoDownloadEpisodes'] !== false,
      } as Parameters<typeof createPodcast>[1]);
      if (!r.existing) created.push(r.itemId);
      else if (r.followed) followed++;
      else skipped.push({ feedUrl: url, reason: 'Already following' });
    } catch (e) {
      if (!(e instanceof PodcastError)) throw e;
      skipped.push({ feedUrl: url, reason: e.message });
    }
  }
  return c.json({ created: created.length, followed, skipped });
});

// GET /api/podcasts/shows?libraryId= — shim-only. Every show stored in a
// podcast library, followed by the caller or not, for Pholia's "On this
// server" list: {shows: [{id, title, author, feedUrl, numEpisodes,
// following, followers}]}. Covers come from /api/items/:id/cover as usual.
// Not a show someone only looked at (`previewed_at`, migration 0033): a
// stranger's browsing isn't a recommendation.
podcastRoutes.get('/shows', async (c) => {
  const tenantId = c.get('tenantId');
  const scope = await resolveLibraryScope(c.env, c.req.query('libraryId') ?? '', tenantId);
  if (!scope) return c.json({ error: 'Library not found' }, 404);
  if (scope.library.media_type !== 'podcast') return c.json({ error: 'Not a podcast library' }, 400);
  const view = scope.filter('li.');
  const r = await c.env.DB.prepare(
    `SELECT p.library_item_id AS id, p.title, p.author, p.feed_url,
            (SELECT COUNT(*) FROM podcast_episodes e WHERE e.library_item_id = p.library_item_id AND e.in_library = 1) AS num_episodes,
            (SELECT COUNT(*) FROM podcast_follows f WHERE f.library_item_id = p.library_item_id) AS followers,
            EXISTS (SELECT 1 FROM podcast_follows f WHERE f.user_id = ? AND f.library_item_id = p.library_item_id) AS following
       FROM podcasts p JOIN library_items li ON li.id = p.library_item_id
      WHERE li.library_id = ? AND p.tenant_id = ? AND p.previewed_at IS NULL${view.sql}
      ORDER BY p.title COLLATE NOCASE`,
  ).bind(c.get('userId'), scope.library.id, tenantId, ...view.binds).all<{
    id: string; title: string | null; author: string | null; feed_url: string; num_episodes: number; followers: number; following: number;
  }>();
  return c.json({
    shows: r.results.map((p) => ({
      id: p.id, title: p.title, author: p.author, feedUrl: p.feed_url,
      numEpisodes: p.num_episodes, following: p.following === 1, followers: p.followers,
    })),
  });
});

// ─── Per-show routes ─────────────────────────────────────────────────────────

type Show = { item: LibraryItemRow; folder: LibraryFolderRow; podcast: PodcastRow };

async function loadShow(c: C): Promise<Show | null> {
  const tenantId = c.get('tenantId');
  const item = await getItem(c.env, c.req.param('id')!, tenantId);
  if (!item || item.media_type !== 'podcast') return null;
  const [folder, podcast] = await Promise.all([getFolderById(c.env, item.folder_id, tenantId), getPodcast(c.env, item.id, tenantId)]);
  return folder && podcast ? { item, folder, podcast } : null;
}

// The show as the caller sees it: without the episodes they hid, with their
// follow and the follower count.
async function expandedItem(c: C, itemId: string) {
  const tenantId = c.get('tenantId');
  const userId = c.get('userId');
  const item = (await getItem(c.env, itemId, tenantId))!;
  const [folder, podcast, episodes, follow] = await Promise.all([
    getFolderById(c.env, item.folder_id, tenantId), getPodcast(c.env, itemId, tenantId), listShowEpisodes(c.env, itemId, tenantId, userId),
    followInfo(c.env, userId, [itemId]),
  ]);
  return buildPodcastItemExpanded(item, folder!, podcast!, episodes, { follow: follow.get(itemId)! });
}

// PUT /api/podcasts/:id/follow {follow} → {following, followers} — shim-only.
// Any member of the show's tenant; idempotent. Unfollowing also turns the
// caller's bell for the show off (unfollowShow). The show itself is never
// touched: only the owner's DELETE /api/admin/items/:id removes it.
podcastRoutes.put('/:id/follow', async (c) => {
  const show = await loadShow(c);
  if (!show) return c.json({ error: 'Podcast not found' }, 404);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof body['follow'] !== 'boolean') return c.json({ error: 'follow must be true or false' }, 400);
  const userId = c.get('userId');
  if (body['follow']) await followShow(c.env, userId, show.item.id, show.item.tenant_id);
  else await unfollowShow(c.env, userId, show.item.id);
  return c.json((await followInfo(c.env, userId, [show.item.id])).get(show.item.id)!);
});

// GET /api/podcasts/:id/checknew?limit=3 — poll the feed now. Returns the
// episodes that landed on the show. canAdd: a follow needs no catch-up call
// (followShow makes an idle show's feed due at the next tick).
podcastRoutes.get('/:id/checknew', requireCanAdd, async (c) => {
  const show = await loadShow(c);
  if (!show) return c.json({ error: 'Podcast not found' }, 404);
  const r = await refreshPodcast(c.env, show.podcast, { force: true });
  if (r.error) return c.json({ error: r.error }, 502);
  const eps = await Promise.all(r.added.map((id) => getEpisode(c.env, show.item.id, id, c.get('tenantId'))));
  return c.json({ episodes: await Promise.all(eps.filter((e): e is EpisodeRow => !!e).map((e) => buildEpisodeExpanded(e, show.item, show.folder))) });
});

// The "download queue" is the archive queue: in ABS a download is the
// server copying the episode, which is what archiving is.
podcastRoutes.get('/:id/downloads', async (c) => {
  const show = await loadShow(c);
  if (!show) return c.json({ error: 'Podcast not found' }, 404);
  const rows = await c.env.DB.prepare(
    `SELECT * FROM podcast_episodes WHERE library_item_id = ? AND archive_state IN ('queued', 'fetching') ORDER BY updated_at ASC`,
  ).bind(show.item.id).all<EpisodeRow>();
  return c.json({ downloads: rows.results.map((e) => downloadJson(e, show)) });
});

export function downloadJson(e: EpisodeRow, show: { item: LibraryItemRow; podcast: PodcastRow }) {
  return {
    id: e.id,
    episodeDisplayTitle: e.title,
    url: e.enclosure_url,
    libraryItemId: show.item.id,
    libraryId: show.item.library_id,
    isFinished: false,
    failed: false,
    appendRandomId: false,
    startedAt: e.archive_state === 'fetching' ? e.archive_started_at : null,
    createdAt: e.updated_at,
    finishedAt: null,
    podcastTitle: show.podcast.title,
    podcastExplicit: show.podcast.explicit === 1,
    season: e.season,
    episode: e.episode,
    episodeType: e.episode_type,
    publishedAt: e.published_at,
  };
}

podcastRoutes.get('/:id/clear-queue', requireCanAdd, async (c) => {
  const show = await loadShow(c);
  if (!show) return c.json({ error: 'Podcast not found' }, 404);
  await c.env.DB.prepare(
    "UPDATE podcast_episodes SET archive_state = NULL WHERE library_item_id = ? AND archive_state = 'queued'",
  ).bind(show.item.id).run();
  return c.body(null, 200);
});

// GET /api/podcasts/:id/search-episode?title= — ABS fuzzy-matches the live
// feed; we match the stored copy of it (every episode the feed has listed).
podcastRoutes.get('/:id/search-episode', async (c) => {
  const show = await loadShow(c);
  if (!show) return c.json({ error: 'Podcast not found' }, 404);
  const title = (c.req.query('title') ?? '').trim();
  if (!title) return c.json({ episodes: [] });
  const pattern = '%' + title.replace(/[\\%_]/g, (ch) => '\\' + ch).toLowerCase() + '%';
  const rows = await c.env.DB.prepare(
    `SELECT * FROM podcast_episodes WHERE library_item_id = ? AND (lower(COALESCE(title, '')) LIKE ? ESCAPE '\\' OR lower(COALESCE(subtitle, '')) LIKE ? ESCAPE '\\')
      ORDER BY published_at DESC LIMIT 25`,
  ).bind(show.item.id, pattern, pattern).all<EpisodeRow>();
  return c.json({ episodes: rows.results.map((e) => ({ episode: feedEpisodeJson(e) })) });
});

// An episode in the shape /podcasts/feed returns it (podcastUtils'
// cleanEpisodeData), which is what clients hand back to download-episodes.
function feedEpisodeJson(e: EpisodeRow) {
  return {
    title: e.title ?? '',
    subtitle: e.subtitle ?? '',
    description: e.description ?? '',
    descriptionPlain: '',
    pubDate: e.pub_date ?? '',
    episodeType: e.episode_type ?? '',
    season: e.season ?? '',
    episode: e.episode ?? '',
    author: '',
    duration: '',
    durationSeconds: e.duration_seconds || null,
    explicit: '',
    publishedAt: e.published_at,
    enclosure: { url: e.enclosure_url, type: e.enclosure_type, length: e.enclosure_length != null ? String(e.enclosure_length) : null },
    guid: e.guid,
    chaptersUrl: null,
    chaptersType: null,
    chapters: JSON.parse(e.chapters || '[]') as unknown[],
    transcripts: JSON.parse(e.transcripts || '[]') as TranscriptLink[],
  };
}

// POST /api/podcasts/:id/download-episodes [feed episodes] — put them on the
// show (matched by guid, then enclosure URL), and queue them for archiving
// when the show archives.
podcastRoutes.post('/:id/download-episodes', requireCanAdd, async (c) => {
  const show = await loadShow(c);
  if (!show) return c.json({ error: 'Podcast not found' }, 404);
  const body = await c.req.json().catch(() => null);
  if (!Array.isArray(body) || !body.length) return c.json({ error: 'Body must be a non-empty array of episodes' }, 400);
  const ids: string[] = [];
  for (const raw of body as Array<Record<string, unknown>>) {
    const guid = typeof raw['guid'] === 'string' ? raw['guid'] : null;
    const id = typeof raw['id'] === 'string' ? raw['id'] : null;
    const url = typeof (raw['enclosure'] as Record<string, unknown> | undefined)?.['url'] === 'string'
      ? (raw['enclosure'] as Record<string, string>)['url'] : null;
    const row = await c.env.DB.prepare(
      `SELECT id FROM podcast_episodes WHERE library_item_id = ? AND (id = ? OR guid = ? OR guid = ? OR enclosure_url = ?) LIMIT 1`,
    ).bind(show.item.id, id, guid, url, url).first<{ id: string }>();
    if (row) ids.push(row.id);
  }
  await addToShow(c.env, show, ids, show.podcast.archive === 1);
  return c.json({ added: ids.length });
});

async function addToShow(env: Env, show: Show, ids: string[], archive: boolean) {
  const queue = archive && await canArchive(env, show.folder);
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    await env.DB.prepare(
      `UPDATE podcast_episodes SET in_library = 1, removed = 0, updated_at = ?${queue ? ", archive_state = CASE WHEN archive_state IS NULL OR archive_state = 'error' THEN 'queued' ELSE archive_state END" : ''}
        WHERE library_item_id = ? AND id IN (${part.map(() => '?').join(',')})`,
    ).bind(Date.now(), show.item.id, ...part).run();
  }
}

podcastRoutes.post('/:id/match-episodes', requireCanAdd, (c) => c.json({ numEpisodesUpdated: 0 }));

podcastRoutes.get('/:id/episode/:episodeId', async (c) => {
  const show = await loadShow(c);
  if (!show) return c.json({ error: 'Podcast not found' }, 404);
  const e = await getEpisode(c.env, show.item.id, c.req.param('episodeId'), c.get('tenantId'));
  if (!e) return c.json({ error: 'Episode not found' }, 404);
  // The whole notes: lists carry a snippet (notesForList), and Pholia's
  // episode page asks here for the rest. Answered even when hidden (a link
  // never 404s); `hidden` (shim extra) says so, for "Show again".
  const hidden = await hiddenAmong(c.env, c.get('userId'), [e.id]);
  return c.json({ ...await buildEpisode(e, show.item, { fullNotes: true }), hidden: hidden.has(e.id) });
});

// GET /api/podcasts/:id/episode/:episodeId/transcript — shim-only. The
// episode's transcript as {format:'cues', cues:[{start,end,speaker,text}]}
// (timed, joined into paragraphs) or {format:'text', paragraphs:[...]},
// whatever the publisher's file format. 404 when the feed lists none, 502
// when none of the listed files could be read.
podcastRoutes.get('/:id/episode/:episodeId/transcript', async (c) => {
  const show = await loadShow(c);
  if (!show) return c.json({ error: 'Podcast not found' }, 404);
  const e = await getEpisode(c.env, show.item.id, c.req.param('episodeId'), c.get('tenantId'));
  if (!e) return c.json({ error: 'Episode not found' }, 404);
  try {
    return c.json(await episodeTranscript(c.env, e), 200, { 'Cache-Control': 'private, max-age=3600' });
  } catch (err) { return fail(c, err); }
});

// ─── Episode analysis (src/lib/episode-analysis.ts) ──────────────────────────

// GET …/analysis — shim-only. Where the episode's analysis stands: `state`
// (queued | running | done | error, or null) for the file served now, the
// rows kept (newest two stitches), and the `analysis` field episodes carry.
podcastRoutes.get('/:id/episode/:episodeId/analysis', async (c) => {
  const show = await loadShow(c);
  if (!show) return c.json({ error: 'Podcast not found' }, 404);
  const e = await getEpisode(c.env, show.item.id, c.req.param('episodeId'), c.get('tenantId'));
  if (!e) return c.json({ error: 'Episode not found' }, 404);
  return c.json(await analysisStatus(c.env, e));
});

// POST …/analysis — the node's result (the job's own output, pushed with the
// 2-hour owner token the job was given). Stored under the size the node
// measured. canAdd, not merely a member: it decides what every listener
// skips.
podcastRoutes.post('/:id/episode/:episodeId/analysis', requireCanAdd, async (c) => {
  const show = await loadShow(c);
  if (!show) return c.json({ error: 'Podcast not found' }, 404);
  const e = await getEpisode(c.env, show.item.id, c.req.param('episodeId'), c.get('tenantId'));
  if (!e) return c.json({ error: 'Episode not found' }, 404);
  const body = await c.req.json().catch(() => null);
  try {
    const r = await storeResult(c.env, e, body);
    // The Mac is free: start the next one now rather than at the next tick.
    c.executionCtx.waitUntil(analysisPump(c.env, { origin: analysisOrigin(c.env, c.req.url) }).then(() => undefined, () => undefined));
    return c.json({ ok: true, size: r.size, current: r.current, state: 'done' });
  } catch (err) {
    if (err instanceof AnalysisInputError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

// POST …/analysis/run — shim-only "Analyse now": queue the stitch served now
// (again, if done or failed) and start it at once if the Mac is free.
podcastRoutes.post('/:id/episode/:episodeId/analysis/run', requireCanAdd, async (c) => {
  if (!wharfConfigured(c.env)) return c.json({ error: 'Episode analysis is not configured on this shim (needs the wharf-router binding and ROUTER_TOKEN)' }, 503);
  const show = await loadShow(c);
  if (!show) return c.json({ error: 'Podcast not found' }, 404);
  const tenantId = c.get('tenantId');
  let e = await getEpisode(c.env, show.item.id, c.req.param('episodeId'), tenantId);
  if (!e) return c.json({ error: 'Episode not found' }, 404);
  // The job is told whether the publisher has chapters; look them up first
  // if the chapter pump hasn't yet.
  if (e.chapters_checked_at == null) {
    await ensureEpisodeChapters(c.env, e);
    e = (await getEpisode(c.env, show.item.id, e.id, tenantId)) ?? e;
  }
  // An ad-inserting host: archive it first when the show can, and the pump
  // holds the analysis until the pCloud copy lands (waitsForArchive), so it
  // describes a file that never changes. The answer then carries
  // waitingFor: 'archive'.
  if (hasDynamicAds(e.enclosure_url) && e.archive_state !== 'done' && await canArchive(c.env, show.folder)) {
    await queueArchive(c.env, show.item.id, [e.id]);
    e = (await getEpisode(c.env, show.item.id, e.id, tenantId)) ?? e;
  }
  await queueAnalysis(c.env, e);
  if (waitsForArchive(e)) c.executionCtx.waitUntil(archivePump(c.env).then(() => undefined, () => undefined));
  c.executionCtx.waitUntil(analysisPump(c.env, { origin: analysisOrigin(c.env, c.req.url) }).then(() => undefined, () => undefined));
  return c.json(await analysisStatus(c.env, e));
});

podcastRoutes.patch('/:id/episode/:episodeId', requireCanAdd, async (c) => {
  const show = await loadShow(c);
  if (!show) return c.json({ error: 'Podcast not found' }, 404);
  const e = await getEpisode(c.env, show.item.id, c.req.param('episodeId'), c.get('tenantId'));
  if (!e) return c.json({ error: 'Episode not found' }, 404);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const cols: Record<string, string> = {
    title: 'title', subtitle: 'subtitle', description: 'description', pubDate: 'pub_date',
    episode: 'episode', season: 'season', episodeType: 'episode_type',
  };
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const [k, col] of Object.entries(cols)) {
    if (typeof body[k] !== 'string') continue;
    // The bundled ABS web UI renders these as HTML on this origin, where
    // /admin's cookie lives, so a member's edit is cleaned like a feed's.
    const v = k === 'description' || k === 'subtitle' ? sanitizeHtml(body[k]) : body[k].replace(/<[^>]*>/g, '');
    sets.push(`${col} = ?`); binds.push(v);
  }
  if (typeof body['publishedAt'] === 'number') { sets.push('published_at = ?'); binds.push(body['publishedAt']); }
  if (sets.length) {
    await c.env.DB.prepare(`UPDATE podcast_episodes SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
      .bind(...binds, Date.now(), e.id).run();
  }
  return c.json(await expandedItem(c, show.item.id));
});

// ABS's remove-episode is "Hide episode", per person (migration 0028): the
// episode leaves the CALLER's lists (show page, Latest, shelves, search,
// smart playlists) and nothing else changes: everyone else still has it,
// and the caller's own progress is kept. Any member. It comes back with
// episodes/add or by playing it. Answers the show as the caller now sees it.
//
// ?hard=1 is the old show-wide removal, owner-only since it changes the show
// for everyone: off the show, flagged so the poller never re-adds it, and an
// archived copy deleted from pCloud (never the publisher's).
podcastRoutes.delete('/:id/episode/:episodeId', async (c, next) => {
  if (c.req.query('hard') === '1') return requireTenantOwner(c, next);
  return next();
}, async (c) => {
  const show = await loadShow(c);
  if (!show) return c.json({ error: 'Podcast not found' }, 404);
  const e = await getEpisode(c.env, show.item.id, c.req.param('episodeId'), c.get('tenantId'));
  if (!e) return c.json({ error: 'Episode not found' }, 404);
  if (c.req.query('hard') !== '1') {
    await hideEpisode(c.env, c.get('userId'), show.item.id, e.id);
    return c.json(await expandedItem(c, show.item.id));
  }
  let archiveDeleted = false;
  if (e.archive_state === 'done' && e.archive_rel_path) {
    const { pcloudDeleteFile } = await import('../storage/pcloud');
    const row = await c.env.DB.prepare('SELECT access_token, api_host FROM oauth_profiles WHERE id = ? AND tenant_id = ?')
      .bind(show.folder.profile_id ?? '', show.folder.tenant_id).first<{ access_token: string; api_host: string | null }>();
    if (row) {
      const root = (JSON.parse(show.folder.config_json ?? '{}') as { rootPath?: string }).rootPath ?? '/';
      await pcloudDeleteFile({ accessToken: row.access_token, apiHost: row.api_host ?? 'api.pcloud.com' },
        (root.replace(/\/+$/, '') || '') + '/' + e.archive_rel_path);
      archiveDeleted = true;
    }
  }
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE podcast_episodes SET in_library = 0, removed = 1, updated_at = ?${archiveDeleted ? ", archive_state = NULL, archive_rel_path = NULL, size_bytes = 0" : ''} WHERE id = ?`,
    ).bind(Date.now(), e.id),
    // Only the caller's progress: the removal is show-wide, but another
    // member's half-listened episode isn't the owner's to wipe.
    c.env.DB.prepare('DELETE FROM media_progress WHERE user_id = ? AND library_item_id = ? AND episode_id = ?').bind(c.get('userId'), show.item.id, e.id),
  ]);
  return c.json(await expandedItem(c, show.item.id));
});

// ─── Shim-only ───────────────────────────────────────────────────────────────

// GET /api/podcasts/:id/all-episodes?limit=50&offset=0&q= — every episode
// the feed has listed, on the show or not, newest first. The show itself
// carries only its in_library episodes (see migration 0016).
podcastRoutes.get('/:id/all-episodes', async (c) => {
  const show = await loadShow(c);
  if (!show) return c.json({ error: 'Podcast not found' }, 404);
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? '50') || 50, 1), 200);
  const offset = Math.max(Number(c.req.query('offset') ?? '0') || 0, 0);
  const q = (c.req.query('q') ?? '').trim();
  const pattern = q ? '%' + q.replace(/[\\%_]/g, (ch) => '\\' + ch).toLowerCase() + '%' : null;
  const where = `library_item_id = ?${pattern ? " AND lower(COALESCE(title, '')) LIKE ? ESCAPE '\\'" : ''}`;
  const binds = pattern ? [show.item.id, pattern] : [show.item.id];
  const sort = c.req.query('sort') === 'oldest' ? 'ASC' : 'DESC';
  const [rows, total] = await Promise.all([
    c.env.DB.prepare(`SELECT * FROM podcast_episodes WHERE ${where} ORDER BY published_at ${sort}, idx ${sort} LIMIT ? OFFSET ?`)
      .bind(...binds, limit, offset).all<EpisodeRow>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM podcast_episodes WHERE ${where}`).bind(...binds).first<{ n: number }>(),
  ]);
  const [progress, hidden] = await Promise.all([
    progressForShows(c.env, c.get('userId'), [show.item.id]),
    hiddenAmong(c.env, c.get('userId'), rows.results.map((e) => e.id)),
  ]);
  const episodes = await Promise.all(rows.results.map(async (e) => ({
    ...await buildEpisodeExpanded(e, show.item, show.folder, { progress }),
    inLibrary: e.in_library === 1,
    removed: e.removed === 1,
    // Hidden by the caller (migration 0028): Pholia offers "Show again".
    hidden: hidden.has(e.id),
  })));
  return c.json({ total: total?.n ?? 0, limit, offset, episodes });
});

// POST /api/podcasts/:id/episodes/add {episodeIds} — shim-only add by id,
// and the way back from "Hide episode" (Pholia's "Show again"): each one is
// unhidden for the caller. canAdd also puts them on the show (for everyone,
// archiving them on an archived show) as before. Any other member may call
// it only when every episode asked for is one they hid, and then it only
// unhides: putting an episode on the show changes it for everyone.
podcastRoutes.post('/:id/episodes/add', async (c) => {
  const show = await loadShow(c);
  if (!show) return c.json({ error: 'Podcast not found' }, 404);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const ids = [...new Set(Array.isArray(body['episodeIds']) ? (body['episodeIds'] as unknown[]).filter((x): x is string => typeof x === 'string') : [])];
  if (!ids.length) return c.json({ error: 'episodeIds required' }, 400);
  const userId = c.get('userId');
  if (await canAddBooks(c)) {
    await unhideEpisodes(c.env, userId, ids);
    await addToShow(c.env, show, ids, show.podcast.archive === 1);
  } else {
    const hidden = await hiddenAmong(c.env, userId, ids);
    if (ids.some((id) => !hidden.has(id))) {
      return c.json({ error: 'The library owner has not enabled adding episodes for members (only your hidden episodes can be shown again)' }, 403);
    }
    await unhideEpisodes(c.env, userId, ids);
  }
  return c.json(await expandedItem(c, show.item.id));
});

// POST /api/podcasts/:id/archive {episodeIds?} — queue episodes for copying
// into the library's storage: the given ones, or every episode on the show
// that isn't archived yet.
podcastRoutes.post('/:id/archive', requireCanAdd, async (c) => {
  const show = await loadShow(c);
  if (!show) return c.json({ error: 'Podcast not found' }, 404);
  if (!await canArchive(c.env, show.folder)) return c.json({ error: 'Archiving needs this library to be on pCloud' }, 400);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const ids = Array.isArray(body['episodeIds']) ? (body['episodeIds'] as unknown[]).filter((x): x is string => typeof x === 'string') : null;
  let n = 0;
  if (ids?.length) {
    n = await queueArchive(c.env, show.item.id, ids);
  } else {
    const r = await c.env.DB.prepare(
      `UPDATE podcast_episodes SET archive_state = 'queued', archive_error = NULL, updated_at = ?
        WHERE library_item_id = ? AND in_library = 1 AND (archive_state IS NULL OR archive_state = 'error')`,
    ).bind(Date.now(), show.item.id).run();
    n = r.meta.changes ?? 0;
  }
  // Start the copies now rather than at the next cron tick (up to 2 min);
  // the cron still notices when pCloud has finished.
  if (n) c.executionCtx.waitUntil(archivePump(c.env).then(() => undefined, () => undefined));
  return c.json({ queued: n });
});

// Queue these episodes for archiving, putting them on the show; one already
// queued, fetching or done is left alone, a failed one is tried again. The
// archive route's {episodeIds}, and "Analyse now" on an ad-inserting host.
// The caller has checked canArchive. Returns how many were queued.
async function queueArchive(env: Env, showItemId: string, ids: string[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const r = await env.DB.prepare(
      `UPDATE podcast_episodes SET in_library = 1, removed = 0, archive_state = 'queued', archive_error = NULL, updated_at = ?
        WHERE library_item_id = ? AND (archive_state IS NULL OR archive_state = 'error') AND id IN (${part.map(() => '?').join(',')})`,
    ).bind(Date.now(), showItemId, ...part).run();
    n += r.meta.changes ?? 0;
  }
  return n;
}

// ─── Search ──────────────────────────────────────────────────────────────────

// GET /api/search/podcast?term=&country= — mounted at /api/search by index.ts.
export const podcastSearchRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>();
podcastSearchRoutes.use('*', requireAuth);
podcastSearchRoutes.get('/podcast', async (c) => {
  const term = (c.req.query('term') ?? '').trim();
  if (!term) return c.json([]);
  // A pasted feed URL is answered with that feed, so one search box covers
  // both "find a show" and "I have its RSS link".
  const url = /^https?:\/\//i.test(term) ? validFeedUrl(term) : null;
  try {
    if (url) {
      const feed = await fetchAndParse(url);
      const m = feed.metadata;
      return c.json([{
        id: null, artistId: null, title: m.title ?? url, artistName: m.author ?? '', description: m.description ?? '',
        descriptionPlain: m.descriptionPlain ?? '', releaseDate: m.pubDate ?? '', genres: m.categories, cover: m.image ?? '',
        trackCount: feed.episodes.length, feedUrl: url, pageUrl: m.link ?? '', explicit: /^(yes|true|explicit)$/i.test(m.explicit ?? ''),
      }]);
    }
    const country = (c.req.query('country') ?? 'us').toLowerCase().replace(/[^a-z]/g, '').slice(0, 2) || 'us';
    return c.json(await searchPodcasts(term, country));
  } catch (e) { return fail(c, e); }
});
