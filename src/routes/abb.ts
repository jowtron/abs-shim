import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth, type AuthVars } from '../auth/middleware';
import { getTenantSetting, setTenantSetting, deleteTenantSetting } from '../db/settings';
import { abbLogin, abbSearch, abbMagnet, abbDetails, type AbbCookie } from '../lib/abb';
import { sealSecret, openSecret, secretsConfigured } from '../lib/secret-box';
import {
  rdUser, rdInfo, rdAddMagnet, rdSelectFiles, rdDelete, rdUnrestrict, rdWaitForFiles,
  audioFiles, extOf, AUDIO_EXT, ARCHIVE_EXT, RD_FAILED,
} from '../lib/realdebrid';

// AudioBookBay → Real-Debrid → pCloud. Mounted at /api/admin/abb.
//
// The browser drives the whole flow (resolve → add torrent(s) → poll → hand
// each direct link to /fetch-url), so every route here is one short step
// and nothing waits on a torrent inside a Worker request. Credentials are
// per tenant in tenant_settings; only the tenant owner can change them,
// any member can use them.
//
// Multi-file releases: Real-Debrid packs a multi-file selection into a rar
// (which we can't extract server-side), but delivers a single selected file
// bare. So for an mp3 chapter set the client adds the same magnet once per
// audio file with a one-file selection each — verified working by the
// abb-rd session on 2026-08-22 — and deletes each torrent once its file has
// landed. RD caps active torrents (~25 premium), hence the client batches.

export const abbRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>();
abbRoutes.use('*', requireAuth);

const K = { user: 'abb_username', pass: 'abb_password', rd: 'rd_token', cookie: 'abb_cookie' } as const;

type Creds = { abbUsername: string | null; abbPassword: string | null; rdToken: string | null };

// Password, token and session cookie are encrypted at rest (secret-box);
// the username is not a secret and stays readable.
async function loadCreds(env: Env, tenantId: string): Promise<Creds> {
  const [abbUsername, abbPassword, rdToken] = await Promise.all([
    getTenantSetting(env, tenantId, K.user),
    getTenantSetting(env, tenantId, K.pass).then((v) => openSecret(env, v)),
    getTenantSetting(env, tenantId, K.rd).then((v) => openSecret(env, v)),
  ]);
  return { abbUsername, abbPassword, rdToken };
}

async function requireRd(env: Env, tenantId: string): Promise<string> {
  const t = await openSecret(env, await getTenantSetting(env, tenantId, K.rd));
  if (!t) throw new Error('Real-Debrid API token not set — add it under AudioBookBay settings');
  return t;
}

// Cached ABB session if fresh; otherwise log in (when credentials exist) and
// cache. Returns null when there are no credentials — search still works
// anonymously, only member-only detail pages need it.
async function abbCookie(env: Env, tenantId: string, force = false): Promise<string | null> {
  if (!force) {
    const raw = await openSecret(env, await getTenantSetting(env, tenantId, K.cookie));
    if (raw) {
      try {
        const c = JSON.parse(raw) as AbbCookie;
        if (c.expiresAt > Date.now() + 60_000) return c.cookie;
      } catch { /* fall through */ }
    }
  }
  const { abbUsername, abbPassword } = await loadCreds(env, tenantId);
  if (!abbUsername || !abbPassword) return null;
  const c = await abbLogin(abbUsername, abbPassword);
  await setTenantSetting(env, tenantId, K.cookie, await sealSecret(env, JSON.stringify(c)));
  return c.cookie;
}

// Folder name from a release title: strip path separators and characters
// pCloud/ABS choke on, collapse whitespace, cap length.
function folderNameFromTitle(title: string): string {
  return title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'audiobook';
}

// ─── Settings ───────────────────────────────────────────────────────────────

abbRoutes.get('/settings', async (c) => {
  const creds = await loadCreds(c.env, c.get('tenantId'));
  return c.json({
    abbUsername: creds.abbUsername ?? '',
    abbPasswordSet: !!creds.abbPassword,
    rdTokenSet: !!creds.rdToken,
    canEdit: c.get('tenantRole') === 'owner',
    encryptionConfigured: secretsConfigured(c.env),
  });
});

