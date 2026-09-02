import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth, type AuthVars } from '../auth/middleware';
import { getTenantSetting, setTenantSetting, deleteTenantSetting } from '../db/settings';
import { abbLogin, abbSearch, abbMagnet, abbDetails, magnetFromHash, type AbbCookie, type AbbResult } from '../lib/abb';
import {
  catalogSearch, catalogBrowse, catalogFacets, catalogGet, rowToDetails, catalogRecordHash, catalogRecordDetails,
  upsertPosts, runCatalogTick, catalogStatus, catalogControl, sendReportNow, type CatalogAction,
  withCoverUrls, coversPending, coverStore, coverFailed, coverStats,
  detailClaim, detailSubmit, noteCoverStored, type DetailSubmission,
} from '../lib/abb-catalog';
import { sealSecret, openSecret, secretsConfigured } from '../lib/secret-box';
import {
  rdUser, rdInfo, rdAddMagnet, rdSelectFiles, rdDelete, rdUnrestrict, rdWaitForFiles,
  audioFiles, extOf, AUDIO_EXT, ARCHIVE_EXT, RD_FAILED, rdList } from '../lib/realdebrid';

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

// Flag results whose book is already in the caller's library. The grab flow
// names the destination folder from the release title (folderNameFromTitle →
// abbPlanDest), so a library item whose top folder matches means "you already
// grabbed this" — good enough to badge, without a separate grab log.
async function markInLibrary(env: Env, tenantId: string, results: AbbResult[]): Promise<AbbResult[]> {
  if (!results.length) return results;
  const rows = await env.DB.prepare('SELECT rel_path FROM library_items WHERE tenant_id = ?').bind(tenantId).all<{ rel_path: string }>();
  const tops = new Set(rows.results.map((r) => (r.rel_path.split('/')[0] ?? '').toLowerCase()));
  for (const r of results) r.inLibrary = tops.has(folderNameFromTitle(r.title).toLowerCase());
  return results;
}

const originOf = (url: string) => new URL(url).origin;

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

// Catalogue + live, merged: cached hits first (ranked by FTS), then live
// results the catalogue doesn't have yet. A live failure is tolerated when
// the cache answered — that's the whole point of having one. Live-only
// extras are folded into the catalogue in the background, so a search for
// an old title teaches the cache about it.
//   ?mode=cache  → catalogue only (instant, offline-safe)
//   ?mode=live   → ABB only (the pre-catalogue behaviour)
//   ?lang=English → only that language, in BOTH halves. ABB's search has no
//     language parameter, so live hits are filtered on the language its own
//     result rows print. Both UIs default to English (12,065 of 12,370
//     catalogued posts); '' means any.
abbRoutes.get('/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const pages = Number(c.req.query('pages') ?? '1') || 1;
  const mode = c.req.query('mode') ?? 'both';
  const lang = (c.req.query('lang') ?? '').trim();
  if (!q) return c.json({ error: 'q required' }, 400);
  let cookie: string | null = null;
  if (mode !== 'cache') {
    try {
      cookie = await abbCookie(c.env, c.get('tenantId'));
    } catch { /* anonymous search still works */ }
  }
  const cachedP: Promise<AbbResult[]> = mode === 'live' ? Promise.resolve([]) : catalogSearch(c.env, q, 60, 0, lang).catch(() => []);
  const liveP: Promise<AbbResult[] | Error> = mode === 'cache'
    ? Promise.resolve([])
    : abbSearch(q, pages, cookie).catch((e: Error) => e);
  const [cached, live] = await Promise.all([cachedP, liveP]);
  if (live instanceof Error && !cached.length && mode !== 'cache') {
    return c.json({ error: live.message }, 502);
  }
  const seen = new Set(cached.map((r) => r.url));
  const extras: AbbResult[] = [];
  if (!(live instanceof Error)) {
    for (const r of live) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      extras.push({ ...r, cached: false });
    }
    // Everything ABB returned still goes into the catalogue — the language
    // filter is about what this search shows, not about what we learn.
    if (extras.length) c.executionCtx.waitUntil(upsertPosts(c.env, extras).catch(() => undefined));
  }
  const shown = lang ? extras.filter((r) => (r.language ?? '').toLowerCase() === lang.toLowerCase()) : extras;
  const results = await markInLibrary(c.env, c.get('tenantId'), withCoverUrls([...cached, ...shown], originOf(c.req.url)));
  return c.json({
    query: q, count: results.length, results, language: lang || null,
    // What the filter hid, so the UI can offer "N more in other languages".
    filteredOut: lang ? (extras.length - shown.length) : 0,
    source: mode === 'cache' ? 'cache' : live instanceof Error ? 'cache' : mode === 'live' ? 'live' : 'both',
    ...(live instanceof Error ? { liveError: live.message } : {}),
  });
});

