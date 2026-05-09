import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { Env } from './types';
import { hashPassword, verifyPassword } from './auth/password';
import { issueAccessToken, issueRefreshToken } from './auth/tokens';
import { requireAuth, type AuthVars } from './auth/middleware';
import {
  countUsers, findUserByUsername, insertUser, toAbsUser, touchLastSeen,
  ROOT_PERMISSIONS,
} from './db/users';
import { insertRefreshToken } from './db/refresh';
import { serverSettings, SERVER_VERSION } from './lib/server-settings';
import { libraryRoutes } from './routes/library';
import { itemRoutes } from './routes/items';
import { adminRoutes } from './routes/admin';
import { listProgressByUser, getProgress, upsertProgress, progressToAbs } from './db/progress';
import { listSessionsByUser } from './db/sessions';
import { resolveStreamUrl } from './storage/resolve';
import { getFolderById } from './db/library';
import { ADMIN_HTML } from './lib/admin-html';
import { verifyProxyUrl } from './storage/proxy-url';
import { getAdapter } from './storage/factory';
import type { LibraryFolderRow } from './db/library';
import { WebDAVAdapter } from './storage/webdav';

const app = new Hono<{ Bindings: Env; Variables: AuthVars }>();

app.use('*', logger());
app.use('*', cors({
  origin: (origin) => origin ?? '*',
  credentials: true,
  allowHeaders: ['Authorization', 'Content-Type'],
  exposeHeaders: ['Content-Range', 'Accept-Ranges'],
}));

// ─── Liveness / status ────────────────────────────────────────────────────────

app.get('/status', async (c) => {
  const isInit = (await countUsers(c.env)) > 0;
  return c.json({
    app: 'audiobookshelf',
    serverVersion: SERVER_VERSION,
    isInit,
    language: 'en-us',
    authMethods: ['local'],
    authFormData: { authLoginCustomMessage: '' },
    ConfigPath: '/config',
    MetadataPath: '/metadata',
  });
});

app.get('/healthcheck', (c) => c.text('OK'));
app.get('/ping', (c) => c.json({ success: true }));

// The bundled ABS web UI handles `/`, `/login`, etc. via env.ASSETS — see the
// notFound handler at the bottom of this file. We deliberately don't define a
// GET / route here so Hono falls through.

// Socket.io: route WebSocket upgrades into the Durable Object so the worker
// can keep handling messages after the upgrade response. Non-upgrade requests
// (the polling fallback) get a stubbed engine.io OPEN packet.
app.all('/socket.io/*', async (c) => {
  if (c.req.header('Upgrade') === 'websocket') {
    const id = c.env.SESSION.idFromName('global-socket-bus');
    const stub = c.env.SESSION.get(id);
    return stub.fetch(c.req.raw);
  }
  // Polling-mode handshake response. We don't actually support polling — but
  // we hand back a session id so the client picks the websocket upgrade path.
  const sid = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const open = '0' + JSON.stringify({
    sid, upgrades: ['websocket'],
    pingInterval: 25000, pingTimeout: 20000, maxPayload: 1_000_000,
  });
  return c.text(open, 200, { 'Content-Type': 'text/plain' });
});

// ABS exposes covers under `/metadata/items/<id>/cover.jpg` and clients build
// URLs from the `coverPath` field they get back in item responses. Forward to
// the real handler.
app.get('/metadata/items/:id/cover.jpg', async (c) => {
  return c.redirect(`/api/items/${c.req.param('id')}/cover${c.req.query('token') ? '?token=' + c.req.query('token') : ''}`, 302);
});

// ABS web UI's player streams via `/public/session/:id/track/:trackIndex` —
// no auth required (anyone with the session id gets the file). Look up the
// session, find its item's audio file, and 302 via the storage adapter.
app.get('/public/session/:id/track/:trackIndex', async (c) => {
  const session = await c.env.DB.prepare(
    `SELECT s.library_item_id, li.folder_id
       FROM listening_sessions s
       JOIN library_items li ON li.id = s.library_item_id
      WHERE s.id = ?`,
  ).bind(c.req.param('id')).first<{ library_item_id: string; folder_id: string }>();
  if (!session?.library_item_id) return c.json({ error: 'Session not found' }, 404);
  const idx = Number(c.req.param('trackIndex'));
  const audio = await c.env.DB.prepare(
    `SELECT * FROM audio_files WHERE library_item_id = ? AND index_no = ?`,
  ).bind(session.library_item_id, idx).first<import('./db/library').AudioFileRow>();
  if (!audio) return c.json({ error: 'Track not found' }, 404);
  const folder = await getFolderById(c.env, session.folder_id);
  if (!folder) return c.json({ error: 'Folder not found' }, 404);
  const stream = await resolveStreamUrl(c.env, folder, audio);
  return c.redirect(stream.url, 302);
});

