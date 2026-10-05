import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth, requireCanAdd, type AuthVars } from '../auth/middleware';
import { buildItemDetail } from '../lib/abs-shapes';
import { buildItemBundle } from './library';
import { probeM4b } from '../prober/m4b';
import { probeOgg } from '../prober/ogg';
import { probeWebm } from '../prober/webm';
import { probeMp3 } from '../prober/mp3';
import { resolveItemIdFromUuid } from '../lib/ids';
import { findCatalogCover } from '../lib/cover-from-catalog';
import { insertListeningSession } from '../db/sessions';
import { getProgress, progressToAbs } from '../db/progress';
import { audioContentType, resolveProbeUrl, resolveStreamUrl, streamAudio, streamRemoteAudio } from '../storage/resolve';
import { getEpisode, getPodcast, listShowEpisodes } from '../db/podcasts';
import { buildEpisodeExpanded, buildPodcastItemExpanded, podcastMetadata } from '../lib/podcast-shapes';
import { getBookMetadata, getFolderById, getItem, getStreamingTarget, type AudioFileRow } from '../db/library';
import { tryServeMoovRange, warmMoovCache } from '../storage/moov-cache';
import { tryServeByteRange, warmByteChunk, estimateByteOffsetForTime, CHUNK_SIZE } from '../storage/byte-cache';

import { placeholderImage } from '../lib/placeholder';

export const itemRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>();

