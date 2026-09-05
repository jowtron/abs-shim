import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Env } from '../types';
import { requireAuth, requireTenantOwner, requireCanAdd, type AuthVars } from '../auth/middleware';
import {
  exchangePcloudCode, pcloudAuthorizeUrl, pcloudUserinfo,
  apiHostFromLocationId, type PcloudProfile,
  pcloudUploadCreate, pcloudUploadWrite, pcloudUploadSave,
  pcloudEnsureFolder, pcloudStat, pcloudDownloadFileAsync,
  pcloudDeleteFile, pcloudDeleteEmptyFolder,
} from '../storage/pcloud';
import { runScan, addBookByPath, reprobeItem, type ScanReport } from '../scanner/scan';
import { getLibrary, listFolders, getFolderById, getAudioFiles, getItem, getBookMetadata } from '../db/library';
import { probeM4b } from '../prober/m4b';
import { probeMp3 } from '../prober/mp3';
import { resolveProbeUrl } from '../storage/resolve';
import type { OAuthProfileRow } from '../storage/factory';
import { S3Adapter } from '../storage/s3';
import { WebDAVAdapter, normalizeWebdavBaseUrl } from '../storage/webdav';
import { PcloudOAuthAdapter } from '../storage/pcloud';
import { isAudiobookFile, type RemoteEntry } from '../storage/adapter';
import { storageLabelText } from '../lib/storage-label';
import { findCatalogCover, purgeCoverCache } from '../lib/cover-from-catalog';
import { redactSecrets, safeJson } from '../lib/redact';
import { getSignupMode, setSetting, membersCanAdd, setTenantSetting, MEMBERS_CAN_ADD_KEY } from '../db/settings';
import { createInvite, listOpenInvites, deleteInvite } from '../db/invites';
import { listTenantMembers, removeMember } from '../db/tenants';

// Mounted at /api/admin from index.ts. The admin UI itself lives at /admin and
// is served as an inline HTML page (src/lib/admin-html.ts).
//
// Auth model. Every query is tenant-scoped (filters by c.get('tenantId')), so
// a member only ever sees their own tenant's data. Within the tenant there
// are three tiers (2026-09-05 — before that every route here was open to any
// active member, so a member could disconnect pCloud or delete the library):
//   - anyone:            read status, scan, re-probe, warm covers, see members
//   - requireCanAdd:     upload / fetch / extract / add-by-path — owner, or a
//                        member when the tenant's members_can_add switch is on
//   - requireTenantOwner: connect/attach/remove storage, delete books, invites
// A small set of *instance-wide* operations (approving signups, the signup-
// mode switch) stay restricted to the instance owner via requireInstanceOwner.
// Cross-tenant visibility lives at /ops, not here.

export const adminRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>();

adminRoutes.use('*', requireAuth);

// Gate for instance-wide (not tenant-scoped) operations. 'root'/'admin' are the
// instance-owner account types — distinct from a per-tenant 'owner' role, which
// only confers authority within that tenant.
const requireInstanceOwner = createMiddleware<{ Bindings: Env; Variables: AuthVars }>(
  async (c, next) => {
    const u = c.get('user');
    if (u.type !== 'root' && u.type !== 'admin') {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return next();
  },
);

// ─── Storage status ─────────────────────────────────────────────────────────

adminRoutes.get('/storage/status', async (c) => {
  const tenantId = c.get('tenantId');
  const u = c.get('user');
  const isInstanceOwner = u.type === 'root' || u.type === 'admin';
  const folders = await c.env.DB.prepare(
    `SELECT lf.*, l.name AS library_name
       FROM library_folders lf
       JOIN libraries l ON l.id = lf.library_id
      WHERE lf.tenant_id = ?
       ORDER BY lf.added_at ASC`,
  ).bind(tenantId).all<FolderWithLibName>();

  const isOwner = c.get('tenantRole') === 'owner';
  // Connected accounts are the owner's business; a member gets the folder
  // list (needed to pick an upload target) but not whose pCloud it is.
  const profiles = isOwner ? await c.env.DB.prepare(
    `SELECT id, provider, account_label, api_host, created_at, last_verified_at
       FROM oauth_profiles
      WHERE tenant_id = ?
       ORDER BY created_at ASC`,
  ).bind(tenantId).all<ProfileSummary>() : { results: [] as ProfileSummary[] };
  const membersMayAdd = await membersCanAdd(c.env, tenantId);

  // Per-library stats. Two queries because counting books requires DISTINCT
  // over library_items, whereas duration/size sums across audio_files (a book
  // can have multiple files in principle, even though our scanner only emits
  // one today).
  // Per-backend counts. A library can have several folders and the useful
  // question when looking at one is "how much of this library lives here".
  const perFolder = await c.env.DB.prepare(
    `SELECT folder_id,
            SUM(CASE WHEN is_missing = 0 THEN 1 ELSE 0 END) AS book_count,
            SUM(CASE WHEN is_missing = 1 THEN 1 ELSE 0 END) AS missing_count
       FROM library_items
      WHERE tenant_id = ?
      GROUP BY folder_id`,
  ).bind(tenantId).all<{ folder_id: string; book_count: number; missing_count: number }>();
  const folderStats: Record<string, { bookCount: number; missingCount: number }> = {};
  for (const r of perFolder.results) {
    folderStats[r.folder_id] = { bookCount: r.book_count ?? 0, missingCount: r.missing_count ?? 0 };
  }

  const counts = await c.env.DB.prepare(
    `SELECT library_id,
            SUM(CASE WHEN is_missing = 0 THEN 1 ELSE 0 END) AS book_count,
            SUM(CASE WHEN is_missing = 1 THEN 1 ELSE 0 END) AS missing_count
       FROM library_items
      WHERE tenant_id = ?
       GROUP BY library_id`,
  ).bind(tenantId).all<{ library_id: string; book_count: number; missing_count: number }>();

  const sums = await c.env.DB.prepare(
    `SELECT li.library_id AS library_id,
            COALESCE(SUM(af.duration_seconds), 0) AS total_duration_seconds,
            COALESCE(SUM(af.size_bytes), 0) AS total_size_bytes
       FROM library_items li
       JOIN audio_files af ON af.library_item_id = li.id
      WHERE li.is_missing = 0 AND li.tenant_id = ?
      GROUP BY li.library_id`,
  ).bind(tenantId).all<{ library_id: string; total_duration_seconds: number; total_size_bytes: number }>();

  const stats: Record<string, { bookCount: number; missingCount: number; totalDurationSeconds: number; totalSizeBytes: number }> = {};
  for (const r of counts.results) {
    stats[r.library_id] = {
      bookCount: r.book_count ?? 0,
      missingCount: r.missing_count ?? 0,
      totalDurationSeconds: 0,
      totalSizeBytes: 0,
    };
  }
  for (const r of sums.results) {
    const s = stats[r.library_id] ?? { bookCount: 0, missingCount: 0, totalDurationSeconds: 0, totalSizeBytes: 0 };
    s.totalDurationSeconds = r.total_duration_seconds ?? 0;
    s.totalSizeBytes = r.total_size_bytes ?? 0;
    stats[r.library_id] = s;
  }

  return c.json({
    folders: folders.results.map((f) => ({
      id: f.id,
      libraryId: f.library_id,
      libraryName: f.library_name,
      provider: f.provider,
      profileId: f.profile_id,
      // Redact stored credentials — the admin UI only displays config, it
      // never needs to read secrets back, so don't round-trip them through
      // every admin session.
      config: redactSecrets(safeJson(f.config_json)),
      legacyBaseUrl: f.filedn_base_url,
      stats: folderStats[f.id] ?? { bookCount: 0, missingCount: 0 },
    })),
    profiles: profiles.results,
    stats,
    // Tell the UI which provider integrations are set up server-side. The UI
    // shows setup instructions when a provider's secrets are missing instead
    // of a "Connect" button that would 500.
    secrets: {
      pcloudConfigured: Boolean(c.env.PCLOUD_CLIENT_ID && c.env.PCLOUD_CLIENT_SECRET),
    },
    // Per-tenant role + instance-owner flag, so the admin page can reveal the
    // owner-only "Members & signups" panel. signupMode is only meaningful (and
    // only loaded) for the instance owner.
    role: c.get('tenantRole'),
    isInstanceOwner,
    userId: u.id,
    signupMode: isInstanceOwner ? await getSignupMode(c.env) : null,
    // The permission switch (owner sets it) and what it means for the caller.
    membersCanAdd: membersMayAdd,
    canAdd: isOwner || membersMayAdd,
  });
});

// Owner-only: the one per-tenant permission switch. Body {membersCanAdd: bool}.
adminRoutes.post('/tenant/settings', requireTenantOwner, async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof body['membersCanAdd'] === 'boolean') {
    await setTenantSetting(c.env, c.get('tenantId'), MEMBERS_CAN_ADD_KEY, body['membersCanAdd'] ? '1' : '0');
  }
  return c.json({ ok: true, membersCanAdd: await membersCanAdd(c.env, c.get('tenantId')) });
});

