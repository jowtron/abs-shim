import type { Env } from '../types';
import { getLibrary, type LibraryRow } from './library';

// Library views: extra "libraries" that are filters over a real one (see
// migrations/0015_library_views.sql). Every library route resolves its :id
// through resolveLibraryScope, so a view id works anywhere a library id does.

export type LibraryViewRow = {
  id: string;
  tenant_id: string;
  library_id: string;
  name: string;
  folder_id: string | null;
  include_prefix: string | null;
  exclude_prefix: string | null;
  display_order: number;
  created_at: number;
};

export type LibraryScope = {
  // The id the client asked for (a library or a view), for output fields.
  id: string;
  // The real library. Author/series ids are salted with library.id.
  library: LibraryRow;
  view: LibraryViewRow | null;
  // Extra WHERE terms for library_items, starting with ' AND ', with the
  // table referenced through `col` (e.g. 'li.' or '').
  filter(col: string): { sql: string; binds: string[] };
};

const likePrefix = (p: string) => p.replace(/[\\%_]/g, (ch) => '\\' + ch) + '%';

export function viewFilter(view: LibraryViewRow | null, col: string): { sql: string; binds: string[] } {
  if (!view) return { sql: '', binds: [] };
  let sql = '';
  const binds: string[] = [];
  if (view.folder_id) { sql += ` AND ${col}folder_id = ?`; binds.push(view.folder_id); }
  if (view.include_prefix) { sql += ` AND ${col}rel_path LIKE ? ESCAPE '\\'`; binds.push(likePrefix(view.include_prefix)); }
  if (view.exclude_prefix) { sql += ` AND ${col}rel_path NOT LIKE ? ESCAPE '\\'`; binds.push(likePrefix(view.exclude_prefix)); }
  return { sql, binds };
}

export async function listViews(env: Env, tenantId: string): Promise<LibraryViewRow[]> {
  const r = await env.DB.prepare(
    'SELECT * FROM library_views WHERE tenant_id = ? ORDER BY display_order ASC, name COLLATE NOCASE ASC',
  ).bind(tenantId).all<LibraryViewRow>();
  return r.results;
}

export async function resolveLibraryScope(env: Env, id: string, tenantId: string): Promise<LibraryScope | null> {
  const lib = await getLibrary(env, id, tenantId);
  if (lib) return { id, library: lib, view: null, filter: () => ({ sql: '', binds: [] }) };
  const view = await env.DB.prepare('SELECT * FROM library_views WHERE id = ? AND tenant_id = ?')
    .bind(id, tenantId).first<LibraryViewRow>();
  if (!view) return null;
  const real = await getLibrary(env, view.library_id, tenantId);
  if (!real) return null;
  return { id, library: real, view, filter: (col) => viewFilter(view, col) };
}

// A view dressed as a library row for buildLibrary: the real library's
// settings and media type, the view's id and name, listed after it.
export function viewAsLibraryRow(view: LibraryViewRow, lib: LibraryRow): LibraryRow {
  return { ...lib, id: view.id, name: view.name, display_order: lib.display_order + 1 + view.display_order };
}