// Cover image — deliberately registered BEFORE the auth middleware so it's
// public. ShelfPlayer and other clients don't always pass auth on image
// requests; album art isn't sensitive content. Range-fetches the moov atom
// and extracts the embedded `covr` atom, cached in the Workers Cache API.
itemRoutes.get('/:id/cover', async (c) => {
  const rawId = c.req.param('id');
  const cache = caches.default;

  // Pholia's home view renders /personalized shelves and builds
  // `/api/items/<entity.id>/cover` for every entity — including series and
  // author cards, whose entity.id is a derivedId UUID. Resolve any UUID form
  // (media-id, author-id, series-id) to a real library_items.id up front so
  // R2/Workers-Cache key off the canonical id and we serve a representative
  // book cover instead of 404ing.
  let id = rawId;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId)) {
    const exists = await c.env.DB
      .prepare('SELECT 1 AS x FROM library_items WHERE id = ? LIMIT 1')
      .bind(rawId)
      .first<{ x: number }>();
    if (!exists) {
      const mapped = await resolveItemIdFromUuid(c.env.DB, rawId);
      if (mapped) id = mapped.itemId;
      else return placeholderImage(); // unknown UUID — return transparent 1x1
    }
  }

  // Cover R2/edge keys are intentionally NOT tenant-prefixed: library_items.id
  // is globally unique (no cross-tenant collision), covers are non-sensitive
  // book artwork, and this route is public + cache-hot — prefixing would force
  // a D1 tenant lookup on every cached-cover hit. Audio/moov caches (which hold
  // actual content) ARE tenant-prefixed; see byte-cache.ts / moov-cache.ts.

  // Token-stripped cache key so different users share the same edge cache entry.
  const cacheKey = new Request(new URL(`/__cover_cache__/${id}`, c.req.url).toString(), { method: 'GET' });

  // Tier 1: Workers Cache (per-POP, ~5ms hit). Most-loaded covers live here.
  const edgeHit = await cache.match(cacheKey);
  if (edgeHit) return edgeHit;

  // Tier 2: R2 (account-wide, ~10ms hit). Survives Workers-Cache eviction
  // and is shared across all CF POPs, so a cold POP only re-probes
  // the very first time a cover is ever requested.
  const r2Key = `covers/${id}`;
  const r2Hit = await c.env.COVERS.get(r2Key);
  if (r2Hit) {
    const headers = new Headers({
      'Content-Type': r2Hit.httpMetadata?.contentType ?? 'image/jpeg',
      'Cache-Control': 'public, max-age=2592000, immutable',
      'Content-Length': String(r2Hit.size),
    });
    const res = new Response(r2Hit.body, { status: 200, headers });
    c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  }

  // Tier 3: probe upstream. Range-reads the relevant header bytes and pulls
  // the embedded cover — expensive (~50–500ms depending on the storage
  // backend), so we want this to happen at most once per item. Dispatch by
  // file extension: mp3 books have ID3v2 APIC frames, m4b/m4a/aac have a
  // moov/udta/meta/ilst/covr atom.
  // Public route — discover the item's own tenant (only on this cache-miss
  // probe path, never on the hot Tier 1/2 cache hits above) so buildItemBundle
  // can run tenant-scoped.
  const trow = await c.env.DB.prepare('SELECT tenant_id, media_type FROM library_items WHERE id = ? LIMIT 1')
    .bind(id).first<{ tenant_id: string; media_type: string }>();
  if (!trow) return c.json({ error: 'Item not found' }, 404);

  // A podcast's cover is its artwork URL — Apple's 600 px copy when the show
  // was matched on iTunes, else the feed's own image (see lib/podcasts.ts).
  if (trow.media_type === 'podcast') {
    const p = await c.env.DB.prepare('SELECT cover_url, image_url FROM podcasts WHERE library_item_id = ?')
      .bind(id).first<{ cover_url: string | null; image_url: string | null }>();
    const src = p?.cover_url || p?.image_url;
    if (!src) return placeholderImage();
    let img: Response;
    try {
      img = await fetch(src, { signal: AbortSignal.timeout(15_000) });
    } catch {
      return placeholderImage();
    }
    const type = img.headers.get('content-type') ?? '';
    if (!img.ok || !type.startsWith('image/')) return placeholderImage();
    const bytes = new Uint8Array(await img.arrayBuffer());
    const res = new Response(bytes, {
      headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=2592000, immutable', 'Content-Length': String(bytes.byteLength) },
    });
    c.executionCtx.waitUntil(Promise.all([
      cache.put(cacheKey, res.clone()),
      c.env.COVERS.put(r2Key, bytes, { httpMetadata: { contentType: type } }),
    ]));
    return res;
  }
  const bundle = await buildItemBundle(c.env, id, trow.tenant_id);
  if (!bundle) return c.json({ error: 'Item not found' }, 404);
  const audio = bundle.audioFiles[0];
  if (!audio) return c.json({ error: 'No audio file' }, 404);

  let cover;
  try {
    const probeUrl = await resolveProbeUrl(c.env, bundle.folder, audio);
    const isMp3 = audio.format === 'mp3'
      || audio.mime_type === 'audio/mpeg'
      || /\.mp3$/i.test(audio.rel_path ?? audio.filedn_url);
    if (isMp3) {
      const probe = await probeMp3(probeUrl.url, audio.size_bytes || undefined, probeUrl.headers);
      cover = probe.cover;
    } else if (audio.format === 'webm' || /\.webm$/i.test(audio.rel_path ?? audio.filedn_url)) {
      cover = (await probeWebm(probeUrl.url, probeUrl.headers)).cover;
    } else if (audio.format === 'ogg' || /\.(opus|ogg)$/i.test(audio.rel_path ?? audio.filedn_url)) {
      cover = (await probeOgg(probeUrl.url, probeUrl.headers)).cover;
    } else {
      const probe = await probeM4b(probeUrl.url, probeUrl.headers);
      cover = probe.cover;
    }
  } catch (e) {
    return c.json({ error: 'Probe failed', detail: (e as Error).message }, 502);
  }
  // Nothing embedded. Rather than 404 and leave a blank card forever, borrow
  // the artwork from the matching AudioBookBay listing — for an mp3 rip with
  // no APIC frame that is the only cover the book has ever had. Cached in
  // both tiers below exactly like an embedded one, so this costs a catalogue
  // lookup once per book, not per view. ("Warm cover cache" in /admin does
  // the same thing for the whole library up front.)
  if (!cover) {
    const meta = await getBookMetadata(c.env, id, c.get('tenantId'));
    const fromCatalog = await findCatalogCover(c.env, { title: meta?.title ?? null, author: meta?.author_name ?? null });
    if (!fromCatalog) return c.json({ error: 'No embedded cover, and no matching AudioBookBay listing' }, 404);
    cover = { bytes: new Uint8Array(fromCatalog.bytes), mimeType: fromCatalog.contentType };
  }

  const res = new Response(cover.bytes, {
    status: 200,
    headers: {
      'Content-Type': cover.mimeType,
      'Cache-Control': 'public, max-age=2592000, immutable',
      'Content-Length': String(cover.bytes.byteLength),
    },
  });
  // Fan out to both tiers in the background so the request returns immediately.
  // R2 put is idempotent on the same key.
  c.executionCtx.waitUntil(Promise.all([
    cache.put(cacheKey, res.clone()),
    c.env.COVERS.put(r2Key, cover.bytes, {
      httpMetadata: { contentType: cover.mimeType },
    }),
  ]));
  return res;
});