// Browse a storage backend before attaching it, so "which folder?" is a list
// to pick from rather than a path to type blind. Takes the same credentials
// the attach routes take — nothing is stored — and answers with one level of
// the tree. Owner-only, like attaching itself.
//
// S3 needs its own one-level call (listFolder is prefix-recursive and hides
// folders); WebDAV and pCloud already list a single directory.
adminRoutes.post('/storage/browse', requireTenantOwner, async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const provider = String(body['provider'] ?? '');
  const path = String(body['path'] ?? '').replace(/^\/+|\/+$/g, '');
  const cfg = (body['config'] ?? {}) as Record<string, string>;

  let entries: RemoteEntry[];
  try {
    if (provider === 's3') {
      const adapter = new S3Adapter(
        { endpoint: String(cfg['endpoint'] ?? ''), bucket: String(cfg['bucket'] ?? ''), region: String(cfg['region'] ?? 'auto'), prefix: '' },
        { accessKeyId: String(cfg['accessKeyId'] ?? ''), secretAccessKey: String(cfg['secretAccessKey'] ?? ''), region: String(cfg['region'] ?? 'auto') },
      );
      entries = await adapter.listDirectory(path);
    } else if (provider === 'webdav') {
      const adapter = new WebDAVAdapter(c.env, 'browse', new URL(c.req.url).origin, {
        baseUrl: String(cfg['baseUrl'] ?? ''), username: String(cfg['username'] ?? ''),
        password: String(cfg['password'] ?? ''), rootPath: '',
      });
      entries = await adapter.listFolder(path);
    } else if (provider === 'pcloud_oauth') {
      const profileRow = await c.env.DB.prepare(
        'SELECT * FROM oauth_profiles WHERE id = ? AND tenant_id = ?',
      ).bind(String(body['profileId'] ?? ''), c.get('tenantId')).first<OAuthProfileRow>();
      if (!profileRow) return c.json({ error: 'Unknown pCloud connection' }, 400);
      const adapter = new PcloudOAuthAdapter(
        { accessToken: profileRow.access_token, apiHost: profileRow.api_host ?? 'api.pcloud.com' },
        { rootPath: '/' },
      );
      entries = await adapter.listFolder(path);
    } else {
      return c.json({ error: `Can't browse provider ${provider}` }, 400);
    }
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }

  const dirs = entries.filter((e) => e.isDir).map((e) => e.relPath.split('/').pop() ?? e.relPath).sort((a, b) => a.localeCompare(b));
  const audioFiles = entries.filter((e) => !e.isDir && isAudiobookFile(e.relPath)).length;
  return c.json({ path, dirs, audioFiles, files: entries.filter((e) => !e.isDir).length });
});

// ─── Tenant members & invites (the "household / family" sharing model) ────────
//
// Members of one tenant share the same libraries but keep their own progress,
// bookmarks, and finished state (media_progress is user-scoped). Any member can
// VIEW the roster + open invites; only the tenant owner can invite or remove.

adminRoutes.get('/members', async (c) => {
  return c.json({ members: await listTenantMembers(c.env, c.get('tenantId')) });
});

adminRoutes.get('/invites', async (c) => {
  const invites = await listOpenInvites(c.env, c.get('tenantId'));
  return c.json({
    invites: invites.map((i) => ({ code: i.code, role: i.role, expiresAt: i.expires_at, createdAt: i.created_at })),
  });
});

// Create an invite for THIS tenant. Returns a ready-to-share signup link.
adminRoutes.post('/invites', requireTenantOwner, async (c) => {
  const invite = await createInvite(c.env, {
    tenantId: c.get('tenantId'),
    role: 'member',
    createdBy: c.get('userId'),
    ttlMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
  const origin = new URL(c.req.url).origin;
  return c.json({ code: invite.code, url: `${origin}/signup?invite=${invite.code}`, expiresAt: invite.expires_at });
});

adminRoutes.delete('/invites/:code', requireTenantOwner, async (c) => {
  const ok = await deleteInvite(c.env, c.req.param('code'), c.get('tenantId'));
  if (!ok) return c.json({ error: 'Invite not found' }, 404);
  return c.body(null, 204);
});

// Remove a member from this tenant. Owner-only; can't remove yourself or another
// owner (transfer/ownership changes are out of scope for now).
adminRoutes.delete('/members/:userId', requireTenantOwner, async (c) => {
  const tenantId = c.get('tenantId');
  const target = c.req.param('userId');
  if (target === c.get('userId')) return c.json({ error: 'You cannot remove yourself' }, 400);
  const members = await listTenantMembers(c.env, tenantId);
  const m = members.find((x) => x.userId === target);
  if (!m) return c.json({ error: 'Not a member of this tenant' }, 404);
  if (m.role === 'owner') return c.json({ error: 'Cannot remove an owner' }, 400);
  await removeMember(c.env, tenantId, target);
  return c.body(null, 204);
});

// ─── pCloud OAuth flow ──────────────────────────────────────────────────────

// Step 1: redirect the browser to pCloud's authorize page. Persists a CSRF
// state token tied to this admin session.
adminRoutes.get('/storage/pcloud/start', requireTenantOwner, async (c) => {
  const clientId = c.env.PCLOUD_CLIENT_ID;
  if (!clientId) {
    return c.json({ error: 'PCLOUD_CLIENT_ID not configured' }, 500);
  }
  const redirectUri = redirectUriFor(c.req.url);
  const state = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO oauth_state (state, provider, redirect_target, expires_at, created_at)
     VALUES (?, 'pcloud', ?, ?, ?)`,
  ).bind(state, '/admin/?pcloud=connected', now + 10 * 60_000, now).run();

  const authorize = pcloudAuthorizeUrl({ clientId, redirectUri, state });
  return c.redirect(authorize, 302);
});

// Step 2: pCloud redirects the browser back here with `code` + `state` (and
// for EU users, `hostname` and `locationid`). Validate state, exchange code,
// persist tokens, redirect to the admin UI success page.
adminRoutes.get('/storage/pcloud/callback', requireTenantOwner, async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state) {
    return c.json({ error: 'Missing code or state' }, 400);
  }
  const stateRow = await c.env.DB.prepare(
    `SELECT * FROM oauth_state WHERE state = ? AND provider = 'pcloud'`,
  ).bind(state).first<{ state: string; redirect_target: string | null; expires_at: number }>();
  if (!stateRow || stateRow.expires_at < Date.now()) {
    return c.json({ error: 'Invalid or expired state' }, 400);
  }
  await c.env.DB.prepare('DELETE FROM oauth_state WHERE state = ?').bind(state).run();

  const clientId = c.env.PCLOUD_CLIENT_ID;
  const clientSecret = c.env.PCLOUD_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return c.json({ error: 'PCLOUD_CLIENT_ID/SECRET not configured' }, 500);
  }

  // pCloud passes `hostname` for EU users; if absent the US host accepts the
  // exchange. We re-derive api_host from the response either way.
  const exchangeArgs: Parameters<typeof exchangePcloudCode>[0] = { code, clientId, clientSecret };
  const exchangeHost = c.req.query('hostname');
  if (exchangeHost) exchangeArgs.apiHost = exchangeHost;
  const tok = await exchangePcloudCode(exchangeArgs);
  const apiHost = apiHostFromLocationId(tok.locationid, tok.hostname);

  // Best-effort: get the account email for display.
  let accountLabel: string | null = null;
  try {
    const info = await pcloudUserinfo({ accessToken: tok.access_token, apiHost });
    accountLabel = info.email ?? null;
  } catch { /* non-fatal */ }

  const profileId = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO oauth_profiles
       (id, tenant_id, provider, access_token, refresh_token, api_host, account_label, scope, created_at, last_verified_at)
     VALUES (?, ?, 'pcloud', ?, NULL, ?, ?, NULL, ?, ?)`,
  ).bind(profileId, c.get('tenantId'), tok.access_token, apiHost, accountLabel, now, now).run();

  const target = stateRow.redirect_target ?? '/admin/';
  // Encode the freshly-created profile_id into the redirect so the admin UI
  // can immediately offer "use this connection for library X".
  const sep = target.includes('?') ? '&' : '?';
  return c.redirect(`${target}${sep}profile_id=${encodeURIComponent(profileId)}`, 302);
});

// Disconnect: remove the oauth_profile and unlink any folder still using it.
// Folder rows are kept (so you can re-link to a fresh connection); their
// provider stays 'pcloud_oauth' but profile_id becomes null and the folder
// will fail at first use.
adminRoutes.post('/storage/pcloud/disconnect/:profileId', requireTenantOwner, async (c) => {
  const profileId = c.req.param('profileId');
  const tenantId = c.get('tenantId');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE library_folders SET profile_id = NULL WHERE profile_id = ? AND tenant_id = ?').bind(profileId, tenantId),
    c.env.DB.prepare('DELETE FROM oauth_profiles WHERE id = ? AND tenant_id = ?').bind(profileId, tenantId),
  ]);
  return c.body(null, 204);
});

// ─── Folder configuration ────────────────────────────────────────────────────

