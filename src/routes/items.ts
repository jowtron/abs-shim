import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth, type AuthVars } from '../auth/middleware';
import { buildItemDetail } from '../lib/abs-shapes';
import { buildItemBundle } from './library';
import { probeM4b } from '../prober/m4b';
import { probeOgg } from '../prober/ogg';
import { probeMp3 } from '../prober/mp3';
import { resolveItemIdFromUuid } from '../lib/ids';
import { insertListeningSession } from '../db/sessions';
import { getProgress, progressToAbs } from '../db/progress';
import { audioContentType, resolveProbeUrl, resolveStreamUrl, streamAudio } from '../storage/resolve';
import { getStreamingTarget } from '../db/library';
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
  const trow = await c.env.DB.prepare('SELECT tenant_id FROM library_items WHERE id = ? LIMIT 1')
    .bind(id).first<{ tenant_id: string }>();
  if (!trow) return c.json({ error: 'Item not found' }, 404);
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
    } else if (audio.format === 'ogg' || /\.(opus|ogg)$/i.test(audio.rel_path ?? audio.filedn_url)) {
      cover = (await probeOgg(probeUrl.url, probeUrl.headers)).cover;
    } else {
      const probe = await probeM4b(probeUrl.url, probeUrl.headers);
      cover = probe.cover;
    }
  } catch (e) {
    return c.json({ error: 'Probe failed', detail: (e as Error).message }, 502);
  }
  if (!cover) return c.json({ error: 'No embedded cover' }, 404);

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

  const rangeHeader = c.req.header('Range') ?? null;

  // Fast path 1: Range overlaps the cached moov atom region — serve from R2
  // (~50ms) instead of pCloud (~800ms). Specifically targets non-fast-start
  // MP4s where iOS seeks directly to the moov offset; for fast-start files
  // the SW already has moov from its cached prefix and this never fires.
  const moovHit = await tryServeMoovRange(c.env, target.audio, rangeHeader);
  if (moovHit) return moovHit;

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
  if (byteHit) return byteHit;

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

  return streamAudio(c.env, target.folder, target.audio, c.req.raw);
});

// POST /api/items/:id/play — open a listening session. Returns the session
// shape ABS clients use to drive playback (audioTracks with contentUrls,
// chapters, duration, displayTitle/Author). We don't persist the session yet
// — that's the next chunk; clients can already stream because contentUrl is
// served by /api/items/:id/file/:ino above.
itemRoutes.post('/:id/play', async (c) => {
  const userRow = c.get('user');
  const bundle = await buildItemBundle(c.env, c.req.param('id'), c.get('tenantId'));
  if (!bundle) return c.json({ error: 'Item not found' }, 404);

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
