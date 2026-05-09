import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth, type AuthVars } from '../auth/middleware';
import {
  countItemsByLibrary, getAudioFiles, getBookMetadata, getChapters,
  getFolderById, getItem, getLibrary, listAllBookMetadata, listFolders,
  listItemsByLibrary, listLibraries,
} from '../db/library';
import {
  buildFilterData, buildItemMinified, buildLibrary, buildPersonalizedShelves,
} from '../lib/abs-shapes';
import { derivedId } from '../lib/ids';

export const libraryRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>();

libraryRoutes.use('*', requireAuth);

libraryRoutes.get('/', async (c) => {
  const rows = await listLibraries(c.env);
  const libraries = await Promise.all(rows.map(async (row) => {
    const folders = await listFolders(c.env, row.id);
    return buildLibrary(row, folders);
  }));
  return c.json({ libraries });
});

libraryRoutes.get('/:id', async (c) => {
  const row = await getLibrary(c.env, c.req.param('id'));
  if (!row) return c.json({ error: 'Library not found' }, 404);
  const folders = await listFolders(c.env, row.id);

  const include = (c.req.query('include') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (include.includes('filterdata')) {
    const metadata = await listAllBookMetadata(c.env, row.id);
    return c.json(await buildFilterData({ libraryRow: row, folders, metadata }));
  }
  return c.json(buildLibrary(row, folders));
});

libraryRoutes.get('/:id/personalized', async (c) => {
  const id = c.req.param('id');
  const row = await getLibrary(c.env, id);
  if (!row) return c.json({ error: 'Library not found' }, 404);

  const items = await listItemsByLibrary(c.env, id);
  const bundles = (await Promise.all(items.map(async (item) => {
    const folder = await getFolderById(c.env, item.folder_id);
    if (!folder) return null;
    const [metadata, audioFiles, chapters] = await Promise.all([
      getBookMetadata(c.env, item.id),
      getAudioFiles(c.env, item.id),
      getChapters(c.env, item.id),
    ]);
    return { item, folder, metadata, audioFiles, chapters };
  }))).filter((b): b is NonNullable<typeof b> => b !== null);

  return c.json(await buildPersonalizedShelves({ libraryId: id, bundles }));
});

libraryRoutes.get('/:id/items', async (c) => {
  const id = c.req.param('id');
  const row = await getLibrary(c.env, id);
  if (!row) return c.json({ error: 'Library not found' }, 404);

  const limit = Number(c.req.query('limit') ?? '0');
  const page = Number(c.req.query('page') ?? '0');
  const offset = limit > 0 ? page * limit : 0;

  const items = await listItemsByLibrary(c.env, id, { limit, offset });
  const total = await countItemsByLibrary(c.env, id);

  const results = await Promise.all(items.map(async (item) => {
    const folder = await getFolderById(c.env, item.folder_id);
    if (!folder) throw new Error(`folder ${item.folder_id} missing`);
    const [metadata, audioFiles, chapters] = await Promise.all([
      getBookMetadata(c.env, item.id),
      getAudioFiles(c.env, item.id),
      getChapters(c.env, item.id),
    ]);
    return buildItemMinified({ item, folder, metadata, audioFiles, chapters });
  }));

  return c.json({
    results,
    total,
    limit,
    page,
    sortDesc: false,
    mediaType: row.media_type,
    minified: false,
    collapseseries: false,
    include: '',
    offset,
  });
});

// Stub: trigger a (re)scan. We don't have a scanner yet, so 200 OK and noop.
libraryRoutes.post('/:id/scan', async (c) => c.text('OK'));

// Search stub. ShelfPlayer hits this when displaying author/narrator pages —
// it's expected to return books/authors/series/narrators arrays. Returning
// empty arrays of each kind is enough to keep the client happy until we wire
// real search.
libraryRoutes.get('/:id/search', async (c) => {
  return c.json({
    book: [] as unknown[],
    podcast: [] as unknown[],
    authors: [] as unknown[],
    series: [] as unknown[],
    narrators: [] as unknown[],
    tags: [] as unknown[],
  });
});

// Authors aggregated across the library's books. Sorted by name.
libraryRoutes.get('/:id/authors', async (c) => {
  const id = c.req.param('id');
  if (!(await getLibrary(c.env, id))) return c.json({ error: 'Library not found' }, 404);
  const metadata = await listAllBookMetadata(c.env, id);
  const counts = new Map<string, number>();
  for (const m of metadata) {
    if (!m.author_name) continue;
    for (const a of m.author_name.split(',').map((s) => s.trim()).filter(Boolean)) {
      counts.set(a, (counts.get(a) ?? 0) + 1);
    }
  }
  const authors = await Promise.all(Array.from(counts.entries()).sort(([a], [b]) => a.localeCompare(b)).map(async ([name, numBooks]) => {
    const aid = await derivedId(id, 'author', name);
    return {
      id: aid,
      asin: null,
      name,
      description: null,
      imagePath: null,
      libraryId: id,
      addedAt: 0,
      updatedAt: 0,
      numBooks,
      lastFirst: nameLF(name),
    };
  }));
  return c.json({ authors });
});

// Series and collections — return empty paged result for now. (We do have
// series data inline in book_metadata; clients render series via the books'
// metadata. Building a /series listing is a larger job and not required for
// playback or browsing.)
libraryRoutes.get('/:id/series', async (c) => {
  const id = c.req.param('id');
  if (!(await getLibrary(c.env, id))) return c.json({ error: 'Library not found' }, 404);
  return c.json(emptyPagedResult());
});

libraryRoutes.get('/:id/collections', async (c) => {
  const id = c.req.param('id');
  if (!(await getLibrary(c.env, id))) return c.json({ error: 'Library not found' }, 404);
  return c.json(emptyPagedResult());
});

function emptyPagedResult() {
  return {
    results: [] as unknown[],
    total: 0,
    limit: 0,
    page: 0,
    sortDesc: false,
    minified: false,
    include: '',
  };
}

function nameLF(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  const last = parts.pop()!;
  return `${last}, ${parts.join(' ')}`;
}

export async function buildItemBundle(env: Env, itemId: string) {
  const item = await getItem(env, itemId);
  if (!item) return null;
  const folder = await getFolderById(env, item.folder_id);
  if (!folder) return null;
  const [metadata, audioFiles, chapters] = await Promise.all([
    getBookMetadata(env, item.id),
    getAudioFiles(env, item.id),
    getChapters(env, item.id),
  ]);
  return { item, folder, metadata, audioFiles, chapters };
}
