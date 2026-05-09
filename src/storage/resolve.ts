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

// LibraryFolderRow (defined before migration 0002) doesn't include the new
// columns; the runtime row from `SELECT *` does. Cast through a widened type.
function asFolderRow(folder: LibraryFolderRow): FolderRow {
  const f = folder as unknown as FolderRow;
  return {
    id: f.id,
    library_id: f.library_id,
    filedn_base_url: f.filedn_base_url,
    added_at: f.added_at,
    provider: f.provider ?? 'public_url',
    config_json: f.config_json ?? '{}',
    profile_id: f.profile_id ?? null,
  };
}
