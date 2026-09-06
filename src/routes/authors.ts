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
import { authorJson, ensureAuthorMeta, getAuthorMeta } from '../lib/audnexus';

export const authorRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>();

// Author photo: edge cache → R2 (authors/<id>) → the Audnexus image URL in
// author_meta, fetched once and stored → a 1x1 transparent PNG when there is
// no picture, so Pholia's <img onerror="…"> doesn't fire. Public (no auth)
// for the same reason cover endpoints are public: <img> tags don't always
// carry Authorization, and clients pass ?token=… anyway. The placeholder is
// deliberately not cached at the edge: the picture may turn up on the next
// authors listing, once the background lookup has run.
authorRoutes.get('/:authorId/image', async (c) => {
  const id = c.req.param('authorId');
  const cache = caches.default;
  const cacheKey = new Request(new URL(`/__author_image__/${id}`, c.req.url).toString(), { method: 'GET' });
  const edgeHit = await cache.match(cacheKey);
  if (edgeHit) return edgeHit;

  const headersFor = (contentType: string, size?: number) => {
    const h = new Headers({ 'Content-Type': contentType, 'Cache-Control': 'public, max-age=2592000, immutable' });
    if (size !== undefined) h.set('Content-Length', String(size));
    return h;
  };
  const r2Key = `authors/${id}`;
  const r2Hit = await c.env.COVERS.get(r2Key);
  if (r2Hit) {
    const res = new Response(r2Hit.body, { status: 200, headers: headersFor(r2Hit.httpMetadata?.contentType ?? 'image/jpeg', r2Hit.size) });
    c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  }

  const row = await getAuthorMeta(c.env, id);
  if (!row?.image_url) return placeholderImage();
  const upstream = await fetch(row.image_url).catch(() => null);
  if (!upstream || !upstream.ok) return placeholderImage();
  const contentType = (upstream.headers.get('content-type') ?? 'image/jpeg').split(';')[0]!.trim();
  if (!contentType.startsWith('image/')) return placeholderImage();
  const bytes = await upstream.arrayBuffer();
  c.executionCtx.waitUntil(Promise.all([
    c.env.COVERS.put(r2Key, bytes, { httpMetadata: { contentType } }),
    c.env.DB.prepare('UPDATE author_meta SET image_r2 = ? WHERE author_id = ?').bind(r2Key, id).run(),
  ]).catch(() => undefined));
  const res = new Response(bytes, { status: 200, headers: headersFor(contentType, bytes.byteLength) });
  c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
});

// Everything else needs auth.
authorRoutes.use('*', requireAuth);

// GET /api/authors/:id — reverse the derivedId(libraryId, 'author', name)
// hash by iterating every library's authors. Returns the matching author
// shape; with ?include=items, attaches `libraryItems` (full ABS item shape
// for every book this author appears on).
authorRoutes.get('/:authorId', async (c) => {
  const t0 = Date.now();
  const tenantId = c.get('tenantId');
  const authorId = c.req.param('authorId');
  const include = (c.req.query('include') ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  for (const lib of await listLibraries(c.env, tenantId)) {
    const metadata = await listAllBookMetadata(c.env, lib.id, tenantId);
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
      const t1 = Date.now();

      // One author, opened on purpose: look Audnexus up now rather than in
      // the background, so the biography is there on the first open.
      const meta = await ensureAuthorMeta(c.env, { authorId, tenantId, libraryId: lib.id, name }).catch(() => null);
      const base = authorJson({ id: authorId, name, libraryId: lib.id, numBooks: itemIds.length, meta });
      if (!include.includes('items')) {
        console.log(`[perf] /authors/${authorId} name=${name} books=${itemIds.length} include=none | resolve=${t1 - t0}ms total=${Date.now() - t0}ms`);
        return c.json(base);
      }

      const libraryItems = (await Promise.all(itemIds.map(async (iid) => {
        const bundle = await buildItemBundle(c.env, iid, tenantId);
        return bundle ? await buildItemDetail(bundle) : null;
      }))).filter((x): x is NonNullable<typeof x> => x !== null);
      const t2 = Date.now();

      console.log(`[perf] /authors/${authorId} name=${name} books=${itemIds.length} include=items | resolve=${t1 - t0}ms items(N+1)=${t2 - t1}ms total=${t2 - t0}ms`);
      return c.json({ ...base, libraryItems });
    }
  }
  console.log(`[perf] /authors/${authorId} NOT FOUND | total=${Date.now() - t0}ms`);
  return c.json({ error: 'Author not found' }, 404);
});
