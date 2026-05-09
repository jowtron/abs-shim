import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth, type AuthVars } from '../auth/middleware';
import {
  exchangePcloudCode, pcloudAuthorizeUrl, pcloudUserinfo,
  apiHostFromLocationId, type PcloudProfile,
} from '../storage/pcloud';
import { runScan, addBookByPath, type ScanReport } from '../scanner/scan';
import { getLibrary, listFolders } from '../db/library';

// All admin routes are gated by requireAuth + requireRoot. Mount at /api/admin
// from index.ts. The admin UI itself lives at /admin and is served via the
// ASSETS binding from the web-admin/ folder.

export const adminRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>();

adminRoutes.use('*', requireAuth);
adminRoutes.use('*', async (c, next) => {
  const u = c.get('user');
  if (u.type !== 'root' && u.type !== 'admin') {
    return c.json({ error: 'Forbidden' }, 403);
  }
  return next();
});

// ─── Storage status ─────────────────────────────────────────────────────────

adminRoutes.get('/storage/status', async (c) => {
  const folders = await c.env.DB.prepare(
    `SELECT lf.*, l.name AS library_name
       FROM library_folders lf
       JOIN libraries l ON l.id = lf.library_id
       ORDER BY lf.added_at ASC`,
  ).all<FolderWithLibName>();

  const profiles = await c.env.DB.prepare(
    `SELECT id, provider, account_label, api_host, created_at, last_verified_at
       FROM oauth_profiles
       ORDER BY created_at ASC`,
  ).all<ProfileSummary>();

  return c.json({
    folders: folders.results.map((f) => ({
      id: f.id,
      libraryId: f.library_id,
      libraryName: f.library_name,
      provider: f.provider,
      profileId: f.profile_id,
      config: safeJson(f.config_json),
      legacyBaseUrl: f.filedn_base_url,
    })),
    profiles: profiles.results,
    // Tell the UI which provider integrations are set up server-side. The UI
    // shows setup instructions when a provider's secrets are missing instead
    // of a "Connect" button that would 500.
    secrets: {
      pcloudConfigured: Boolean(c.env.PCLOUD_CLIENT_ID && c.env.PCLOUD_CLIENT_SECRET),
    },
  });
});

// ─── pCloud OAuth flow ──────────────────────────────────────────────────────