// Convert (or initialise) a folder to point at a pCloud-OAuth profile + root
// path. Used by the admin UI after a successful connect.
//
// Body: { libraryId, profileId, rootPath }
adminRoutes.post('/storage/folder/pcloud', requireTenantOwner, async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const libraryId = String(body['libraryId'] ?? '');
  const profileId = String(body['profileId'] ?? '');
  const rootPath = String(body['rootPath'] ?? '/');
  if (!libraryId || !profileId) {
    return c.json({ error: 'libraryId and profileId required' }, 400);
  }
  const tenantId = c.get('tenantId');
  const lib = await getLibrary(c.env, libraryId, tenantId);
  if (!lib) return c.json({ error: 'Library not found' }, 404);
  const profile = await c.env.DB.prepare(
    `SELECT id FROM oauth_profiles WHERE id = ? AND provider = 'pcloud' AND tenant_id = ?`,
  ).bind(profileId, tenantId).first<{ id: string }>();
  if (!profile) return c.json({ error: 'Profile not found' }, 404);

  const folders = await listFolders(c.env, libraryId, tenantId);
  const config = JSON.stringify({ rootPath });
  const now = Date.now();

  if (folders.length === 0) {
    // Fresh library — create a folder row.
    const id = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO library_folders
         (id, library_id, tenant_id, filedn_base_url, added_at, provider, config_json, profile_id)
       VALUES (?, ?, ?, '', ?, 'pcloud_oauth', ?, ?)`,
    ).bind(id, libraryId, tenantId, now, config, profileId).run();
    return c.json({ folderId: id });
  }

  // Re-point the first folder. (Multi-folder libraries are not in scope for
  // the MVP; the admin UI shows one folder per library.)
  const folderId = folders[0]!.id;
  await c.env.DB.prepare(
    `UPDATE library_folders
        SET provider = 'pcloud_oauth', config_json = ?, profile_id = ?
      WHERE id = ?`,
  ).bind(config, profileId, folderId).run();
  return c.json({ folderId });
});

// Configure a library_folders row to point at an S3-compatible bucket.
// Body: { libraryId, endpoint, bucket, region, prefix?, accessKeyId, secretAccessKey }
adminRoutes.post('/storage/folder/s3', requireTenantOwner, async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const libraryId = String(body['libraryId'] ?? '');
  const endpoint = String(body['endpoint'] ?? '').replace(/\/+$/, '');
  const bucket = String(body['bucket'] ?? '');
  const region = String(body['region'] ?? 'auto');
  const prefix = String(body['prefix'] ?? '');
  const accessKeyId = String(body['accessKeyId'] ?? '');
  const secretAccessKey = String(body['secretAccessKey'] ?? '');
  if (!libraryId || !endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    return c.json({ error: 'libraryId, endpoint, bucket, accessKeyId, secretAccessKey required' }, 400);
  }
  const tenantId = c.get('tenantId');
  if (!await getLibrary(c.env, libraryId, tenantId)) return c.json({ error: 'Library not found' }, 404);
  const config = JSON.stringify({ endpoint, bucket, region, prefix, accessKeyId, secretAccessKey });
  return upsertFolderProvider(c.env, libraryId, tenantId, 's3', config, null);
});

// Configure a library_folders row to point at a WebDAV server.
// Body: { libraryId, baseUrl, username, password, rootPath? }
adminRoutes.post('/storage/folder/webdav', requireTenantOwner, async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const libraryId = String(body['libraryId'] ?? '');
  const username = String(body['username'] ?? '');
  const password = String(body['password'] ?? '');
  const rootPath = String(body['rootPath'] ?? '');
  if (!libraryId || !body['baseUrl'] || !username) {
    return c.json({ error: 'libraryId, baseUrl, username required' }, 400);
  }
  // Store it already normalised, so a URL typed without https:// can't be
  // saved as one that no request can be built from.
  let baseUrl: string;
  try { baseUrl = normalizeWebdavBaseUrl(String(body['baseUrl'])); }
  catch (e) { return c.json({ error: (e as Error).message }, 400); }
  const tenantId = c.get('tenantId');
  if (!await getLibrary(c.env, libraryId, tenantId)) return c.json({ error: 'Library not found' }, 404);
  const config = JSON.stringify({ baseUrl, username, password, rootPath });
  return upsertFolderProvider(c.env, libraryId, tenantId, 'webdav', config, null);
});

// Always insert a new folder row. Multi-backend per library is intentional —
// libraries can pull from R2 + NAS + pCloud simultaneously, with each book
// pinned to the folder it actually lives in via library_items.folder_id.
// To swap a backend, add the new one and remove the old one explicitly.
async function upsertFolderProvider(env: Env, libraryId: string, tenantId: string, provider: string, configJson: string, profileId: string | null): Promise<Response> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO library_folders
       (id, library_id, tenant_id, filedn_base_url, added_at, provider, config_json, profile_id)
     VALUES (?, ?, ?, '', ?, ?, ?, ?)`,
  ).bind(id, libraryId, tenantId, now, provider, configJson, profileId).run();
  return new Response(JSON.stringify({ folderId: id }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

// Remove a folder. Refuses if any library_items still reference it — caller
// has to explicitly clear those items first (we don't cascade-delete here
// because losing user progress on a misclick is worse than the inconvenience).
// Detach a storage backend. `?removeItems=1` also drops the library entries
// that lived on it — which is what "remove this backend" means to a person:
// the shelf shouldn't keep listing books it can no longer read. **Nothing is
// deleted from the storage itself**; the files stay on the NAS or in the
// bucket and re-attaching plus a scan brings them back (progress doesn't
// come back — the item ids are regenerated).
//
// Without the flag a folder with items is still refused, so an accidental
// call can't quietly wipe a shelf.
adminRoutes.delete('/storage/folder/:id', requireTenantOwner, async (c) => {
  const folderId = c.req.param('id');
  const tenantId = c.get('tenantId');
  const removeItems = c.req.query('removeItems') === '1';
  // Confirm the folder belongs to this tenant before touching it.
  const owned = await c.env.DB.prepare(
    `SELECT id FROM library_folders WHERE id = ? AND tenant_id = ?`,
  ).bind(folderId, tenantId).first<{ id: string }>();
  if (!owned) return c.json({ error: 'Folder not found' }, 404);

  // Count by folder alone: the folder's own tenant is already verified, and
  // filtering items by tenant_id too would let a row with drifted tenancy
  // slip past the guard below — which matters because
  // `library_items.folder_id` is ON DELETE CASCADE, so deleting the folder
  // row takes its books (and everything hanging off them) with it whether we
  // ask or not. The guard is the only thing standing between a mis-click and
  // a wiped shelf; the explicit deletes below are belt-and-braces.
  const items = await c.env.DB.prepare(
    `SELECT id FROM library_items WHERE folder_id = ?`,
  ).bind(folderId).all<{ id: string }>();

  if (items.results.length && !removeItems) {
    return c.json({
      error: 'Folder still has items',
      detail: `${items.results.length} book(s) still live on this backend. Detach with ?removeItems=1 to drop them from the library (the files themselves are not touched).`,
      items: items.results.length,
    }, 409);
  }

  if (items.results.length) {
    // Same tables as deleting one item, keyed on the folder in one pass.
    const ownedIds = 'SELECT id FROM library_items WHERE folder_id = ?';
    await c.env.DB.batch([
      c.env.DB.prepare(`DELETE FROM chapters WHERE library_item_id IN (${ownedIds})`).bind(folderId),
      c.env.DB.prepare(`DELETE FROM audio_files WHERE library_item_id IN (${ownedIds})`).bind(folderId),
      c.env.DB.prepare(`DELETE FROM book_metadata WHERE library_item_id IN (${ownedIds})`).bind(folderId),
      c.env.DB.prepare(`DELETE FROM media_progress WHERE library_item_id IN (${ownedIds})`).bind(folderId),
      c.env.DB.prepare(`DELETE FROM bookmarks WHERE library_item_id IN (${ownedIds})`).bind(folderId),
      c.env.DB.prepare(`DELETE FROM listening_sessions WHERE library_item_id IN (${ownedIds})`).bind(folderId),
      c.env.DB.prepare('DELETE FROM library_items WHERE folder_id = ?').bind(folderId),
    ]);
    // Cached covers are per item; failure here only wastes R2 space.
    for (const it of items.results) {
      try { await c.env.COVERS.delete(`covers/${it.id}`); } catch { /* non-fatal */ }
    }
  }

  await c.env.DB.prepare('DELETE FROM library_folders WHERE id = ? AND tenant_id = ?').bind(folderId, tenantId).run();
  return c.json({ detached: true, itemsRemoved: items.results.length });
});

// ─── Scan ────────────────────────────────────────────────────────────────────

// Run a synchronous scan of one library. Returns a small report (added /
// updated / skipped / errors). Long scans should move to a Durable Object or
// queue later — for personal-library sizes (≤ a few hundred books) the wall
// clock is fine inside one Worker invocation.
adminRoutes.post('/libraries/:id/scan', async (c) => {
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');
  const lib = await getLibrary(c.env, id, tenantId);
  if (!lib) return c.json({ error: 'Library not found' }, 404);
  let report: ScanReport;
  try {
    report = await runScan(c.env, id, tenantId);
  } catch (e) {
    return c.json({ error: 'Scan failed', detail: (e as Error).message }, 502);
  }
  return c.json(report);
});

// Add one book by relative path, bypassing the folder-listing scanner. Works
// on any backend the adapter supports — including public_url, which can't
// list folders but CAN resolve a known relative path. Useful for filedn-style
// libraries while waiting for OAuth, or as an "add this specific book"
// shortcut even on pCloud/R2.
//
// Body: { libraryId: string, relPath: string }
//   relPath is the path inside the folder, e.g. "The Singularity Trap/The Singularity Trap (Unabridged).m4b"
adminRoutes.post('/books/add-by-path', requireCanAdd, async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const libraryId = String(body['libraryId'] ?? '');
  const relPath = String(body['relPath'] ?? '').trim();
  if (!libraryId || !relPath) {
    return c.json({ error: 'libraryId and relPath required' }, 400);
  }
  try {
    const result = await addBookByPath(c.env, libraryId, relPath, c.get('tenantId'));
    return c.json(result);
  } catch (e) {
    return c.json({ error: 'Add failed', detail: (e as Error).message }, 502);
  }
});

// ─── pCloud upload (chunked) ────────────────────────────────────────────────
//
// Three-step browser → Worker → pCloud upload flow. Workers cap inbound bodies
// at 100 MB (Free) / 500 MB (Paid), so the browser splits files into smaller
// chunks (~8 MB) and we forward each one to pCloud's upload_write. The actual
// pCloud upload session has no size limit, so any file fits.
//
// Why we don't use pCloud's createuploadlink (which would let the browser POST
// directly to pCloud and bypass the Worker entirely): it needs write-scope
// OAuth that pCloud only hands out after manual review, and CORS on those
// upload hosts is not browser-friendly. The proxy adds one extra hop but is
// simple, observable, and works today.

// Load a pCloud-OAuth folder + its profile. Returns the same Response shape
// as a Hono handler when the lookup fails so callers can `return` directly.
async function loadPcloudFolder(env: Env, folderId: string, tenantId: string): Promise<
  { ok: true; folder: NonNullable<Awaited<ReturnType<typeof getFolderById>>>; profile: PcloudProfile; rootPath: string }
  | { ok: false; status: number; error: string }
> {
  const folder = await getFolderById(env, folderId, tenantId);
  if (!folder) return { ok: false, status: 404, error: 'Folder not found' };
  if (folder.provider !== 'pcloud_oauth') {
    return { ok: false, status: 400, error: 'Upload is only supported on pcloud_oauth folders' };
  }
  if (!folder.profile_id) return { ok: false, status: 400, error: 'Folder has no profile_id' };
  const profileRow = await env.DB.prepare(
    'SELECT * FROM oauth_profiles WHERE id = ? AND tenant_id = ?',
  ).bind(folder.profile_id, tenantId).first<OAuthProfileRow>();
  if (!profileRow) return { ok: false, status: 404, error: 'pCloud profile missing' };
  const apiHost = profileRow.api_host ?? 'api.pcloud.com';
  const profile: PcloudProfile = { accessToken: profileRow.access_token, apiHost };
  let rootPath = '/';
  try {
    const cfg = JSON.parse(folder.config_json ?? '{}') as { rootPath?: string };
    rootPath = cfg.rootPath ?? '/';
  } catch { /* default */ }
  return { ok: true, folder, profile, rootPath };
}

// Build an absolute pCloud path from a folder's rootPath + a user-supplied
// relPath. Defends against path-traversal (../) so a compromised browser
// can't write outside the configured audiobook root.
function joinPcloudPath(rootPath: string, relPath: string): string {
  const cleanRoot = rootPath.replace(/\/+$/, '') || '/';
  const cleanRel = relPath.replace(/^\/+/, '').replace(/\\/g, '/');
  if (cleanRel.split('/').some((seg) => seg === '..' || seg === '')) {
    throw new Error(`Invalid relPath: ${relPath}`);
  }
  return cleanRoot === '/' ? `/${cleanRel}` : `${cleanRoot}/${cleanRel}`;
}

// Step 1: create a pCloud upload session.
// Body: { relPath: string }  (relPath is informational here; the actual save
// path is chosen in /save so retries / renames are possible)
// Returns: { uploadId, chunkSize }
//
// Chunk size = 25 MB. Larger amortises per-request handshake overhead; the
// Worker streams the body through (see /chunk below) so we don't hold this
// in memory.
adminRoutes.post('/storage/folder/:folderId/upload/init', requireCanAdd, async (c) => {
  const loaded = await loadPcloudFolder(c.env, c.req.param('folderId'), c.get('tenantId'));
  if (!loaded.ok) return c.json({ error: loaded.error }, loaded.status as 400 | 404);
  const uploadId = await pcloudUploadCreate(loaded.profile);
  return c.json({ uploadId, chunkSize: 25 * 1024 * 1024 });
});

// Step 2: write one chunk.
// Query: ?uploadId=N&offset=N
// Body: raw bytes for this chunk
// Returns: 204
//
// The body is streamed through the Worker — `c.req.raw.body` is forwarded
// directly to pCloud's upload_write as a ReadableStream with the inbound
// Content-Length passed along. This means browser→Worker and Worker→pCloud
// transfers overlap in time instead of running sequentially, ~halving wall
// clock for each chunk on slow uplinks, and Worker memory stays low so we
// can use large chunks without trouble.
adminRoutes.post('/storage/folder/:folderId/upload/chunk', requireCanAdd, async (c) => {
  const loaded = await loadPcloudFolder(c.env, c.req.param('folderId'), c.get('tenantId'));
  if (!loaded.ok) return c.json({ error: loaded.error }, loaded.status as 400 | 404);
  const uploadId = Number(c.req.query('uploadId') ?? '');
  const offset = Number(c.req.query('offset') ?? '');
  const contentLength = Number(c.req.header('content-length') ?? '0');
  if (!Number.isFinite(uploadId) || !Number.isFinite(offset) || offset < 0) {
    return c.json({ error: 'uploadId and offset required' }, 400);
  }
  if (!contentLength) return c.json({ error: 'Content-Length header required' }, 411);
  const body = c.req.raw.body;
  if (!body) return c.json({ error: 'Empty body' }, 400);
  await pcloudUploadWrite(loaded.profile, {
    uploadId, offset, body, contentLength,
  });
  return c.body(null, 204);
});

// Step 3: finalize. Saves the assembled bytes to <rootPath>/<relPath> in
// pCloud. If the saved file looks like an audiobook (.m4b/.m4a/.aac/.opus/.ogg),
// automatically registers it via addBookByPath so it shows up in the library
// without a separate scan step.
//
// Body: { uploadId: number, relPath: string, registerAsBook?: boolean }
adminRoutes.post('/storage/folder/:folderId/upload/save', requireCanAdd, async (c) => {
  const loaded = await loadPcloudFolder(c.env, c.req.param('folderId'), c.get('tenantId'));
  if (!loaded.ok) return c.json({ error: loaded.error }, loaded.status as 400 | 404);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const uploadId = Number(body['uploadId'] ?? '');
  const relPath = String(body['relPath'] ?? '').trim();
  const registerAsBook = body['registerAsBook'] !== false;
  if (!Number.isFinite(uploadId) || !relPath) {
    return c.json({ error: 'uploadId and relPath required' }, 400);
  }
  let absPath: string;
  try {
    absPath = joinPcloudPath(loaded.rootPath, relPath);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
  const saved = await pcloudUploadSave(loaded.profile, { uploadId, path: absPath });

  // Auto-register as a library item when this is the primary audio file.
  // Failures here are non-fatal (the file is uploaded; manual add-by-path
  // recovers) but we DO surface them so the UI can show what went wrong
  // instead of silently dropping the book.
  let itemId: string | undefined;
  let registerError: string | undefined;
  let alreadyInLibrary = false;
  if (registerAsBook && /\.(m4b|m4a|aac|opus|ogg)$/i.test(relPath)) {
    try {
      // Pass through size from pCloud's upload_save response so audio_files
      // gets a real size_bytes on first insert (without this, single-file
      // uploads end up with size=0 in the library).
      const hints: { sizeBytes?: number } = {};
      if (saved.metadata?.size != null) hints.sizeBytes = saved.metadata.size;
      const result = await addBookByPath(c.env, loaded.folder.library_id, relPath, c.get('tenantId'), hints);
      if (result.itemId) itemId = result.itemId;
      if (!result.added && result.reason) registerError = result.reason;
      if (!result.added && result.reason === 'Already in library') alreadyInLibrary = true;
    } catch (e) {
      registerError = (e as Error).message;
    }
  }

  const out: { savedPath: string; size?: number; itemId?: string; registerError?: string; alreadyInLibrary?: boolean } = {
    savedPath: saved.metadata?.path ?? absPath,
  };
  if (alreadyInLibrary) out.alreadyInLibrary = true;
  if (saved.metadata?.size != null) out.size = saved.metadata.size;
  if (itemId) out.itemId = itemId;
  if (registerError) out.registerError = registerError;
  return c.json(out);
});

// ─── pCloud fetch-from-URL ──────────────────────────────────────────────────
//
// "Paste a download link" flow. pCloud's own servers pull the file
// (downloadfileasync), so nothing streams through the Worker and the file
// size doesn't matter. Three stateless calls from the browser:
//   start    → validates, HEADs the source for Content-Length, ensures the
//              target folder exists, queues the job
//   progress → stat()s the target path; "finished" when its size reaches
//              the source's Content-Length (or, when the source didn't say,
//              when the size stops changing between two polls)
//   finish   → registers the landed file with addBookByPath
// Stateless on purpose — no D1 table for jobs; if the admin tab closes
// mid-download the file still lands and "Add book by path" recovers it.
//
// Why stat-based: pCloud documents uploadprogress?progresshash for these
// jobs, but live it returns 1900 "Upload not found" for the entire download
// (see src/storage/pcloud.ts). Why size-compare: we don't know whether pCloud
// writes the file atomically or grows it in place, and registering a
// half-written m4b would probe garbage. Matching Content-Length is safe
// either way.
//
// Constraint worth knowing: the URL must be a *direct* download that
// pCloud's fetcher can GET without cookies/JS. Google Drive share pages,
// MEGA etc. hand back HTML; some hosts (w3.org, observed) refuse pCloud's
// fetcher outright — pCloud reports success and the file simply never
// appears. The HEAD probe in /start catches the HTML case; the
// never-appears case surfaces as a client-side timeout.

function splitRelPath(relPath: string): { dir: string; name: string } {
  const idx = relPath.lastIndexOf('/');
  return idx === -1
    ? { dir: '', name: relPath }
    : { dir: relPath.slice(0, idx), name: relPath.slice(idx + 1) };
}

// Learn what the source serves before asking pCloud to fetch it. HEAD first;
// some hosts reject HEAD, so fall back to a 1-byte ranged GET and read the
// total off Content-Range. Any failure here is non-fatal (size unknown) —
// pCloud may still succeed where we didn't — except an HTML body, which
// means this is a landing page and not a file.
async function probeSourceUrl(url: string): Promise<{ size?: number; contentType?: string; error?: string }> {
  const out: { size?: number; contentType?: string; error?: string } = {};
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    let res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ac.signal });
    let size = Number(res.headers.get('content-length') ?? '');
    if (!res.ok || !Number.isFinite(size) || size <= 0) {
      res = await fetch(url, { method: 'GET', redirect: 'follow', signal: ac.signal, headers: { Range: 'bytes=0-0' } });
      const m = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '');
      size = m ? Number(m[1]) : Number(res.headers.get('content-length') ?? '');
      await res.body?.cancel().catch(() => undefined);
    }
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    if (ct) out.contentType = ct;
    if (/^text\/html/.test(ct)) {
      out.error = 'That URL serves a web page (text/html), not a file — it needs to be a direct download link';
      return out;
    }
    if (res.ok && Number.isFinite(size) && size > 0) out.size = size;
  } catch {
    // Unreachable from the Worker isn't proof pCloud can't fetch it; carry on with size unknown.
  } finally {
    clearTimeout(timer);
  }
  return out;
}

