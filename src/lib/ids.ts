// Helpers for synthesizing stable derived UUIDs. ABS exposes ids for many
// records that we don't separately persist (book.id distinct from
// libraryItem.id, author.id, series.id). We don't model them as separate
// tables, but clients still expect stable string ids — so we hash them
// deterministically from a parent id + a discriminator.

const enc = new TextEncoder();

async function sha256(input: string): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return new Uint8Array(buf);
}

function bytesToUuid(bytes: Uint8Array): string {
  // Take the first 16 bytes, set version (4) and variant (RFC 4122) bits, format.
  const b = bytes.slice(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export async function derivedId(...parts: string[]): Promise<string> {
  const h = await sha256(parts.join('\x00'));
  return bytesToUuid(h);
}

// Reverse a derivedId(...) UUID back to a representative library_items.id.
// Pholia builds `/api/items/<entity.id>/cover` for everything it renders,
// including the entities in /personalized shelves — which means the route
// receives:
//   - the raw library_items.id (handled by the caller before reaching here)
//   - a derivedId(item.id, 'media') UUID
//   - a derivedId(library.id, 'author', name) UUID (from "Newest Authors")
//   - a derivedId(library.id, 'series', name) UUID (from "Recent Series")
//
// SHA-256 is one-way, but library sizes are small (<~200 items typically),
// so we just compute every possible mapping once and cache it. The resolved
// item is used as the cover source — for an author UUID, we pick that
// author's first-added book; for a series UUID, we pick the series's first
// book by series_sequence (or first-added if no sequence).
type IdMap = Map<string, string>; // uuid -> item_id
let cache: IdMap | null = null;

async function buildMap(db: D1Database): Promise<IdMap> {
  const m: IdMap = new Map();

  // media-id mapping: every item has a 1:1 derivedId(item.id, 'media').
  const items = await db
    .prepare('SELECT id FROM library_items')
    .all<{ id: string }>();
  for (const r of items.results) {
    m.set(await derivedId(r.id, 'media'), r.id);
  }

  // author + series: derived against library.id, so we need each item's
  // library_id and metadata. Pick the first-added book for an author; the
  // earliest-sequence (NULLS LAST) book for a series.
  const meta = await db
    .prepare(`
      SELECT li.id AS item_id, li.library_id, li.created_at,
             bm.author_name, bm.series_name, bm.series_sequence
      FROM library_items li
      LEFT JOIN book_metadata bm ON bm.library_item_id = li.id
      ORDER BY li.created_at ASC
    `)
    .all<{
      item_id: string;
      library_id: string;
      created_at: number;
      author_name: string | null;
      series_name: string | null;
      series_sequence: string | null;
    }>();

  // First-seen wins (because we ORDERed by created_at ASC, oldest first).
  const seenAuthor = new Set<string>();
  const seenSeries = new Map<string, { seq: number; item: string }>();

  for (const row of meta.results) {
    if (row.author_name) {
      for (const a of row.author_name.split(',').map((s) => s.trim()).filter(Boolean)) {
        const key = `${row.library_id}|author|${a}`;
        if (seenAuthor.has(key)) continue;
        seenAuthor.add(key);
        m.set(await derivedId(row.library_id, 'author', a), row.item_id);
      }
    }
    if (row.series_name) {
      const seq = Number(row.series_sequence ?? Number.MAX_SAFE_INTEGER);
      const key = `${row.library_id}|series|${row.series_name}`;
      const prev = seenSeries.get(key);
      if (!prev || seq < prev.seq) {
        seenSeries.set(key, { seq, item: row.item_id });
      }
    }
  }
  for (const [key, val] of seenSeries) {
    const [libraryId, , name] = key.split('|') as [string, string, string];
    m.set(await derivedId(libraryId, 'series', name), val.item);
  }

  return m;
}

// Resolve any UUID-shaped id the cover route receives to a concrete
// library_items.id. Returns null if no derivation matches — caller should
// treat that as "no cover available". Cached at module scope across
// invocations of the same Worker instance; stale entries are tolerable
// since they only affect representative-cover choice (an item-rename or
// metadata edit would invalidate it, but the cache resets on every cold
// start anyway).
export async function resolveItemIdFromUuid(
  db: D1Database,
  uuid: string,
): Promise<string | null> {
  if (!cache) cache = await buildMap(db);
  return cache.get(uuid) ?? null;
}

// Test/admin hook to drop the cache (e.g. after a scan adds new items).
export function invalidateIdMap(): void {
  cache = null;
}
