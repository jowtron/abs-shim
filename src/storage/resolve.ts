import type { Env } from '../types';
import type { AudioFileRow, LibraryFolderRow } from '../db/library';
import { getAdapter, type FolderRow } from './factory';

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

export async function resolveProbeUrl(
  env: Env,
  folder: LibraryFolderRow,
  audio: AudioFileRow,
): Promise<{ url: string; expiresAt?: number }> {
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
export async function streamAudio(
  env: Env,
  folder: LibraryFolderRow,
  audio: AudioFileRow,
  req: Request,
): Promise<Response> {
  const stream = await resolveStreamUrl(env, folder, audio);
  const provider = folder.provider ?? 'public_url';

  if (provider === 'pcloud_oauth') {
    const fwd = new Headers();
    const range = req.headers.get('Range');
    if (range) fwd.set('Range', range);
    const upstream = await fetch(stream.url, { headers: fwd });
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
