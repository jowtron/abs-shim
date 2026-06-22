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
  // Owning tenant — denormalized in migration 0004. Present on every row
  // post-backfill; treated as required.
  tenant_id: string;
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
  tenant_id: string; // migration 0004
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
  tenant_id: string; // migration 0004
};

export type BookMetadataRow = {
  library_item_id: string;
  tenant_id: string; // migration 0004
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
  tenant_id: string; // migration 0004
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

// Every helper below takes the caller's tenantId and filters on the
// denormalized tenant_id column. The get-by-id helpers are the security
// boundary: a row outside the caller's tenant returns null → the route's
// existing 404 path, which is exactly the cross-tenant isolation we want,
// with no change to the response wire shape. getChapters is the only
// exception: chapters carry no tenant_id, but they're only ever fetched for
// an item that the caller already tenant-verified (via getItem/buildItemBundle).

export async function listLibraries(env: Env, tenantId: string): Promise<LibraryRow[]> {
  const r = await env.DB.prepare(
    'SELECT * FROM libraries WHERE tenant_id = ? ORDER BY display_order ASC, created_at ASC',
  ).bind(tenantId).all<LibraryRow>();
  return r.results;
}

export async function getLibrary(env: Env, id: string, tenantId: string): Promise<LibraryRow | null> {
  return env.DB.prepare('SELECT * FROM libraries WHERE id = ? AND tenant_id = ?').bind(id, tenantId).first<LibraryRow>();
}

export async function listFolders(env: Env, libraryId: string, tenantId: string): Promise<LibraryFolderRow[]> {
  const r = await env.DB.prepare(
    'SELECT * FROM library_folders WHERE library_id = ? AND tenant_id = ? ORDER BY added_at ASC',
  ).bind(libraryId, tenantId).all<LibraryFolderRow>();
  return r.results;
}

export async function getFolderById(env: Env, id: string, tenantId: string): Promise<LibraryFolderRow | null> {
  return env.DB.prepare('SELECT * FROM library_folders WHERE id = ? AND tenant_id = ?').bind(id, tenantId).first<LibraryFolderRow>();
}

// Unscoped folder lookup — ONLY for the HMAC-signed /public/proxy route, where
// authorization comes from the signature (minted for that specific folder),
// not from a user's tenant context. Do not use elsewhere.
export async function getFolderByIdUnscoped(env: Env, id: string): Promise<LibraryFolderRow | null> {
  return env.DB.prepare('SELECT * FROM library_folders WHERE id = ?').bind(id).first<LibraryFolderRow>();
}

export async function listItemsByLibrary(env: Env, libraryId: string, tenantId: string, opts: { limit?: number; offset?: number } = {}): Promise<LibraryItemRow[]> {
  const limit = opts.limit ?? 0;
  const offset = opts.offset ?? 0;
  const sql = limit > 0
    ? 'SELECT * FROM library_items WHERE library_id = ? AND tenant_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?'
    : 'SELECT * FROM library_items WHERE library_id = ? AND tenant_id = ? ORDER BY created_at ASC';
  const stmt = limit > 0
    ? env.DB.prepare(sql).bind(libraryId, tenantId, limit, offset)
    : env.DB.prepare(sql).bind(libraryId, tenantId);
  const r = await stmt.all<LibraryItemRow>();
  return r.results;
}

export async function countItemsByLibrary(env: Env, libraryId: string, tenantId: string): Promise<number> {
  const r = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM library_items WHERE library_id = ? AND tenant_id = ?',
  ).bind(libraryId, tenantId).first<{ n: number }>();
  return r?.n ?? 0;
}

export async function getItem(env: Env, id: string, tenantId: string): Promise<LibraryItemRow | null> {
  return env.DB.prepare('SELECT * FROM library_items WHERE id = ? AND tenant_id = ?').bind(id, tenantId).first<LibraryItemRow>();
}

export async function getBookMetadata(env: Env, itemId: string, tenantId: string): Promise<BookMetadataRow | null> {
  return env.DB.prepare(
    'SELECT * FROM book_metadata WHERE library_item_id = ? AND tenant_id = ?',
  ).bind(itemId, tenantId).first<BookMetadataRow>();
}

export async function getAudioFiles(env: Env, itemId: string, tenantId: string): Promise<AudioFileRow[]> {
  const r = await env.DB.prepare(
    'SELECT * FROM audio_files WHERE library_item_id = ? AND tenant_id = ? ORDER BY index_no ASC',
  ).bind(itemId, tenantId).all<AudioFileRow>();
  return r.results;
}

// Unscoped — see note above; chapters carry no tenant_id and are only fetched
// for an already tenant-verified item.
export async function getChapters(env: Env, itemId: string): Promise<ChapterRow[]> {
  const r = await env.DB.prepare(
    'SELECT * FROM chapters WHERE library_item_id = ? ORDER BY chapter_index ASC',
  ).bind(itemId).all<ChapterRow>();
  return r.results;
}

export async function listAllBookMetadata(env: Env, libraryId: string, tenantId: string): Promise<BookMetadataRow[]> {
  const r = await env.DB.prepare(
    `SELECT bm.* FROM book_metadata bm
     JOIN library_items li ON li.id = bm.library_item_id
     WHERE li.library_id = ? AND bm.tenant_id = ?`,
  ).bind(libraryId, tenantId).all<BookMetadataRow>();
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
  tenantId: string,
): Promise<{ audio: AudioFileRow; folder: LibraryFolderRow } | null> {
  // Tenant filter is a single extra predicate on the existing index — NOT a
  // JOIN — to keep this Range hot path cheap (see migration 0004 rationale).
  const item = await env.DB.prepare(
    'SELECT folder_id FROM library_items WHERE id = ? AND tenant_id = ? LIMIT 1',
  ).bind(itemId, tenantId).first<{ folder_id: string }>();
  if (!item) return null;

  const numericFid = Number(fileId);
  const numericLookup = Number.isFinite(numericFid) ? numericFid : -1;

  // Lookup audio file (by ino preferred, then index_no) and folder in parallel.
  let [audio, folder] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM audio_files
       WHERE library_item_id = ? AND tenant_id = ? AND (ino = ? OR index_no = ?)
       ORDER BY (ino = ?) DESC LIMIT 1`,
    ).bind(itemId, tenantId, fileId, numericLookup, fileId).first<AudioFileRow>(),
    env.DB.prepare(
      'SELECT * FROM library_folders WHERE id = ? AND tenant_id = ? LIMIT 1',
    ).bind(item.folder_id, tenantId).first<LibraryFolderRow>(),
  ]);

  // Preserve the existing route's "fall back to first audio file" behavior for
  // clients that pass an unknown ino/index_no — costs one extra query, only on
  // miss, which should be effectively never in practice.
  if (!audio) {
    audio = await env.DB.prepare(
      'SELECT * FROM audio_files WHERE library_item_id = ? AND tenant_id = ? ORDER BY index_no ASC LIMIT 1',
    ).bind(itemId, tenantId).first<AudioFileRow>();
  }

  if (!audio || !folder) return null;
  return { audio, folder };
}