// ─── Auth ────────────────────────────────────────────────────────────────────

// First-run admin creation. Only succeeds while the users table is empty.
app.post('/init', async (c) => {
  if ((await countUsers(c.env)) > 0) {
    return c.json({ error: 'Already initialised' }, 400);
  }
  const body = await c.req.json().catch(() => null) as { newRoot?: { username?: string; password?: string } } | null;
  const username = body?.newRoot?.username?.trim();
  const password = body?.newRoot?.password;
  if (!username || !password) {
    return c.json({ error: 'newRoot.username and newRoot.password required' }, 400);
  }
  const passwordHash = await hashPassword(password);
  const id = crypto.randomUUID();
  await insertUser(c.env, {
    id,
    username,
    email: null,
    type: 'root',
    password_hash: passwordHash,
    google_sub: null,
    is_active: 1,
    is_locked: 0,
    permissions: JSON.stringify(ROOT_PERMISSIONS),
    libraries_accessible: '[]',
    item_tags_selected: '[]',
    created_at: Date.now(),
    last_seen: null,
  });
  return c.text('OK');
});

app.post('/login', async (c) => {
  const body = await c.req.json().catch(() => null) as { username?: string; password?: string } | null;
  if (!body?.username || !body?.password) {
    return c.json({ error: 'username and password required' }, 400);
  }

  const row = await findUserByUsername(c.env, body.username);
  if (!row || row.password_hash === null || row.is_active !== 1 || row.is_locked === 1) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }
  if (!(await verifyPassword(body.password, row.password_hash))) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const access = await issueAccessToken(c.env, { id: row.id, username: row.username });
  const refresh = await issueRefreshToken();
  await insertRefreshToken(c.env, {
    id: crypto.randomUUID(),
    userId: row.id,
    tokenHash: refresh.hash,
    expiresAt: refresh.expiresAt,
    deviceInfo: { userAgent: c.req.header('user-agent') ?? '' },
  });
  await touchLastSeen(c.env, row.id);

  // Set the access token as a cookie too, so the bundled web UI can issue
  // requests that don't set the Authorization header (e.g. <img>, <audio>).
  c.header('Set-Cookie', `accessToken=${access.token}; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax`, { append: true });

  const progressRows = await listProgressByUser(c.env, row.id);
  const mediaProgress = await Promise.all(progressRows.map((p) => progressToAbs(c.env, p)));

  return c.json({
    user: {
      ...toAbsUser(row, mediaProgress),
      token: access.token,         // legacy slot — ABS clients still read it
      accessToken: access.token,
      refreshToken: refresh.raw,
    },
    userDefaultLibraryId: null,
    serverSettings: serverSettings(),
    ereaderDevices: [] as unknown[],
    Source: 'cloudflare-shim',
  });
});

// Token re-validation heartbeat. ABS clients call this on app focus.
// We refresh the `accessToken` cookie here too so the same-origin admin UI
// (which auths via cookie, not localStorage) stays signed in for as long as
// the user is interacting with the player.
app.post('/api/authorize', requireAuth, async (c) => {
  const row = c.get('user');
  const access = await issueAccessToken(c.env, { id: row.id, username: row.username });
  c.header('Set-Cookie', `accessToken=${access.token}; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax`, { append: true });
  const progressRows = await listProgressByUser(c.env, row.id);
  const mediaProgress = await Promise.all(progressRows.map((p) => progressToAbs(c.env, p)));
  return c.json({
    user: {
      ...toAbsUser(row, mediaProgress),
      token: access.token,
      accessToken: access.token,
      refreshToken: null,
    },
    userDefaultLibraryId: null,
    serverSettings: serverSettings(),
    ereaderDevices: [] as unknown[],
    Source: 'cloudflare-shim',
  });
});

