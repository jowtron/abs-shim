import { Hono, type Context } from 'hono';
import type { Env } from '../types';
import { requireAuth, type AuthVars } from '../auth/middleware';
import { base64UrlToBytes, deliver, logPush, pushConfig, pushService, summarise, type PushPayload, type SubRow } from '../lib/push';

// /api/push (shim-only): Pholia's side of new-episode notifications. Any
// tenant member, each acting on their own rows only. Routes and shapes are a
// contract with Pholia's receiver (2026-10-13), summarised in CLAUDE.md
// "Push notifications": change them in both repos or not at all. The sender
// and the trigger are in src/lib/push.ts.

type C = Context<{ Bindings: Env; Variables: AuthVars }>;

export const pushRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>();
pushRoutes.use('*', requireAuth);

// A member can make the Worker POST to whatever endpoint they register, so
// each user keeps at most this many (the least recently re-posted go first;
// Pholia re-posts on every start, so a live device is never the oldest).
const MAX_SUBS_PER_USER = 20;

type SubDbRow = { id: string; endpoint: string; created_at: number; last_success_at: number | null; last_failure_at: number | null; last_failure_status: number | null };

async function subsFor(c: C) {
  const r = await c.env.DB.prepare(
    `SELECT id, endpoint, created_at, last_success_at, last_failure_at, last_failure_status
       FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC`,
  ).bind(c.get('userId')).all<SubDbRow>();
  // Never the endpoint or the keys: the endpoint is the device's address.
  return r.results.map((s) => ({
    id: s.id,
    service: pushService(s.endpoint),
    createdAt: s.created_at,
    lastSuccessAt: s.last_success_at,
    lastFailureAt: s.last_failure_at,
    lastFailureStatus: s.last_failure_status,
  }));
}

// The caller's shows with the bell on, in the tenant they are acting in (a
// show of another tenant couldn't be opened from here), and only those they
// follow: the trigger rings for nothing else (migration 0028).
async function showsFor(c: C): Promise<string[]> {
  const r = await c.env.DB.prepare(
    `SELECT sp.library_item_id FROM push_show_prefs sp JOIN library_items li ON li.id = sp.library_item_id
       JOIN podcast_follows f ON f.user_id = sp.user_id AND f.library_item_id = sp.library_item_id
      WHERE sp.user_id = ? AND sp.notify = 1 AND li.tenant_id = ? ORDER BY sp.updated_at ASC`,
  ).bind(c.get('userId'), c.get('tenantId')).all<{ library_item_id: string }>();
  return r.results.map((x) => x.library_item_id);
}

pushRoutes.get('/status', async (c) => {
  const cfg = pushConfig(c.env);
  const [shows, subscriptions] = await Promise.all([showsFor(c), subsFor(c)]);
  return c.json({ configured: cfg != null, publicKey: cfg?.publicKey ?? null, shows, subscriptions });
});

// What PushSubscription.toJSON() gives, checked so a malformed key can't sit
// in the table and fail every send: p256dh an uncompressed P-256 point (65
// bytes, 0x04 first), auth 16 bytes. Stored as base64url either way.
function keyBytes(v: unknown, len: number): string | null {
  if (typeof v !== 'string' || v.length > 200) return null;
  try {
    const b = base64UrlToBytes(v.trim());
    if (b.length !== len || (len === 65 && b[0] !== 0x04)) return null;
    let bin = '';
    for (const x of b) bin += String.fromCharCode(x);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch { return null; }
}

// https only (every push service is), except plain http to this machine,
// which a deployed Worker can't reach anyway and local tests use as a fake
// push service.
function validEndpoint(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 2048) return null;
  try {
    const u = new URL(v.trim());
    if (u.protocol === 'https:') return u.toString();
    if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return u.toString();
  } catch { /* fall through */ }
  return null;
}