// ─── Catalogue (see src/lib/abb-catalog.ts) ─────────────────────────────────

abbRoutes.get('/catalog/status', async (c) => c.json(await catalogStatus(c.env)));

abbRoutes.get('/catalog/categories', async (c) => c.json(await catalogFacets(c.env)));

// ?cat=Fantasy&language=English&format=m4b&page=1&limit=30 — newest first.
// No cat = everything, i.e. ABB's home listing.
abbRoutes.get('/catalog/browse', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? '30') || 30, 100);
  const page = Math.max(Number(c.req.query('page') ?? '1') || 1, 1);
  const o: Parameters<typeof catalogBrowse>[1] = { limit, offset: (page - 1) * limit };
  const cat = (c.req.query('cat') ?? '').trim();
  const language = (c.req.query('language') ?? '').trim();
  const format = (c.req.query('format') ?? '').trim();
  if (cat) o.cat = cat;
  if (language) o.language = language;
  if (format) o.format = format;
  const results = await markInLibrary(c.env, c.get('tenantId'), withCoverUrls(await catalogBrowse(c.env, o), originOf(c.req.url)));
  return c.json({ page, limit, count: results.length, hasMore: results.length === limit, results });
});

// ─── Catalogue covers (resized off-Worker by scripts/abb-covers.py) ─────────

// ?shard=&shards= partitions the backlog between several runners (the Mac
// and/or the wharf nodes) so they don't resize the same covers.
abbRoutes.get('/catalog/covers/pending', async (c) => {
  const limit = Number(c.req.query('limit') ?? '200') || 200;
  const shards = Number(c.req.query('shards') ?? '1') || 1;
  const shard = Number(c.req.query('shard') ?? '0') || 0;
  return c.json({ ...(await coverStats(c.env)), pending: await coversPending(c.env, limit, shard, shards) });
});

// Body: the webp bytes. Stored as abbcovers/<id>.webp, served at /public/abb-cover/<id>.webp.
abbRoutes.put('/catalog/covers/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'bad id' }, 400);
  const body = await c.req.arrayBuffer();
  const magic = new Uint8Array(body.slice(0, 12));
  const isWebp = magic.length === 12 && String.fromCharCode(...magic.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...magic.subarray(8, 12)) === 'WEBP';
  if (!isWebp || body.byteLength > 512 * 1024) return c.json({ error: 'expected a webp under 512 KB' }, 400);
  if (!(await coverStore(c.env, id, body))) return c.json({ error: 'no such post' }, 404);
  const node = (c.req.query('node') ?? '').trim().slice(0, 40);
  if (node) c.executionCtx.waitUntil(noteCoverStored(c.env, node).catch(() => undefined));
  return c.json({ ok: true, bytes: body.byteLength });
});

abbRoutes.post('/catalog/covers/:id/error', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({})) as { error?: string };
  if (!Number.isInteger(id)) return c.json({ error: 'bad id' }, 400);
  await coverFailed(c.env, id, String(body.error ?? 'unknown'));
  return c.json({ ok: true });
});

// Manual tick (the cron runs one every 5 minutes). Runs after the response;
// poll /catalog/status to watch it.
abbRoutes.post('/catalog/run', async (c) => {
  c.executionCtx.waitUntil(runCatalogTick(c.env, { force: true }).catch(() => undefined));
  return c.json({ ok: true });
});

