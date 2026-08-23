// AudioBookBay scraping: login, search, and magnet resolution.
//
// Ported from the standalone abb-rd worker (/Users/joseph/CLINE/ABB) so the
// shim doesn't depend on a second deployment. Pure fetch + regex; ABB has no
// API. Everything that touches their markup is in parseResults/parseInfo —
// when the site changes, that's where it breaks (silently: results become
// []), so the admin UI says "0 results — ABB markup may have changed" rather
// than "no such book".

const ABB_BASE = 'https://audiobookbay.lu';
// ABB blocks non-browser user agents.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export type AbbResult = {
  title: string;
  url: string;
  cover: string | null;     // post thumbnail (ibb.co / Amazon), http(s) only
  category: string;
  language: string;
  info: string;
  format: string | null;    // 'm4b' | 'mp3' | …
  bitrate: string | null;
  sizeBytes: number | null;
  posted: string | null;    // "24 Dec 2025" — ABB's upload date, verbatim
};

export type AbbCookie = { cookie: string; expiresAt: number };

// POST the login form. ABB answers 302 → /member/users/ with Set-Cookie on
// the redirect response itself; `redirect: 'follow'` would discard it, so
// read the cookie off the 302 and verify the session with a second GET.
export async function abbLogin(username: string, password: string): Promise<AbbCookie> {
  const resp = await fetch(`${ABB_BASE}/member/login.php`, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }),
    redirect: 'manual',
  });
  const cookie = collectCookies(resp);
  if (!cookie) throw new Error('ABB login returned no session cookie');
  const check = await fetch(`${ABB_BASE}/member/users/`, {
    headers: { 'User-Agent': UA, Cookie: cookie },
    redirect: 'follow',
  });
  const html = await check.text();
  if (!html.toLowerCase().includes('logout')) throw new Error('ABB rejected the username/password');
  // Sessions last hours; refresh well inside that.
  return { cookie, expiresAt: Date.now() + 6 * 60 * 60 * 1000 };
}

function collectCookies(resp: Response): string {
  const h = resp.headers as Headers & { getSetCookie?: () => string[] };
  const raw = typeof h.getSetCookie === 'function' ? h.getSetCookie().join('; ') : (resp.headers.get('set-cookie') ?? '');
  return raw
    .split(/,(?=[^ ;]+=)/)
    .map((c) => c.split(';')[0]!.trim())
    .filter(Boolean)
    .join('; ');
}

async function abbFetch(path: string, cookie: string | null): Promise<string> {
  const headers: Record<string, string> = { 'User-Agent': UA };
  if (cookie) headers['Cookie'] = cookie;
  const resp = await fetch(ABB_BASE + path, { headers, redirect: 'follow' });
  if (!resp.ok) throw new Error(`AudioBookBay HTTP ${resp.status}`);
  return resp.text();
}

// Search works without a login; the cookie only unlocks member-only detail
// pages, so callers pass whatever they have.
//
// The query MUST be lower-case: ABB answers any `?s=` containing a capital
// letter with a 301 to its homepage (observed 2026-08-22: "Dune+Frank+Herbert"
// → 301 /, "dune+frank+herbert" → 200). With redirect:'follow' that silently
// turns into "search results" that are really the latest posts.
export async function abbSearch(query: string, pages: number, cookie: string | null): Promise<AbbResult[]> {
  const results: AbbResult[] = [];
  const q = query.trim().toLowerCase().split(/\s+/).map(encodeURIComponent).join('+');
  for (let page = 1; page <= Math.min(Math.max(pages, 1), 5); page++) {
    const qs = `/?s=${q}&tt=1,2,3${page > 1 ? `&p=${page}` : ''}`;
    const found = parseResults(await abbFetch(qs, cookie));
    if (!found.length) break;
    results.push(...found);
  }
  return results;
}

function parseResults(html: string): AbbResult[] {
  const out: AbbResult[] = [];
  const postRe = /<div class="post">([\s\S]*?)(?=<div class="post">|$)/g;
  let m: RegExpExecArray | null;
  while ((m = postRe.exec(html))) {
    const block = m[1]!;
    const t = /<div class="postTitle"><h2><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!t) continue;
    // Scraped hrefs end up in <a href> in the admin UI and Pholia — refuse
    // anything that isn't http(s) so a hostile page can't plant javascript:.
    const url = safeHttpUrl(t[1]!);
    if (!url) continue;
    const title = decodeEntities(t[2]!.trim());
    const img = /<img[^>]+src="([^"]+)"/i.exec(block);
    const cover = img ? safeHttpUrl(img[1]!) : null;
    const infoText = decodeEntities(block.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
    const cat = /Category:\s*([\s\S]*?)\s*Language:\s*(\w+)/.exec(infoText);
    const fmt = /(Format:\s*.*?File Size:\s*[\d.]+\s*\w+)/.exec(infoText);
    const info = fmt ? fmt[1]!.trim() : '';
    // "Posted: 24 Dec 2025" sits right before "Format:" in the same <p>.
    const posted = /Posted:\s*(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})/.exec(infoText)?.[1] ?? null;
    out.push({
      title, url, cover,
      category: cat ? cat[1]!.trim() : '',
      language: cat ? cat[2]! : '',
      info,
      posted,
      ...parseInfo(info),
    });
  }
  return out;
}

