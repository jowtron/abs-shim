import { Hono, type Context } from 'hono';
import type { Env } from '../types';
import { requireAuth, requireTenantOwner, type AuthVars } from '../auth/middleware';
import {
  countItemsByLibrary, getAudioFiles, getBookMetadata, getChapters,
  getFolderById, getItem, getLibrary, listAllBookMetadata, listFolders,
  listItemsByLibrary, listLibraries, loadItemBundles,
  type LibraryFolderRow, type LibraryItemRow,
} from '../db/library';
import { getEpisodeCounts, getPodcasts, type EpisodeRow, type PodcastRow } from '../db/podcasts';
import { buildEpisodeExpanded, buildPodcastItemMinified, buildPodcastOld } from '../lib/podcast-shapes';
import { buildOpml } from '../lib/rss';
import { downloadJson } from './podcasts';
import { libraryPlaylists } from './playlists';
import {
  buildFilterData, buildItemMinified, buildLibrary, buildPersonalizedShelves,
} from '../lib/abs-shapes';
import { derivedId } from '../lib/ids';
import { splitPersonNames } from '../lib/names';
import { listProgressByUser, progressToAbs, type MediaProgressRow } from '../db/progress';
import { libraryStats } from '../db/stats';
import { listViews, resolveLibraryScope, viewAsLibraryRow } from '../db/library-views';
import { authorJson, ensureAuthorMeta, getAuthorMetasForLibrary, needsLookup } from '../lib/audnexus';

export const libraryRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>();

libraryRoutes.use('*', requireAuth);

libraryRoutes.get('/', async (c) => {
  const tenantId = c.get('tenantId');
  const [rows, views] = await Promise.all([listLibraries(c.env, tenantId), listViews(c.env, tenantId)]);
  const libraries = await Promise.all(rows.map(async (row) => {
    const folders = await listFolders(c.env, row.id, tenantId);
    // Views list straight after their library (see src/db/library-views.ts).
    return [buildLibrary(row, folders), ...views.filter((v) => v.library_id === row.id)
      .map((v) => buildLibrary(viewAsLibraryRow(v, row), folders))];
  }));
  return c.json({ libraries: libraries.flat() });
});