// Body: { action: 'pause' | 'resume' | 'retry-errors' | 'restart-backfill' | 'reset-report' | 'send-report'
//                 | 'set-budget' (+ value) | 'clear-backoff' }
abbRoutes.post('/catalog/control', async (c) => {
  if (c.get('tenantRole') !== 'owner') return c.json({ error: 'Only the tenant owner can control the crawler' }, 403);
  const body = await c.req.json().catch(() => ({})) as { action?: string; value?: number };
  const action = body.action ?? '';
  if (action === 'send-report') {
    await sendReportNow(c.env);
    return c.json({ ok: true });
  }
  const allowed: CatalogAction[] = ['pause', 'resume', 'retry-errors', 'restart-backfill', 'reset-report', 'set-budget', 'clear-backoff'];
  if (!allowed.includes(action as CatalogAction)) return c.json({ error: 'unknown action' }, 400);
  await catalogControl(c.env, action as CatalogAction, typeof body.value === 'number' ? body.value : undefined);
  return c.json({ ok: true });
});

// ─── Detail backfill farmed out to wharf nodes ──────────────────────────────
//
// See the header comment on detailClaim in src/lib/abb-catalog.ts for why
// this exists and why the node sends HTML rather than parsed fields. The
// node client is wharf-project/abbcrawl/handlers/abb-detail-crawler.py.
//
// Owner-only: a submission becomes catalogue content every tenant sees, so
// this isn't a route any member should be able to feed.
abbRoutes.post('/catalog/details/claim', async (c) => {
  if (c.get('tenantRole') !== 'owner') return c.json({ error: 'Only the tenant owner can run a crawl node' }, 403);
  const body = await c.req.json().catch(() => ({})) as { node?: string; limit?: number };
  const node = String(body.node ?? '').trim().slice(0, 40);
  if (!node) return c.json({ error: 'node required' }, 400);
  const items = await detailClaim(c.env, node, Number(body.limit ?? 10));
  return c.json({ items, count: items.length });
});

// Body: { node, url, status, html } — or { node, url, error } for a fetch
// that failed, or { node, url, release: true } to hand a leased row back
// untouched (a node shutting down or backing off).
abbRoutes.post('/catalog/details/submit', async (c) => {
  if (c.get('tenantRole') !== 'owner') return c.json({ error: 'Only the tenant owner can run a crawl node' }, 403);
  const body = await c.req.json().catch(() => ({})) as { node?: string } & Record<string, unknown>;
  const node = String(body.node ?? '').trim().slice(0, 40);
  if (!node) return c.json({ error: 'node required' }, 400);
  const html = typeof body.html === 'string' ? body.html : undefined;
  // ABB detail pages are ~100 KB; anything far past that is a mistake, not
  // a page, and parsing it would burn the request's CPU budget.
  if (html && html.length > 2 * 1024 * 1024) return c.json({ error: 'html too large' }, 413);
  const sub: DetailSubmission = { url: String(body.url ?? '') };
  if (html !== undefined) sub.html = html;
  if (typeof body.status === 'number') sub.status = body.status;
  if (typeof body.error === 'string') sub.error = body.error.slice(0, 200);
  if (body.release === true) sub.release = true;
  return c.json(await detailSubmit(c.env, node, sub));
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
  const row = await catalogGet(c.env, url).catch(() => null);
  if (row && row.detail_fetched_at && !row.detail_error) return c.json({ ...rowToDetails(row), cached: true });
  try {
    const d = await abbDetails(url, cookie);
    c.executionCtx.waitUntil(catalogRecordDetails(c.env, d, null).catch(() => undefined));
    return c.json(d);
  } catch (e) {
    if (row && row.detail_fetched_at) return c.json({ ...rowToDetails(row), cached: true, liveError: (e as Error).message });
    return c.json({ error: (e as Error).message }, 502);
  }
});

