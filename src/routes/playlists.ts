import { Hono, type Context } from 'hono';
import type { Env } from '../types';
import { requireAuth, type AuthVars } from '../auth/middleware';
import { loadItemBundles, type LibraryFolderRow, type LibraryItemRow } from '../db/library';
import { getEpisodeCounts, getEpisodesByIds, getPodcasts, type EpisodeRow } from '../db/podcasts';
import { resolveLibraryScope } from '../db/library-views';
import { buildItemDetail } from '../lib/abs-shapes';
import { buildEpisodeExpanded, buildPodcastItemMinified } from '../lib/podcast-shapes';

// ABS playlists (server/controllers/PlaylistController.js): per user, per
// library, an ordered list of books and podcast episodes, answered in
// Playlist.toOldJSONExpanded's shape. Shim extra: `rules`, a smart playlist
// whose items are computed on every read (migration 0017) — "every unplayed
// episode of these shows, newest first", the way Pocket Casts' filters work.
// A client that doesn't know about rules sees an ordinary playlist that keeps
// itself current, and can't add to or remove from it (400).

type C = Context<{ Bindings: Env; Variables: AuthVars }>;

type PlaylistRow = {
  id: string; tenant_id: string; user_id: string; library_id: string; name: string;
  description: string | null; rules: string | null; created_at: number; updated_at: number;
};

export type Rules = {
  podcastIds: string[];
  include: 'unplayed' | 'inProgress' | 'all';
  sort: 'newest' | 'oldest';
  limit: number;
  days: number | null;   // only episodes published in the last N days
};

type Ref = { library_item_id: string; episode_id: string | null };

export const playlistRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>();
playlistRoutes.use('*', requireAuth);

function parseRules(raw: string | null): Rules | null {
  if (!raw) return null;
  try { return cleanRules(JSON.parse(raw)) ?? null; } catch { return null; }
}

function cleanRules(input: unknown): Rules | null {
  if (!input || typeof input !== 'object') return null;
  const r = input as Record<string, unknown>;
  const ids = Array.isArray(r['podcastIds']) ? (r['podcastIds'] as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 200) : [];
  const include = r['include'] === 'inProgress' || r['include'] === 'all' ? r['include'] : 'unplayed';
  const sort = r['sort'] === 'oldest' ? 'oldest' : 'newest';
  const limit = Math.min(Math.max(Number(r['limit']) || 100, 1), 500);
  const days = Number(r['days']) > 0 ? Math.min(Number(r['days']), 3650) : null;
  return { podcastIds: [...new Set(ids)], include, sort, limit, days };
}

async function refsFor(env: Env, pl: PlaylistRow, userId: string): Promise<Ref[]> {
  const rules = parseRules(pl.rules);
  if (!rules) {
    const r = await env.DB.prepare(
      'SELECT library_item_id, episode_id FROM playlist_items WHERE playlist_id = ? ORDER BY position ASC',
    ).bind(pl.id).all<Ref>();
    return r.results;
  }
  if (!rules.podcastIds.length) return [];
  const ids = rules.podcastIds.slice(0, 90);
  const where: string[] = [];
  if (rules.include === 'unplayed') where.push('COALESCE(mp.is_finished, 0) = 0');
  if (rules.include === 'inProgress') where.push('mp.progress > 0 AND mp.is_finished = 0');
  const binds: unknown[] = [userId, pl.tenant_id, ...ids];
  if (rules.days) { where.push('e.published_at >= ?'); binds.push(Date.now() - rules.days * 86400_000); }
  binds.push(rules.limit);
  const r = await env.DB.prepare(
    `SELECT e.library_item_id, e.id AS episode_id FROM podcast_episodes e
       LEFT JOIN media_progress mp ON mp.library_item_id = e.library_item_id AND mp.episode_id = e.id AND mp.user_id = ?
      WHERE e.tenant_id = ? AND e.in_library = 1 AND e.library_item_id IN (${ids.map(() => '?').join(',')})
        ${where.length ? 'AND ' + where.join(' AND ') : ''}
      ORDER BY e.published_at ${rules.sort === 'oldest' ? 'ASC' : 'DESC'}, e.idx ${rules.sort === 'oldest' ? 'ASC' : 'DESC'}
      LIMIT ?`,
  ).bind(...binds).all<Ref>();
  return r.results;
}