app.get('/api/me', requireAuth, async (c) => {
  const row = c.get('user');
  const progressRows = await listProgressByUser(c.env, row.id);
  const mediaProgress = await Promise.all(progressRows.map((p) => progressToAbs(c.env, p)));
  return c.json(toAbsUser(row, mediaProgress));
});

// Per-item progress: read + write. Pholia and the official UI hit these every
// few seconds while playing.
app.patch('/api/me/progress/:itemId', requireAuth, async (c) => {
  const userRow = c.get('user');
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const patch: Parameters<typeof upsertProgress>[1]['patch'] = {};
  if (typeof body['duration'] === 'number') patch.duration = body['duration'];
  if (typeof body['progress'] === 'number') patch.progress = body['progress'];
  if (typeof body['currentTime'] === 'number') patch.currentTime = body['currentTime'];
  if (typeof body['isFinished'] === 'boolean') patch.isFinished = body['isFinished'];
  if (typeof body['hideFromContinueListening'] === 'boolean') patch.hideFromContinueListening = body['hideFromContinueListening'];
  const row = await upsertProgress(c.env, {
    userId: userRow.id,
    itemId: c.req.param('itemId'),
    patch,
  });
  return c.json(await progressToAbs(c.env, row));
});

app.get('/api/me/progress/:itemId', requireAuth, async (c) => {
  const userRow = c.get('user');
  const row = await getProgress(c.env, userRow.id, c.req.param('itemId'));
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(await progressToAbs(c.env, row));
});

// Batch progress update. ShelfPlayer fires this in addition to per-session
// sync — it bulk-uploads pending progress entries that may have been written
// while offline. Body is an array of progress objects; we upsert each.
app.patch('/api/me/progress/batch/update', requireAuth, async (c) => {
  const userRow = c.get('user');
  const body = await c.req.json().catch(() => []) as Array<Record<string, unknown>>;
  if (!Array.isArray(body)) return c.json({ error: 'Body must be array' }, 400);

  for (const entry of body) {
    const itemId = String(entry['libraryItemId'] ?? '');
    if (!itemId) continue;
    const patch: Parameters<typeof upsertProgress>[1]['patch'] = {};
    if (typeof entry['duration'] === 'number') patch.duration = entry['duration'];
    if (typeof entry['progress'] === 'number') patch.progress = entry['progress'];
    if (typeof entry['currentTime'] === 'number') patch.currentTime = entry['currentTime'];
    if (typeof entry['isFinished'] === 'boolean') patch.isFinished = entry['isFinished'];
    if (typeof entry['hideFromContinueListening'] === 'boolean') patch.hideFromContinueListening = entry['hideFromContinueListening'];
    await upsertProgress(c.env, { userId: userRow.id, itemId, patch });
  }
  return c.body(null, 200);
});

// In-flight session sync. ABS clients POST currentTime + timeListening every
// few seconds while playing. We mirror it into the session row + bump the
// per-item progress so the position survives reload. Body is `{currentTime,
// timeListening, duration?}`.
app.post('/api/session/:id/sync', requireAuth, async (c) => {
  const userRow = c.get('user');
  const sid = c.req.param('id');
  const session = await c.env.DB.prepare(
    'SELECT * FROM listening_sessions WHERE id = ? AND user_id = ?',
  ).bind(sid, userRow.id).first<{ library_item_id: string | null; duration_seconds: number }>();
  if (!session) return c.json({ error: 'Session not found' }, 404);

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const currentTime = typeof body['currentTime'] === 'number' ? body['currentTime'] : 0;
  const timeListening = typeof body['timeListening'] === 'number' ? body['timeListening'] : 0;
  const now = Date.now();

  await c.env.DB.prepare(
    `UPDATE listening_sessions
       SET current_time_seconds = ?, time_listening_seconds = ?, updated_at = ?
       WHERE id = ?`,
  ).bind(currentTime, timeListening, now, sid).run();

  // Mirror into media_progress so the next /login or /api/me reflects position.
  if (session.library_item_id && session.duration_seconds > 0) {
    await upsertProgress(c.env, {
      userId: userRow.id,
      itemId: session.library_item_id,
      patch: {
        currentTime,
        duration: session.duration_seconds,
        progress: currentTime / session.duration_seconds,
      },
    });
  }
  return c.body(null, 200);
});