// "Format: M4B / Bitrate: 64 Kbps File Size: 350 MBs" → structured fields.
// "Bitrate: ?" and "Mixed" occur; units are "MBs"/"GBs".
function parseInfo(info: string): { format: string | null; bitrate: string | null; sizeBytes: number | null } {
  const format = /Format:\s*([A-Za-z0-9]+)/.exec(info)?.[1];
  const bitrate = /Bitrate:\s*([^/]+?)\s*File Size:/.exec(info)?.[1];
  const size = /File Size:\s*([\d.]+)\s*([KMGT]?)B/i.exec(info);
  const mult: Record<string, number> = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  return {
    format: format ? format.toLowerCase() : null,
    bitrate: bitrate ? bitrate.trim() : null,
    sizeBytes: size ? Math.round(parseFloat(size[1]!) * (mult[size[2]!.toUpperCase()] ?? 1)) : null,
  };
}

export type AbbMagnet = { url: string; title: string; infoHash: string; magnet: string };

// Members get a real magnet href on the detail page; otherwise the page
// shows the info hash and we build a magnet with public trackers (RD
// resolves those fine).
export async function abbMagnet(pageUrl: string, cookie: string | null): Promise<AbbMagnet> {
  const u = new URL(pageUrl);
  if (u.origin !== ABB_BASE) throw new Error('Not an AudioBookBay URL');
  const html = await abbFetch(u.pathname + u.search, cookie);
  const title = htmlTitle(html);
  const m = /href="(magnet:\?[^"]+)"/i.exec(html);
  if (m) {
    const magnet = decodeEntities(m[1]!);
    const hash = /btih:([0-9a-fA-F]{40})/.exec(magnet)?.[1] ?? '';
    return { url: pageUrl, title, infoHash: hash.toLowerCase(), magnet };
  }
  const cell = /Info Hash:<\/td>\s*<td>([0-9a-fA-F]{40})<\/td>/.exec(html);
  const hash = cell?.[1] ?? /\b([0-9a-fA-F]{40})\b/.exec(html)?.[1] ?? '';
  if (!hash) throw new Error('No info hash found on the AudioBookBay page');
  const dn = title.replace(/[^\w]+/g, '+').slice(0, 80);
  const magnet = `magnet:?xt=urn:btih:${hash}&dn=${dn}`
    + '&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A80'
    + '&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce';
  return { url: pageUrl, title, infoHash: hash.toLowerCase(), magnet };
}

export type AbbDetails = {
  url: string;
  title: string;
  author: string | null;
  narrators: string[];
  format: string | null;
  bitrate: string | null;
  length: string | null;
  abridged: boolean | null;
  description: string;      // plain text, paragraphs separated by blank lines
};

// The detail page's <div class="desc" itemprop="description"> holds a
// "Written by / Read by / Format / Unabridged" header paragraph, a
// "Bit Rate / Length / Narrators" paragraph, then the blurb. The header
// fields are tagged (span.author, span.narrator, span.format,
// span.is_abridged) so those are read structurally; the blurb is whatever
// paragraphs remain once the two meta paragraphs are dropped.
export async function abbDetails(pageUrl: string, cookie: string | null): Promise<AbbDetails> {
  const u = new URL(pageUrl);
  if (u.origin !== ABB_BASE) throw new Error('Not an AudioBookBay URL');
  const html = await abbFetch(u.pathname + u.search, cookie);
  return parseDetails(pageUrl, html);
}

export function parseDetails(pageUrl: string, html: string): AbbDetails {
  const title = htmlTitle(html);
  const descStart = html.search(/<div class="desc"[^>]*>/);
  const desc = descStart >= 0 ? html.slice(descStart, html.indexOf('</div>', descStart)) : '';
  const text = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  const spans = (cls: string) => [...desc.matchAll(new RegExp(`<span class="${cls}"[^>]*>([\\s\\S]*?)<\\/span>`, 'g'))].map((m) => text(m[1]!)).filter(Boolean);
  const author = spans('author')[0] ?? null;
  const narrators = spans('narrator');
  const format = spans('format')[0] ?? null;
  const abridgedSpan = spans('is_abridged')[0];
  const abridged = abridgedSpan ? /^abridged/i.test(abridgedSpan) : null;
  const paras = [...desc.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => text(m[1]!)).filter(Boolean);
  const metaRe = /^(Written by|Read by|Format:|Bit ?Rate:|Length:|Narrators?:)/i;
  const meta = paras.filter((p) => metaRe.test(p)).join(' ');
  const bitrate = /Bit ?Rate:\s*([^\n]+?)(?=\s+(?:Length|Narrators?):|$)/i.exec(meta)?.[1]?.trim() ?? null;
  const length = /Length:\s*([^\n]+?)(?=\s+Narrators?:|$)/i.exec(meta)?.[1]?.trim() ?? null;
  const description = paras.filter((p) => !metaRe.test(p)).join('\n\n');
  return { url: pageUrl, title, author, narrators, format, bitrate, length, abridged, description };
}

function safeHttpUrl(raw: string): string | null {
  try {
    const u = new URL(decodeEntities(raw), ABB_BASE);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function htmlTitle(html: string): string {
  const t = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html) ?? /<title>([\s\S]*?)<\/title>/.exec(html);
  return t ? decodeEntities(t[1]!.replace(/<[^>]+>/g, '').trim()) : 'audiobook';
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}
