import type { Env } from '../types';
import { EPISODE_AUDIO_UA } from '../lib/podcast-shapes';
import type { AudioFileRow, LibraryFolderRow } from '../db/library';
import { getAdapter, type FolderRow } from './factory';
import { fetchLink } from './link-fetch';

// Glue for the existing routes: given the folder + audio_file rows we already
// load, return a stream URL. Handles the legacy/no-rel_path case (filedn_url
// is a baked-in absolute URL from the seed) so we don't have to touch seeds.

export async function resolveStreamUrl(
  env: Env,
  folder: LibraryFolderRow,
  audio: AudioFileRow,
): Promise<{ url: string; expiresAt?: number }> {
  // Pre-scanner rows: filedn_url is the source of truth, no rel_path.
  if (!audio.rel_path) {
    return { url: audio.filedn_url };
  }
  const adapter = await getAdapter(env, asFolderRow(folder));
  return adapter.resolveUrl(audio.rel_path, audio.provider_file_id);
}

// `headers` comes back set for backends we must authenticate to ourselves
// (WebDAV). Probing must NOT go through the client-facing proxy URL: that
// points at this Worker, and a Worker fetching its own hostname is answered
// with 522 by the edge.
export async function resolveProbeUrl(
  env: Env,
  folder: LibraryFolderRow,
  audio: AudioFileRow,
): Promise<{ url: string; expiresAt?: number; headers?: Record<string, string> }> {
  if (!audio.rel_path) {
    return { url: audio.filedn_url };
  }
  const adapter = await getAdapter(env, asFolderRow(folder));
  return adapter.resolveProbeUrl(audio.rel_path, audio.provider_file_id);
}

// Return a `Response` that streams the audio file to the client. For 302-
// compatible adapters (public_url) this is a redirect; for adapters whose
// URLs are bound to the requesting IP (pCloud's getfilelink) the bytes are
// proxied through the Worker so the egress IP is consistent. Range headers
// are forwarded so seeking works.
//
// We keep this in resolve.ts (rather than per-route) so /api/items/:id/file
// and /public/session/:id/track stay in sync — both stream the same way.
// Bound only time-to-headers on upstream (pCloud CDN) fetches: the timer is
// cleared once the response headers arrive, so a multi-minute audio body
// still streams unbounded. Why not AbortSignal.timeout(): that would abort
// the BODY ~10s into the stream. 10s sits comfortably above pCloud's ~800ms
// TTFB and well inside the ~40s iOS waits before giving up with a fatal
// (client-unretried) error 4 — see crash-log analysis 2026-08-23.
export const UPSTREAM_HEADER_TIMEOUT_MS = 10_000;