libraryRoutes.get('/:id', async (c) => {
  const tenantId = c.get('tenantId');
  const scope = await resolveLibraryScope(c.env, c.req.param('id'), tenantId);
  if (!scope) return c.json({ error: 'Library not found' }, 404);
  const folders = await listFolders(c.env, scope.library.id, tenantId);
  const shown = scope.view ? viewAsLibraryRow(scope.view, scope.library) : scope.library;

  const include = (c.req.query('include') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (include.includes('filterdata') && scope.library.media_type === 'podcast') {
    return c.json(await podcastFilterData(c.env, scope, tenantId, folders));
  }
  if (include.includes('filterdata')) {
    const metadata = await listAllBookMetadata(c.env, scope.library.id, tenantId, scope.filter('li.'));
    // Ids are salted with the real library; the library shown is the view.
    const fd = await buildFilterData({ libraryRow: scope.library, folders, metadata });
    return c.json({ ...fd, library: buildLibrary(shown, folders) });
  }
  return c.json(buildLibrary(shown, folders));
});

// PATCH /api/libraries/:id — ABS's library settings update, for the one
// setting the shim acts on: settings.markAsFinishedTimeRemaining, the
// seconds left at which an episode counts as played (a show can override it,
// PATCH /api/items/:id/media). Other fields are ignored. A view's settings
// are its library's.
libraryRoutes.patch('/:id', requireTenantOwner, async (c) => {
  const tenantId = c.get('tenantId');
  const scope = await resolveLibraryScope(c.env, c.req.param('id'), tenantId);
  if (!scope) return c.json({ error: 'Library not found' }, 404);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const incoming = (body['settings'] && typeof body['settings'] === 'object' ? body['settings'] : {}) as Record<string, unknown>;
  const fin = incoming['markAsFinishedTimeRemaining'];
  if (typeof fin === 'number' && Number.isFinite(fin) && fin >= 0 && fin <= 3600) {
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(scope.library.settings || '{}') as Record<string, unknown>; } catch {}
    settings['markAsFinishedTimeRemaining'] = Math.round(fin);
    await c.env.DB.prepare('UPDATE libraries SET settings = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
      .bind(JSON.stringify(settings), Date.now(), scope.library.id, tenantId).run();
  }
  const fresh = (await getLibrary(c.env, scope.library.id, tenantId))!;
  return c.json(buildLibrary(fresh, await listFolders(c.env, fresh.id, tenantId)));
});

libraryRoutes.get('/:id/personalized', async (c) => {
  const t0 = Date.now();
  const tenantId = c.get('tenantId');
  const scope = await resolveLibraryScope(c.env, c.req.param('id'), tenantId);
  if (!scope) return c.json({ error: 'Library not found' }, 404);
  const id = scope.library.id;
  if (scope.library.media_type === 'podcast') return podcastPersonalized(c, scope);
  const t1 = Date.now();

  const items = await listItemsByLibrary(c.env, id, tenantId, { view: scope.filter('') });
  const t2 = Date.now();

  const bundles = await loadItemBundles(c.env, items, tenantId);
  const t3 = Date.now();

  // The caller's book progress feeds the continue-listening shelf and the
  // progress bars on every other shelf's cards.
  const progressRows = (await listProgressByUser(c.env, c.get('userId'))).filter((p) => !p.episode_id);
  const progress = new Map<string, { row: MediaProgressRow; abs: unknown }>();
  for (const p of progressRows) progress.set(p.library_item_id, { row: p, abs: await progressToAbs(c.env, p) });
  const shelves = await buildPersonalizedShelves({ libraryId: id, bundles, progress });
  const t4 = Date.now();

  console.log(`[perf] /personalized lib=${scope.id} items=${items.length} | getLibrary=${t1 - t0}ms listItems=${t2 - t1}ms bundles(batched)=${t3 - t2}ms shelves=${t4 - t3}ms total=${t4 - t0}ms`);
  return c.json(shelves);
});

libraryRoutes.get('/:id/items', async (c) => {
  const tenantId = c.get('tenantId');
  const scope = await resolveLibraryScope(c.env, c.req.param('id'), tenantId);
  if (!scope) return c.json({ error: 'Library not found' }, 404);
  const id = scope.library.id;
  const row = scope.library;
  if (row.media_type === 'podcast') return podcastItems(c, scope);

  const limit = Number(c.req.query('limit') ?? '0');
  const page = Number(c.req.query('page') ?? '0');
  const offset = limit > 0 ? page * limit : 0;
  // ABS filters are `<group>.<base64 value>`, except `issues`, which is bare.
  // Only that one is honoured here (see listItemsByLibrary); the others fall
  // through to the unfiltered list as before.
  const filter = c.req.query('filter') ?? '';
  const issuesOnly = filter === 'issues';

  const view = scope.filter('');
  const items = await listItemsByLibrary(c.env, id, tenantId, { limit, offset, issuesOnly, view });
  const total = await countItemsByLibrary(c.env, id, tenantId, { issuesOnly, view });

  const bundles = await loadItemBundles(c.env, items, tenantId);
  if (bundles.length !== items.length) throw new Error('a library item references a missing folder');
  const results = await Promise.all(bundles.map((b) => buildItemMinified(b)));

  return c.json({
    results,
    total,
    limit,
    page,
    sortDesc: false,
    ...(filter ? { filterBy: filter } : {}),
    mediaType: row.media_type,
    minified: false,
    collapseseries: false,
    include: '',
    offset,
  });
});

// GET /api/libraries/:id/stats — the numbers behind Absorb's library page
// and the web UI's Stats tab. Absent until 2026-09-06, which read as
// "0 books" in Absorb's library list.
libraryRoutes.get('/:id/stats', async (c) => {
  const tenantId = c.get('tenantId');
  const scope = await resolveLibraryScope(c.env, c.req.param('id'), tenantId);
  if (!scope) return c.json({ error: 'Library not found' }, 404);
  return c.json(await libraryStats(c.env, scope.library.id, tenantId, scope.filter('li.')));
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
  const scope = await resolveLibraryScope(c.env, c.req.param('id'), tenantId);
  if (!scope) return c.json({ error: 'Library not found' }, 404);
  const id = scope.library.id;
  const view = scope.filter('li.');

  const q = (c.req.query('q') ?? '').trim();
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? '12') || 12, 1), 50);
  const empty = {
    book: [] as unknown[], podcast: [] as unknown[], authors: [] as unknown[],
    series: [] as unknown[], narrators: [] as unknown[], tags: [] as unknown[],
  };
  if (!q) return c.json(empty);
  if (scope.library.media_type === 'podcast') return podcastSearch(c, scope, q, limit);

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
      WHERE li.library_id = ? AND li.tenant_id = ? AND li.is_missing = 0${view.sql}
        AND (lower(COALESCE(bm.title, '')) LIKE ? ESCAPE '\\'
          OR lower(COALESCE(bm.subtitle, '')) LIKE ? ESCAPE '\\'
          OR lower(COALESCE(bm.author_name, '')) LIKE ? ESCAPE '\\'
          OR lower(COALESCE(bm.narrator_name, '')) LIKE ? ESCAPE '\\'
          OR lower(COALESCE(bm.series_name, '')) LIKE ? ESCAPE '\\')
      ORDER BY
        CASE WHEN lower(COALESCE(bm.title, '')) LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
        bm.title COLLATE NOCASE
      LIMIT ?`,
  ).bind(id, tenantId, ...view.binds, pattern, pattern, pattern, pattern, pattern, pattern, limit).all<{
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
    for (const name of splitPersonNames(r.author_name)) {
      // Salt with the library id, like every other author id (see abs-shapes).
      if (has(name) && !authors.has(name)) authors.set(name, await derivedId(id, 'author', name));
    }
    for (const name of splitPersonNames(r.narrator_name)) if (has(name)) narrators.add(name);
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


// Authors aggregated across the library's books. Sorted by name.
// GET /api/libraries/:id/authors. Two response shapes, like real ABS: with
// numeric `limit` AND `page` it is a paged {results, total, ...} result,
// otherwise the plain {authors: [...]}. ShelfPlayer always asks paged and
// decodes `total` as required — until 2026-09-06 the shim answered the plain
// shape regardless, the decode failed, and its Authors tab showed "Content
// unavailable". Author descriptions and images come from author_meta
// (Audnexus, see src/lib/audnexus.ts); authors not yet looked up are looked
// up in the background, a few per request, so a second load has them.
libraryRoutes.get('/:id/authors', async (c) => {
  const tenantId = c.get('tenantId');
  const scope = await resolveLibraryScope(c.env, c.req.param('id'), tenantId);
  if (!scope) return c.json({ error: 'Library not found' }, 404);
  const id = scope.library.id;
  const metadata = await listAllBookMetadata(c.env, id, tenantId, scope.filter('li.'));
  const counts = new Map<string, number>();
  for (const m of metadata) {
    if (!m.author_name) continue;
    for (const a of splitPersonNames(m.author_name)) {
      counts.set(a, (counts.get(a) ?? 0) + 1);
    }
  }
  const metas = await getAuthorMetasForLibrary(c.env, id);
  const authors = await Promise.all(Array.from(counts.entries()).map(async ([name, numBooks]) => {
    const aid = await derivedId(id, 'author', name);
    return { ...authorJson({ id: aid, name, libraryId: id, numBooks, meta: metas.get(aid) }), lastFirst: nameLF(name) };
  }));

  const pending = authors.filter((a) => needsLookup(metas.get(a.id))).slice(0, 4);
  if (pending.length) {
    c.executionCtx.waitUntil(Promise.all(pending.map((a) =>
      ensureAuthorMeta(c.env, { authorId: a.id, tenantId, libraryId: id, name: a.name }).catch(() => undefined))));
  }

  const sort = c.req.query('sort') ?? 'name';
  const desc = c.req.query('desc') === '1';
  const byName = (x: string, y: string) => x.localeCompare(y, undefined, { sensitivity: 'base' });
  authors.sort((a, b) => {
    let cmp: number;
    if (sort === 'numBooks') cmp = a.numBooks - b.numBooks;
    else if (sort === 'lastFirst') cmp = byName(a.lastFirst, b.lastFirst);
    else if (sort === 'addedAt' || sort === 'updatedAt') cmp = a.updatedAt - b.updatedAt;
    else cmp = byName(a.name, b.name);
    return desc ? -cmp : cmp;
  });

  const limitQ = c.req.query('limit');
  const pageQ = c.req.query('page');
  const paginated = !!limitQ && !isNaN(Number(limitQ)) && pageQ !== undefined && !isNaN(Number(pageQ));
  if (!paginated) return c.json({ authors });
  const limit = Number(limitQ);
  const page = Number(pageQ);
  const results = limit > 0 ? authors.slice(page * limit, page * limit + limit) : authors;
  const include = c.req.query('include');
  return c.json({
    results,
    total: authors.length,
    limit,
    page,
    sortBy: sort,
    sortDesc: desc,
    minified: c.req.query('minified') === '1',
    ...(include !== undefined ? { include } : {}),
  });
});

// Series listing: group books by series_name, return one entry per series
// with `books[]` sorted by series_sequence. Pholia's Series tab reads
// `results[].books[].id` to render each book card, so we MUST include the
// books with at least an id + minified media metadata.
libraryRoutes.get('/:id/series', async (c) => {
  const t0 = Date.now();
  const tenantId = c.get('tenantId');
  const scope = await resolveLibraryScope(c.env, c.req.param('id'), tenantId);
  if (!scope) return c.json({ error: 'Library not found' }, 404);
  const id = scope.library.id;

  const items = await listItemsByLibrary(c.env, id, tenantId, { view: scope.filter('') });
  const t1 = Date.now();
  const bundles = await loadItemBundles(c.env, items, tenantId);
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

  console.log(`[perf] /series lib=${id} items=${items.length} series=${seriesArr.length} | listItems=${t1 - t0}ms bundles(batched)=${t2 - t1}ms group+build=${t3 - t2}ms total=${t3 - t0}ms`);
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

libraryRoutes.get('/:id/playlists', async (c) => {
  const scope = await resolveLibraryScope(c.env, c.req.param('id'), c.get('tenantId'));
  if (!scope) return c.json({ error: 'Library not found' }, 404);
  return libraryPlaylists(c, scope.library.id);
});

libraryRoutes.get('/:id/collections', async (c) => {
  const tenantId = c.get('tenantId');
  if (!(await resolveLibraryScope(c.env, c.req.param('id'), tenantId))) return c.json({ error: 'Library not found' }, 404);
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

// ─── Podcast libraries ───────────────────────────────────────────────────────
//
// A library whose media_type is 'podcast' holds shows, not books (migration
// 0016). These build ABS's podcast-library answers; the routes above branch
// to them on scope.library.media_type.

type PodcastScope = NonNullable<Awaited<ReturnType<typeof resolveLibraryScope>>>;

async function podcastItemsMinified(env: Env, items: LibraryItemRow[], tenantId: string) {
  const ids = items.map((i) => i.id);
  const [pods, counts] = await Promise.all([getPodcasts(env, ids, tenantId), getEpisodeCounts(env, ids, tenantId)]);
  return Promise.all(items.filter((i) => pods.has(i.id)).map((i) => buildPodcastItemMinified(i, pods.get(i.id)!, counts.get(i.id))));
}

const byTitle = (a: { media: { metadata: { titleIgnorePrefix: string | null } } }, b: typeof a) =>
  (a.media.metadata.titleIgnorePrefix ?? '').localeCompare(b.media.metadata.titleIgnorePrefix ?? '', undefined, { sensitivity: 'base' });

async function podcastItems(c: Context<{ Bindings: Env; Variables: AuthVars }>, scope: PodcastScope) {
  const tenantId = c.get('tenantId');
  const items = await listItemsByLibrary(c.env, scope.library.id, tenantId, { view: scope.filter('') });
  const all = await podcastItemsMinified(c.env, items, tenantId);
  const sort = c.req.query('sort') ?? 'media.metadata.title';
  const desc = c.req.query('desc') === '1';
  all.sort((a, b) => {
    const cmp = sort === 'addedAt' ? a.addedAt - b.addedAt
      : sort === 'media.numTracks' || sort === 'media.numEpisodes' ? a.media.numEpisodes - b.media.numEpisodes
        : byTitle(a, b);
    return desc ? -cmp : cmp;
  });
  const limit = Number(c.req.query('limit') ?? '0');
  const page = Number(c.req.query('page') ?? '0');
  const offset = limit > 0 ? page * limit : 0;
  return c.json({
    results: limit > 0 ? all.slice(offset, offset + limit) : all,
    total: all.length, limit, page, sortBy: sort, sortDesc: desc, mediaType: 'podcast',
    minified: false, collapseseries: false, include: '', offset,
  });
}

type EpisodeWithShow = EpisodeRow & { li_library_id: string };

// Episodes on the shows of one library, joined to the caller's progress.
async function libraryEpisodes(env: Env, scope: PodcastScope, tenantId: string, userId: string, opts: {
  where: string; order: string; limit: number; offset?: number;
}) {
  const view = scope.filter('li.');
  const r = await env.DB.prepare(
    `SELECT e.*, li.library_id AS li_library_id FROM podcast_episodes e
       JOIN library_items li ON li.id = e.library_item_id
       LEFT JOIN media_progress mp ON mp.library_item_id = e.library_item_id AND mp.episode_id = e.id AND mp.user_id = ?
      WHERE li.library_id = ? AND e.tenant_id = ? AND e.in_library = 1${view.sql} AND ${opts.where}
      ORDER BY ${opts.order} LIMIT ? OFFSET ?`,
  ).bind(userId, scope.library.id, tenantId, ...view.binds, opts.limit, opts.offset ?? 0).all<EpisodeWithShow>();
  return r.results;
}

async function showsFor(env: Env, itemIds: string[], tenantId: string) {
  const uniq = [...new Set(itemIds)];
  const items = new Map<string, LibraryItemRow>();
  for (let i = 0; i < uniq.length; i += 90) {
    const part = uniq.slice(i, i + 90);
    const r = await env.DB.prepare(`SELECT * FROM library_items WHERE id IN (${part.map(() => '?').join(',')}) AND tenant_id = ?`)
      .bind(...part, tenantId).all<LibraryItemRow>();
    for (const row of r.results) items.set(row.id, row);
  }
  const [pods, counts] = await Promise.all([getPodcasts(env, uniq, tenantId), getEpisodeCounts(env, uniq, tenantId)]);
  const folderIds = [...new Set([...items.values()].map((i) => i.folder_id))];
  const folders = new Map<string, LibraryFolderRow>();
  for (const id of folderIds) {
    const f = await getFolderById(env, id, tenantId);
    if (f) folders.set(id, f);
  }
  return { items, pods, counts, folders };
}

// ABS's recent-episodes entry: the expanded episode, plus `podcast` (the show
// with an empty episode list) and `libraryId`.
async function recentEpisodeEntries(env: Env, eps: EpisodeWithShow[], tenantId: string, progress?: Map<string, unknown>) {
  const { items, pods, folders } = await showsFor(env, eps.map((e) => e.library_item_id), tenantId);
  const out = [];
  for (const e of eps) {
    const item = items.get(e.library_item_id);
    const p = pods.get(e.library_item_id);
    const folder = item ? folders.get(item.folder_id) : undefined;
    if (!item || !p || !folder) continue;
    out.push({
      ...await buildEpisodeExpanded(e, item, folder),
      podcast: await buildPodcastOld(item, p),
      libraryId: item.library_id,
      ...(progress?.has(e.id) ? { mediaProgress: progress.get(e.id) } : {}),
    });
  }
  return out;
}

// Shelf entities for episode shelves: the show (minified) with the episode
// as `recentEpisode`, which is how ABS shapes continue-listening and
// newest-episodes in a podcast library.
async function episodeShelfEntities(env: Env, eps: EpisodeWithShow[], tenantId: string, progress: Map<string, unknown>) {
  const { items, pods, counts, folders } = await showsFor(env, eps.map((e) => e.library_item_id), tenantId);
  const out = [];
  for (const e of eps) {
    const item = items.get(e.library_item_id);
    const p = pods.get(e.library_item_id);
    const folder = item ? folders.get(item.folder_id) : undefined;
    if (!item || !p || !folder) continue;
    const show = await buildPodcastItemMinified(item, p, counts.get(item.id));
    out.push({
      ...show,
      recentEpisode: await buildEpisodeExpanded(e, item, folder),
      ...(progress.has(e.id) ? { mediaProgress: progress.get(e.id) } : {}),
    });
  }
  return out;
}

async function episodeProgress(env: Env, userId: string) {
  const rows = (await listProgressByUser(env, userId)).filter((p) => p.episode_id);
  const map = new Map<string, unknown>();
  for (const p of rows) map.set(p.episode_id!, await progressToAbs(env, p));
  return map;
}

async function podcastPersonalized(c: Context<{ Bindings: Env; Variables: AuthVars }>, scope: PodcastScope) {
  const tenantId = c.get('tenantId');
  const userId = c.get('userId');
  const progress = await episodeProgress(c.env, userId);
  const [inProgress, newest, finished] = await Promise.all([
    libraryEpisodes(c.env, scope, tenantId, userId, {
      where: 'mp.progress > 0 AND mp.is_finished = 0 AND mp.hide_from_continue_listening = 0',
      order: 'mp.last_update DESC', limit: 20,
    }),
    libraryEpisodes(c.env, scope, tenantId, userId, { where: 'COALESCE(mp.is_finished, 0) = 0', order: 'e.published_at DESC', limit: 25 }),
    libraryEpisodes(c.env, scope, tenantId, userId, { where: 'mp.is_finished = 1', order: 'mp.finished_at DESC', limit: 20 }),
  ]);
  const items = await listItemsByLibrary(c.env, scope.library.id, tenantId, { view: scope.filter('') });
  const shows = await podcastItemsMinified(c.env, items, tenantId);
  const recentlyAdded = [...shows].sort((a, b) => b.addedAt - a.addedAt);
  const continueListening = await episodeShelfEntities(c.env, inProgress, tenantId, progress);
  const newestEpisodes = await episodeShelfEntities(c.env, newest, tenantId, progress);
  const listenAgain = await episodeShelfEntities(c.env, finished, tenantId, progress);
  const shelf = (id: string, label: string, key: string, type: string, entities: unknown[]) =>
    ({ id, label, labelStringKey: key, type, entities, total: entities.length });
  return c.json([
    shelf('continue-listening', 'Continue Listening', 'LabelContinueListening', 'episode', continueListening),
    shelf('newest-episodes', 'Newest Episodes', 'LabelNewestEpisodes', 'episode', newestEpisodes),
    shelf('recently-added', 'Recently Added', 'LabelRecentlyAdded', 'podcast', recentlyAdded),
    shelf('listen-again', 'Listen Again', 'LabelListenAgain', 'episode', listenAgain),
    shelf('discover', 'Discover', 'LabelDiscover', 'podcast', [...shows].sort(byTitle)),
  ].filter((s) => s.entities.length));
}

libraryRoutes.get('/:id/recent-episodes', async (c) => {
  const tenantId = c.get('tenantId');
  const scope = await resolveLibraryScope(c.env, c.req.param('id'), tenantId);
  if (!scope || scope.library.media_type !== 'podcast') return c.json({ error: 'Not a podcast library' }, 404);
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? '25') || 25, 1), 200);
  const page = Math.max(Number(c.req.query('page') ?? '0') || 0, 0);
  const eps = await libraryEpisodes(c.env, scope, tenantId, c.get('userId'), {
    where: 'COALESCE(mp.is_finished, 0) = 0', order: 'e.published_at DESC', limit, offset: page * limit,
  });
  const progress = await episodeProgress(c.env, c.get('userId'));
  return c.json({ episodes: await recentEpisodeEntries(c.env, eps, tenantId, progress), limit, page });
});

libraryRoutes.get('/:id/podcast-titles', async (c) => {
  const tenantId = c.get('tenantId');
  const scope = await resolveLibraryScope(c.env, c.req.param('id'), tenantId);
  if (!scope) return c.json({ error: 'Library not found' }, 404);
  const view = scope.filter('li.');
  const r = await c.env.DB.prepare(
    `SELECT p.title, p.itunes_id, p.feed_url, li.id, li.library_id FROM podcasts p JOIN library_items li ON li.id = p.library_item_id
      WHERE li.library_id = ? AND p.tenant_id = ?${view.sql}`,
  ).bind(scope.library.id, tenantId, ...view.binds).all<{ title: string; itunes_id: string | null; feed_url: string; id: string; library_id: string }>();
  // feedUrl isn't in ABS's answer: Pholia marks search results already
  // subscribed by it, since Apple can list one feed under two ids.
  return c.json({ podcasts: r.results.map((p) => ({ title: p.title, itunesId: p.itunes_id, feedUrl: p.feed_url, libraryItemId: p.id, libraryId: p.library_id })) });
});

// The archive queue across the library, in ABS's episode-download shape.
libraryRoutes.get('/:id/episode-downloads', async (c) => {
  const tenantId = c.get('tenantId');
  const scope = await resolveLibraryScope(c.env, c.req.param('id'), tenantId);
  if (!scope) return c.json({ error: 'Library not found' }, 404);
  const r = await c.env.DB.prepare(
    `SELECT e.*, li.library_id AS li_library_id FROM podcast_episodes e JOIN library_items li ON li.id = e.library_item_id
      WHERE li.library_id = ? AND e.tenant_id = ? AND e.archive_state IN ('queued', 'fetching') ORDER BY e.updated_at ASC LIMIT 100`,
  ).bind(scope.library.id, tenantId).all<EpisodeWithShow>();
  const { items, pods } = await showsFor(c.env, r.results.map((e) => e.library_item_id), tenantId);
  const rows = r.results.filter((e) => items.has(e.library_item_id) && pods.has(e.library_item_id))
    .map((e) => downloadJson(e, { item: items.get(e.library_item_id)!, podcast: pods.get(e.library_item_id)! }));
  const current = rows.find((d) => d.startedAt != null) ?? null;
  return c.json({ currentDownload: current, queue: rows.filter((d) => d !== current) });
});

libraryRoutes.get('/:id/opml', async (c) => {
  const tenantId = c.get('tenantId');
  const scope = await resolveLibraryScope(c.env, c.req.param('id'), tenantId);
  if (!scope) return c.json({ error: 'Library not found' }, 404);
  const view = scope.filter('li.');
  const r = await c.env.DB.prepare(
    `SELECT p.* FROM podcasts p JOIN library_items li ON li.id = p.library_item_id
      WHERE li.library_id = ? AND p.tenant_id = ?${view.sql} ORDER BY p.title COLLATE NOCASE`,
  ).bind(scope.library.id, tenantId, ...view.binds).all<PodcastRow>();
  const xml = buildOpml(scope.view?.name ?? scope.library.name, r.results.map((p) => ({
    title: p.title ?? p.feed_url, feedUrl: p.feed_url, description: p.description, pageUrl: p.itunes_page_url, language: p.language,
  })));
  return c.body(xml, 200, { 'Content-Type': 'application/xml; charset=utf-8' });
});

async function podcastFilterData(env: Env, scope: PodcastScope, tenantId: string, folders: LibraryFolderRow[]) {
  const view = scope.filter('li.');
  const r = await env.DB.prepare(
    `SELECT p.genres, p.language, p.tags FROM podcasts p JOIN library_items li ON li.id = p.library_item_id
      WHERE li.library_id = ? AND p.tenant_id = ?${view.sql}`,
  ).bind(scope.library.id, tenantId, ...view.binds).all<{ genres: string; language: string | null; tags: string }>();
  const genres = new Set<string>();
  const tags = new Set<string>();
  const languages = new Set<string>();
  for (const p of r.results) {
    for (const g of JSON.parse(p.genres || '[]') as string[]) genres.add(g);
    for (const t of JSON.parse(p.tags || '[]') as string[]) tags.add(t);
    if (p.language) languages.add(p.language);
  }
  const shown = scope.view ? viewAsLibraryRow(scope.view, scope.library) : scope.library;
  return {
    library: buildLibrary(shown, folders),
    filterdata: {
      authors: [], genres: [...genres], tags: [...tags], series: [], narrators: [], languages: [...languages],
      publishers: [], publishedDecades: [], bookCount: 0, authorCount: 0, seriesCount: 0,
      podcastCount: r.results.length, numIssues: 0, loadedAt: Date.now(),
    },
    issues: 0,
    numUserPlaylists: 0,
  };
}

// Search a podcast library: shows by title/author, episodes by title. ABS's
// shape puts shows in `podcast` and episode hits in `episodes`.
async function podcastSearch(c: Context<{ Bindings: Env; Variables: AuthVars }>, scope: PodcastScope, q: string, limit: number) {
  const tenantId = c.get('tenantId');
  const view = scope.filter('li.');
  const pattern = '%' + q.replace(/[\\%_]/g, (ch) => '\\' + ch).toLowerCase() + '%';
  const shows = await c.env.DB.prepare(
    `SELECT li.* FROM library_items li JOIN podcasts p ON p.library_item_id = li.id
      WHERE li.library_id = ? AND li.tenant_id = ?${view.sql}
        AND (lower(COALESCE(p.title, '')) LIKE ? ESCAPE '\\' OR lower(COALESCE(p.author, '')) LIKE ? ESCAPE '\\')
      LIMIT ?`,
  ).bind(scope.library.id, tenantId, ...view.binds, pattern, pattern, limit).all<LibraryItemRow>();
  const showJson = await podcastItemsMinified(c.env, shows.results, tenantId);
  const epRows = await c.env.DB.prepare(
    `SELECT e.*, li.library_id AS li_library_id FROM podcast_episodes e JOIN library_items li ON li.id = e.library_item_id
      WHERE li.library_id = ? AND e.tenant_id = ? AND e.in_library = 1${view.sql} AND lower(COALESCE(e.title, '')) LIKE ? ESCAPE '\\'
      ORDER BY e.published_at DESC LIMIT ?`,
  ).bind(scope.library.id, tenantId, ...view.binds, pattern, limit).all<EpisodeWithShow>();
  const progress = await episodeProgress(c.env, c.get('userId'));
  const episodeEntities = await episodeShelfEntities(c.env, epRows.results, tenantId, progress);
  return c.json({
    book: [], authors: [], series: [], narrators: [], tags: [],
    podcast: showJson.map((s) => ({ libraryItem: s, matchKey: 'title', matchText: s.media.metadata.title ?? '' })),
    episodes: episodeEntities.map((s) => ({ libraryItem: s, matchKey: 'title', matchText: s.recentEpisode.title })),
  });
}