async function inChunks<T>(env: Env, ids: string[], sql: (m: string) => string, extra: unknown[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    out.push(...(await env.DB.prepare(sql(part.map(() => '?').join(','))).bind(...part, ...extra).all<T>()).results);
  }
  return out;
}

export async function expandPlaylist(env: Env, pl: PlaylistRow, userId: string) {
  const refs = await refsFor(env, pl, userId);
  const tenantId = pl.tenant_id;
  const itemIds = [...new Set(refs.map((r) => r.library_item_id))];
  const items = new Map((await inChunks<LibraryItemRow>(env, itemIds,
    (m) => `SELECT * FROM library_items WHERE id IN (${m}) AND tenant_id = ?`, [tenantId])).map((i) => [i.id, i]));
  const showIds = [...items.values()].filter((i) => i.media_type === 'podcast').map((i) => i.id);
  const bookItems = [...items.values()].filter((i) => i.media_type !== 'podcast');
  const [pods, counts, episodes, bundles] = await Promise.all([
    getPodcasts(env, showIds, tenantId),
    getEpisodeCounts(env, showIds, tenantId),
    getEpisodesByIds(env, refs.map((r) => r.episode_id).filter((x): x is string => !!x), tenantId),
    loadItemBundles(env, bookItems, tenantId),
  ]);
  const epById = new Map(episodes.map((e) => [e.id, e]));
  const bundleById = new Map(bundles.map((b) => [b.item.id, b]));
  const folderIds = [...new Set(showIds.map((id) => items.get(id)!.folder_id))];
  const folders = new Map((await inChunks<LibraryFolderRow>(env, folderIds,
    (m) => `SELECT * FROM library_folders WHERE id IN (${m}) AND tenant_id = ?`, [tenantId])).map((f) => [f.id, f]));

  const out: unknown[] = [];
  for (const ref of refs) {
    const item = items.get(ref.library_item_id);
    if (!item) continue;
    if (ref.episode_id) {
      const ep = epById.get(ref.episode_id) as EpisodeRow | undefined;
      const pod = pods.get(item.id);
      const folder = folders.get(item.folder_id);
      if (!ep || !pod || !folder) continue;
      out.push({
        episodeId: ep.id,
        episode: await buildEpisodeExpanded(ep, item, folder),
        libraryItemId: item.id,
        libraryItem: await buildPodcastItemMinified(item, pod, counts.get(item.id)),
      });
    } else {
      const b = bundleById.get(item.id);
      if (b) out.push({ libraryItemId: item.id, libraryItem: await buildItemDetail(b) });
    }
  }
  const rules = parseRules(pl.rules);
  return {
    id: pl.id,
    name: pl.name,
    libraryId: pl.library_id,
    userId: pl.user_id,
    description: pl.description,
    lastUpdate: pl.updated_at,
    createdAt: pl.created_at,
    items: out,
    // Not ABS: a smart playlist's definition (null for an ordinary one).
    rules,
  };
}

async function loadOwn(c: C): Promise<PlaylistRow | null> {
  return c.env.DB.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ? AND tenant_id = ?')
    .bind(c.req.param('id'), c.get('userId'), c.get('tenantId')).first<PlaylistRow>();
}

// Items a client asks to add, kept only when the book or episode exists in
// the playlist's library and the caller's tenant.
async function validRefs(c: C, libraryId: string, raw: unknown): Promise<Ref[]> {
  if (!Array.isArray(raw)) return [];
  const out: Ref[] = [];
  for (const r of raw.slice(0, 500) as Array<Record<string, unknown>>) {
    const itemId = typeof r?.['libraryItemId'] === 'string' ? r['libraryItemId'] : null;
    const epId = typeof r?.['episodeId'] === 'string' && r['episodeId'] ? r['episodeId'] : null;
    if (!itemId) continue;
    const ok = epId
      ? await c.env.DB.prepare(
        `SELECT 1 AS x FROM podcast_episodes e JOIN library_items li ON li.id = e.library_item_id
          WHERE e.id = ? AND e.library_item_id = ? AND li.library_id = ? AND li.tenant_id = ?`,
      ).bind(epId, itemId, libraryId, c.get('tenantId')).first()
      : await c.env.DB.prepare('SELECT 1 AS x FROM library_items WHERE id = ? AND library_id = ? AND tenant_id = ?')
        .bind(itemId, libraryId, c.get('tenantId')).first();
    if (ok) out.push({ library_item_id: itemId, episode_id: epId });
  }
  return out;
}