// Body: { url: string, relPath: string }
// Returns: { relPath, absPath, expectedSize? }
adminRoutes.post('/storage/folder/:folderId/fetch-url/start', requireCanAdd, async (c) => {
  const loaded = await loadPcloudFolder(c.env, c.req.param('folderId'), c.get('tenantId'));
  if (!loaded.ok) return c.json({ error: loaded.error }, loaded.status as 400 | 404);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const url = String(body['url'] ?? '').trim();
  const relPath = String(body['relPath'] ?? '').trim().replace(/^\/+/, '');
  // Remember where this release goes, so a later top-up pass lands in the
  // same folder instead of inventing a new one (migration 0013).
  const sourceHash = String(body['sourceHash'] ?? '').trim().toLowerCase();
  const sourceTitle = String(body['sourceTitle'] ?? '').trim();
  if (/^[0-9a-f]{40}$/.test(sourceHash) && relPath.includes('/')) {
    const top = relPath.split('/')[0]!;
    const now = Date.now();
    await c.env.DB.prepare(
      `INSERT INTO abb_grabs (tenant_id, hash, dest, title, folder_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, hash) DO UPDATE SET updated_at = excluded.updated_at`,
    ).bind(c.get('tenantId'), sourceHash, top, sourceTitle || null, c.req.param('folderId'), now, now)
      .run().catch(() => undefined);   // never block a fetch on bookkeeping
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return c.json({ error: 'url must be an absolute http(s) URL' }, 400);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return c.json({ error: 'url must be http(s)' }, 400);
  }
  const { dir, name } = splitRelPath(relPath);
  if (!name) return c.json({ error: 'relPath must include a file name' }, 400);
  let absDir: string;
  let absPath: string;
  try {
    absDir = dir ? joinPcloudPath(loaded.rootPath, dir) : (loaded.rootPath.replace(/\/+$/, '') || '/');
    absPath = joinPcloudPath(loaded.rootPath, relPath);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
  // Refuse to clobber — pCloud would otherwise save alongside as "name (1)"
  // and the registration step would point at the wrong file. There's no
  // hash to compare (pCloud exposes none for a remote URL), so "same path
  // AND same byte size as the source" is treated as already-landed: the
  // client skips straight to /finish. A size mismatch is a different or
  // partial file and stays a hard 409.
  const existing = await pcloudStat(loaded.profile, absPath);
  const probe = await probeSourceUrl(url);
  if (probe.error) return c.json({ error: probe.error }, 400);
  if (existing) {
    if (probe.size != null && existing.size === probe.size) {
      return c.json({ relPath, absPath, expectedSize: probe.size, alreadyComplete: true });
    }
    // Smaller than the source: pCloud is (or was) still writing it — a
    // previous attempt whose tab died, or a transient error that killed the
    // client's polling. Let the client resume polling instead of refusing;
    // /progress's size-vs-expected rule decides when it's done.
    if (probe.size != null && existing.size != null && existing.size < probe.size) {
      return c.json({ relPath, absPath, expectedSize: probe.size, resumed: true });
    }
    const why = probe.size != null && existing.size != null
      ? ` (pCloud copy is ${existing.size} bytes, source is ${probe.size} bytes)`
      : '';
    return c.json({ error: `Already exists in pCloud: ${absPath}${why} — delete it there first if you want it re-fetched` }, 409);
  }
  const folderId = await pcloudEnsureFolder(loaded.profile, absDir);
  await pcloudDownloadFileAsync(loaded.profile, { url, folderId, name });
  const out: { relPath: string; absPath: string; expectedSize?: number } = { relPath, absPath };
  if (probe.size != null) out.expectedSize = probe.size;
  return c.json(out);
});

// Query: ?relPath=…&expectedSize=N&lastSize=N
// Returns: { finished: boolean, status: 'pending'|'downloading'|'ready', size?, downloaded? }
adminRoutes.get('/storage/folder/:folderId/fetch-url/progress', requireCanAdd, async (c) => {
  const loaded = await loadPcloudFolder(c.env, c.req.param('folderId'), c.get('tenantId'));
  if (!loaded.ok) return c.json({ error: loaded.error }, loaded.status as 400 | 404);
  const relPath = (c.req.query('relPath') ?? '').trim().replace(/^\/+/, '');
  const expectedSize = Number(c.req.query('expectedSize') ?? '');
  const lastSize = Number(c.req.query('lastSize') ?? '');
  if (!relPath) return c.json({ error: 'relPath required' }, 400);
  let absPath: string;
  try {
    absPath = joinPcloudPath(loaded.rootPath, relPath);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
  const meta = await pcloudStat(loaded.profile, absPath);
  if (!meta || meta.isfolder) return c.json({ finished: false, status: 'pending' });
  const size = meta.size ?? 0;
  const done = Number.isFinite(expectedSize) && expectedSize > 0
    ? size >= expectedSize
    // No Content-Length from the source: call it done once the size holds
    // still across two polls. Only a heuristic, but it's all we've got.
    : size > 0 && Number.isFinite(lastSize) && lastSize === size;
  const out: { finished: boolean; status: string; size?: number; downloaded: number } = {
    finished: done, status: done ? 'ready' : 'downloading', downloaded: size,
  };
  if (Number.isFinite(expectedSize) && expectedSize > 0) out.size = expectedSize;
  return c.json(out);
});

// Body: { relPath: string, registerAsBook?: boolean }
// Mirrors the tail of /upload/save so both paths register books identically.
adminRoutes.post('/storage/folder/:folderId/fetch-url/finish', requireCanAdd, async (c) => {
  const loaded = await loadPcloudFolder(c.env, c.req.param('folderId'), c.get('tenantId'));
  if (!loaded.ok) return c.json({ error: loaded.error }, loaded.status as 400 | 404);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const relPath = String(body['relPath'] ?? '').trim().replace(/^\/+/, '');
  const registerAsBook = body['registerAsBook'] !== false;
  if (!relPath) return c.json({ error: 'relPath required' }, 400);
  let absPath: string;
  try {
    absPath = joinPcloudPath(loaded.rootPath, relPath);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
  const meta = await pcloudStat(loaded.profile, absPath);
  if (!meta || meta.isfolder) return c.json({ error: `File not found in pCloud: ${absPath}` }, 404);

  let itemId: string | undefined;
  let registerError: string | undefined;
  let alreadyInLibrary = false;
  if (registerAsBook && /\.(m4b|m4a|aac|opus|ogg)$/i.test(relPath)) {
    try {
      const hints: { sizeBytes?: number } = {};
      if (meta.size != null) hints.sizeBytes = meta.size;
      const result = await addBookByPath(c.env, loaded.folder.library_id, relPath, c.get('tenantId'), hints);
      if (result.itemId) itemId = result.itemId;
      if (!result.added && result.reason) registerError = result.reason;
      if (!result.added && result.reason === 'Already in library') alreadyInLibrary = true;
    } catch (e) {
      registerError = (e as Error).message;
    }
  }
  const out: { savedPath: string; size?: number; itemId?: string; registerError?: string; alreadyInLibrary?: boolean } = { savedPath: absPath };
  if (alreadyInLibrary) out.alreadyInLibrary = true;
  if (meta.size != null) out.size = meta.size;
  if (itemId) out.itemId = itemId;
  if (registerError) out.registerError = registerError;
  return c.json(out);
});

// ─── Server-side zip extraction ─────────────────────────────────────────────
//
// Hands a zip that already sits in pCloud to ArchiveExtractDO (see
// src/do/archive-extract.ts) and lets the browser poll it. Used after a
// fetch-from-URL lands an archive; browser uploads still extract client-side
// because that already works and handles rar.

function extractJobStub(env: Env, tenantId: string, folderId: string, relPath: string): DurableObjectStub {
  return env.ARCHIVE_EXTRACT.get(env.ARCHIVE_EXTRACT.idFromName(`${tenantId}|${folderId}|${relPath}`));
}

// Body: { relPath: string, deleteArchive?: boolean }
adminRoutes.post('/storage/folder/:folderId/extract/start', requireCanAdd, async (c) => {
  const loaded = await loadPcloudFolder(c.env, c.req.param('folderId'), c.get('tenantId'));
  if (!loaded.ok) return c.json({ error: loaded.error }, loaded.status as 400 | 404);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const relPath = String(body['relPath'] ?? '').trim().replace(/^\/+/, '');
  const deleteArchive = body['deleteArchive'] !== false;
  if (!relPath) return c.json({ error: 'relPath required' }, 400);
  if (/\.rar$/i.test(relPath)) {
    return c.json({ error: 'rar archives can\'t be extracted server-side (pCloud\'s extract API is broken and rar needs a WASM decoder). Download it and use the browser upload, which extracts rar locally.' }, 400);
  }
  if (!/\.zip$/i.test(relPath)) return c.json({ error: 'Only .zip is supported' }, 400);
  try {
    joinPcloudPath(loaded.rootPath, relPath);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
  const { dir, name } = splitRelPath(relPath);
  const stem = name.replace(/\.zip$/i, '');
  const destRelDir = dir ? `${dir}/${stem}` : stem;
  const init = {
    tenantId: c.get('tenantId'), libraryId: loaded.folder.library_id, folderId: loaded.folder.id,
    profile: loaded.profile, rootPath: loaded.rootPath, archiveRelPath: relPath, destRelDir, deleteArchive,
  };
  const res = await extractJobStub(c.env, c.get('tenantId'), loaded.folder.id, relPath).fetch('https://do/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init),
  });
  return c.json(await res.json(), res.status as 200);
});

// Query: ?relPath=
adminRoutes.get('/storage/folder/:folderId/extract/status', requireCanAdd, async (c) => {
  const loaded = await loadPcloudFolder(c.env, c.req.param('folderId'), c.get('tenantId'));
  if (!loaded.ok) return c.json({ error: loaded.error }, loaded.status as 400 | 404);
  const relPath = (c.req.query('relPath') ?? '').trim().replace(/^\/+/, '');
  if (!relPath) return c.json({ error: 'relPath required' }, 400);
  const res = await extractJobStub(c.env, c.get('tenantId'), loaded.folder.id, relPath).fetch('https://do/status');
  return c.json(await res.json(), res.status as 200);
});

// ─── Library item management ────────────────────────────────────────────────

// Compact book list for the admin UI. Returns just enough to render rows
// (title, author, duration, chapter count, size). The main /api/libraries
// endpoint returns the full ABS shape per item which is overkill here.
adminRoutes.get('/libraries/:libId/items', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT li.id,
            li.rel_path,
            li.is_missing,
            bm.title,
            bm.author_name,
            bm.series_name,
            (SELECT COUNT(*) FROM chapters ch WHERE ch.library_item_id = li.id) AS chapter_count,
            (SELECT COALESCE(SUM(af.duration_seconds), 0) FROM audio_files af WHERE af.library_item_id = li.id) AS duration_seconds,
            (SELECT COALESCE(SUM(af.size_bytes), 0) FROM audio_files af WHERE af.library_item_id = li.id) AS size_bytes
       FROM library_items li
       LEFT JOIN book_metadata bm ON bm.library_item_id = li.id
      WHERE li.library_id = ? AND li.tenant_id = ?
      ORDER BY bm.title COLLATE NOCASE ASC`,
  ).bind(c.req.param('libId'), c.get('tenantId')).all<{
    id: string;
    rel_path: string;
    is_missing: number;
    title: string | null;
    author_name: string | null;
    series_name: string | null;
    chapter_count: number;
    duration_seconds: number;
    size_bytes: number;
  }>();
  return c.json({ items: rows.results });
});

// Re-probe a single item. Useful when chapters or duration came in wrong.
// The same book registered more than once. It happens when one release is
// grabbed twice into different folders — the scanner is idempotent per
// (folder, path), so a second path is a second book as far as it can tell,
// and nothing else in the UI would ever tell you. Grouped by title+author,
// which is what a person means by "the same book"; the paths and lengths in
// each group are what you need to decide which copy to keep.
adminRoutes.get('/libraries/:libId/duplicates', async (c) => {
  const folders = await listFolders(c.env, c.req.param('libId'), c.get('tenantId'));
  const backendOf = new Map(folders.map((f) => [f.id, storageLabelText(f)]));
  const rows = await c.env.DB.prepare(
    `SELECT li.id, li.rel_path, li.folder_id, bm.title, bm.author_name,
            (SELECT COUNT(*) FROM chapters ch WHERE ch.library_item_id = li.id) AS chapter_count,
            (SELECT COUNT(*) FROM audio_files af WHERE af.library_item_id = li.id) AS file_count,
            (SELECT COALESCE(SUM(af.duration_seconds), 0) FROM audio_files af WHERE af.library_item_id = li.id) AS duration_seconds,
            (SELECT COALESCE(SUM(af.size_bytes), 0) FROM audio_files af WHERE af.library_item_id = li.id) AS size_bytes
       FROM library_items li
       LEFT JOIN book_metadata bm ON bm.library_item_id = li.id
      WHERE li.library_id = ? AND li.tenant_id = ?
      ORDER BY bm.title COLLATE NOCASE ASC, li.rel_path ASC`,
  ).bind(c.req.param('libId'), c.get('tenantId')).all<{
    id: string; rel_path: string; folder_id: string; title: string | null; author_name: string | null;
    chapter_count: number; file_count: number; duration_seconds: number; size_bytes: number;
  }>();

  const groups = new Map<string, typeof rows.results>();
  for (const r of rows.results) {
    const key = ((r.title ?? r.rel_path) + '|' + (r.author_name ?? '')).toLowerCase().trim();
    const arr = groups.get(key);
    if (arr) arr.push(r); else groups.set(key, [r]);
  }
  return c.json({
    groups: [...groups.values()]
      .filter((g) => g.length > 1)
      .map((g) => ({
        title: g[0]!.title,
        author: g[0]!.author_name,
        // The same book on two backends is a deliberate arrangement (one
        // copy on the NAS, one on pCloud); the same book twice on ONE
        // backend is the accident worth cleaning up. Say which this is.
        acrossBackends: new Set(g.map((i) => i.folder_id)).size > 1,
        items: g.map((i) => ({ ...i, backend: backendOf.get(i.folder_id) ?? i.folder_id })),
      })),
  });
});

adminRoutes.post('/items/:itemId/reprobe', async (c) => {
  try {
    const result = await reprobeItem(c.env, c.req.param('itemId'), c.get('tenantId'));
    return c.json(result);
  } catch (e) {
    return c.json({ error: 'Re-probe failed', detail: (e as Error).message }, 502);
  }
});

// Re-probe every item in a library, or only those with zero chapters when
// onlyMissingChapters=1. Long libraries may exceed Worker wall-clock if
// audiobooks are huge — we run sequentially to keep memory bounded and
// surface per-item failures in the response.
adminRoutes.post('/libraries/:libId/reprobe', async (c) => {
  const libId = c.req.param('libId');
  const onlyMissing = c.req.query('onlyMissingChapters') === '1';
  // "Missing" includes exactly-one-chapter books: a single-file mp3 scanned
  // before CHAP support (2026-08-23) got one whole-file chapter.
  const filter = onlyMissing
    ? `AND (SELECT count(*) FROM chapters ch WHERE ch.library_item_id = li.id) <= 1`
    : '';
  const tenantId = c.get('tenantId');
  const rows = await c.env.DB.prepare(
    `SELECT li.id FROM library_items li
      WHERE li.library_id = ? AND li.tenant_id = ? AND li.is_missing = 0 ${filter}`,
  ).bind(libId, tenantId).all<{ id: string }>();
  const ids = rows.results.map((r) => r.id);

  let succeeded = 0;
  let failed = 0;
  const errors: Array<{ id: string; reason: string }> = [];
  const chaptersFound: Array<{ id: string; chapters: number }> = [];
  for (const id of ids) {
    try {
      const r = await reprobeItem(c.env, id, tenantId);
      succeeded++;
      chaptersFound.push({ id, chapters: r.chapters });
    } catch (e) {
      failed++;
      errors.push({ id, reason: (e as Error).message });
    }
  }
  return c.json({ total: ids.length, succeeded, failed, chaptersFound, errors });
});

// Delete an item from D1. The underlying file on storage is left alone —
// removing it from pCloud / S3 / etc. is a separate operation and we'd
// rather not surprise a user with destructive cloud-side deletes here.
// Cascading: library_items + book_metadata + audio_files + chapters +
// listening_sessions + media_progress + bookmarks all get removed. R2 cover
// is best-effort.
// ?deleteFiles=1 additionally removes the audio files from storage and
// then the item's folder if that left it empty. pCloud (OAuth) folders
// only — other providers return filesDeleted:0 with a reason and the D1
// rows are still removed. Files are deleted one by one and the D1 delete
// only runs afterwards, so a pCloud failure mid-way leaves a consistent
// "item still listed, some files gone" state the next scan marks missing,
// rather than an orphaned file nobody can see.
adminRoutes.delete('/items/:itemId', requireTenantOwner, async (c) => {
  const itemId = c.req.param('itemId');
  const tenantId = c.get('tenantId');
  const deleteFiles = c.req.query('deleteFiles') === '1';
  const item = await c.env.DB.prepare(
    'SELECT id, folder_id, rel_path, is_file FROM library_items WHERE id = ? AND tenant_id = ?',
  ).bind(itemId, tenantId).first<{ id: string; folder_id: string; rel_path: string; is_file: number }>();
  if (!item) return c.json({ error: 'Item not found' }, 404);

  let filesDeleted = 0;
  let folderDeleted = false;
  let filesReason: string | undefined;
  if (deleteFiles) {
    const loaded = await loadPcloudFolder(c.env, item.folder_id, tenantId);
    if (!loaded.ok) {
      filesReason = `files left in place: ${loaded.error}`;
    } else {
      const files = await c.env.DB.prepare(
        'SELECT rel_path FROM audio_files WHERE library_item_id = ? AND rel_path IS NOT NULL',
      ).bind(itemId).all<{ rel_path: string }>();
      try {
        for (const f of files.results) {
          await pcloudDeleteFile(loaded.profile, joinPcloudPath(loaded.rootPath, f.rel_path));
          filesDeleted++;
        }
        if (item.is_file === 0 && item.rel_path && item.rel_path !== '/') {
          folderDeleted = await pcloudDeleteEmptyFolder(loaded.profile, joinPcloudPath(loaded.rootPath, item.rel_path));
        }
      } catch (e) {
        return c.json({ error: `Deleted ${filesDeleted} of ${files.results.length} file(s) from pCloud, then: ${(e as Error).message}. The item is still listed — retry.` }, 502);
      }
    }
  }
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM chapters WHERE library_item_id = ?').bind(itemId),
    c.env.DB.prepare('DELETE FROM audio_files WHERE library_item_id = ?').bind(itemId),
    c.env.DB.prepare('DELETE FROM book_metadata WHERE library_item_id = ?').bind(itemId),
    c.env.DB.prepare('DELETE FROM media_progress WHERE library_item_id = ?').bind(itemId),
    c.env.DB.prepare('DELETE FROM bookmarks WHERE library_item_id = ?').bind(itemId),
    c.env.DB.prepare('DELETE FROM listening_sessions WHERE library_item_id = ?').bind(itemId),
    c.env.DB.prepare('DELETE FROM library_items WHERE id = ?').bind(itemId),
  ]);
  try { await c.env.COVERS.delete(`covers/${itemId}`); } catch { /* non-fatal */ }
  if (!deleteFiles) return c.body(null, 204);
  const out: { deleted: true; filesDeleted: number; folderDeleted: boolean; reason?: string } = { deleted: true, filesDeleted, folderDeleted };
  if (filesReason) out.reason = filesReason;
  return c.json(out);
});

// Warm the R2 cover cache for every item that doesn't already have one stored.
// Useful right after first enabling the R2 layer — otherwise R2 only fills as
// items are added (via the scanner pre-warm) or as Workers Cache entries
// evict and re-probe. Idempotent: existing R2 keys are skipped.
adminRoutes.post('/covers/warm', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id FROM library_items WHERE is_missing = 0 AND tenant_id = ?',
  ).bind(c.get('tenantId')).all<{ id: string }>();
  const ids = (rows.results ?? []).map((r) => r.id);

  let warmed = 0, skipped = 0, failed = 0, fromCatalogCount = 0;
  const errors: { id: string; reason: string }[] = [];

  for (const id of ids) {
    const r2Key = `covers/${id}`;
    const head = await c.env.COVERS.head(r2Key);
    if (head) { skipped++; continue; }

    try {
      const item = await getItem(c.env, id, c.get('tenantId'));
      if (!item) { failed++; errors.push({ id, reason: 'item not found' }); continue; }
      const folder = await getFolderById(c.env, item.folder_id, c.get('tenantId'));
      if (!folder) { failed++; errors.push({ id, reason: 'folder missing' }); continue; }
      const audio = (await getAudioFiles(c.env, id, c.get('tenantId')))[0];
      if (!audio) { failed++; errors.push({ id, reason: 'no audio file' }); continue; }

      const probeUrl = await resolveProbeUrl(c.env, folder, audio);
      const isMp3 = audio.format === 'mp3'
        || audio.mime_type === 'audio/mpeg'
        || /\.mp3$/i.test(audio.rel_path ?? audio.filedn_url);
      const cover = isMp3
        ? (await probeMp3(probeUrl.url, audio.size_bytes || undefined, probeUrl.headers)).cover
        : (await probeM4b(probeUrl.url, probeUrl.headers)).cover;
      if (!cover) {
        // Nothing embedded — borrow the AudioBookBay listing's artwork,
        // which is the only cover these releases ever had.
        const meta = await getBookMetadata(c.env, id, c.get('tenantId'));
        const fromCatalog = await findCatalogCover(c.env, { title: meta?.title ?? null, author: meta?.author_name ?? null });
        if (!fromCatalog) { failed++; errors.push({ id, reason: 'no embedded cover, and no catalogue match' }); continue; }
        await c.env.COVERS.put(r2Key, fromCatalog.bytes, { httpMetadata: { contentType: fromCatalog.contentType } });
        await purgeCoverCache(id, c.req.url);
        fromCatalogCount++;
        warmed++;
        continue;
      }

      await c.env.COVERS.put(r2Key, cover.bytes, {
        httpMetadata: { contentType: cover.mimeType },
      });
      warmed++;
    } catch (e) {
      failed++;
      errors.push({ id, reason: (e as Error).message });
    }
  }
  return c.json({ totalItems: ids.length, warmed, fromCatalog: fromCatalogCount, skipped, failed, errors });
});

// Set one book's cover by hand: from the AudioBookBay catalogue, or from a
// URL you paste. For releases whose files carry no artwork and that the
// catalogue can't match — the fallback in "Warm cover cache" handles the
// rest automatically.
adminRoutes.post('/items/:itemId/cover', requireTenantOwner, async (c) => {
  const itemId = c.req.param('itemId');
  const tenantId = c.get('tenantId');
  const item = await getItem(c.env, itemId, tenantId);
  if (!item) return c.json({ error: 'Item not found' }, 404);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const url = String(body['url'] ?? '').trim();

  let bytes: ArrayBuffer;
  let contentType: string;
  let source: string;
  if (url) {
    if (!/^https?:\/\//i.test(url)) return c.json({ error: 'Cover URL must be http(s)' }, 400);
    const res = await fetch(url).catch(() => null);
    if (!res || !res.ok) return c.json({ error: `Could not fetch that URL (${res ? res.status : 'no response'})` }, 502);
    contentType = res.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) return c.json({ error: `That URL returned ${contentType || 'no content type'}, not an image` }, 400);
    bytes = await res.arrayBuffer();
    source = url;
  } else {
    const meta = await getBookMetadata(c.env, itemId, tenantId);
    const found = await findCatalogCover(c.env, { title: meta?.title ?? null, author: meta?.author_name ?? null });
    if (!found) return c.json({ error: 'No matching AudioBookBay listing with a cover' }, 404);
    bytes = found.bytes;
    contentType = found.contentType;
    source = found.postTitle;
  }

  await c.env.COVERS.put(`covers/${itemId}`, bytes, { httpMetadata: { contentType } });
  await purgeCoverCache(itemId, c.req.url);
  return c.json({ ok: true, source, bytes: bytes.byteLength });
});

// ─── Signups & membership (instance owner only) ──────────────────────────────
//
// Approving a pending signup provisions a brand-new tenant for that user, so it
// is an instance-wide action — gated by requireInstanceOwner (account type
// root/admin), NOT the per-tenant owner role.

// List accounts awaiting approval, oldest first.
adminRoutes.get('/signup/pending', requireInstanceOwner, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, username, email, created_at
       FROM users
      WHERE signup_status = 'pending' AND is_active = 0
      ORDER BY created_at ASC`,
  ).all<{ id: string; username: string; email: string | null; created_at: number }>();
  return c.json({ pending: rows.results });
});

// Approve a pending signup: activate the user and provision their own tenant
// (they become its owner). Idempotency-guarded on signup_status so a double
// click can't mint two tenants.
adminRoutes.post('/users/:id/approve', requireInstanceOwner, async (c) => {
  const userId = c.req.param('id');
  const u = await c.env.DB.prepare(
    `SELECT id, username, signup_status FROM users WHERE id = ?`,
  ).bind(userId).first<{ id: string; username: string; signup_status: string }>();
  if (!u) return c.json({ error: 'User not found' }, 404);
  if (u.signup_status !== 'pending') return c.json({ error: 'User is not pending approval' }, 409);

  const now = Date.now();
  const tenantId = `tnt_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE users SET is_active = 1, signup_status = 'active' WHERE id = ?`).bind(userId),
    c.env.DB.prepare(
      `INSERT INTO tenants (id, name, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).bind(tenantId, `${u.username}'s library`, userId, now, now),
    c.env.DB.prepare(
      `INSERT INTO tenant_members (tenant_id, user_id, role, is_default, created_at) VALUES (?, ?, 'owner', 1, ?)`,
    ).bind(tenantId, userId, now),
  ]);
  return c.json({ ok: true, tenantId });
});

