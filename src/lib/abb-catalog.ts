import type { Env } from '../types';
import {
  ABB_BASE, abbFetchRaw, parseResults, parseMagnet, parseDetails, decodeEntities,
  type AbbResult, type AbbDetails,
} from './abb';
import { sendPushover } from './notify';

// AudioBookBay catalogue (migration 0007): a local copy of ABB's listings,
// filled slowly by the cron in src/index.ts (`scheduled`) so that
//   - search is instant and keeps working while ABB is down,
//   - a cached post goes straight to Real-Debrid without a live page fetch
//     (the info hash is all RD needs),
//   - the site can be browsed by category like ABB's own sidebar.
//
// What is reachable (measured 2026-09-02): every ABB listing — the home
// page and each of the ~62 category/language pages — is capped at 500
// pages of 9 posts; page 501+ silently repeat page 500. The home listing
// therefore only covers the last ~2.5 months, big categories reach back a
// year or so, small ones end earlier with a 404. Nothing older can be
// enumerated, so the catalogue is "everything ABB shows on a listing today,
// plus everything posted from now on, plus whatever live searches turn up"
// (search results are folded in opportunistically).
//
// Politeness is not optional. ABB firewalls an IP that fetches too fast:
// the first local test tick (~50 pages in 3 minutes) got this Mac's IP
// dropped at TCP level (connects hang, a VPS still got 200) — see the
// 2026-09-02 session. Cloudflare egress IPs are shared with every other
// Worker (and the shim's own live search), so tripping that in prod would
// take search down too. Hence: a small per-tick budget, a pause between
// fetches, and an exponential backoff the moment fetches start timing out.
// The budget is adjustable from /admin (stats.budget) once we know what
// ABB tolerates; the defaults are deliberately timid (~3 req/min).

const DEFAULT_BUDGET = 6;   // fetches per tick (cron: every 2 minutes)
const MAX_BUDGET = 30;
const PACE_MS = 4000;       // pause between consecutive fetches
const FRESH_EVERY_MS = 15 * 60 * 1000; // how often the home page is checked for new posts (~2.5 posts/hour arrive)
const FRESH_PAGES = 3;      // home pages walked newest-first until a page has nothing new
const LISTING_CAP = 500;    // ABB's hard pagination wall
const REPORT_AFTER_MS = 14 * 24 * 3600 * 1000;
const TICK_STALE_MS = 12 * 60 * 1000; // a tick older than this is assumed dead (cron overlap guard)
// Three signals, not two: after 168 clean ticks the first backoff (2026-09-02
// 10:31Z) was two 20 s timeouts on a slow patch, not a block — a 2 h pause
// for that was too trigger-happy. A real block fails every fetch.
const BLOCK_SIGNALS_TO_BACK_OFF = 3;  // timeouts / 403 / 429 / 503 in one tick before we stop
const BACKOFF_BASE_MS = 30 * 60 * 1000;  // 30 min, doubling per consecutive episode
const BACKOFF_MAX_MS = 24 * 3600 * 1000;

export type ListingState = {
  name: string;
  page: number;             // last page fetched (0 = not started)
  done: boolean;
  pages: number;            // pages fetched in this pass
  posts: number;            // posts seen in this pass
  added: number;            // posts that were new to the catalogue
  lastFirstUrl: string | null; // wall detection: page N+1 repeating page N's first post
  error: string | null;
  finishedAt: number | null;
};

export type CrawlStats = {
  startedAt: number;
  ticks: number;
  tickStartedAt: number | null;
  lastTick: number | null;
  lastTickMs: number | null;
  pagesFetched: number;
  postsSeen: number;
  postsAdded: number;
  detailsFetched: number;
  detailErrors: number;
  zeroParsePages: number;   // 200 responses the parser found no posts on — markup drift alarm
  lastError: string | null;
  lastErrorAt: number | null;
  reportSentAt: number | null;
  paused: boolean;
  budget: number;           // fetches per tick, adjustable from /admin
  lastFresh: number | null; // last home-page check for new posts
  backoffUntil: number | null;  // set when ABB looks like it's blocking us
  backoffLevel: number;     // consecutive backoffs (doubles the wait)
  blockedTicks: number;     // how many ticks ended in a backoff, ever
};

