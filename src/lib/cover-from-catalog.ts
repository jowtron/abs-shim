// Cover art for books whose files don't carry any.
//
// Plenty of mp3 audiobook rips have no APIC frame at all — Joseph's Philippa
// Gregory releases have an ID3v2.3 tag with title/author/publisher and no
// picture, and the torrents didn't ship a cover.jpg either, so there is
// nothing to extract from anywhere on the storage. The AudioBookBay
// catalogue, on the other hand, has a cover for nearly every post, and most
// are already resized to webp in R2 by the cover runner.
//
// So: match the book against the catalogue by title (and author when we have
// one) and reuse that image as the item's cover. Matching is FTS over
// abb_posts, which is the same index the Add screen searches.

import type { Env } from '../types';

export type CatalogCover = {
  bytes: ArrayBuffer;
  contentType: string;
  postId: number;
  postTitle: string;
  from: 'r2' | 'source';
};

// Strip the noise that stops a library title matching a listing title:
// series suffixes, "unabridged", format words, punctuation.
function terms(title: string, author: string | null): string[] {
  const cleaned = (title || '')
    .replace(/\b(unabridged|abridged|audiobook|mp3|m4b|64k|128k)\b/gi, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[-–—:,.]/g, ' ');
  const words = (cleaned + ' ' + (author ?? ''))
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => w.length > 2);
  // De-duplicate, keep order, cap: an FTS query of 30 required terms matches
  // nothing.
  return [...new Set(words.map((w) => w.toLowerCase()))].slice(0, 8);
}

export async function findCatalogCover(
  env: Env,
  book: { title: string | null; author: string | null },
): Promise<CatalogCover | null> {
  const words = terms(book.title ?? '', book.author);
  if (!words.length) return null;

  // Title words are required; the author's are a bonus, so try the full set
  // first and fall back to the title alone.
  const titleWords = terms(book.title ?? '', null);
  const attempts = [words, titleWords].filter((w) => w.length);

  for (const attempt of attempts) {
    const match = attempt.map((w) => `"${w}"*`).join(' ');
    const row = await env.DB.prepare(
      `SELECT p.id, p.title, p.cover, p.cover_r2
         FROM abb_posts_fts f
         JOIN abb_posts p ON p.id = f.rowid
        WHERE abb_posts_fts MATCH ?
          AND p.cover IS NOT NULL
        ORDER BY bm25(abb_posts_fts, 10.0, 5.0, 1.0, 1.0)
        LIMIT 1`,
    ).bind(match).first<{ id: number; title: string; cover: string; cover_r2: number | null }>()
      .catch(() => null);   // a malformed FTS query is a miss, not a failure
    if (!row) continue;

    // Prefer the resized webp we already hold; it's small and the source
    // hosts these listings use die off over time.
    if (row.cover_r2) {
      const obj = await env.COVERS.get(`abbcovers/${row.id}.webp`);
      if (obj) {
        return { bytes: await obj.arrayBuffer(), contentType: 'image/webp', postId: row.id, postTitle: row.title, from: 'r2' };
      }
    }
    const res = await fetch(row.cover).catch(() => null);
    if (res && res.ok) {
      const type = res.headers.get('content-type') ?? '';
      if (type.startsWith('image/')) {
        return { bytes: await res.arrayBuffer(), contentType: type, postId: row.id, postTitle: row.title, from: 'source' };
      }
    }
  }
  return null;
}

// Drop the edge-cached copy so a newly set cover shows up at once rather
// than after the old response ages out.
export async function purgeCoverCache(itemId: string, requestUrl: string): Promise<void> {
  try {
    const key = new Request(new URL(`/__cover_cache__/${itemId}`, requestUrl).toString(), { method: 'GET' });
    await caches.default.delete(key);
  } catch { /* cache API unavailable in tests */ }
}