// Reject a pending signup: hard-delete the row. Safe to delete outright — a
// pending user owns no tenant/content yet, so there's nothing to cascade.
adminRoutes.post('/users/:id/reject', requireInstanceOwner, async (c) => {
  const userId = c.req.param('id');
  const u = await c.env.DB.prepare(
    `SELECT signup_status FROM users WHERE id = ?`,
  ).bind(userId).first<{ signup_status: string }>();
  if (!u) return c.json({ error: 'User not found' }, 404);
  if (u.signup_status !== 'pending') return c.json({ error: 'User is not pending approval' }, 409);
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
  return c.body(null, 204);
});

// Read / set the instance signup mode ('approval' | 'closed').
adminRoutes.get('/signup/mode', requireInstanceOwner, async (c) => {
  return c.json({ mode: await getSignupMode(c.env) });
});

adminRoutes.post('/signup/mode', requireInstanceOwner, async (c) => {
  const body = await c.req.json().catch(() => ({})) as { mode?: string };
  if (body.mode !== 'approval' && body.mode !== 'closed') {
    return c.json({ error: "mode must be 'approval' or 'closed'" }, 400);
  }
  await setSetting(c.env, 'signup_mode', body.mode);
  return c.json({ mode: body.mode });
});

// ─── All users (instance-wide roster) ────────────────────────────────────────
//
// The gap-filler for the instance owner. "Library members" only shows your OWN
// tenant; "Members & signups" only shows PENDING requests — so an already-
// approved user, living in their own isolated library, is invisible everywhere
// else. This lists EVERY account (active, pending, or locked) with the library
// (tenant) it belongs to and the storage backends ("servers") attached to that
// library. Read-only apart from lock/unlock — a reversible disable: requireAuth
// rejects is_locked = 1, so a locked user can't log in or stream, but no data
// is deleted.

