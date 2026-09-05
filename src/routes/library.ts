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
import { listProgressByUser, progressToAbs, type MediaProgressRow } from '../db/progress';

export const libraryRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>();

libraryRoutes.use('*', requireAuth);

libraryRoutes.get('/', async (c) => {
  const tenantId = c.get('tenantId');
  const rows = await listLibraries(c.env, tenantId);
  const libraries = await Promise.all(rows.map(async (row) => {
    const folders = await listFolders(c.env, row.id, tenantId);
    return buildLibrary(row, folders);
  }));
  return c.json({ libraries });
});

libraryRoutes.get('/:id', async (c) => {
  const tenantId = c.get('tenantId');
  const row = await getLibrary(c.env, c.req.param('id'), tenantId);
  if (!row) return c.json({ error: 'Library not found' }, 404);
  const folders = await listFolders(c.env, row.id, tenantId);

  const include = (c.req.query('include') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (include.includes('filterdata')) {
    const metadata = await listAllBookMetadata(c.env, row.id, tenantId);
    return c.json(await buildFilterData({ libraryRow: row, folders, metadata }));
  }
  return c.json(buildLibrary(row, folders));
});

libraryRoutes.get('/:id/personalized', async (c) => {
  const t0 = Date.now();
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');
  const row = await getLibrary(c.env, id, tenantId);
  if (!row) return c.json({ error: 'Library not found' }, 404);
  const t1 = Date.now();

  const items = await listItemsByLibrary(c.env, id, tenantId);
  const t2 = Date.now();

  const bundles = (await Promise.all(items.map(async (item) => {
    const folder = await getFolderById(c.env, item.folder_id, tenantId);
    if (!folder) return null;
    const [metadata, audioFiles, chapters] = await Promise.all([
      getBookMetadata(c.env, item.id, tenantId),
      getAudioFiles(c.env, item.id, tenantId),
      getChapters(c.env, item.id),
    ]);
    return { item, folder, metadata, audioFiles, chapters };
  }))).filter((b): b is NonNullable<typeof b> => b !== null);
  const t3 = Date.now();

  // The caller's book progress feeds the continue-listening shelf and the
  // progress bars on every other shelf's cards.
  const progressRows = (await listProgressByUser(c.env, c.get('userId'))).filter((p) => !p.episode_id);
  const progress = new Map<string, { row: MediaProgressRow; abs: unknown }>();
  for (const p of progressRows) progress.set(p.library_item_id, { row: p, abs: await progressToAbs(c.env, p) });
  const shelves = await buildPersonalizedShelves({ libraryId: id, bundles, progress });
  const t4 = Date.now();

  console.log(`[perf] /personalized lib=${id} items=${items.length} | getLibrary=${t1 - t0}ms listItems=${t2 - t1}ms bundles(N+1)=${t3 - t2}ms shelves=${t4 - t3}ms total=${t4 - t0}ms`);
  return c.json(shelves);
});

libraryRoutes.get('/:id/items', async (c) => {
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');
  const row = await getLibrary(c.env, id, tenantId);
  if (!row) return c.json({ error: 'Library not found' }, 404);

  const limit = Number(c.req.query('limit') ?? '0');
  const page = Number(c.req.query('page') ?? '0');
  const offset = limit > 0 ? page * limit : 0;

  const items = await listItemsByLibrary(c.env, id, tenantId, { limit, offset });
  const total = await countItemsByLibrary(c.env, id, tenantId);

  const results = await Promise.all(items.map(async (item) => {
    const folder = await getFolderById(c.env, item.folder_id, tenantId);
    if (!folder) throw new Error(`folder ${item.folder_id} missing`);
    const [metadata, audioFiles, chapters] = await Promise.all([
      getBookMetadata(c.env, item.id, tenantId),
      getAudioFiles(c.env, item.id, tenantId),
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
// Library search. This returned an empty result set for every query until
// 2026-09-06 — a stub that had never been filled in, so Pholia's search box
// looked broken rather than unimplemented.
//
// ABS's shape: `book` entries are {libraryItem, matchKey, matchText} and the
// author/series/narrator lists are derived from the same matches. Matching is
// a case-insensitive substring over title, subtitle, author, narrator and
// series — no FTS table here (the catalogue's FTS5 is for AudioBookBay), and
// a personal library is small enough that a LIKE scan over book_metadata is
// nothing next to the per-item bundle building below.
libraryRoutes.get('/:id/search', async (c) => {
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');
  const row = await getLibrary(c.env, id, tenantId);
  if (!row) return c.json({ error: 'Library not found' }, 404);

  const q = (c.req.query('q') ?? '').trim();
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? '12') || 12, 1), 50);
  const empty = {
    book: [] as unknown[], podcast: [] as unknown[], authors: [] as unknown[],
    series: [] as unknown[], narrators: [] as unknown[], tags: [] as unknown[],
  };
  if (!q) return c.json(empty);

  // LIKE with an escaped pattern: a title containing % or _ would otherwise
  // turn into a wildcard.
  // LIKE with an escaped pattern: a title containing % or _ would otherwise
  // turn into a wildcard. D1's bind() is positional only — numbered ?1
  // placeholders are rejected with "Wrong number of parameter bindings", so
  // the pattern is simply bound once per placeholder.
  const pattern = '%' + q.replace(/[\\%_]/g, (ch) => '\\' + ch).toLowerCase() + '%';
  const rows = await c.env.DB.prepare(
    `SELECT li.id AS item_id, bm.title, bm.subtitle, bm.author_name, bm.narrator_name, bm.series_name
       FROM library_items li
       JOIN book_metadata bm ON bm.library_item_id = li.id
      WHERE li.library_id = ? AND li.tenant_id = ? AND li.is_missing = 0
        AND (lower(COALESCE(bm.title, '')) LIKE ? ESCAPE '\\'
          OR lower(COALESCE(bm.subtitle, '')) LIKE ? ESCAPE '\\'
          OR lower(COALESCE(bm.author_name, '')) LIKE ? ESCAPE '\\'
          OR lower(COALESCE(bm.narrator_name, '')) LIKE ? ESCAPE '\\'
          OR lower(COALESCE(bm.series_name, '')) LIKE ? ESCAPE '\\')
      ORDER BY
        CASE WHEN lower(COALESCE(bm.title, '')) LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
        bm.title COLLATE NOCASE
      LIMIT ?`,
  ).bind(id, tenantId, pattern, pattern, pattern, pattern, pattern, pattern, limit).all<{
    item_id: string; title: string | null; subtitle: string | null;
    author_name: string | null; narrator_name: string | null; series_name: string | null;
  }>();

  const has = (v: string | null) => !!v && v.toLowerCase().includes(q.toLowerCase());
  const book = [];
  const authors = new Map<string, string>();   // name → id
  const seriesNames = new Set<string>();
  const narrators = new Set<string>();

  for (const r of rows.results) {
    const item = await getItem(c.env, r.item_id, tenantId);
    if (!item) continue;
    const folder = await getFolderById(c.env, item.folder_id, tenantId);
    if (!folder) continue;
    const [metadata, audioFiles, chapters] = await Promise.all([
      getBookMetadata(c.env, item.id, tenantId),
      getAudioFiles(c.env, item.id, tenantId),
      getChapters(c.env, item.id),
    ]);
    // Which field matched, so a client can say why a result is there.
    const matchKey = has(r.title) ? 'title'
      : has(r.subtitle) ? 'subtitle'
      : has(r.author_name) ? 'authors'
      : has(r.narrator_name) ? 'narrators'
      : 'series';
    const matchText = (matchKey === 'title' ? r.title
      : matchKey === 'subtitle' ? r.subtitle
      : matchKey === 'authors' ? r.author_name
      : matchKey === 'narrators' ? r.narrator_name
      : r.series_name) ?? '';
    book.push({
      libraryItem: await buildItemMinified({ item, folder, metadata, audioFiles, chapters }),
      matchKey,
      matchText,
    });
    for (const name of splitList(r.author_name)) {
      if (has(name) && !authors.has(name)) authors.set(name, await derivedId(item.id, 'author', name));
    }
    for (const name of splitList(r.narrator_name)) if (has(name)) narrators.add(name);
    if (has(r.series_name) && r.series_name) seriesNames.add(r.series_name);
  }

  return c.json({
    ...empty,
    book,
    authors: [...authors].map(([name, aid]) => ({ id: aid, name, numBooks: 0 })),
    narrators: [...narrators].map((name) => ({ name, numBooks: 0 })),
    series: await Promise.all([...seriesNames].map(async (name) => ({
      series: { id: await derivedId(id, 'series', name), name },
      books: [] as unknown[],
    }))),
  });
});

// Author and narrator columns hold "A, B & C" style lists.
function splitList(v: string | null): string[] {
  return (v ?? '').split(/,|;|&| and /i).map((s) => s.trim()).filter(Boolean);
}

// Authors aggregated across the library's books. Sorted by name.
libraryRoutes.get('/:id/authors', async (c) => {
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');
  if (!(await getLibrary(c.env, id, tenantId))) return c.json({ error: 'Library not found' }, 404);
  const metadata = await listAllBookMetadata(c.env, id, tenantId);
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

// Series listing: group books by series_name, return one entry per series
// with `books[]` sorted by series_sequence. Pholia's Series tab reads
// `results[].books[].id` to render each book card, so we MUST include the
// books with at least an id + minified media metadata.
libraryRoutes.get('/:id/series', async (c) => {
  const t0 = Date.now();
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');
  if (!(await getLibrary(c.env, id, tenantId))) return c.json({ error: 'Library not found' }, 404);

  const items = await listItemsByLibrary(c.env, id, tenantId);
  const t1 = Date.now();
  const bundles = (await Promise.all(items.map(async (item) => {
    const folder = await getFolderById(c.env, item.folder_id, tenantId);
    if (!folder) return null;
    const [metadata, audioFiles, chapters] = await Promise.all([
      getBookMetadata(c.env, item.id, tenantId),
      getAudioFiles(c.env, item.id, tenantId),
      getChapters(c.env, item.id),
    ]);
    return { item, folder, metadata, audioFiles, chapters };
  }))).filter((b): b is NonNullable<typeof b> => b !== null);
  const t2 = Date.now();

  // Group by series_name. A book with no series is excluded entirely.
  const groups = new Map<string, typeof bundles>();
  for (const b of bundles) {
    if (!b.metadata?.series_name) continue;
    const arr = groups.get(b.metadata.series_name) ?? [];
    arr.push(b);
    groups.set(b.metadata.series_name, arr);
  }

  const seriesArr = await Promise.all(Array.from(groups.entries()).map(async ([name, group]) => {
    // Sort books within series by sequence: numeric ASC, NULL/non-numeric last.
    const sortedBundles = [...group].sort((a, b) => {
      const sa = parseFloat(a.metadata?.series_sequence ?? '');
      const sb = parseFloat(b.metadata?.series_sequence ?? '');
      const ba = Number.isFinite(sa), bb = Number.isFinite(sb);
      if (ba && bb) return sa - sb;
      if (ba) return -1;
      if (bb) return 1;
      return (a.metadata?.title ?? '').localeCompare(b.metadata?.title ?? '');
    });
    const books = await Promise.all(sortedBundles.map((bb) => buildItemMinified(bb)));
    const totalDuration = sortedBundles.reduce(
      (s, bb) => s + bb.audioFiles.reduce((t, a) => t + a.duration_seconds, 0),
      0,
    );
    const addedAt = Math.min(...sortedBundles.map((bb) => bb.item.created_at));
    return {
      id: await derivedId(id, 'series', name),
      name,
      nameIgnorePrefix: name.replace(/^(The|A|An)\s+/i, ''),
      description: null,
      addedAt,
      updatedAt: addedAt,
      libraryId: id,
      books,
      numBooks: books.length,
      totalDuration,
    };
  }));

  // Sort + page. ABS defaults to sort=name asc; Pholia explicitly passes that.
  const sort = c.req.query('sort') ?? 'name';
  const desc = c.req.query('desc') === '1';
  seriesArr.sort((a, b) => {
    const cmp = sort === 'addedAt'
      ? a.addedAt - b.addedAt
      : a.nameIgnorePrefix.localeCompare(b.nameIgnorePrefix);
    return desc ? -cmp : cmp;
  });

  const limit = Number(c.req.query('limit') ?? '0');
  const page = Number(c.req.query('page') ?? '0');
  const offset = limit > 0 ? page * limit : 0;
  const results = limit > 0 ? seriesArr.slice(offset, offset + limit) : seriesArr;
  const t3 = Date.now();

  console.log(`[perf] /series lib=${id} items=${items.length} series=${seriesArr.length} | listItems=${t1 - t0}ms bundles(N+1)=${t2 - t1}ms group+build=${t3 - t2}ms total=${t3 - t0}ms`);
  return c.json({
    results,
    total: seriesArr.length,
    limit,
    page,
    sortBy: sort,
    sortDesc: desc,
    minified: false,
    include: c.req.query('include') ?? '',
  });
});

libraryRoutes.get('/:id/collections', async (c) => {
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');
  if (!(await getLibrary(c.env, id, tenantId))) return c.json({ error: 'Library not found' }, 404);
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

export async function buildItemBundle(env: Env, itemId: string, tenantId: string) {
  const item = await getItem(env, itemId, tenantId);
  if (!item) return null;
  const folder = await getFolderById(env, item.folder_id, tenantId);
  if (!folder) return null;
  const [metadata, audioFiles, chapters] = await Promise.all([
    getBookMetadata(env, item.id, tenantId),
    getAudioFiles(env, item.id, tenantId),
    getChapters(env, item.id),
  ]);
  return { item, folder, metadata, audioFiles, chapters };
}
