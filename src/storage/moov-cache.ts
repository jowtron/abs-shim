import type { Env } from '../types';
import type { AudioFileRow, LibraryFolderRow } from '../db/library';
import { resolveProbeUrl, resolveStreamUrl, audioContentType } from './resolve';
import { probeM4b } from '../prober/m4b';

// Server-side cache of the m4b `moov` atom bytes in R2, keyed by audio_files.id.
//
// Why this exists: iOS Safari's audio element, on a partially-cached book,
// parses the file prefix to find the `moov` atom offset, then cancels its
// initial stream and issues a direct Range fetch for moov. If that Range
// takes ~1s to start flowing iOS gives up — and pCloud OAuth's per-Range
// `getfilelink` + CDN TTFB adds up to exactly that ~1s. By caching the moov
// byte range in R2 (~50ms to read), the Range response starts before iOS's
// stall timer fires and playback proceeds normally.
//
// We reuse the existing COVERS R2 bucket with a `moov/` key prefix rather
// than minting a new binding. Bucket name doesn't constrain key namespace.

// Probe an m4b on-demand to discover moov location, write the result back
// to D1, and update the in-memory `audio` row so the caller sees the new
// values. Used only when an older row hasn't been backfilled yet.
async function backfillMoovLocation(env: Env, folder: LibraryFolderRow, audio: AudioFileRow): Promise<void> {
  const probeUrl = await resolveProbeUrl(env, folder, audio);
  const probe = await probeM4b(probeUrl.url);
  audio.moov_offset = probe.moovOffset;
  audio.moov_size = probe.moovSize;
  await env.DB.prepare(
    'UPDATE audio_files SET moov_offset = ?, moov_size = ? WHERE id = ?',
  ).bind(probe.moovOffset, probe.moovSize, audio.id).run();
}

// Idempotently populate the R2 moov cache for one audio file. Called from
// `/play` via `waitUntil` so it runs in the background while the client is
// still processing the play response. By the time the audio element fires
// its first seek-to-moov Range, the R2 entry is in place.
//
// Best-effort — any error is silently swallowed, the streaming path falls
// back to pCloud as before.
export async function warmMoovCache(env: Env, folder: LibraryFolderRow, audio: AudioFileRow): Promise<void> {
  // Only m4b/m4a/mp4 have a moov atom. mp3/opus/ogg/flac have no analogue
  // and don't trigger the iOS seek-to-moov pathology.
  const path = (audio.rel_path ?? audio.filedn_url ?? '').toLowerCase();
  const isMp4Container = path.endsWith('.m4b') || path.endsWith('.m4a') || path.endsWith('.mp4');
  if (!isMp4Container) return;

  try {
    if (audio.moov_offset == null || audio.moov_size == null) {
      await backfillMoovLocation(env, folder, audio);
    }
    if (audio.moov_offset == null || audio.moov_size == null) return;

    // Skip the upstream fetch if R2 already has it.
    const existing = await env.COVERS.head(`moov/${audio.tenant_id}/${audio.id}`);
    if (existing && existing.size === audio.moov_size) return;

    const streamUrl = await resolveStreamUrl(env, folder, audio);
    const last = audio.moov_offset + audio.moov_size - 1;
    const upstream = await fetch(streamUrl.url, {
      headers: { Range: `bytes=${audio.moov_offset}-${last}` },
    });
    // Accept 206 (Partial Content) and 200 (server ignored Range). Anything
    // else means upstream isn't going to give us the bytes — bail.
    if (upstream.status !== 206 && upstream.status !== 200) return;

    const bytes = new Uint8Array(await upstream.arrayBuffer());
    if (bytes.byteLength !== audio.moov_size) return; // safety: don't cache a partial read

    await env.COVERS.put(`moov/${audio.tenant_id}/${audio.id}`, bytes, {
      httpMetadata: { contentType: 'application/octet-stream' },
    });
  } catch {
    // Background prewarm is best-effort.
  }
}

// Range-header parser. Returns null for malformed/multipart/suffix ranges,
// which the streaming route then passes through to pCloud unchanged.
export function parseRange(header: string | null, totalSize: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : totalSize - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < start || end >= totalSize) return null;
  return { start, end };
}

// If a Range request's start byte falls inside the cached moov region, slice
// from R2 and return a 206 covering [range.start, min(range.end, moovEnd)].
// Otherwise (or on any cache miss / R2 error) returns null and the caller
// streams from pCloud as today.
//
// Note: when the requested Range extends past the moov region (e.g. iOS's
// typical open-ended `bytes=moov_offset-` seek), we deliberately truncate
// the response at the moov boundary. iOS sees a short Range response,
// parses the moov atom it now has, and issues subsequent Ranges for the
// real audio data. Those subsequent requests don't trigger the seek-to-moov
// stall pathology because iOS already has the metadata.
export async function tryServeMoovRange(
  env: Env,
  audio: AudioFileRow,
  rangeHeader: string | null,
): Promise<Response | null> {
  if (audio.moov_offset == null || audio.moov_size == null) return null;
  if (!audio.size_bytes) return null;

  const range = parseRange(rangeHeader, audio.size_bytes);
  if (!range) return null;

  const moovStart = audio.moov_offset;
  const moovEnd = moovStart + audio.moov_size - 1;
  if (range.start < moovStart || range.start > moovEnd) return null;

  const sliceOffsetInR2 = range.start - moovStart;
  const responseEnd = Math.min(range.end, moovEnd);
  const sliceLen = responseEnd - range.start + 1;

  const r2 = await env.COVERS.get(`moov/${audio.tenant_id}/${audio.id}`, {
    range: { offset: sliceOffsetInR2, length: sliceLen },
  });
  if (!r2) return null;

  return new Response(r2.body, {
    status: 206,
    headers: {
      'Content-Type': audioContentType(audio),
      'Content-Range': `bytes ${range.start}-${responseEnd}/${audio.size_bytes}`,
      'Content-Length': String(sliceLen),
      'Accept-Ranges': 'bytes',
    },
  });
}
