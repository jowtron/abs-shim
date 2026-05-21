import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth, type AuthVars } from '../auth/middleware';
import {
  listLibraries, listAllBookMetadata,
} from '../db/library';
import { derivedId } from '../lib/ids';
import { buildItemDetail } from '../lib/abs-shapes';
import { buildItemBundle } from './library';
import { placeholderImage } from '../lib/placeholder';

export const authorRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>();

// Author photo. We don't store author images yet — return a 1x1 transparent
// PNG so Pholia's <img onerror="…"> doesn't fire and the console stays clean.
// Public (no auth) for the same reason cover endpoints are public: <img>
// tags don't always carry Authorization, and clients pass ?token=… anyway.
authorRoutes.get('/:authorId/image', () => placeholderImage());

// Everything else needs auth.
authorRoutes.use('*', requireAuth);

// GET /api/authors/:id — reverse the derivedId(libraryId, 'author', name)
// hash by iterating every library's authors. Returns the matching author
// shape; with ?include=items, attaches `libraryItems` (full ABS item shape
// for every book this author appears on).
authorRoutes.get('/:authorId', async (c) => {
  const authorId = c.req.param('authorId');
  const include = (c.req.query('include') ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  for (const lib of await listLibraries(c.env)) {
    const metadata = await listAllBookMetadata(c.env, lib.id);
    // For each unique author name in this library, the books they appear on.
    const itemsByAuthor = new Map<string, string[]>();
    for (const m of metadata) {
      if (!m.author_name) continue;
      for (const a of m.author_name.split(',').map((s) => s.trim()).filter(Boolean)) {
        const arr = itemsByAuthor.get(a) ?? [];
        arr.push(m.library_item_id);
        itemsByAuthor.set(a, arr);
      }
    }
    for (const [name, itemIds] of itemsByAuthor) {
      const id = await derivedId(lib.id, 'author', name);
      if (id !== authorId) continue;

      const base = {
        id: authorId,
        asin: null as string | null,
        name,
        description: null as string | null,
        imagePath: null as string | null,
        addedAt: 0,
        updatedAt: 0,
        libraryId: lib.id,
        numBooks: itemIds.length,
      };
      if (!include.includes('items')) return c.json(base);

      const libraryItems = (await Promise.all(itemIds.map(async (iid) => {
        const bundle = await buildItemBundle(c.env, iid);
        return bundle ? await buildItemDetail(bundle) : null;
      }))).filter((x): x is NonNullable<typeof x> => x !== null);

      return c.json({ ...base, libraryItems });
    }
  }
  return c.json({ error: 'Author not found' }, 404);
});