const emptyStats = (): CrawlStats => ({
  startedAt: Date.now(), ticks: 0, tickStartedAt: null, lastTick: null, lastTickMs: null,
  pagesFetched: 0, postsSeen: 0, postsAdded: 0, detailsFetched: 0, detailErrors: 0, zeroParsePages: 0,
  lastError: null, lastErrorAt: null, reportSentAt: null, paused: false,
  budget: DEFAULT_BUDGET, lastFresh: null, backoffUntil: null, backoffLevel: 0, blockedTicks: 0,
});

// ─── abb_crawl key/value ────────────────────────────────────────────────────

async function getState<T>(env: Env, key: string): Promise<T | null> {
  const r = await env.DB.prepare('SELECT value FROM abb_crawl WHERE key = ?').bind(key).first<{ value: string }>();
  if (!r) return null;
  try { return JSON.parse(r.value) as T; } catch { return null; }
}

async function setState(env: Env, key: string, value: unknown): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO abb_crawl (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(key, JSON.stringify(value), Date.now()).run();
}

async function loadStats(env: Env): Promise<CrawlStats> {
  return { ...emptyStats(), ...((await getState<Partial<CrawlStats>>(env, 'stats')) ?? {}) };
}

async function listListings(env: Env): Promise<Array<{ path: string; state: ListingState }>> {
  const rows = await env.DB.prepare(`SELECT key, value FROM abb_crawl WHERE key LIKE 'listing:%' ORDER BY rowid`).all<{ key: string; value: string }>();
  const out: Array<{ path: string; state: ListingState }> = [];
  for (const r of rows.results) {
    try { out.push({ path: r.key.slice('listing:'.length), state: JSON.parse(r.value) as ListingState }); } catch { /* skip */ }
  }
  return out;
}

const newListing = (name: string): ListingState => ({
  name, page: 0, done: false, pages: 0, posts: 0, added: 0, lastFirstUrl: null, error: null, finishedAt: null,
});

// Every listing page carries the sidebar with all category/language links,
// so any fetched page can register listings we haven't seen yet.
async function discoverListings(env: Env, html: string, known: Set<string>): Promise<void> {
  const re = /<a href="(\/audio-books\/(?:type|tag)\/[^"/]+\/)"[^>]*>([^<]+)</g;
  let m: RegExpExecArray | null;
  const batch: D1PreparedStatement[] = [];
  while ((m = re.exec(html))) {
    const path = m[1]!;
    if (known.has(path)) continue;
    known.add(path);
    const name = decodeEntities(m[2]!.trim());
    batch.push(env.DB.prepare('INSERT OR IGNORE INTO abb_crawl (key, value, updated_at) VALUES (?, ?, ?)')
      .bind('listing:' + path, JSON.stringify(newListing(name)), Date.now()));
  }
  if (batch.length) await env.DB.batch(batch);
}

// ─── Posts ──────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function postedTs(posted: string | null): number | null {
  const m = posted ? /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/.exec(posted.trim()) : null;
  if (!m) return null;
  const mon = MONTHS[m[2]!.toLowerCase()];
  return mon == null ? null : Date.UTC(Number(m[3]), mon, Number(m[1]));
}