type AllUsersRow = {
  id: string; username: string; email: string | null; type: string;
  is_active: number; is_locked: number; signup_status: string;
  created_at: number; last_seen: number | null;
  tenant_id: string | null; role: string | null; tenant_name: string | null;
};

adminRoutes.get('/users', requireInstanceOwner, async (c) => {
  // One row per user via the default membership (is_default = 1) so a user in
  // more than one tenant doesn't fan out into duplicate rows.
  const users = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.email, u.type, u.is_active, u.is_locked,
            u.signup_status, u.created_at, u.last_seen,
            tm.tenant_id, tm.role, t.name AS tenant_name
       FROM users u
       LEFT JOIN tenant_members tm ON tm.user_id = u.id AND tm.is_default = 1
       LEFT JOIN tenants t ON t.id = tm.tenant_id
      ORDER BY u.created_at ASC`,
  ).all<AllUsersRow>();

  // Storage backends + book counts for every tenant, fetched once and grouped.
  const folders = await c.env.DB.prepare(
    `SELECT lf.tenant_id, lf.provider, lf.config_json, lf.filedn_base_url,
            op.account_label AS profile_label
       FROM library_folders lf
       LEFT JOIN oauth_profiles op ON op.id = lf.profile_id`,
  ).all<{ tenant_id: string; provider: string; config_json: string; filedn_base_url: string | null; profile_label: string | null }>();

  const books = await c.env.DB.prepare(
    `SELECT tenant_id, SUM(CASE WHEN is_missing = 0 THEN 1 ELSE 0 END) AS book_count
       FROM library_items GROUP BY tenant_id`,
  ).all<{ tenant_id: string; book_count: number }>();

  const serversByTenant: Record<string, { provider: string; label: string }[]> = {};
  for (const f of folders.results) {
    const arr = serversByTenant[f.tenant_id] ?? (serversByTenant[f.tenant_id] = []);
    arr.push({
      provider: f.provider,
      label: describeBackend(f.provider, safeJson(f.config_json), f.filedn_base_url, f.profile_label),
    });
  }
  const bookByTenant: Record<string, number> = {};
  for (const b of books.results) bookByTenant[b.tenant_id] = b.book_count ?? 0;

  return c.json({
    selfId: c.get('userId'),
    users: users.results.map((u) => ({
      id: u.id,
      username: u.username,
      email: u.email,
      type: u.type,
      isActive: u.is_active === 1,
      isLocked: u.is_locked === 1,
      signupStatus: u.signup_status,
      createdAt: u.created_at,
      lastSeen: u.last_seen,
      tenantId: u.tenant_id,
      tenantName: u.tenant_name,
      role: u.role,
      servers: u.tenant_id ? (serversByTenant[u.tenant_id] ?? []) : [],
      bookCount: u.tenant_id ? (bookByTenant[u.tenant_id] ?? 0) : 0,
    })),
  });
});

// Lock / unlock an account (instance owner only). Locking is the reversible
// "disable" — requireAuth bounces is_locked = 1 on the next request. You can't
// lock yourself: that'd be a one-way foot-gun on the only root account.
adminRoutes.post('/users/:id/lock', requireInstanceOwner, async (c) => {
  const userId = c.req.param('id');
  if (userId === c.get('userId')) return c.json({ error: 'You cannot lock your own account' }, 400);
  const u = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first<{ id: string }>();
  if (!u) return c.json({ error: 'User not found' }, 404);
  await c.env.DB.prepare('UPDATE users SET is_locked = 1 WHERE id = ?').bind(userId).run();
  return c.json({ ok: true, isLocked: true });
});

adminRoutes.post('/users/:id/unlock', requireInstanceOwner, async (c) => {
  const userId = c.req.param('id');
  const u = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first<{ id: string }>();
  if (!u) return c.json({ error: 'User not found' }, 404);
  await c.env.DB.prepare('UPDATE users SET is_locked = 0 WHERE id = ?').bind(userId).run();
  return c.json({ ok: true, isLocked: false });
});

// ─── helpers ────────────────────────────────────────────────────────────────

// Short, secret-free label for a storage backend ("server") a tenant attached.
// Only ever reads non-secret config (endpoint/bucket/baseUrl/host), so the
// all-users roster never ships credentials just to render a row.
function describeBackend(
  provider: string,
  config: unknown,
  filednBaseUrl: string | null,
  profileLabel: string | null,
): string {
  const cfg = (config && typeof config === 'object') ? config as Record<string, unknown> : {};
  const host = (v: unknown): string => { try { return new URL(String(v)).host; } catch { return String(v ?? ''); } };
  switch (provider) {
    case 'public_url': {
      const base = filednBaseUrl || cfg.baseUrl;
      return base ? 'Public URL · ' + host(base) : 'Public URL';
    }
    case 'pcloud_oauth': return profileLabel ? 'pCloud · ' + profileLabel : 'pCloud';
    case 's3': return 'S3 · ' + host(cfg.endpoint) + (cfg.bucket ? '/' + String(cfg.bucket) : '');
    case 'webdav': return 'WebDAV · ' + host(cfg.baseUrl);
    default: return provider;
  }
}

type FolderWithLibName = {
  id: string;
  library_id: string;
  filedn_base_url: string;
  added_at: number;
  provider: string;
  config_json: string;
  profile_id: string | null;
  library_name: string;
};

type ProfileSummary = {
  id: string;
  provider: string;
  account_label: string | null;
  api_host: string | null;
  created_at: number;
  last_verified_at: number | null;
};

// Build the absolute redirect_uri for OAuth using the same origin/path the
// browser hit (so dev on Tailscale and prod on workers.dev both work).
function redirectUriFor(currentUrl: string): string {
  const u = new URL(currentUrl);
  u.pathname = '/api/admin/storage/pcloud/callback';
  u.search = '';
  return u.toString();
}