// Body: { url } or { magnet } → { title, folderName, infoHash, magnet }
// A pasted magnet skips AudioBookBay entirely; the title comes from its
// dn= parameter (or the hash when absent).
abbRoutes.post('/resolve', async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const url = String(body['url'] ?? '').trim();
  const magnet = String(body['magnet'] ?? '').trim();
  if (magnet) {
    if (!magnet.startsWith('magnet:?')) return c.json({ error: 'Not a magnet link' }, 400);
    const hash = /btih:([0-9a-zA-Z]{32,40})/.exec(magnet)?.[1] ?? '';
    if (!hash) return c.json({ error: 'Magnet has no info hash' }, 400);
    let dn = '';
    try { dn = new URL(magnet).searchParams.get('dn') ?? ''; } catch { /* malformed query — fall back to hash */ }
    const title = dn.replace(/\+/g, ' ').trim() || `magnet ${hash.slice(0, 8)}`;
    return c.json({ url: null, title, infoHash: hash.toLowerCase(), magnet, folderName: folderNameFromTitle(title) });
  }
  if (!url) return c.json({ error: 'url or magnet required' }, 400);
  // Cached hash → no ABB round trip at all (and it works while ABB is down).
  const row = await catalogGet(c.env, url).catch(() => null);
  if (row?.info_hash) {
    return c.json({ url, title: row.title, infoHash: row.info_hash, magnet: magnetFromHash(row.info_hash, row.title), folderName: folderNameFromTitle(row.title), cached: true });
  }
  let cookie: string | null = null;
  try {
    cookie = await abbCookie(c.env, c.get('tenantId'));
  } catch (e) {
    return c.json({ error: `AudioBookBay login failed: ${(e as Error).message}` }, 502);
  }
  try {
    const m = await abbMagnet(url, cookie);
    if (m.infoHash) c.executionCtx.waitUntil(catalogRecordHash(c.env, url, m.title, m.infoHash).catch(() => undefined));
    return c.json({ ...m, folderName: folderNameFromTitle(m.title) });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

// ─── Torrents ───────────────────────────────────────────────────────────────

// Body: { magnet, fileId?, inspect? }
// Adds the magnet, waits for RD to list the files, then selects:
//   inspect: true     → nothing; returns every file (path/size/kind) and
//                       deletes the torrent again. The client shows a picker
//                       and comes back with one fileId per wanted file.
//   fileId given      → that one file (per-file add for multi-file sets)
//   exactly one audio → it                    mode: 'single'
//   several audio     → the first; the rest  mode: 'multi' (client adds them)
//   no audio          → nothing; torrent deleted, error returned
abbRoutes.post('/torrents', async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const magnet = String(body['magnet'] ?? '').trim();
  const fileId = body['fileId'] != null ? Number(body['fileId']) : null;
  const inspect = body['inspect'] === true;
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
    if (inspect) {
      await rdDelete(token, added.id).catch(() => undefined);
      const all = (info.files ?? []).map((f) => {
        const ext = extOf(f.path);
        return { id: f.id, path: f.path, bytes: f.bytes, ext, isAudio: AUDIO_EXT.has(ext), isArchive: ARCHIVE_EXT.has(ext) };
      });
      return c.json({ name: info.filename, files: all });
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

// Everything on the Real-Debrid account. The grab flow is browser-driven,
// so a tab closed mid-grab leaves torrents here with nobody watching; the
// UIs list these with Finish / Watch / Delete.
abbRoutes.get('/torrents', async (c) => {
  let token: string;
  try {
    token = await requireRd(c.env, c.get('tenantId'));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
  try {
    const list = await rdList(token);
    return c.json({
      torrents: list.map((t) => ({
        id: t.id, hash: (t.hash ?? '').toLowerCase(), filename: t.filename, status: t.status, progress: t.progress, bytes: t.bytes,
        seeders: t.seeders ?? null, speed: t.speed ?? null, error: RD_FAILED[t.status] ?? null,
      })),
    });
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
      error: string | null; hash: string;
      selectedFiles: Array<{ id: number; path: string; bytes: number }>;
      files: Array<{ id: number; path: string; bytes: number; selected: boolean; isAudio: boolean; isArchive: boolean }>;
      downloads?: Array<{ filename: string; filesize: number; ext: string; isAudio: boolean; isArchive: boolean; download: string }>;
    } = {
      id: info.id, status: info.status, progress: info.progress, filename: info.filename,
      error: RD_FAILED[info.status] ?? null,
      hash: (info.hash ?? '').toLowerCase(),
      // Lets a UI that didn't start this grab (tab closed, other device)
      // recompute the pCloud destination for the file(s) it selected, and
      // re-offer the picker over the whole torrent (files + selected flag).
      selectedFiles: (info.files ?? []).filter((f) => f.selected === 1).map((f) => ({ id: f.id, path: f.path, bytes: f.bytes })),
      files: (info.files ?? []).filter((f) => !/\/?\.pad\//.test(f.path)).map((f) => {
        const fe = extOf(f.path);
        return { id: f.id, path: f.path, bytes: f.bytes, selected: f.selected === 1, isAudio: AUDIO_EXT.has(fe), isArchive: ARCHIVE_EXT.has(fe) };
      }),
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