// Insert-or-refresh listing rows. Returns how many were new. Detail fields
// (hash, author, blurb) are never touched here — they come from the detail
// pass — but the listing fields are refreshed so an edited post (new cover,
// corrected size) converges.
export async function upsertPosts(env: Env, posts: AbbResult[]): Promise<number> {
  const urls = [...new Set(posts.map((p) => p.url))];
  if (!urls.length) return 0;
  const existing = new Set<string>();
  for (let i = 0; i < urls.length; i += 50) {
    const chunk = urls.slice(i, i + 50);
    const rows = await env.DB.prepare(`SELECT url FROM abb_posts WHERE url IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk).all<{ url: string }>();
    for (const r of rows.results) existing.add(r.url);
  }
  const now = Date.now();
  const batch: D1PreparedStatement[] = [];
  const seen = new Set<string>();
  for (const p of posts) {
    if (seen.has(p.url)) continue;
    seen.add(p.url);
    const ts = postedTs(p.posted);
    batch.push(env.DB.prepare(
      `INSERT INTO abb_posts (url, title, cover, categories, keywords, language, format, bitrate, size_bytes, posted, posted_ts, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           title = excluded.title, cover = COALESCE(excluded.cover, abb_posts.cover),
           categories = excluded.categories, keywords = excluded.keywords, language = excluded.language,
           format = excluded.format, bitrate = excluded.bitrate, size_bytes = excluded.size_bytes,
           posted = excluded.posted, posted_ts = excluded.posted_ts, last_seen = excluded.last_seen`,
    ).bind(p.url, p.title, p.cover, JSON.stringify(p.categories), JSON.stringify(p.keywords), p.language || null,
      p.format, p.bitrate, p.sizeBytes, p.posted, ts, now, now));
    batch.push(env.DB.prepare('DELETE FROM abb_post_cats WHERE post_id = (SELECT id FROM abb_posts WHERE url = ?)').bind(p.url));
    for (const cat of p.categories) {
      batch.push(env.DB.prepare('INSERT OR IGNORE INTO abb_post_cats (post_id, cat, posted_ts) SELECT id, ?, ? FROM abb_posts WHERE url = ?')
        .bind(cat, ts, p.url));
    }
  }
  for (let i = 0; i < batch.length; i += 100) await env.DB.batch(batch.slice(i, i + 100));
  return urls.filter((u) => !existing.has(u)).length;
}

export type CatalogRow = {
  id: number; url: string; title: string; cover: string | null; categories: string; keywords: string;
  language: string | null; format: string | null; bitrate: string | null; size_bytes: number | null;
  posted: string | null; info_hash: string | null; author: string | null; narrators: string | null;
  length: string | null; abridged: number | null; description: string | null; detail_fetched_at: number | null; detail_error: string | null;
  cover_r2: number | null; cover_error: string | null;
};

const parseArr = (s: string | null): string[] => { try { const v = JSON.parse(s ?? '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };

export function rowToResult(r: CatalogRow): AbbResult {
  const categories = parseArr(r.categories);
  const size = r.size_bytes != null ? `${(r.size_bytes / 1024 ** 2).toFixed(2)} MBs` : '';
  return {
    title: r.title, url: r.url, cover: r.cover,
    category: categories.join(', '), language: r.language ?? '',
    info: r.format ? `Format: ${r.format.toUpperCase()} / Bitrate: ${r.bitrate ?? '?'} File Size: ${size}` : '',
    format: r.format, bitrate: r.bitrate, sizeBytes: r.size_bytes, posted: r.posted,
    categories, keywords: parseArr(r.keywords),
    infoHash: r.info_hash, author: r.author, narrators: parseArr(r.narrators), cached: true,
    catalogId: r.id, coverOrig: r.cover, coverCached: !!r.cover_r2,
  };
}

// Swap the source cover for the shim-hosted webp where one exists (see
// migration 0008 / scripts/abb-covers.py). Pholia is on another origin,
// hence absolute URLs.
export function withCoverUrls(results: AbbResult[], origin: string): AbbResult[] {
  for (const r of results) {
    if (r.coverCached && r.catalogId != null) r.cover = `${origin}/public/abb-cover/${r.catalogId}.webp`;
  }
  return results;
}

export const ABB_COVER_PREFIX = 'abbcovers/';

export async function coversPending(env: Env, limit: number): Promise<Array<{ id: number; url: string; title: string }>> {
  const rows = await env.DB.prepare(
    `SELECT id, cover AS url, title FROM abb_posts WHERE cover IS NOT NULL AND cover_r2 IS NULL AND cover_error IS NULL
       ORDER BY posted_ts DESC, id DESC LIMIT ?`,
  ).bind(Math.min(Math.max(limit, 1), 1000)).all<{ id: number; url: string; title: string }>();
  return rows.results;
}

export async function coverStore(env: Env, id: number, webp: ArrayBuffer): Promise<boolean> {
  const row = await env.DB.prepare('SELECT id FROM abb_posts WHERE id = ?').bind(id).first<{ id: number }>();
  if (!row) return false;
  await env.COVERS.put(`${ABB_COVER_PREFIX}${id}.webp`, webp, { httpMetadata: { contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' } });
  await env.DB.prepare('UPDATE abb_posts SET cover_r2 = ?, cover_error = NULL WHERE id = ?').bind(Date.now(), id).run();
  return true;
}

export async function coverFailed(env: Env, id: number, error: string): Promise<void> {
  await env.DB.prepare('UPDATE abb_posts SET cover_error = ? WHERE id = ?').bind(error.slice(0, 200), id).run();
}

export async function coverStats(env: Env): Promise<{ withCover: number; cached: number; failed: number }> {
  const r = await env.DB.prepare(
    'SELECT SUM(cover IS NOT NULL) AS withCover, SUM(cover_r2 IS NOT NULL) AS cached, SUM(cover_error IS NOT NULL) AS failed FROM abb_posts',
  ).first<{ withCover: number; cached: number; failed: number }>();
  return { withCover: r?.withCover ?? 0, cached: r?.cached ?? 0, failed: r?.failed ?? 0 };
}

// FTS5 query from free text: each word becomes a prefix term, all required.
// Everything that isn't a letter/digit is stripped so user input can't
// reach the FTS parser as syntax ("dune:", quotes, parentheses).
export function ftsQuery(q: string): string | null {
  const toks = q.split(/\s+/).map((t) => t.replace(/[^\p{L}\p{N}]+/gu, '')).filter(Boolean);
  return toks.length ? toks.map((t) => `"${t}"*`).join(' ') : null;
}

export async function catalogSearch(env: Env, q: string, limit = 50, offset = 0): Promise<AbbResult[]> {
  const match = ftsQuery(q);
  if (!match) return [];
  const rows = await env.DB.prepare(
    `SELECT p.* FROM abb_posts_fts f JOIN abb_posts p ON p.id = f.rowid
       WHERE abb_posts_fts MATCH ?
       ORDER BY bm25(abb_posts_fts, 10.0, 6.0, 3.0, 1.0), p.posted_ts DESC
       LIMIT ? OFFSET ?`,
  ).bind(match, limit, offset).all<CatalogRow>();
  return rows.results.map(rowToResult);
}

export type BrowseOpts = { cat?: string; language?: string; format?: string; limit?: number; offset?: number };

export async function catalogBrowse(env: Env, o: BrowseOpts): Promise<AbbResult[]> {
  const limit = Math.min(Math.max(o.limit ?? 30, 1), 100);
  const offset = Math.max(o.offset ?? 0, 0);
  const where: string[] = [];
  const args: unknown[] = [];
  if (o.language) { where.push('p.language = ?'); args.push(o.language); }
  if (o.format) { where.push('p.format = ?'); args.push(o.format.toLowerCase()); }
  let sql: string;
  if (o.cat) {
    sql = `SELECT p.* FROM abb_post_cats c JOIN abb_posts p ON p.id = c.post_id WHERE c.cat = ?${where.map((w) => ' AND ' + w).join('')}
             ORDER BY c.posted_ts DESC, c.post_id DESC LIMIT ? OFFSET ?`;
    args.unshift(o.cat);
  } else {
    sql = `SELECT p.* FROM abb_posts p${where.length ? ' WHERE ' + where.join(' AND ') : ''}
             ORDER BY p.posted_ts DESC, p.id DESC LIMIT ? OFFSET ?`;
  }
  const rows = await env.DB.prepare(sql).bind(...args, limit, offset).all<CatalogRow>();
  return rows.results.map(rowToResult);
}

export async function catalogFacets(env: Env): Promise<{
  categories: Array<{ name: string; count: number }>;
  languages: Array<{ name: string; count: number }>;
  formats: Array<{ name: string; count: number }>;
  total: number;
}> {
  const [cats, langs, fmts, total] = await Promise.all([
    env.DB.prepare('SELECT cat AS name, COUNT(*) AS count FROM abb_post_cats GROUP BY cat ORDER BY name').all<{ name: string; count: number }>(),
    env.DB.prepare('SELECT language AS name, COUNT(*) AS count FROM abb_posts WHERE language IS NOT NULL GROUP BY language ORDER BY count DESC').all<{ name: string; count: number }>(),
    env.DB.prepare('SELECT format AS name, COUNT(*) AS count FROM abb_posts WHERE format IS NOT NULL GROUP BY format ORDER BY count DESC').all<{ name: string; count: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM abb_posts').first<{ n: number }>(),
  ]);
  return { categories: cats.results, languages: langs.results, formats: fmts.results, total: total?.n ?? 0 };
}

export async function catalogGet(env: Env, url: string): Promise<CatalogRow | null> {
  return env.DB.prepare('SELECT * FROM abb_posts WHERE url = ?').bind(url).first<CatalogRow>();
}

export function rowToDetails(r: CatalogRow): AbbDetails {
  return {
    url: r.url, title: r.title, author: r.author, narrators: parseArr(r.narrators),
    format: r.format, bitrate: r.bitrate, length: r.length,
    abridged: r.abridged == null ? null : r.abridged === 1,
    description: r.description ?? '',
  };
}

// A live resolve/details learned something the crawler hasn't fetched yet:
// remember it. Creates a bare row when the post isn't catalogued at all (a
// search hit older than every listing) so the next tick fills the rest.
export async function catalogRecordHash(env: Env, url: string, title: string, hash: string): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO abb_posts (url, title, first_seen, last_seen) VALUES (?, ?, ?, ?)').bind(url, title, now, now),
    env.DB.prepare('UPDATE abb_posts SET info_hash = ? WHERE url = ? AND info_hash IS NULL').bind(hash.toLowerCase(), url),
  ]);
}

export async function catalogRecordDetails(env: Env, d: AbbDetails, hash: string | null): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO abb_posts (url, title, first_seen, last_seen) VALUES (?, ?, ?, ?)').bind(d.url, d.title, now, now),
    env.DB.prepare(
      `UPDATE abb_posts SET author = ?, narrators = ?, length = ?, abridged = ?, description = ?,
         format = COALESCE(format, ?), bitrate = COALESCE(bitrate, ?),
         info_hash = COALESCE(?, info_hash), detail_fetched_at = ?, detail_error = NULL WHERE url = ?`,
    ).bind(d.author, JSON.stringify(d.narrators), d.length, d.abridged == null ? null : d.abridged ? 1 : 0, d.description,
      d.format ? d.format.toLowerCase() : null, d.bitrate, hash ? hash.toLowerCase() : null, now, d.url),
  ]);
}

// ─── Crawler ────────────────────────────────────────────────────────────────

type Tick = { stats: CrawlStats; fetches: number; budget: number; blockSignals: number; log: string[] };

class BlockedError extends Error {}

function noteError(t: Tick, msg: string): void {
  t.stats.lastError = msg;
  t.stats.lastErrorAt = Date.now();
  t.log.push('error: ' + msg);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Every crawler fetch goes through here: enforces the per-tick budget and
// the pause between requests, and turns "ABB is dropping us" (timeouts,
// 403/429/503) into a BlockedError once it has happened twice in a tick.
async function paced(t: Tick, path: string): Promise<{ status: number; html: string }> {
  if (t.fetches >= t.budget) throw new BudgetExhausted();
  if (t.fetches > 0) await sleep(PACE_MS);
  t.fetches++;
  let r: { status: number; html: string };
  try {
    r = await abbFetchRaw(path, null);
  } catch (e) {
    t.blockSignals++;
    if (t.blockSignals >= BLOCK_SIGNALS_TO_BACK_OFF) throw new BlockedError(`${(e as Error).message} on ${path}`);
    throw e;
  }
  t.stats.pagesFetched++;
  if (r.status === 403 || r.status === 429 || r.status === 503) {
    t.blockSignals++;
    if (t.blockSignals >= BLOCK_SIGNALS_TO_BACK_OFF) throw new BlockedError(`HTTP ${r.status} on ${path}`);
  }
  return r;
}

class BudgetExhausted extends Error {}

// One listing page → parsed posts (or null when the page doesn't exist).
async function fetchListingPage(t: Tick, path: string, page: number): Promise<{ posts: AbbResult[]; html: string } | null> {
  const p = page > 1 ? `${path}page/${page}/` : path;
  const { status, html } = await paced(t, p);
  if (status === 404) return null;
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status} on ${p}`);
  const posts = parseResults(html);
  if (!posts.length && html.length > 5000) {
    // ABB answers a real end-of-listing with a 404, so a 200 with no posts
    // is either the site's markup changing or a challenge page. Count it so
    // /admin can show the alarm.
    t.stats.zeroParsePages++;
    noteError(t, `parser found 0 posts on ${p} (HTTP 200, ${html.length} bytes)`);
  }
  t.stats.postsSeen += posts.length;
  return { posts, html };
}

// Newest-first walk of the home listing until a page has nothing we don't
// already have. This is what keeps the catalogue current once backfill is
// done — ~60 posts/day arrive, page 1 holds 9.
async function freshPass(env: Env, t: Tick, known: Set<string>): Promise<void> {
  if (t.stats.lastFresh && Date.now() - t.stats.lastFresh < FRESH_EVERY_MS) return;
  t.stats.lastFresh = Date.now();
  for (let page = 1; page <= FRESH_PAGES; page++) {
    const r = await fetchListingPage(t, '/', page);
    if (!r || !r.posts.length) break;
    if (page === 1) await discoverListings(env, r.html, known);
    const added = await upsertPosts(env, r.posts);
    t.stats.postsAdded += added;
    t.log.push(`fresh p${page}: ${r.posts.length} posts, ${added} new`);
    if (!added) break;
  }
}

// Advance the first unfinished listing by up to `pages` pages. Returns
// false when there's nothing left to backfill.
async function backfillPass(env: Env, t: Tick, pages: number): Promise<boolean> {
  const listings = await listListings(env);
  const cur = listings.find((l) => !l.state.done);
  if (!cur) return false;
  const st = cur.state;
  const save = () => setState(env, 'listing:' + cur.path, st);
  for (let i = 0; i < pages; i++) {
    const page = st.page + 1;
    if (page > LISTING_CAP) { st.done = true; st.finishedAt = Date.now(); break; }
    let r: { posts: AbbResult[]; html: string } | null;
    try {
      r = await fetchListingPage(t, cur.path, page);
    } catch (e) {
      if (e instanceof BlockedError || e instanceof BudgetExhausted) { await save(); throw e; }
      st.error = (e as Error).message;
      noteError(t, `${cur.path} p${page}: ${st.error}`);
      break; // leave the cursor; next tick retries this page
    }
    const first = r?.posts[0]?.url ?? null;
    if (!r || !r.posts.length || (first && first === st.lastFirstUrl)) {
      // 404 = past the end; a repeat of the previous page's first post is
      // ABB's 500-page wall (pages beyond it echo the last real page).
      st.done = true;
      st.finishedAt = Date.now();
      if (r && !r.posts.length) st.error = 'parser found 0 posts';
      break;
    }
    st.page = page;
    st.pages++;
    st.posts += r.posts.length;
    st.lastFirstUrl = first;
    st.error = null;
    const added = await upsertPosts(env, r.posts);
    st.added += added;
    t.stats.postsAdded += added;
    await save();
  }
  await save();
  t.log.push(`backfill ${st.name}: at p${st.page}${st.done ? ' (done)' : ''}, +${st.added} new so far`);
  return true;
}

// Detail pages for posts that don't have one yet, newest first: the info
// hash (what Real-Debrid needs), author/narrators/blurb (what search and
// the details panel show).
async function detailPass(env: Env, t: Tick, count: number): Promise<number> {
  if (count <= 0) return 0;
  const rows = await env.DB.prepare(
    'SELECT url, title FROM abb_posts WHERE detail_fetched_at IS NULL ORDER BY posted_ts DESC, id DESC LIMIT ?',
  ).bind(count).all<{ url: string; title: string }>();
  let ok = 0;
  for (const row of rows.results) {
    const u = new URL(row.url);
    let status = 0;
    let html = '';
    try {
      ({ status, html } = await paced(t, u.pathname + u.search));
    } catch (e) {
      if (e instanceof BlockedError || e instanceof BudgetExhausted) throw e;
      await env.DB.prepare('UPDATE abb_posts SET detail_fetched_at = ?, detail_error = ? WHERE url = ?')
        .bind(Date.now(), (e as Error).message, row.url).run();
      t.stats.detailErrors++;
      continue;
    }
    if (status < 200 || status >= 300) {
      await env.DB.prepare('UPDATE abb_posts SET detail_fetched_at = ?, detail_error = ? WHERE url = ?')
        .bind(Date.now(), `HTTP ${status}`, row.url).run();
      t.stats.detailErrors++;
      continue;
    }
    let hash: string | null = null;
    try { hash = parseMagnet(row.url, html).infoHash || null; } catch { /* no hash on the page — details still worth keeping */ }
    const d = parseDetails(row.url, html);
    await catalogRecordDetails(env, d, hash);
    if (!hash) {
      await env.DB.prepare('UPDATE abb_posts SET detail_error = ? WHERE url = ?').bind('no info hash on page', row.url).run();
      t.stats.detailErrors++;
    } else {
      ok++;
    }
    t.stats.detailsFetched++;
  }
  if (rows.results.length) t.log.push(`details: ${ok}/${rows.results.length} with hash`);
  return rows.results.length;
}

export type CatalogCounts = { total: number; withHash: number; pending: number; errors: number };

export async function catalogCounts(env: Env): Promise<CatalogCounts> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS total, SUM(info_hash IS NOT NULL) AS withHash,
            SUM(detail_fetched_at IS NULL) AS pending, SUM(detail_error IS NOT NULL) AS errors FROM abb_posts`,
  ).first<CatalogCounts>();
  return { total: r?.total ?? 0, withHash: r?.withHash ?? 0, pending: r?.pending ?? 0, errors: r?.errors ?? 0 };
}

// The two-week check-in Joseph asked for: one Pushover push with the
// numbers, sent by whichever tick first runs past the deadline.
async function maybeSendReport(env: Env, stats: CrawlStats, force = false): Promise<boolean> {
  if (!force && (stats.reportSentAt || Date.now() - stats.startedAt < REPORT_AFTER_MS)) return false;
  const c = await catalogCounts(env);
  const listings = await listListings(env);
  const done = listings.filter((l) => l.state.done).length;
  const days = Math.round((Date.now() - stats.startedAt) / 86_400_000);
  const message = [
    `${c.total.toLocaleString()} posts cached, ${c.withHash.toLocaleString()} with a magnet, ${c.pending.toLocaleString()} awaiting details.`,
    `Listings crawled: ${done}/${listings.length}. Detail errors: ${c.errors}. Parser alarms: ${stats.zeroParsePages}.`,
    `Ticks: ${stats.ticks}, pages fetched: ${stats.pagesFetched.toLocaleString()}.`,
    stats.lastError ? `Last error: ${stats.lastError}` : 'No recent errors.',
  ].join('\n');
  await sendPushover(env, {
    title: `ABB catalogue: ${days}-day check-in`,
    message,
    url: (env.PUBLIC_ORIGIN ?? 'https://abs-shim.jderrick.app') + '/admin',
    urlTitle: 'Open /admin',
  });
  if (!force) stats.reportSentAt = Date.now();
  return true;
}

export async function sendReportNow(env: Env): Promise<void> {
  const stats = await loadStats(env);
  await maybeSendReport(env, stats, true);
}

// One cron tick. `force` ignores the pause flag (manual "Run now").
export async function runCatalogTick(env: Env, opts: { force?: boolean } = {}): Promise<{ ran: boolean; log: string[] }> {
  const stats = await loadStats(env);
  if (stats.paused && !opts.force) return { ran: false, log: ['paused'] };
  if (stats.backoffUntil && Date.now() < stats.backoffUntil && !opts.force) return { ran: false, log: ['backing off'] };
  if (stats.tickStartedAt && (!stats.lastTick || stats.tickStartedAt > stats.lastTick) && Date.now() - stats.tickStartedAt < TICK_STALE_MS) {
    return { ran: false, log: ['a tick is still running'] };
  }
  stats.tickStartedAt = Date.now();
  await setState(env, 'stats', stats);
  const budget = Math.min(Math.max(stats.budget || DEFAULT_BUDGET, 1), MAX_BUDGET);
  const t: Tick = { stats, fetches: 0, budget, blockSignals: 0, log: [] };
  await ensureHomeListing(env);
  const known = new Set((await listListings(env)).map((l) => l.path));
  let blocked: string | null = null;
  try {
    await freshPass(env, t, known);
    // Whatever the fresh check left goes half to backfill (listing pages,
    // 9 posts each) and half to detail pages (one post each). When one side
    // has nothing to do the other gets it all.
    const left = budget - t.fetches;
    const pending = (await catalogCounts(env)).pending;
    let detailShare = pending ? Math.ceil(left / 2) : 0;
    const more = await backfillPass(env, t, left - detailShare);
    if (!more) detailShare = budget - t.fetches;
    await detailPass(env, t, Math.min(detailShare, budget - t.fetches));
  } catch (e) {
    if (e instanceof BlockedError) blocked = e.message;
    else if (!(e instanceof BudgetExhausted)) noteError(t, (e as Error).message);
  }
  if (blocked) {
    // Two dropped/refused fetches in one tick: assume ABB is throttling the
    // egress IP and go quiet — 2h, doubling per consecutive episode, to a
    // day. One push per episode so Joseph knows; a clean tick resets it.
    const wait = Math.min(BACKOFF_BASE_MS * 2 ** stats.backoffLevel, BACKOFF_MAX_MS);
    stats.backoffUntil = Date.now() + wait;
    stats.backoffLevel++;
    stats.blockedTicks++;
    const waitText = wait >= 3600000 ? `${Math.round(wait / 3600000)}h` : `${Math.round(wait / 60000)}min`;
    noteError(t, `backing off ${waitText}: ${blocked}`);
    await sendPushover(env, {
      title: 'ABB catalogue crawler backing off',
      message: `AudioBookBay stopped answering (${blocked}). Pausing the crawler for ${waitText} (episode ${stats.backoffLevel}). It resumes by itself; a real block shows up as repeated episodes.`,
      url: (env.PUBLIC_ORIGIN ?? 'https://abs-shim.jderrick.app') + '/admin', urlTitle: 'Open /admin',
    }).catch(() => undefined);
  } else if (t.fetches > 0 && t.blockSignals === 0) {
    stats.backoffLevel = 0;
    stats.backoffUntil = null;
  }
  stats.ticks++;
  stats.lastTick = Date.now();
  stats.lastTickMs = stats.lastTick - stats.tickStartedAt;
  try {
    await maybeSendReport(env, stats);
  } catch (e) {
    noteError(t, 'report: ' + (e as Error).message);
  }
  await setState(env, 'stats', stats);
  t.log.unshift(`${t.fetches}/${budget} fetches`);
  return { ran: true, log: t.log };
}

export async function catalogStatus(env: Env): Promise<{
  stats: CrawlStats; counts: CatalogCounts;
  listings: Array<{ path: string; name: string; page: number; done: boolean; posts: number; added: number; error: string | null }>;
  reportDueAt: number;
}> {
  const stats = await loadStats(env);
  const [counts, listings] = await Promise.all([catalogCounts(env), listListings(env)]);
  return {
    stats, counts,
    listings: listings.map((l) => ({ path: l.path, name: l.state.name, page: l.state.page, done: l.state.done, posts: l.state.posts, added: l.state.added, error: l.state.error })),
    reportDueAt: stats.startedAt + REPORT_AFTER_MS,
  };
}

export type CatalogAction = 'pause' | 'resume' | 'retry-errors' | 'restart-backfill' | 'reset-report' | 'set-budget' | 'clear-backoff';

export async function catalogControl(env: Env, action: CatalogAction, value?: number): Promise<void> {
  const stats = await loadStats(env);
  switch (action) {
    case 'pause': stats.paused = true; break;
    case 'resume': stats.paused = false; break;
    case 'set-budget': stats.budget = Math.min(Math.max(Math.round(value ?? DEFAULT_BUDGET) || DEFAULT_BUDGET, 1), MAX_BUDGET); break;
    case 'clear-backoff': stats.backoffUntil = null; stats.backoffLevel = 0; break;
    case 'reset-report': stats.reportSentAt = null; stats.startedAt = Date.now(); break;
    case 'retry-errors':
      await env.DB.prepare('UPDATE abb_posts SET detail_fetched_at = NULL, detail_error = NULL WHERE detail_error IS NOT NULL').run();
      break;
    case 'restart-backfill': {
      // Re-walk every listing from page 1 (posts already cached are just refreshed).
      const listings = await listListings(env);
      await env.DB.batch(listings.map((l) => env.DB.prepare('UPDATE abb_crawl SET value = ?, updated_at = ? WHERE key = ?')
        .bind(JSON.stringify(newListing(l.state.name)), Date.now(), 'listing:' + l.path)));
      break;
    }
  }
  await setState(env, 'stats', stats);
}

// The home listing is registered on the first tick; categories are
// discovered from its sidebar. Exposed so /admin can show the list before
// the first tick has run.
export const HOME_LISTING = { path: '/', name: 'Latest' };
export async function ensureHomeListing(env: Env): Promise<void> {
  await env.DB.prepare('INSERT OR IGNORE INTO abb_crawl (key, value, updated_at) VALUES (?, ?, ?)')
    .bind('listing:' + HOME_LISTING.path, JSON.stringify(newListing(HOME_LISTING.name)), Date.now()).run();
}

export { ABB_BASE };