// Everything below requires auth.
itemRoutes.use('*', requireAuth);

itemRoutes.get('/:id', async (c) => {
  const userRow = c.get('user');
  const show = await loadPodcastItem(c.env, c.req.param('id'), c.get('tenantId'));
  if (show) return c.json(await buildPodcastItemExpanded(show.item, show.folder, show.podcast, await listShowEpisodes(c.env, show.item.id, c.get('tenantId'))));
  const bundle = await buildItemBundle(c.env, c.req.param('id'), c.get('tenantId'));
  if (!bundle) return c.json({ error: 'Item not found' }, 404);
  // Stock ABS gates `userMediaProgress` on ?include=progress, but Plappa and
  // some other clients don't pass that flag — they just expect it to be there.
  // Including it whenever a row exists is harmless (Codable parsers ignore
  // unknown keys; clients that don't need it just skip the field).
  const progressRow = await getProgress(c.env, userRow.id, bundle.item.id, null);
  const userMediaProgress = progressRow ? await progressToAbs(c.env, progressRow) : null;
  return c.json(await buildItemDetail(bundle, { userMediaProgress }));
});

// Stream / probe an audio file. ABS clients reference files by either `index`
// (1-based) or `ino`. Hot path — every Range request from the audio element
// lands here, so we use a slim D1 query (folder + audio_file only) instead of
// the full buildItemBundle that the JSON-shape routes need.
//
// HEAD short-circuit: the audio element probes Content-Length, Content-Type,
// and Accept-Ranges before issuing Ranges. All three are derivable from D1.
// Skipping the pCloud round-trip on HEAD drops it from ~800ms to ~30ms, which
// matters because iOS's stall-detection timer kills slow probes mid-flight.
itemRoutes.get('/:id/file/:fileId', async (c) => {
  const target = await getStreamingTarget(c.env, c.req.param('id'), c.req.param('fileId'), c.get('tenantId'));
  if (!target) return c.json({ error: 'Item or audio file not found' }, 404);

  // Only short-circuit HEAD when D1 actually knows the size — size_bytes can
  // be 0 for rows added without a size hint, and answering Content-Length: 0
  // tells iOS the file is empty (playback never starts, and nothing ever
  // corrects it). Falsy size falls through to the real streaming path.
  if (c.req.method === 'HEAD' && target.audio.size_bytes) {
    return new Response(null, {
      status: 200,
      headers: {
        'Content-Type': audioContentType(target.audio),
        'Content-Length': String(target.audio.size_bytes),
        'Accept-Ranges': 'bytes',
      },
    });
  }

  // ?download=1 (the /admin Download button): same bytes, plus a
  // Content-Disposition so the browser saves the file under its own name
  // instead of opening a player. A 302 to a backend URL can't carry it; the
  // browser then saves under whatever name the backend gives.
  const download = c.req.query('download') === '1';
  const finish = (r: Response): Response => (download ? asAttachment(r, target.audio) : r);

  const rangeHeader = c.req.header('Range') ?? null;

  // Podcast episodes skip the moov and byte caches: those exist for pCloud's
  // slow first byte on books people come back to for weeks, and an R2 copy
  // of every episode anyone plays would only grow. Not archived → the
  // publisher's CDN, proxied; archived → the library's storage, like a book.
  if (target.episode) {
    if (!target.audio.rel_path) {
      const episodeId = target.episode.id;
      return finish(await streamRemoteAudio(target.audio, c.req.raw, (size) => {
        c.executionCtx.waitUntil(c.env.DB.prepare('UPDATE podcast_episodes SET size_bytes = ? WHERE id = ?')
          .bind(size, episodeId).run().then(() => undefined, () => undefined));
      }));
    }
    return finish(await streamAudio(c.env, target.folder, target.audio, c.req.raw));
  }

  // Fast path 1: Range overlaps the cached moov atom region — serve from R2
  // (~50ms) instead of pCloud (~800ms). Specifically targets non-fast-start
  // MP4s where iOS seeks directly to the moov offset; for fast-start files
  // the SW already has moov from its cached prefix and this never fires.
  const moovHit = await tryServeMoovRange(c.env, target.audio, rangeHeader);
  if (moovHit) return finish(moovHit);

  // Pre-flight warming strategy:
  //
  //   - Synchronously wait for chunks N and N+1 (the chunk containing the
  //     Range start, plus the next one). Two-chunk buffer is required because
  //     iOS reads ahead through one chunk in ~3-4s, then stalls if the next
  //     chunk forces a pCloud TTFB gap. With two consecutive cached chunks
  //     the stitched stream serves ~8 MiB before transitioning, which is
  //     enough cushion for iOS to keep playing across the seam.
  //   - Background-warm chunks N+2 and N+3 so they're already in R2 by the
  //     time iOS reads through N+1 and asks for them. Sequential reads then
  //     stay on the fast path without any cancel-retry stutter.
  //
  // If the request starts at a chunk we already have in R2, serve from
  // the stitched stream (R2 prefix + pCloud for any uncached suffix).
  // tryServeByteRange returns null when the start chunk isn't cached.
  const byteHit = await tryServeByteRange(c.env, target.folder, target.audio, rangeHeader);
  if (byteHit) return finish(byteHit);

  // Cache miss: pipe pCloud directly to the client (low TTFB so iOS's
  // ~1 s Range stall budget doesn't trigger cancel-retry) AND fire a
  // small background warm in parallel so the NEXT request to this region
  // hits R2 fast. The background warm is a separate pCloud fetch (2×
  // bandwidth on the cold path) — but it's the only safe way to populate
  // R2 without backpressure between the client stream and the cache
  // writes interfering with each other (an earlier tee-stream attempt
  // truncated playback after ~3 s of audio).
  if (rangeHeader && target.audio.size_bytes) {
    const parsed = /^bytes=(\d+)-/.exec(rangeHeader);
    if (parsed) {
      const startByte = Number(parsed[1]);
      if (Number.isFinite(startByte)) {
        const startChunkStart = Math.floor(startByte / CHUNK_SIZE) * CHUNK_SIZE;
        c.executionCtx.waitUntil(warmByteChunk(c.env, target.folder, target.audio, startChunkStart));
        const nextChunkStart = startChunkStart + CHUNK_SIZE;
        if (nextChunkStart < target.audio.size_bytes) {
          c.executionCtx.waitUntil(warmByteChunk(c.env, target.folder, target.audio, nextChunkStart));
        }
      }
    }
  }

  return finish(await streamAudio(c.env, target.folder, target.audio, c.req.raw));
});