async function appendRefs(env: Env, playlistId: string, refs: Ref[]) {
  if (!refs.length) return;
  const max = await env.DB.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM playlist_items WHERE playlist_id = ?')
    .bind(playlistId).first<{ m: number }>();
  let pos = max?.m ?? 0;
  const now = Date.now();
  await env.DB.batch(refs.map((r) => env.DB.prepare(
    `INSERT OR IGNORE INTO playlist_items (playlist_id, position, library_item_id, episode_id, added_at) VALUES (?, ?, ?, ?, ?)`,
  ).bind(playlistId, ++pos, r.library_item_id, r.episode_id, now)));
}

const touch = (env: Env, id: string) => env.DB.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').bind(Date.now(), id).run();

playlistRoutes.get('/', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM playlists WHERE user_id = ? AND tenant_id = ? ORDER BY name COLLATE NOCASE')
    .bind(c.get('userId'), c.get('tenantId')).all<PlaylistRow>();
  const playlists = await Promise.all(rows.results.map((p) => expandPlaylist(c.env, p, c.get('userId'))));
  // `total`/`limit`/`page` were what the old stub sent; Plappa reads it at
  // bootstrap and tolerates either shape.
  return c.json({ playlists, total: playlists.length, limit: Number(c.req.query('limit') ?? 0), page: 0 });
});

playlistRoutes.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const name = String(body['name'] ?? '').replace(/<[^>]*>/g, '').trim().slice(0, 120);
  const scope = await resolveLibraryScope(c.env, String(body['libraryId'] ?? ''), c.get('tenantId'));
  if (!name || !scope) return c.json({ error: 'Invalid playlist data' }, 400);
  const rules = body['rules'] != null ? cleanRules(body['rules']) : null;
  const now = Date.now();
  const id = 'pl_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  await c.env.DB.prepare(
    `INSERT INTO playlists (id, tenant_id, user_id, library_id, name, description, rules, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, c.get('tenantId'), c.get('userId'), scope.library.id, name,
    typeof body['description'] === 'string' ? body['description'].slice(0, 2000) : null,
    rules ? JSON.stringify(rules) : null, now, now).run();
  if (!rules) await appendRefs(c.env, id, await validRefs(c, scope.library.id, body['items']));
  const pl = (await c.env.DB.prepare('SELECT * FROM playlists WHERE id = ?').bind(id).first<PlaylistRow>())!;
  return c.json(await expandPlaylist(c.env, pl, c.get('userId')));
});

playlistRoutes.get('/:id', async (c) => {
  const pl = await loadOwn(c);
  if (!pl) return c.json({ error: 'Playlist not found' }, 404);
  return c.json(await expandPlaylist(c.env, pl, c.get('userId')));
});

// PATCH {name?, description?, items?, rules?}: `items` replaces the order
// (ABS's reorder), `rules: null` turns a smart playlist into an empty
// ordinary one.
playlistRoutes.patch('/:id', async (c) => {
  const pl = await loadOwn(c);
  if (!pl) return c.json({ error: 'Playlist not found' }, 404);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (typeof body['name'] === 'string' && body['name'].trim()) { sets.push('name = ?'); binds.push(body['name'].replace(/<[^>]*>/g, '').trim().slice(0, 120)); }
  if (typeof body['description'] === 'string' || body['description'] === null) { sets.push('description = ?'); binds.push(body['description']); }
  if ('rules' in body) {
    const rules = body['rules'] === null ? null : cleanRules(body['rules']);
    sets.push('rules = ?'); binds.push(rules ? JSON.stringify(rules) : null);
  }
  sets.push('updated_at = ?'); binds.push(Date.now());
  await c.env.DB.prepare(`UPDATE playlists SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, pl.id).run();
  if (Array.isArray(body['items']) && !parseRules(pl.rules)) {
    const refs = await validRefs(c, pl.library_id, body['items']);
    await c.env.DB.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').bind(pl.id).run();
    await appendRefs(c.env, pl.id, refs);
  }
  const fresh = (await c.env.DB.prepare('SELECT * FROM playlists WHERE id = ?').bind(pl.id).first<PlaylistRow>())!;
  return c.json(await expandPlaylist(c.env, fresh, c.get('userId')));
});