export async function fetchWithHeaderTimeout(
  url: string,
  headers: HeadersInit,
  timeoutMs = UPSTREAM_HEADER_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('upstream header timeout')), timeoutMs);
  try {
    return await fetchLink(url, { headers, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function streamAudio(
  env: Env,
  folder: LibraryFolderRow,
  audio: AudioFileRow,
  req: Request,
): Promise<Response> {
  const t0 = Date.now();
  const stream = await resolveStreamUrl(env, folder, audio);
  const tLink = Date.now() - t0;
  const provider = folder.provider ?? 'public_url';

  if (provider === 'pcloud_oauth') {
    const fwd = new Headers();
    const range = req.headers.get('Range');
    if (range) fwd.set('Range', range);
    // One retry on hang/5xx. A pCloud TTFB hang used to propagate to the
    // client as a ~40s dead wait, which iOS turns into a fatal error 4.
    // Retrying the SAME url is right for hangs. A 410 (the link was minted
    // from another of Cloudflare's IPs) is retried with a fresh link inside
    // fetchLink; other 4xx come back fast and pass through unchanged.
    let upstream: Response;
    try {
      upstream = await fetchWithHeaderTimeout(stream.url, fwd);
      if (upstream.status >= 500) throw new Error(`pCloud upstream ${upstream.status}`);
    } catch {
      upstream = await fetchWithHeaderTimeout(stream.url, fwd);
    }
    // Cold-path timing for `wrangler tail`: where a slow first byte went
    // (pCloud link resolution vs pCloud's own TTFB). Pholia's crash logs
    // showed 8-12 s from loadstart to loadedmetadata on a resume (2026-09-03).
    console.log(`audio cold ${audio.id} ${range ?? 'full'} link=${tLink}ms ttfb=${Date.now() - t0 - tLink}ms status=${upstream.status}`);
    // Don't pass through pCloud's CORS headers (the Worker already handles
    // CORS for its own origin) and drop Content-Encoding so the runtime
    // doesn't re-encode a stream pCloud already left raw.
    const respHeaders = new Headers(upstream.headers);
    respHeaders.delete('access-control-allow-origin');
    // Upstreams (filedn, pCloud) hand us application/octet-stream. Strict
    // clients and Service Worker caches behave better with a real audio MIME,
    // so override based on what the file actually is.
    respHeaders.set('content-type', audioContentType(audio));
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    });
  }

  return Response.redirect(stream.url, 302);
}

// A podcast episode that isn't archived: bytes come from the publisher's
// enclosure URL, proxied rather than redirected. A 302 would leave the
// client following a chain of tracking redirects to a CDN that sends no CORS
// headers, which breaks Pholia's service-worker fetches (every response in
// one iOS media load must share a CORS status — see CLAUDE.md), and would
// show the publisher the listener's IP instead of Cloudflare's.
//
// The feed's enclosure length is often wrong or missing, so size_bytes stays
// 0 until a response states the real total; `onSize` records it, after which
// the file route can answer HEAD from D1 like any other file.
// ── Where an enclosure's redirect chain ends (2026-11-09) ──
// Most enclosures are a chain of trackers before the file: The West Wing
// Weekly's is podtrac → pscrb.fm → dovetail.prxu.org → dovetail-cdn, about
// 3 s before the first byte from here. iOS starts an mp3 part-way through
// with dozens of small Range requests one after another, and every one of
// them walked the whole chain: 49 s from tap to sound on an iPhone. The
// end of the chain is remembered for 6 h (in this isolate, and in the
// colo's cache for the next one), so later requests go straight to the
// file; anything but a 200/206 from it forgets it and walks the chain
// again. It also keeps a listen on ONE stitch of an ad-inserting host,
// where each walk could hand back a differently stitched file. Trackers
// see one download per listen instead of one per Range request, which is
// what a podcast app's download looks like to them anyway.
const RESOLVED_TTL_S = 6 * 3600;
const resolvedMemo = new Map<string, { url: string; until: number }>();
function resolvedKey(enclosure: string): string {
  return 'https://resolved-enclosure.internal/' + encodeURIComponent(enclosure);
}
async function resolvedEnclosure(enclosure: string): Promise<string | null> {
  const m = resolvedMemo.get(enclosure);
  if (m && m.until > Date.now()) return m.url;
  try {
    const hit = await caches.default.match(resolvedKey(enclosure));
    if (!hit) return null;
    const url = (await hit.text()).trim();
    if (!/^https?:\/\//.test(url)) return null;
    resolvedMemo.set(enclosure, { url, until: Date.now() + 10 * 60_000 });
    return url;
  } catch { return null; }
}
async function rememberResolvedEnclosure(enclosure: string, url: string): Promise<void> {
  resolvedMemo.set(enclosure, { url, until: Date.now() + RESOLVED_TTL_S * 1000 });
  if (resolvedMemo.size > 500) resolvedMemo.delete(resolvedMemo.keys().next().value as string);
  try {
    await caches.default.put(resolvedKey(enclosure), new Response(url, {
      headers: { 'Content-Type': 'text/plain', 'Cache-Control': `max-age=${RESOLVED_TTL_S}` },
    }));
  } catch { /* the in-isolate memo still helps */ }
}
async function forgetResolvedEnclosure(enclosure: string): Promise<void> {
  resolvedMemo.delete(enclosure);
  try { await caches.default.delete(resolvedKey(enclosure)); } catch { /* expires anyway */ }
}

export async function streamRemoteAudio(
  audio: AudioFileRow,
  req: Request,
  onSize?: (size: number) => void,
  // Where the redirect chain ended, on every 200/206 (audio-host.ts).
  onFinal?: (url: string) => void,
): Promise<Response> {
  const fwd = new Headers({ 'User-Agent': EPISODE_AUDIO_UA });
  const range = req.headers.get('Range');
  const head = req.method === 'HEAD';
  // HEAD with an unknown size: a one-byte GET says the total without
  // starting a whole download.
  if (head) fwd.set('Range', 'bytes=0-0');
  else if (range) fwd.set('Range', range);
  let upstream: Response | null = null;
  // Where the enclosure's redirect chain ended last time (see
  // resolvedEnclosure): straight there, back to the start of the chain if
  // that address no longer answers.
  const known = await resolvedEnclosure(audio.filedn_url);
  if (known) {
    try {
      const r = await fetchWithHeaderTimeout(known, fwd);
      if (r.status === 200 || r.status === 206) upstream = r;
      else await r.body?.cancel().catch(() => undefined);
    } catch { /* fall through to the full chain */ }
    if (!upstream) await forgetResolvedEnclosure(audio.filedn_url);
  }
  if (!upstream) {
    try {
      upstream = await fetchWithHeaderTimeout(audio.filedn_url, fwd);
      if (upstream.status >= 500) throw new Error(`publisher ${upstream.status}`);
    } catch {
      upstream = await fetchWithHeaderTimeout(audio.filedn_url, fwd);
    }
    if ((upstream.status === 200 || upstream.status === 206) && upstream.url && upstream.url !== audio.filedn_url) {
      await rememberResolvedEnclosure(audio.filedn_url, upstream.url);
    }
  }
  if (upstream.status === 200 || upstream.status === 206) onFinal?.(upstream.url || known || audio.filedn_url);
  const total = Number(/\/(\d+)\s*$/.exec(upstream.headers.get('content-range') ?? '')?.[1]
    ?? (upstream.status === 200 ? upstream.headers.get('content-length') ?? '' : ''));
  if (Number.isFinite(total) && total > 0 && total !== audio.size_bytes) onSize?.(total);

  if (head) {
    await upstream.body?.cancel().catch(() => undefined);
    const h = new Headers({ 'Content-Type': audioContentType(audio), 'Accept-Ranges': 'bytes' });
    if (total > 0) h.set('Content-Length', String(total));
    return new Response(null, { status: upstream.ok ? 200 : upstream.status, headers: h });
  }
  // Pass through only what describes the bytes; the publisher's CORS,
  // cookies and caching headers aren't ours to forward.
  const h = new Headers({ 'Content-Type': audioContentType(audio), 'Accept-Ranges': 'bytes' });
  for (const k of ['content-length', 'content-range', 'etag', 'last-modified']) {
    const v = upstream.headers.get(k);
    if (v) h.set(k, v);
  }
  // The runtime hands us a compressed body already decoded, so its length
  // header no longer describes what we send.
  if (upstream.headers.get('content-encoding')) h.delete('content-length');
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: h });
}