// Body: { abbUsername?, abbPassword?, rdToken? } — blank fields are left
// alone; pass clear: ['abb'|'rd'] to remove.
abbRoutes.put('/settings', async (c) => {
  if (c.get('tenantRole') !== 'owner') return c.json({ error: 'Only the tenant owner can change these' }, 403);
  const tenantId = c.get('tenantId');
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const abbUsername = String(body['abbUsername'] ?? '').trim();
  const abbPassword = String(body['abbPassword'] ?? '');
  const rdToken = String(body['rdToken'] ?? '').trim();
  const clear = Array.isArray(body['clear']) ? (body['clear'] as unknown[]).map(String) : [];
  if ((abbPassword || rdToken) && !secretsConfigured(c.env)) {
    return c.json({ error: 'Server has no SETTINGS_KEY secret, so credentials can\'t be stored encrypted. Run: openssl rand -base64 32 | npx wrangler secret put SETTINGS_KEY' }, 503);
  }
  if (clear.includes('abb')) {
    await Promise.all([K.user, K.pass, K.cookie].map((k) => deleteTenantSetting(c.env, tenantId, k)));
  }
  if (clear.includes('rd')) await deleteTenantSetting(c.env, tenantId, K.rd);
  if (abbUsername) await setTenantSetting(c.env, tenantId, K.user, abbUsername);
  if (abbPassword) await setTenantSetting(c.env, tenantId, K.pass, await sealSecret(c.env, abbPassword));
  if (abbUsername || abbPassword) await deleteTenantSetting(c.env, tenantId, K.cookie);
  if (rdToken) await setTenantSetting(c.env, tenantId, K.rd, await sealSecret(c.env, rdToken));
  return c.json({ ok: true });
});

// Exercise both credentials. ABB: a forced login. RD: /user.
abbRoutes.post('/settings/test', async (c) => {
  const tenantId = c.get('tenantId');
  const out: { abb: { ok: boolean; error?: string; configured: boolean }; rd: { ok: boolean; error?: string; configured: boolean; username?: string; premiumUntil?: string } } = {
    abb: { ok: false, configured: false }, rd: { ok: false, configured: false },
  };
  const creds = await loadCreds(c.env, tenantId);
  if (creds.abbUsername && creds.abbPassword) {
    out.abb.configured = true;
    try {
      await abbCookie(c.env, tenantId, true);
      out.abb.ok = true;
    } catch (e) {
      out.abb.error = (e as Error).message;
    }
  }
  if (creds.rdToken) {
    out.rd.configured = true;
    try {
      const u = await rdUser(creds.rdToken);
      out.rd.ok = true;
      out.rd.username = u.username;
      out.rd.premiumUntil = u.expiration;
      if (u.type !== 'premium') out.rd.error = `Account type is "${u.type}" — torrents need premium`;
    } catch (e) {
      out.rd.error = (e as Error).message;
    }
  }
  return c.json(out);
});

// ─── Search / resolve ───────────────────────────────────────────────────────