// POST /api/push/subscriptions {endpoint, keys:{p256dh, auth}} → {id, created}.
// An upsert on the endpoint: re-posting is normal (Pholia does it on every
// start, which is what restores a row deleted after a 410), and a device
// that signs in as someone else moves to them.
pushRoutes.post('/subscriptions', async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const keys = (body['keys'] ?? {}) as Record<string, unknown>;
  const endpoint = validEndpoint(body['endpoint']);
  if (!endpoint) return c.json({ error: 'endpoint must be an https URL' }, 400);
  const p256dh = keyBytes(keys['p256dh'], 65);
  const auth = keyBytes(keys['auth'], 16);
  if (!p256dh || !auth) return c.json({ error: 'keys.p256dh and keys.auth must be the subscription\'s base64url keys' }, 400);
  const userId = c.get('userId');
  const now = Date.now();
  const newId = crypto.randomUUID();
  const row = await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
       updated_at = excluded.updated_at
     RETURNING id`,
  ).bind(newId, userId, endpoint, p256dh, auth, now, now).first<{ id: string }>();
  const created = row?.id === newId;
  if (created) {
    await c.env.DB.prepare(
      `DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN (
         SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?)`,
    ).bind(userId, userId, MAX_SUBS_PER_USER).run();
  }
  return c.json({ id: row?.id ?? newId, created });
});

// POST /api/push/unsubscribe {endpoint} — the device turned push off.
pushRoutes.post('/unsubscribe', async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  // Normalised as the subscribe route stored it.
  const endpoint = validEndpoint(body['endpoint']) ?? (typeof body['endpoint'] === 'string' ? body['endpoint'] : '');
  if (endpoint) {
    await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?')
      .bind(endpoint, c.get('userId')).run();
  }
  return c.json({ ok: true });
});

// DELETE /api/push/subscriptions/:id — "Remove" in Pholia's device list.
pushRoutes.delete('/subscriptions/:id', async (c) => {
  const r = await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), c.get('userId')).run();
  if (!r.meta.changes) return c.json({ error: 'Subscription not found' }, 404);
  return c.json({ ok: true });
});

// PUT /api/push/shows/:libraryItemId {notify} → {shows}. Turning the bell
// off keeps the subscription: the device may want other shows.
pushRoutes.put('/shows/:libraryItemId', async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof body['notify'] !== 'boolean') return c.json({ error: 'notify must be true or false' }, 400);
  const itemId = c.req.param('libraryItemId');
  const show = await c.env.DB.prepare(
    `SELECT id FROM library_items WHERE id = ? AND tenant_id = ? AND media_type = 'podcast'`,
  ).bind(itemId, c.get('tenantId')).first<{ id: string }>();
  if (!show) return c.json({ error: 'Podcast not found' }, 404);
  await c.env.DB.prepare(
    `INSERT INTO push_show_prefs (user_id, library_item_id, notify, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, library_item_id) DO UPDATE SET notify = excluded.notify, updated_at = excluded.updated_at`,
  ).bind(c.get('userId'), show.id, body['notify'] ? 1 : 0, Date.now()).run();
  return c.json({ shows: await showsFor(c) });
});

// POST /api/push/test — one push to each of the caller's devices, answering
// what each push service actually said. TinnyGo's test route once reported
// success unconditionally, which made it useless for "why didn't I get it".
pushRoutes.post('/test', async (c) => {
  const cfg = pushConfig(c.env);
  if (!cfg) return c.json({ error: 'Push notifications are not configured on this server' }, 503);
  const subs = (await c.env.DB.prepare('SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?')
    .bind(c.get('userId')).all<SubRow>()).results;
  const payload: PushPayload = { title: 'Pholia', body: 'Test notification: push is working on this device.', tag: 'test', kind: 'test' };
  const ds = subs.length ? await deliver(c.env, cfg, subs, payload) : [];
  await logPush(c.env, [{ userId: c.get('userId'), kind: 'test', title: payload.title, status: summarise(ds) }]);
  return c.json({
    devices: ds.length,
    sent: ds.filter((d) => d.status === 'sent').length,
    failed: ds.filter((d) => d.status === 'failed').length,
    expired: ds.filter((d) => d.status === 'expired').length,
    results: ds.map((d) => ({ id: d.id, service: d.service, status: d.status, httpStatus: d.httpStatus })),
  });
});