export function audioContentType(audio: AudioFileRow): string {
  if (audio.mime_type && audio.mime_type !== 'application/octet-stream') {
    return audio.mime_type;
  }
  const path = (audio.rel_path ?? audio.filedn_url ?? '').toLowerCase();
  if (path.endsWith('.m4b') || path.endsWith('.m4a') || path.endsWith('.mp4')) return 'audio/mp4';
  if (path.endsWith('.mp3')) return 'audio/mpeg';
  if (path.endsWith('.opus')) return 'audio/ogg; codecs=opus';
  if (path.endsWith('.ogg')) return 'audio/ogg';
  if (path.endsWith('.flac')) return 'audio/flac';
  if (path.endsWith('.wav')) return 'audio/wav';
  if (path.endsWith('.webm')) return 'audio/webm';
  return 'application/octet-stream';
}

// LibraryFolderRow (defined before migration 0002) doesn't include the new
// columns; the runtime row from `SELECT *` does. Cast through a widened type.
function asFolderRow(folder: LibraryFolderRow): FolderRow {
  const f = folder as unknown as FolderRow;
  return {
    id: f.id,
    library_id: f.library_id,
    tenant_id: f.tenant_id,
    filedn_base_url: f.filedn_base_url,
    added_at: f.added_at,
    provider: f.provider ?? 'public_url',
    config_json: f.config_json ?? '{}',
    profile_id: f.profile_id ?? null,
  };
}