// Close a session (player stopped). Records the final time + closed_at.
app.post('/api/session/:id/close', requireAuth, async (c) => {
  const userRow = c.get('user');
  const sid = c.req.param('id');
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const currentTime = typeof body['currentTime'] === 'number' ? body['currentTime'] : null;
  const timeListening = typeof body['timeListening'] === 'number' ? body['timeListening'] : null;
  const now = Date.now();

  await c.env.DB.prepare(
    `UPDATE listening_sessions
       SET current_time_seconds = COALESCE(?, current_time_seconds),
           time_listening_seconds = COALESCE(?, time_listening_seconds),
           closed_at = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
  ).bind(currentTime, timeListening, now, now, sid, userRow.id).run();
  return c.body(null, 200);
});

// Per-item session history. ShelfPlayer fetches this on book detail open;
// returning paged-empty satisfies the parser when there's no history yet.
app.get('/api/me/item/listening-sessions/:itemId', requireAuth, async (c) => {
  const itemsPerPage = Math.max(1, Number(c.req.query('itemsPerPage') ?? '20'));
  const page = Math.max(0, Number(c.req.query('page') ?? '0'));
  return c.json({
    total: 0,
    numPages: 0,
    page,
    itemsPerPage,
    sessions: [] as unknown[],
  });
});

// History of listening sessions, paged.
app.get('/api/me/listening-sessions', requireAuth, async (c) => {
  const userRow = c.get('user');
  const itemsPerPage = Math.max(1, Number(c.req.query('itemsPerPage') ?? '10'));
  const page = Math.max(0, Number(c.req.query('page') ?? '0'));
  const { rows, total } = await listSessionsByUser(c.env, userRow.id, {
    limit: itemsPerPage,
    offset: page * itemsPerPage,
  });
  return c.json({
    total,
    numPages: Math.max(1, Math.ceil(total / itemsPerPage)),
    page,
    itemsPerPage,
    sessions: rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      libraryItemId: r.library_item_id,
      displayTitle: r.display_title,
      displayAuthor: r.display_author,
      duration: r.duration_seconds,
      playMethod: r.play_method,
      mediaPlayer: r.media_player,
      deviceInfo: JSON.parse(r.device_info || '{}'),
      serverVersion: r.server_version,
      dateStarted: r.date_started,
      currentTime: r.current_time_seconds,
      timeListening: r.time_listening_seconds,
      startTime: r.start_time_seconds,
      closedAt: r.closed_at,
      updatedAt: r.updated_at,
    })),
  });
});

// ─── Library / items ─────────────────────────────────────────────────────────

app.route('/api/libraries', libraryRoutes);
app.route('/api/items', itemRoutes);
app.route('/api/admin', adminRoutes);

// Admin UI: a self-contained HTML page (see src/lib/admin-html.ts). Registered
// before the SPA notFound fallback so the Nuxt index.html doesn't hijack it.
app.get('/admin', (c) => c.html(ADMIN_HTML));
app.get('/admin/', (c) => c.html(ADMIN_HTML));

// Proxy stream route — for adapters that can't 302 (WebDAV today, possibly
// other backends later). The URL is HMAC-signed by the adapter's resolveUrl;
// signature + expiry are verified here, then the adapter fetches bytes from
// its backend and streams them through. Range header is preserved end-to-end.
app.get('/public/proxy/:folderId/*', async (c) => {
  const folderId = c.req.param('folderId');
  // Hono's wildcard captures the rest of the path; pull it out manually so
  // we keep the original encoding the signer used.
  const pathPart = c.req.url.split(`/public/proxy/${folderId}/`)[1] ?? '';
  const [encodedRel] = pathPart.split('?');
  const relPath = decodeURIComponent(encodedRel ?? '');
  const exp = c.req.query('exp') ?? '';
  const sig = c.req.query('sig') ?? '';

  const ok = await verifyProxyUrl({ env: c.env, folderId, relPath, exp, sig });
  if (!ok) return c.json({ error: 'Invalid or expired signature' }, 403);

  const folder = await getFolderById(c.env, folderId);
  if (!folder) return c.json({ error: 'Folder not found' }, 404);

  const adapter = await getAdapter(c.env, folder as unknown as Parameters<typeof getAdapter>[1], c.req.url);
  if (!(adapter instanceof WebDAVAdapter)) {
    // Other proxy-using providers will land here in future. For now reject.
    return c.json({ error: 'Provider does not use the proxy route' }, 400);
  }
  return adapter.fetchFromBackend(relPath, c.req.raw);
});

// ShelfPlayer's per-session sync. Body is a SINGLE session object (not an
// array — that's the bulk variant `local-all` below). ShelfPlayer fires this
// after every play/pause; maxAttempts:1 on its side means a 404 immediately
// marks the connection offline. Same forward-only guard as local-all.
app.post('/api/session/local', requireAuth, async (c) => {
  const userRow = c.get('user');
  const s = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const itemId = typeof s?.['libraryItemId'] === 'string' ? s['libraryItemId'] as string : null;
  if (!itemId) return c.json({ success: false, error: 'libraryItemId required' }, 400);
  const itemExists = await c.env.DB.prepare('SELECT id FROM library_items WHERE id = ?')
    .bind(itemId).first<{ id: string }>();
  if (!itemExists) return c.json({ success: true, applied: 0 });
  const currentTime = typeof s?.['currentTime'] === 'number' ? s['currentTime'] as number : null;
  if (currentTime == null) return c.json({ success: true, applied: 0 });
  const existing = await getProgress(c.env, userRow.id, itemId, null);
  if (existing && existing.current_time_seconds > currentTime) {
    return c.json({ success: true, applied: 0, skipped: 'forward-only' });
  }
  const duration = typeof s?.['duration'] === 'number' ? s['duration'] as number : null;
  const patch: { currentTime: number; duration?: number; progress?: number } = { currentTime };
  if (duration && duration > 0) {
    patch.duration = duration;
    patch.progress = currentTime / duration;
  }
  await upsertProgress(c.env, { userId: userRow.id, itemId, patch });
  return c.json({ success: true, applied: 1 });
});

// Bulk-upload offline-recorded sessions. Plappa accumulates listening
// sessions while offline and POSTs the entire array here on reconnect. We
// upsert progress for sessions whose libraryItemId we know about; unknown
// item ids are ignored (Plappa carries history from previous servers and
// will keep retrying forever if we 4xx). Body: array of session objects
// with libraryItemId, currentTime, timeListening, startedAt, updatedAt.
app.post('/api/session/local-all', requireAuth, async (c) => {
  const userRow = c.get('user');
  const body = await c.req.json().catch(() => null);
  const sessions = Array.isArray(body) ? body : [];
  let applied = 0;
  for (const s of sessions) {
    const itemId = typeof s?.libraryItemId === 'string' ? s.libraryItemId : null;
    if (!itemId) continue;
    const itemExists = await c.env.DB.prepare('SELECT id FROM library_items WHERE id = ?')
      .bind(itemId).first<{ id: string }>();
    if (!itemExists) continue;
    const currentTime = typeof s?.currentTime === 'number' ? s.currentTime : null;
    if (currentTime == null) continue;
    // Forward-only: skip if existing server progress is past this session's
    // currentTime. Plappa carries a backlog of stale local sessions and
    // re-stamps them with `updatedAt = now` on bulk upload, so a timestamp-
    // based guard doesn't help. Real-time progress goes via /api/session/
    // :id/sync; the local-all endpoint exists purely to backfill offline gaps,
    // and a bulk import that goes _backwards_ is almost always stale data.
    const existing = await getProgress(c.env, userRow.id, itemId, null);
    if (existing && existing.current_time_seconds > currentTime) continue;
    const duration = typeof s?.duration === 'number' ? s.duration : null;
    const patch: { currentTime: number; duration?: number; progress?: number } = { currentTime };
    if (duration && duration > 0) {
      patch.duration = duration;
      patch.progress = currentTime / duration;
    }
    await upsertProgress(c.env, { userId: userRow.id, itemId, patch });
    applied++;
  }
  return c.json({ success: true, applied, ignored: sessions.length - applied });
});

// Plappa fetches /api/playlists during bootstrap. We don't model playlists.
app.get('/api/playlists', requireAuth, (c) => c.json({
  playlists: [] as unknown[],
  total: 0,
  limit: Number(c.req.query('limit') ?? 0),
  page: 0,
}));

// ─── Misc shapes clients fetch on bootstrap ──────────────────────────────────

app.get('/api/tags', requireAuth, (c) => c.json([]));

app.get('/api/stats/year/:year', requireAuth, (c) => c.json({
  totalDuration: 0,
  totalItemsFinished: 0,
  totalListeningSessions: 0,
  totalListeningTime: 0,
  itemsFinishedThisYear: [],
  mostListenedAuthor: null,
  topAuthors: [],
  topGenres: [],
  topNarrators: [],
  numBooksAddedThisYear: 0,
  numBooksListenedThisYear: 0,
}));

app.get('/api/notifications', requireAuth, (c) => c.json({
  data: { events: [] },
  settings: {
    id: 'notification-settings',
    appriseType: 'api',
    appriseApiUrl: null,
    notifications: [],
    maxFailedAttempts: 5,
    maxNotificationQueue: 20,
    notificationDelay: 1000,
  },
}));

// Anything the Worker hasn't routed (i.e. paths that aren't `/api/*`, `/login`,
// `/init`, `/status`, etc.) is delegated to the bundled ABS web client.
//
// Exception: API paths (/api/*) that we don't handle MUST return real JSON
// 404s, not the SPA index.html. Strict-Codable clients (ShelfPlayer) treat
// the HTML 200 fallback as a successful response with garbage body, parsing
// fails, and the whole connection gets marked offline. Be honest with API
// clients; let only browser navigations reach the SPA.
app.notFound((c) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/api/') || path.startsWith('/auth/')) {
    return c.json({ error: 'Not Found', path }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

// ─── Durable Object: socket.io shim ──────────────────────────────────────────

// Stubbed socket.io endpoint. We accept WS upgrades, emit the engine.io OPEN
// + socket.io NAMESPACE OPEN handshake packets, then ping each connection
// every 25s via DO alarms (engine.io v4 has the *server* drive pings).
//
// The DO is hibernation-mode: it sleeps between events, so this costs almost
// nothing on the free tier even with persistent sockets.
const PING_INTERVAL_MS = 25_000;

export class ListeningSessionDO {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]] as [WebSocket, WebSocket];
    this.state.acceptWebSocket(server);

    const sid = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    server.send('0' + JSON.stringify({
      sid, upgrades: [],
      pingInterval: PING_INTERVAL_MS, pingTimeout: 20000, maxPayload: 1_000_000,
    }));
    server.send('40' + JSON.stringify({ sid: 'sh-' + sid }));

    // Make sure an alarm is scheduled so we'll send pings.
    if ((await this.state.storage.getAlarm()) == null) {
      await this.state.storage.setAlarm(Date.now() + PING_INTERVAL_MS);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm(): Promise<void> {
    const sockets = this.state.getWebSockets();
    if (sockets.length === 0) return; // nothing to ping; let alarm idle
    for (const ws of sockets) {
      try { ws.send('2'); } catch { /* socket gone, hibernation will GC */ }
    }
    await this.state.storage.setAlarm(Date.now() + PING_INTERVAL_MS);
  }

  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = typeof message === 'string' ? message : '';
    // engine.io '3' = client pong (response to our ping). Nothing to do.
    // Older clients sometimes still send '2' (ping); ignore — the alarm drives ours.
    // socket.io events ('40', '41', '42…') would need real handling; ignored for now.
    if (text === '3' || text === '2') return;
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try { ws.close(code, reason); } catch { /* already closed */ }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try { ws.close(1011, 'error'); } catch { /* already closed */ }
  }
}

// The bundled Nuxt build hardcodes `/audiobookshelf/` as its router base, so
// the web UI requests both static assets AND API routes under that prefix.
// Strip the prefix at the outer fetch boundary so Hono's route matcher and
// the assets fallback see plain paths.
export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response {
    const u = new URL(req.url);
    let mutated = false;
    // Plappa concatenates `serverUrl + /api/...`; if the user pasted a URL
    // with a trailing slash it produces `//api/...`. Workerd auto-redirects
    // these with a 307, which iOS NSURLSession technically preserves — but
    // it's flaky for POSTs with bodies. Collapse leading `/` runs ourselves
    // so requests reach Hono cleanly the first time.
    if (u.pathname.startsWith('//')) {
      u.pathname = u.pathname.replace(/^\/+/, '/');
      mutated = true;
    }
    if (u.pathname === '/audiobookshelf' || u.pathname.startsWith('/audiobookshelf/')) {
      u.pathname = u.pathname.slice('/audiobookshelf'.length) || '/';
      mutated = true;
    }
    if (mutated) req = new Request(u.toString(), req);
    return app.fetch(req, env, ctx);
  },
};