function asAttachment(r: Response, audio: AudioFileRow): Response {
  if (r.status >= 300 && r.status < 400) return r;
  // rel_path is a plain path; only the legacy filedn_url is URL-encoded.
  let name = audio.rel_path?.split('/').pop() || '';
  if (!name && audio.filedn_url) {
    const last = audio.filedn_url.split('?')[0]!.split('/').pop() || '';
    try { name = decodeURIComponent(last); } catch { name = last; }
  }
  if (!name) name = `audio-${audio.id}`;
  // RFC 6266: an ASCII fallback plus the UTF-8 name for anything non-ASCII.
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const headers = new Headers(r.headers);
  headers.set('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers });
}

// POST /api/items/:id/play — open a listening session. Returns the session
// shape ABS clients use to drive playback (audioTracks with contentUrls,
// chapters, duration, displayTitle/Author). We don't persist the session yet
// — that's the next chunk; clients can already stream because contentUrl is
// served by /api/items/:id/file/:ino above.
itemRoutes.post('/:id/play', async (c) => {
  const userRow = c.get('user');
  const bundle = await buildItemBundle(c.env, c.req.param('id'), c.get('tenantId'));
  if (!bundle) return c.json({ error: 'Item not found' }, 404);
  if (bundle.item.media_type === 'podcast') return c.json({ error: 'A podcast plays one episode: POST /api/items/:id/play/:episodeId' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const detail = await buildItemDetail(bundle);
  const m = detail.media;

  const totalDuration = bundle.audioFiles.reduce((s, a) => s + a.duration_seconds, 0);
  const audioTracks = m.audioFiles.map((af, i) => {
    const startOffset = m.audioFiles.slice(0, i).reduce((s, a) => s + (a.duration ?? 0), 0);
    const af2 = af as typeof af & { metadata: { filename: string } };
    return {
      ...af,
      title: af2.metadata.filename,
      startOffset,
      contentUrl: `/api/items/${bundle.item.id}/file/${af.ino ?? af.index}`,
    };
  });

  // Resume from existing progress if any. ABS clients seek to `startTime` /
  // `currentTime` on the first PLAY event, so populating these from D1 is what
  // makes "remember position" actually work.
  const progress = await getProgress(c.env, userRow.id, bundle.item.id, null);
  const resumeAt = progress?.current_time_seconds ?? 0;

  const now = Date.now();
  const date = new Date(now);
  const sessionId = crypto.randomUUID();

  // Persist the session so /public/session/:id/track/:n can resolve back to
  // an audio file later, and so /api/me/listening-sessions has history.
  await insertListeningSession(c.env, {
    id: sessionId,
    user_id: userRow.id,
    library_item_id: bundle.item.id,
    display_title: m.metadata.title ?? null,
    display_author: (m.metadata.authors as Array<{ name: string }>).map((a) => a.name).join(', ') || null,
    duration_seconds: totalDuration,
    play_method: 0,
    media_player: body?.mediaPlayer ?? 'unknown',
    device_info: JSON.stringify(body?.deviceInfo ?? {}),
    server_version: '2.34.0',
    date_started: now,
    current_time_seconds: resumeAt,
    time_listening_seconds: 0,
    start_time_seconds: resumeAt,
    closed_at: null,
    updated_at: now,
  });

  // Background prewarms — all best-effort, silently swallow errors. Each
  // failure mode degrades gracefully to "the corresponding Range pays full
  // pCloud cost on its first request", which is the pre-cache baseline.
  const firstAudio = bundle.audioFiles[0];
  if (firstAudio) {
    // pCloud filelink: ~300ms saved on every subsequent Range request
    // within the URL's 6h validity window.
    c.executionCtx.waitUntil(
      resolveStreamUrl(c.env, bundle.folder, firstAudio).then(() => undefined, () => undefined),
    );
    // moov atom: defeats iOS's seek-to-moov stall on non-fast-start MP4s.
    c.executionCtx.waitUntil(warmMoovCache(c.env, bundle.folder, firstAudio));
    // Playhead chunk: when resuming a book, iOS seeks to (roughly) the byte
    // offset for the current time. Pre-fetching that chunk lands an R2 hit
    // on the first user-perceptible Range, which is the difference between
    // "starts playing" and "cancel-retry death spiral" for fast-start MP4s.
    const playheadByte = estimateByteOffsetForTime(firstAudio, totalDuration, resumeAt);
    if (playheadByte != null) {
      c.executionCtx.waitUntil(warmByteChunk(c.env, bundle.folder, firstAudio, playheadByte));
    }
  }

  return c.json({
    id: sessionId,
    userId: userRow.id,
    libraryId: bundle.item.library_id,
    libraryItemId: bundle.item.id,
    bookId: m.id,
    episodeId: null,
    mediaType: bundle.item.media_type,
    mediaMetadata: m.metadata,
    chapters: m.chapters,
    displayTitle: m.metadata.title,
    displayAuthor: (m.metadata.authors as Array<{ name: string }>).map((a) => a.name).join(', '),
    coverPath: m.coverPath,
    duration: totalDuration,
    playMethod: 0, // direct play
    mediaPlayer: body?.mediaPlayer ?? 'unknown',
    deviceInfo: body?.deviceInfo ?? {},
    serverVersion: '2.34.0',
    date: date.toISOString().slice(0, 10),
    dayOfWeek: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][date.getUTCDay()]!,
    timeListening: 0,
    startTime: resumeAt,
    currentTime: resumeAt,
    startedAt: now,
    updatedAt: now,
    audioTracks,
    libraryItem: detail,
  });
});

// ─── Podcasts ────────────────────────────────────────────────────────────────

async function loadPodcastItem(env: Env, itemId: string, tenantId: string) {
  const item = await getItem(env, itemId, tenantId);
  if (!item || item.media_type !== 'podcast') return null;
  const [folder, podcast] = await Promise.all([getFolderById(env, item.folder_id, tenantId), getPodcast(env, itemId, tenantId)]);
  return folder && podcast ? { item, folder, podcast } : null;
}

// POST /api/items/:id/play/:episodeId — ABS's startEpisodePlaybackSession:
// one audio track (the episode), the show's metadata as mediaMetadata, the
// episode title as displayTitle and the show's author as displayAuthor.
itemRoutes.post('/:id/play/:episodeId', async (c) => {
  const userRow = c.get('user');
  const tenantId = c.get('tenantId');
  const show = await loadPodcastItem(c.env, c.req.param('id'), tenantId);
  if (!show) return c.json({ error: 'Podcast not found' }, 404);
  const ep = await getEpisode(c.env, show.item.id, c.req.param('episodeId'), tenantId);
  if (!ep) return c.json({ error: 'Episode not found' }, 404);
  // Playing an episode from the feed that isn't on the show puts it there:
  // Continue Listening and Latest only list episodes on a show.
  if (ep.in_library !== 1) {
    await c.env.DB.prepare('UPDATE podcast_episodes SET in_library = 1, removed = 0, updated_at = ? WHERE id = ?')
      .bind(Date.now(), ep.id).run();
  }
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const episode = await buildEpisodeExpanded(ep, show.item, show.folder);

  const progress = await getProgress(c.env, userRow.id, show.item.id, ep.id);
  const resumeAt = progress && progress.is_finished !== 1 ? progress.current_time_seconds : 0;
  const now = Date.now();
  const date = new Date(now);
  const sessionId = crypto.randomUUID();
  await insertListeningSession(c.env, {
    id: sessionId,
    user_id: userRow.id,
    library_item_id: show.item.id,
    episode_id: ep.id,
    display_title: ep.title,
    display_author: show.podcast.author,
    duration_seconds: ep.duration_seconds,
    play_method: 0,
    media_player: String(body['mediaPlayer'] ?? 'unknown'),
    device_info: JSON.stringify(body['deviceInfo'] ?? {}),
    server_version: '2.34.0',
    date_started: now,
    current_time_seconds: resumeAt,
    time_listening_seconds: 0,
    start_time_seconds: resumeAt,
    closed_at: null,
    updated_at: now,
  });

  return c.json({
    id: sessionId,
    userId: userRow.id,
    libraryId: show.item.library_id,
    libraryItemId: show.item.id,
    bookId: null,
    episodeId: ep.id,
    mediaType: 'podcast',
    mediaMetadata: podcastMetadata(show.podcast),
    chapters: episode.chapters,
    displayTitle: ep.title,
    displayAuthor: show.podcast.author,
    coverPath: `/metadata/items/${show.item.id}/cover.jpg`,
    duration: ep.duration_seconds,
    playMethod: 0,
    mediaPlayer: body['mediaPlayer'] ?? 'unknown',
    deviceInfo: body['deviceInfo'] ?? {},
    serverVersion: '2.34.0',
    date: date.toISOString().slice(0, 10),
    dayOfWeek: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][date.getUTCDay()]!,
    timeListening: 0,
    startTime: resumeAt,
    currentTime: resumeAt,
    startedAt: now,
    updatedAt: now,
    audioTracks: [episode.audioTrack],
    libraryItem: await buildPodcastItemExpanded(show.item, show.folder, show.podcast, [ep]),
  });
});

// PATCH /api/items/:id/media — how ABS clients change a podcast's settings
// (autoDownloadEpisodes, maxEpisodesToKeep, maxNewEpisodesToDownload,
// autoDownloadSchedule, tags). Shim extra: `archive`. Books aren't editable
// here (their metadata comes from the files); that answers 400.
itemRoutes.patch('/:id/media', requireCanAdd, async (c) => {
  const tenantId = c.get('tenantId');
  const show = await loadPodcastItem(c.env, c.req.param('id'), tenantId);
  if (!show) return c.json({ error: 'Only podcast settings can be changed here' }, 400);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const sets: string[] = [];
  const binds: unknown[] = [];
  const bool = (k: string, col: string) => { if (typeof body[k] === 'boolean') { sets.push(`${col} = ?`); binds.push(body[k] ? 1 : 0); } };
  const int = (k: string, col: string) => {
    const v = body[k];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10000) { sets.push(`${col} = ?`); binds.push(v); }
  };
  bool('autoDownloadEpisodes', 'auto_download');
  bool('archive', 'archive');
  int('maxEpisodesToKeep', 'max_episodes_to_keep');
  int('maxNewEpisodesToDownload', 'max_new_episodes_to_download');
  if (typeof body['autoDownloadSchedule'] === 'string') { sets.push('auto_download_schedule = ?'); binds.push(body['autoDownloadSchedule']); }
  if (Array.isArray(body['tags'])) { sets.push('tags = ?'); binds.push(JSON.stringify((body['tags'] as unknown[]).filter((t) => typeof t === 'string'))); }
  const md = body['metadata'] as Record<string, unknown> | undefined;
  if (md && typeof md === 'object') {
    for (const [k, col] of [['title', 'title'], ['author', 'author'], ['description', 'description'], ['language', 'language']] as const) {
      if (typeof md[k] === 'string') { sets.push(`${col} = ?`); binds.push(md[k]); }
    }
    if (typeof md['feedUrl'] === 'string' && /^https?:\/\//i.test(md['feedUrl'])) {
      sets.push('feed_url = ?, feed_etag = NULL, feed_last_modified = NULL'); binds.push(md['feedUrl']);
    }
  }
  if (sets.length) {
    await c.env.DB.prepare(`UPDATE podcasts SET ${sets.join(', ')}, updated_at = ? WHERE library_item_id = ?`)
      .bind(...binds, Date.now(), show.item.id).run();
  }
  const fresh = (await loadPodcastItem(c.env, show.item.id, tenantId))!;
  const libraryItem = await buildPodcastItemExpanded(fresh.item, fresh.folder, fresh.podcast, await listShowEpisodes(c.env, show.item.id, tenantId));
  return c.json({ updated: sets.length > 0, libraryItem });
});