abbRoutes.get('/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const pages = Number(c.req.query('pages') ?? '1') || 1;
  if (!q) return c.json({ error: 'q required' }, 400);
  let cookie: string | null = null;
  try {
    cookie = await abbCookie(c.env, c.get('tenantId'));
  } catch { /* anonymous search still works */ }
  try {
    const results = await abbSearch(q, pages, cookie);
    return c.json({ query: q, count: results.length, results });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

// ?url= → blurb + "Written by / Read by / Format / Bit Rate / Length" from
// the detail page. Shown on tap in the search results; anonymous fetch is
// fine (detail pages are public, only the magnet is member-gated).
abbRoutes.get('/details', async (c) => {
  const url = (c.req.query('url') ?? '').trim();
  if (!url) return c.json({ error: 'url required' }, 400);
  let cookie: string | null = null;
  try {
    cookie = await abbCookie(c.env, c.get('tenantId'));
  } catch { /* anonymous is fine */ }
  try {
    return c.json(await abbDetails(url, cookie));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

// Body: { url } → { title, folderName, infoHash, magnet }
abbRoutes.post('/resolve', async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const url = String(body['url'] ?? '').trim();
  if (!url) return c.json({ error: 'url required' }, 400);
  let cookie: string | null = null;
  try {
    cookie = await abbCookie(c.env, c.get('tenantId'));
  } catch (e) {
    return c.json({ error: `AudioBookBay login failed: ${(e as Error).message}` }, 502);
  }
  try {
    const m = await abbMagnet(url, cookie);
    return c.json({ ...m, folderName: folderNameFromTitle(m.title) });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

// ─── Torrents ───────────────────────────────────────────────────────────────

// Body: { magnet, fileId? }
// Adds the magnet, waits for RD to list the files, then selects:
//   fileId given      → that one file (per-file add for multi-file sets)
//   exactly one audio → it                    mode: 'single'
//   several audio     → the first; the rest  mode: 'multi' (client adds them)
//   no audio          → nothing; torrent deleted, error returned
abbRoutes.post('/torrents', async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const magnet = String(body['magnet'] ?? '').trim();
  const fileId = body['fileId'] != null ? Number(body['fileId']) : null;
  if (!magnet.startsWith('magnet:?')) return c.json({ error: 'magnet required' }, 400);
  let token: string;
  try {
    token = await requireRd(c.env, c.get('tenantId'));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
  try {
    const added = await rdAddMagnet(token, magnet);
    const info = await rdWaitForFiles(token, added.id);
    if (RD_FAILED[info.status]) {
      await rdDelete(token, added.id).catch(() => undefined);
      return c.json({ error: RD_FAILED[info.status] }, 502);
    }
    const audio = audioFiles(info);
    const files = audio.map((f) => ({ id: f.id, path: f.path, bytes: f.bytes }));
    let selected: number | null = null;
    let mode: 'single' | 'multi' | 'file' = 'single';
    if (fileId != null) {
      if (!(info.files ?? []).some((f) => f.id === fileId)) {
        await rdDelete(token, added.id).catch(() => undefined);
        return c.json({ error: `File id ${fileId} not in torrent` }, 400);
      }
      selected = fileId;
      mode = 'file';
    } else if (audio.length === 1) {
      selected = audio[0]!.id;
    } else if (audio.length > 1) {
      selected = audio[0]!.id;
      mode = 'multi';
    } else {
      await rdDelete(token, added.id).catch(() => undefined);
      return c.json({ error: 'Torrent contains no audio files' }, 400);
    }
    await rdSelectFiles(token, added.id, String(selected));
    const after = await rdInfo(token, added.id);
    return c.json({ id: added.id, status: after.status, progress: after.progress, mode, selected, files });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

abbRoutes.get('/torrents/:id', async (c) => {
  let token: string;
  try {
    token = await requireRd(c.env, c.get('tenantId'));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
  try {
    const info = await rdInfo(token, c.req.param('id'));
    const out: {
      id: string; status: string; progress: number; seeders?: number; speed?: number; filename: string;
      error: string | null; downloads?: Array<{ filename: string; filesize: number; ext: string; isAudio: boolean; isArchive: boolean; download: string }>;
    } = {
      id: info.id, status: info.status, progress: info.progress, filename: info.filename,
      error: RD_FAILED[info.status] ?? null,
    };
    if (info.seeders != null) out.seeders = info.seeders;
    if (info.speed != null) out.speed = info.speed;
    if (info.status === 'downloaded') {
      out.downloads = [];
      for (const link of info.links ?? []) {
        const u = await rdUnrestrict(token, link);
        const ext = extOf(u.filename);
        out.downloads.push({
          filename: u.filename, filesize: u.filesize, ext,
          isAudio: AUDIO_EXT.has(ext), isArchive: ARCHIVE_EXT.has(ext), download: u.download,
        });
      }
    }
    return c.json(out);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

abbRoutes.delete('/torrents/:id', async (c) => {
  let token: string;
  try {
    token = await requireRd(c.env, c.get('tenantId'));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
  try {
    await rdDelete(token, c.req.param('id'));
    return c.body(null, 204);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});
