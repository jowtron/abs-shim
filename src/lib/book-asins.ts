import type { Env } from '../types';
import { derivedId } from './ids';
import { splitPersonNames } from './names';

// Audible book ASINs, recorded on book_metadata.asin (2026-10-04). The
// scanner can't know them (the m4b carries no ASIN tag), but the Audible
// sync does: every synced title is `{asin, path}` in its records. With the
// ASIN, an author the Audnexus name search can't find can be found through
// the book itself (lookupAudnexusByBooks in ./audnexus.ts).
//
// `path` is the synced file's path under the library root; the library item
// is its folder (or the file itself for a loose single-file book). Only
// empty asin columns are filled. Authors of newly-tagged books who have no
// photo get their lookup clock reset, so the next authors listing tries the
// book route instead of waiting out the 30-day miss.
export async function recordBookAsins(env: Env, tenantId: string, recs: Array<{ asin: string; path: string }>): Promise<number> {
  const valid = recs.filter((r) => /^[A-Z0-9]{10}$/.test(r.asin) && r.path);
  if (!valid.length) return 0;
  let changed = 0;
  const touched: Array<{ library_id: string; author_name: string | null }> = [];
  for (const r of valid) {
    const dir = r.path.includes('/') ? r.path.slice(0, r.path.lastIndexOf('/')) : r.path;
    const rows = (await env.DB.prepare(
      `UPDATE book_metadata SET asin = ?
        WHERE tenant_id = ? AND (asin IS NULL OR asin = '')
          AND library_item_id IN (SELECT id FROM library_items WHERE tenant_id = ? AND (rel_path = ? OR rel_path = ?))
        RETURNING library_item_id, author_name`,
    ).bind(r.asin, tenantId, tenantId, dir, r.path).all<{ library_item_id: string; author_name: string | null }>()).results;
    for (const row of rows) {
      changed++;
      const li = await env.DB.prepare('SELECT library_id FROM library_items WHERE id = ?').bind(row.library_item_id).first<{ library_id: string }>();
      if (li) touched.push({ library_id: li.library_id, author_name: row.author_name });
    }
  }
  const ids = new Set<string>();
  for (const t of touched) for (const name of splitPersonNames(t.author_name)) ids.add(await derivedId(t.library_id, 'author', name));
  for (const id of ids) {
    await env.DB.prepare('UPDATE author_meta SET checked_at = NULL WHERE author_id = ? AND image_url IS NULL').bind(id).run();
  }
  return changed;
}
