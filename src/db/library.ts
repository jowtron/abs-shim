import type { Env } from '../types';

export type LibraryRow = {
  id: string;
  name: string;
  display_order: number;
  media_type: string;
  icon: string;
  provider: string;
  settings: string;
  created_at: number;
  updated_at: number;
};

export type LibraryFolderRow = {
  id: string;
  library_id: string;
  filedn_base_url: string;
  added_at: number;
  // Added in migration 0002 — defaults make existing rows behave like the
  // public_url provider with the legacy filedn_base_url.
  provider?: string;
  config_json?: string;
  profile_id?: string | null;
};

export type LibraryItemRow = {
  id: string;
  library_id: string;
  folder_id: string;
  ino: string | null;
  rel_path: string;
  is_file: number;
  media_type: string;
  is_missing: number;
  is_invalid: number;
  created_at: number;
  updated_at: number;
};

export type BookMetadataRow = {
  library_item_id: string;
  title: string | null;
  title_ignore_prefix: string | null;
  subtitle: string | null;
  author_name: string | null;
  narrator_name: string | null;
  series_name: string | null;
  series_sequence: string | null;
  description: string | null;
  isbn: string | null;
  asin: string | null;
  language: string | null;
  publish_year: number | null;
  publisher: string | null;
  genres: string;
  tags: string;
  explicit: number;
  abridged: number;
  cover_url: string | null;
};

export type AudioFileRow = {
  id: string;
  library_item_id: string;
  index_no: number;
  filedn_url: string;
  ino: string | null;
  duration_seconds: number;
  size_bytes: number;
  mime_type: string | null;
  format: string | null;
  codec: string | null;
  bitrate: number | null;
  sample_rate: number | null;
  channels: number | null;
  added_at: number;
  // Added in migration 0002. NULL for legacy rows (which carry an absolute
  // filedn_url instead) — see src/storage/resolve.ts.
  rel_path?: string | null;
  provider_file_id?: string | null;
  // Added in migration 0003. Absolute byte offset + total size of the m4b's
  // moov atom in the source file. NULL for rows scanned before 0003 (or for
  // non-m4b files); the streaming route backfills on first /play.
  moov_offset?: number | null;
  moov_size?: number | null;
};

export type ChapterRow = {
  library_item_id: string;
  chapter_index: number;
  title: string;
  start_seconds: number;
  end_seconds: number;
};

export async function listLibraries(env: Env): Promise<LibraryRow[]> {
  const r = await env.DB.prepare(
    'SELECT * FROM libraries ORDER BY display_order ASC, created_at ASC',
  ).all<LibraryRow>();
  return r.results;
}

export async function getLibrary(env: Env, id: string): Promise<LibraryRow | null> {
  return env.DB.prepare('SELECT * FROM libraries WHERE id = ?').bind(id).first<LibraryRow>();
}

export async function listFolders(env: Env, libraryId: string): Promise<LibraryFolderRow[]> {
  const r = await env.DB.prepare(
    'SELECT * FROM library_folders WHERE library_id = ? ORDER BY added_at ASC',
  ).bind(libraryId).all<LibraryFolderRow>();
  return r.results;
}

export async function getFolderById(env: Env, id: string): Promise<LibraryFolderRow | null> {
  return env.DB.prepare('SELECT * FROM library_folders WHERE id = ?').bind(id).first<LibraryFolderRow>();
}

export async function listItemsByLibrary(env: Env, libraryId: string, opts: { limit?: number; offset?: number } = {}): Promise<LibraryItemRow[]> {
  const limit = opts.limit ?? 0;
  const offset = opts.offset ?? 0;
  const sql = limit > 0
    ? 'SELECT * FROM library_items WHERE library_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?'
    : 'SELECT * FROM library_items WHERE library_id = ? ORDER BY created_at ASC';
  const stmt = limit > 0
    ? env.DB.prepare(sql).bind(libraryId, limit, offset)
    : env.DB.prepare(sql).bind(libraryId);
  const r = await stmt.all<LibraryItemRow>();
  return r.results;
}

export async function countItemsByLibrary(env: Env, libraryId: string): Promise<number> {
  const r = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM library_items WHERE library_id = ?',
  ).bind(libraryId).first<{ n: number }>();
  return r?.n ?? 0;
}

export async function getItem(env: Env, id: string): Promise<LibraryItemRow | null> {
  return env.DB.prepare('SELECT * FROM library_items WHERE id = ?').bind(id).first<LibraryItemRow>();
}

export async function getBookMetadata(env: Env, itemId: string): Promise<BookMetadataRow | null> {
  return env.DB.prepare(
    'SELECT * FROM book_metadata WHERE library_item_id = ?',
  ).bind(itemId).first<BookMetadataRow>();
}

export async function getAudioFiles(env: Env, itemId: string): Promise<AudioFileRow[]> {
  const r = await env.DB.prepare(
    'SELECT * FROM audio_files WHERE library_item_id = ? ORDER BY index_no ASC',
  ).bind(itemId).all<AudioFileRow>();
  return r.results;
}

export async function getChapters(env: Env, itemId: string): Promise<ChapterRow[]> {
  const r = await env.DB.prepare(
    'SELECT * FROM chapters WHERE library_item_id = ? ORDER BY chapter_index ASC',
  ).bind(itemId).all<ChapterRow>();
  return r.results;
}

export async function listAllBookMetadata(env: Env, libraryId: string): Promise<BookMetadataRow[]> {
  const r = await env.DB.prepare(
    `SELECT bm.* FROM book_metadata bm
     JOIN library_items li ON li.id = bm.library_item_id
     WHERE li.library_id = ?`,
  ).bind(libraryId).all<BookMetadataRow>();
  return r.results;
}

// Slim resolver for the /file/:fileId streaming route. Loads only the
// audio_files row and the library_folders row we need to stream — skips the
// book_metadata + chapters + libraryitem-shape work that buildItemBundle does
// (which the streaming path never reads). Two D1 round-trips instead of five,
// plus matches the existing fileId lookup semantics (try `ino` first, then
// `index_no`, fall back to the first audio file for unknown identifiers).
export async function getStreamingTarget(
  env: Env,
  itemId: string,
  fileId: string,
): Promise<{ audio: AudioFileRow; folder: LibraryFolderRow } | null> {
  const item = await env.DB.prepare(
    'SELECT folder_id FROM library_items WHERE id = ? LIMIT 1',
  ).bind(itemId).first<{ folder_id: string }>();
  if (!item) return null;

  const numericFid = Number(fileId);
  const numericLookup = Number.isFinite(numericFid) ? numericFid : -1;

  // Lookup audio file (by ino preferred, then index_no) and folder in parallel.
  let [audio, folder] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM audio_files
       WHERE library_item_id = ? AND (ino = ? OR index_no = ?)
       ORDER BY (ino = ?) DESC LIMIT 1`,
    ).bind(itemId, fileId, numericLookup, fileId).first<AudioFileRow>(),
    env.DB.prepare(
      'SELECT * FROM library_folders WHERE id = ? LIMIT 1',
    ).bind(item.folder_id).first<LibraryFolderRow>(),
  ]);

  // Preserve the existing route's "fall back to first audio file" behavior for
  // clients that pass an unknown ino/index_no — costs one extra query, only on
  // miss, which should be effectively never in practice.
  if (!audio) {
    audio = await env.DB.prepare(
      'SELECT * FROM audio_files WHERE library_item_id = ? ORDER BY index_no ASC LIMIT 1',
    ).bind(itemId).first<AudioFileRow>();
  }

  if (!audio || !folder) return null;
  return { audio, folder };
}