// Step 1: redirect the browser to pCloud's authorize page. Persists a CSRF
// state token tied to this admin session.
adminRoutes.get('/storage/pcloud/start', async (c) => {
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
adminRoutes.get('/storage/pcloud/callback', async (c) => {
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
       (id, provider, access_token, refresh_token, api_host, account_label, scope, created_at, last_verified_at)
     VALUES (?, 'pcloud', ?, NULL, ?, ?, NULL, ?, ?)`,
  ).bind(profileId, tok.access_token, apiHost, accountLabel, now, now).run();

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
adminRoutes.post('/storage/pcloud/disconnect/:profileId', async (c) => {
  const profileId = c.req.param('profileId');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE library_folders SET profile_id = NULL WHERE profile_id = ?').bind(profileId),
    c.env.DB.prepare('DELETE FROM oauth_profiles WHERE id = ?').bind(profileId),
  ]);
  return c.body(null, 204);
});

// ─── Folder configuration ────────────────────────────────────────────────────

// Convert (or initialise) a folder to point at a pCloud-OAuth profile + root
// path. Used by the admin UI after a successful connect.
//
// Body: { libraryId, profileId, rootPath }
adminRoutes.post('/storage/folder/pcloud', async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const libraryId = String(body['libraryId'] ?? '');
  const profileId = String(body['profileId'] ?? '');
  const rootPath = String(body['rootPath'] ?? '/');
  if (!libraryId || !profileId) {
    return c.json({ error: 'libraryId and profileId required' }, 400);
  }
  const lib = await getLibrary(c.env, libraryId);
  if (!lib) return c.json({ error: 'Library not found' }, 404);
  const profile = await c.env.DB.prepare(
    `SELECT id FROM oauth_profiles WHERE id = ? AND provider = 'pcloud'`,
  ).bind(profileId).first<{ id: string }>();
  if (!profile) return c.json({ error: 'Profile not found' }, 404);

  const folders = await listFolders(c.env, libraryId);
  const config = JSON.stringify({ rootPath });
  const now = Date.now();

  if (folders.length === 0) {
    // Fresh library — create a folder row.
    const id = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO library_folders
         (id, library_id, filedn_base_url, added_at, provider, config_json, profile_id)
       VALUES (?, ?, '', ?, 'pcloud_oauth', ?, ?)`,
    ).bind(id, libraryId, now, config, profileId).run();
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
adminRoutes.post('/storage/folder/s3', async (c) => {
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
  if (!await getLibrary(c.env, libraryId)) return c.json({ error: 'Library not found' }, 404);
  const config = JSON.stringify({ endpoint, bucket, region, prefix, accessKeyId, secretAccessKey });
  return upsertFolderProvider(c.env, libraryId, 's3', config, null);
});

// Configure a library_folders row to point at a WebDAV server.
// Body: { libraryId, baseUrl, username, password, rootPath? }
adminRoutes.post('/storage/folder/webdav', async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const libraryId = String(body['libraryId'] ?? '');
  const baseUrl = String(body['baseUrl'] ?? '').replace(/\/+$/, '') + '/';
  const username = String(body['username'] ?? '');
  const password = String(body['password'] ?? '');
  const rootPath = String(body['rootPath'] ?? '');
  if (!libraryId || !baseUrl || !username) {
    return c.json({ error: 'libraryId, baseUrl, username required' }, 400);
  }
  if (!await getLibrary(c.env, libraryId)) return c.json({ error: 'Library not found' }, 404);
  const config = JSON.stringify({ baseUrl, username, password, rootPath });
  return upsertFolderProvider(c.env, libraryId, 'webdav', config, null);
});

// Always insert a new folder row. Multi-backend per library is intentional —
// libraries can pull from R2 + NAS + pCloud simultaneously, with each book
// pinned to the folder it actually lives in via library_items.folder_id.
// To swap a backend, add the new one and remove the old one explicitly.
async function upsertFolderProvider(env: Env, libraryId: string, provider: string, configJson: string, profileId: string | null): Promise<Response> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO library_folders
       (id, library_id, filedn_base_url, added_at, provider, config_json, profile_id)
     VALUES (?, ?, '', ?, ?, ?, ?)`,
  ).bind(id, libraryId, now, provider, configJson, profileId).run();
  return new Response(JSON.stringify({ folderId: id }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

// Remove a folder. Refuses if any library_items still reference it — caller
// has to explicitly clear those items first (we don't cascade-delete here
// because losing user progress on a misclick is worse than the inconvenience).
adminRoutes.delete('/storage/folder/:id', async (c) => {
  const folderId = c.req.param('id');
  const refs = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM library_items WHERE folder_id = ?`,
  ).bind(folderId).first<{ n: number }>();
  if ((refs?.n ?? 0) > 0) {
    return c.json({
      error: 'Folder still has items',
      detail: `${refs!.n} library_item(s) reference this folder. Delete or migrate them first.`,
    }, 409);
  }
  await c.env.DB.prepare('DELETE FROM library_folders WHERE id = ?').bind(folderId).run();
  return c.body(null, 204);
});

// ─── Scan ────────────────────────────────────────────────────────────────────

// Run a synchronous scan of one library. Returns a small report (added /
// updated / skipped / errors). Long scans should move to a Durable Object or
// queue later — for personal-library sizes (≤ a few hundred books) the wall
// clock is fine inside one Worker invocation.
adminRoutes.post('/libraries/:id/scan', async (c) => {
  const id = c.req.param('id');
  const lib = await getLibrary(c.env, id);
  if (!lib) return c.json({ error: 'Library not found' }, 404);
  let report: ScanReport;
  try {
    report = await runScan(c.env, id);
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
adminRoutes.post('/books/add-by-path', async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const libraryId = String(body['libraryId'] ?? '');
  const relPath = String(body['relPath'] ?? '').trim();
  if (!libraryId || !relPath) {
    return c.json({ error: 'libraryId and relPath required' }, 400);
  }
  try {
    const result = await addBookByPath(c.env, libraryId, relPath);
    return c.json(result);
  } catch (e) {
    return c.json({ error: 'Add failed', detail: (e as Error).message }, 502);
  }
});

// ─── helpers ────────────────────────────────────────────────────────────────

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

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return {}; }
}