playlistRoutes.delete('/:id', async (c) => {
  const pl = await loadOwn(c);
  if (!pl) return c.json({ error: 'Playlist not found' }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').bind(pl.id),
    c.env.DB.prepare('DELETE FROM playlists WHERE id = ?').bind(pl.id),
  ]);
  return c.body(null, 200);
});

const smartRefusal = { error: "This is a smart playlist: its episodes come from its rules, so items can't be added or removed by hand" };

playlistRoutes.post('/:id/item', async (c) => {
  const pl = await loadOwn(c);
  if (!pl) return c.json({ error: 'Playlist not found' }, 404);
  if (pl.rules) return c.json(smartRefusal, 400);
  const body = await c.req.json().catch(() => ({}));
  const refs = await validRefs(c, pl.library_id, [body]);
  if (!refs.length) return c.json({ error: 'Invalid playlist item' }, 400);
  await appendRefs(c.env, pl.id, refs);
  await touch(c.env, pl.id);
  return c.json(await expandPlaylist(c.env, pl, c.get('userId')));
});

async function removeRefs(env: Env, playlistId: string, refs: Ref[]) {
  if (!refs.length) return;
  await env.DB.batch(refs.map((r) => env.DB.prepare(
    `DELETE FROM playlist_items WHERE playlist_id = ? AND library_item_id = ? AND COALESCE(episode_id, '') = ?`,
  ).bind(playlistId, r.library_item_id, r.episode_id ?? '')));
}

// ABS deletes a playlist once its last item goes; here an empty playlist
// stays, since one made in Pholia starts empty and fills as you add.
const removeOne = async (c: C) => {
  const pl = await loadOwn(c);
  if (!pl) return c.json({ error: 'Playlist not found' }, 404);
  if (pl.rules) return c.json(smartRefusal, 400);
  await removeRefs(c.env, pl.id, [{ library_item_id: c.req.param('libraryItemId')!, episode_id: c.req.param('episodeId') ?? null }]);
  await touch(c.env, pl.id);
  return c.json(await expandPlaylist(c.env, pl, c.get('userId')));
};
playlistRoutes.delete('/:id/item/:libraryItemId', removeOne);
playlistRoutes.delete('/:id/item/:libraryItemId/:episodeId', removeOne);

playlistRoutes.post('/:id/batch/add', async (c) => {
  const pl = await loadOwn(c);
  if (!pl) return c.json({ error: 'Playlist not found' }, 404);
  if (pl.rules) return c.json(smartRefusal, 400);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  await appendRefs(c.env, pl.id, await validRefs(c, pl.library_id, body['items']));
  await touch(c.env, pl.id);
  return c.json(await expandPlaylist(c.env, pl, c.get('userId')));
});

playlistRoutes.post('/:id/batch/remove', async (c) => {
  const pl = await loadOwn(c);
  if (!pl) return c.json({ error: 'Playlist not found' }, 404);
  if (pl.rules) return c.json(smartRefusal, 400);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const raw = Array.isArray(body['items']) ? body['items'] as Array<Record<string, unknown>> : [];
  await removeRefs(c.env, pl.id, raw.filter((r) => typeof r?.['libraryItemId'] === 'string').map((r) => ({
    library_item_id: r['libraryItemId'] as string,
    episode_id: typeof r['episodeId'] === 'string' && r['episodeId'] ? r['episodeId'] : null,
  })));
  await touch(c.env, pl.id);
  return c.json(await expandPlaylist(c.env, pl, c.get('userId')));
});

// GET /api/libraries/:id/playlists (mounted from library.ts): the caller's
// playlists in one library, ABS's paged {results, total, limit, page}.
export async function libraryPlaylists(c: C, libraryId: string) {
  const rows = await c.env.DB.prepare(
    'SELECT * FROM playlists WHERE user_id = ? AND tenant_id = ? AND library_id = ? ORDER BY name COLLATE NOCASE',
  ).bind(c.get('userId'), c.get('tenantId'), libraryId).all<PlaylistRow>();
  let list = rows.results;
  const limit = Number(c.req.query('limit') ?? 0) || 0;
  const page = Number(c.req.query('page') ?? 0) || 0;
  const total = list.length;
  if (limit) list = list.slice(page * limit, page * limit + limit);
  return c.json({ results: await Promise.all(list.map((p) => expandPlaylist(c.env, p, c.get('userId')))), total, limit, page });
}
