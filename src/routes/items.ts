import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth, type AuthVars } from '../auth/middleware';
import { buildItemDetail } from '../lib/abs-shapes';
import { buildItemBundle } from './library';
import { probeM4b } from '../prober/m4b';
import { probeMp3 } from '../prober/mp3';
import { resolveItemIdFromUuid } from '../lib/ids';
import { insertListeningSession } from '../db/sessions';
import { getProgress, progressToAbs } from '../db/progress';
import { resolveProbeUrl, streamAudio } from '../storage/resolve';

export const itemRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>();

// 1x1 transparent PNG used when a cover request resolves to no item — kills
// the broken-image console spam from Pholia rendering /personalized shelves
// against an empty library or a stale UUID.
const PLACEHOLDER_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII='),
  (ch) => ch.charCodeAt(0),
);
function placeholderCover(): Response {
  return new Response(PLACEHOLDER_PNG, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=300',
      'Content-Length': String(PLACEHOLDER_PNG.byteLength),
    },
  });
}

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
      if (mapped) id = mapped;
      else return placeholderCover(); // unknown UUID — return transparent 1x1
    }
  }

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
  const bundle = await buildItemBundle(c.env, id);
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
      const probe = await probeMp3(probeUrl.url, audio.size_bytes || undefined);
      cover = probe.cover;
    } else {
      const probe = await probeM4b(probeUrl.url);
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
  const bundle = await buildItemBundle(c.env, c.req.param('id'));
  if (!bundle) return c.json({ error: 'Item not found' }, 404);
  // Stock ABS gates `userMediaProgress` on ?include=progress, but Plappa and
  // some other clients don't pass that flag — they just expect it to be there.
  // Including it whenever a row exists is harmless (Codable parsers ignore
  // unknown keys; clients that don't need it just skip the field).
  const progressRow = await getProgress(c.env, userRow.id, bundle.item.id, null);
  const userMediaProgress = progressRow ? await progressToAbs(c.env, progressRow) : null;
  return c.json(await buildItemDetail(bundle, { userMediaProgress }));
});

// Stream redirect. ABS clients reference audio by either `index` (1-based) or
// `ino` (the inode-style id we synthesise in the seed). Try both.
itemRoutes.get('/:id/file/:fileId', async (c) => {
  const bundle = await buildItemBundle(c.env, c.req.param('id'));
  if (!bundle) return c.json({ error: 'Item not found' }, 404);
  const fid = c.req.param('fileId');
  const audio =
    bundle.audioFiles.find((a) => a.ino === fid)
    ?? bundle.audioFiles.find((a) => a.index_no === Number(fid))
    ?? bundle.audioFiles[0];
  if (!audio) return c.json({ error: 'No audio' }, 404);
  return streamAudio(c.env, bundle.folder, audio, c.req.raw);
});

// POST /api/items/:id/play — open a listening session. Returns the session
// shape ABS clients use to drive playback (audioTracks with contentUrls,
// chapters, duration, displayTitle/Author). We don't persist the session yet
// — that's the next chunk; clients can already stream because contentUrl is
// served by /api/items/:id/file/:ino above.
itemRoutes.post('/:id/play', async (c) => {
  const userRow = c.get('user');
  const bundle = await buildItemBundle(c.env, c.req.param('id'));
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
