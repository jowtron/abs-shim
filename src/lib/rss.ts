// Podcast RSS parsing without an XML library. A Worker has no DOMParser, and
// the Free plan's CPU budget is small, so this is an indexOf scanner over the
// feed text rather than a general XML parser: it finds <channel>, the <item>
// elements, and the handful of tags ABS reads from each, in one pass. Field
// names and fallbacks follow ABS's server/utils/podcastUtils.js so the
// `/api/podcasts/feed` answer matches what ABS clients expect.
//
// Feeds are not always newest-first (serial audio dramas are often oldest
// first), so `stopAfterKnown` only cuts a parse short when the first items are
// in descending date order.

export type FeedEnclosure = { url: string; type: string | null; length: string | null };

export type FeedEpisode = {
  title: string;
  subtitle: string;
  description: string;
  descriptionPlain: string;
  pubDate: string;
  episodeType: string;
  season: string;
  episode: string;
  author: string;
  duration: string;
  durationSeconds: number | null;
  explicit: string;
  publishedAt: number | null;
  enclosure: FeedEnclosure;
  guid: string | null;
  chaptersUrl: string | null;
  chaptersType: string | null;
  chapters: Array<{ id: number; title: string; start: number; end: number }>;
};

export type FeedMetadata = {
  image: string | null;
  categories: string[];
  feedUrl: string | null;
  description: string | null;
  descriptionPlain: string | null;
  type: string | null;
  title: string | null;
  language: string | null;
  explicit: string | null;
  author: string | null;
  pubDate: string | null;
  link: string | null;
};

export type ParsedFeed = {
  metadata: FeedMetadata;
  episodes: FeedEpisode[];
  // Items seen in the document, including any skipped by an early stop.
  itemsScanned: number;
  stoppedEarly: boolean;
};

export type ParseOpts = {
  // Stop once this many consecutive items carry a guid (or enclosure URL) in
  // this set — but only in a newest-first feed.
  known?: Set<string>;
  stopAfterKnown?: number;
  maxItems?: number;
};

// ─── Low-level scanning ──────────────────────────────────────────────────────

// Index of the next `<name` that is a whole tag name (followed by whitespace,
// `>` or `/`), so `<item` doesn't match `<itunes:image`.
function openTagAt(s: string, name: string, from: number, to = s.length): number {
  const needle = '<' + name;
  let i = s.indexOf(needle, from);
  while (i !== -1 && i < to) {
    const ch = s.charCodeAt(i + needle.length);
    // space, tab, CR, LF, '>', '/'
    if (ch === 32 || ch === 9 || ch === 13 || ch === 10 || ch === 62 || ch === 47) return i;
    i = s.indexOf(needle, i + 1);
  }
  return -1;
}

type Element = { attrs: string; inner: string | null; end: number };

// The first <name ...>…</name> (or <name ... />) in s[from, to).
function element(s: string, name: string, from = 0, to = s.length): Element | null {
  const start = openTagAt(s, name, from, to);
  if (start === -1) return null;
  const gt = s.indexOf('>', start);
  if (gt === -1 || gt >= to) return null;
  const selfClosing = s.charCodeAt(gt - 1) === 47;
  const attrs = s.slice(start + name.length + 1, selfClosing ? gt - 1 : gt);
  if (selfClosing) return { attrs, inner: null, end: gt + 1 };
  const close = s.indexOf('</' + name + '>', gt + 1);
  if (close === -1 || close >= to) return { attrs, inner: null, end: gt + 1 };
  return { attrs, inner: s.slice(gt + 1, close), end: close + name.length + 3 };
}

function allElements(s: string, name: string, from = 0, to = s.length): Element[] {
  const out: Element[] = [];
  let pos = from;
  for (;;) {
    const el = element(s, name, pos, to);
    if (!el) break;
    out.push(el);
    pos = el.end;
  }
  return out;
}

function attr(attrs: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\s)${name.replace(/:/g, '\\:')}\\s*=\\s*("([^"]*)"|'([^']*)')`);
  const m = re.exec(attrs);
  if (!m) return null;
  return decodeEntities(m[2] ?? m[3] ?? '');
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED[ent.toLowerCase()] ?? m;
  });
}

// Element text: CDATA sections verbatim, everything else entity-decoded.
function text(inner: string | null): string {
  if (inner == null) return '';
  if (inner.indexOf('<![CDATA[') === -1) return decodeEntities(inner).trim();
  let out = '';
  let pos = 0;
  for (;;) {
    const open = inner.indexOf('<![CDATA[', pos);
    if (open === -1) { out += decodeEntities(inner.slice(pos)); break; }
    out += decodeEntities(inner.slice(pos, open));
    const close = inner.indexOf(']]>', open + 9);
    if (close === -1) { out += inner.slice(open + 9); break; }
    out += inner.slice(open + 9, close);
    pos = close + 3;
  }
  return out.trim();
}

function field(s: string, name: string, from?: number, to?: number): string {
  return text(element(s, name, from, to)?.inner ?? null);
}

// ─── HTML cleaning ───────────────────────────────────────────────────────────

// Show notes are publisher-supplied HTML that clients render. Keep ABS's
// allowlist (p, lists, links, emphasis, br) and drop everything else: other
// tags lose their markup but keep their text, and scripts, styles and
// embedded objects go entirely. `href` is the only attribute that survives,
// and only for http(s) and mailto.
const ALLOWED = new Set(['p', 'ol', 'ul', 'li', 'a', 'strong', 'em', 'del', 'br', 'b', 'i']);

export function sanitizeHtml(html: string): string {
  if (!html) return '';
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed|noscript|template|svg|math|form|select|textarea)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|style|iframe|object|embed|noscript|template|svg|math|form|select|textarea|link|meta|img|input|base)\b[^>]*>/gi, '');
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (m, tag: string, rest: string) => {
    const t = tag.toLowerCase();
    if (!ALLOWED.has(t)) return '';
    if (m.startsWith('</')) return `</${t}>`;
    if (t === 'a') {
      const href = attr(rest, 'href');
      if (href && /^(https?:|mailto:)/i.test(href.trim())) {
        return `<a href="${href.trim().replace(/"/g, '&quot;')}" target="_blank" rel="noopener noreferrer">`;
      }
      return '<a>';
    }
    return t === 'br' ? '<br>' : `<${t}>`;
  });
  return s.trim();
}

export function stripAllTags(html: string): string {
  if (!html) return '';
  return decodeEntities(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  ).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

// "3600", "62:03", "1:02:03" (and "1:02:03.5") → seconds.
export function timestampToSeconds(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const parts = String(ts).trim().split(':').map((p) => Number(p));
  if (!parts.length || parts.some((p) => !Number.isFinite(p))) return null;
  let secs = 0;
  for (const p of parts) secs = secs * 60 + p;
  return secs >= 0 ? secs : null;
}

// ─── Feed ────────────────────────────────────────────────────────────────────

function parseCategories(s: string, from: number, to: number): string[] {
  // Top-level <itunes:category text="X"> with optional nested subcategory,
  // flattened "X:Y" like ABS. Nested elements are scanned by position.
  const out: string[] = [];
  let pos = from;
  for (;;) {
    const start = openTagAt(s, 'itunes:category', pos, to);
    if (start === -1) break;
    const gt = s.indexOf('>', start);
    if (gt === -1 || gt >= to) break;
    const name = attr(s.slice(start + 16, gt), 'text');
    const selfClosing = s.charCodeAt(gt - 1) === 47;
    if (selfClosing) {
      if (name) out.push(name);
      pos = gt + 1;
      continue;
    }
    const close = s.indexOf('</itunes:category>', gt);
    const innerEnd = close === -1 || close > to ? gt + 1 : close;
    const subs = parseCategories(s, gt + 1, innerEnd);
    if (name) {
      if (subs.length) out.push(...subs.map((sub) => `${name}:${sub}`));
      else out.push(name);
    }
    pos = close === -1 ? gt + 1 : close + 18;
  }
  return out;
}

function parseChannel(xml: string, from: number, to: number): FeedMetadata {
  let image: string | null = null;
  const imageEl = element(xml, 'image', from, to);
  if (imageEl?.inner) image = field(imageEl.inner, 'url') || null;
  if (!image) {
    const it = element(xml, 'itunes:image', from, to);
    if (it) image = attr(it.attrs, 'href');
  }
  let feedUrl: string | null = field(xml, 'itunes:new-feed-url', from, to) || null;
  if (!feedUrl) {
    for (const el of allElements(xml, 'atom:link', from, to)) {
      const rel = attr(el.attrs, 'rel');
      if (!rel || rel === 'self') { feedUrl = attr(el.attrs, 'href'); break; }
    }
  }
  const rawDescription = field(xml, 'description', from, to) || field(xml, 'itunes:summary', from, to);
  const str = (name: string) => field(xml, name, from, to) || null;
  return {
    image,
    categories: parseCategories(xml, from, to),
    feedUrl,
    description: rawDescription ? sanitizeHtml(rawDescription) : null,
    descriptionPlain: rawDescription ? stripAllTags(rawDescription) : null,
    type: str('itunes:type'),
    title: str('title'),
    language: str('language'),
    explicit: str('itunes:explicit'),
    author: str('itunes:author'),
    pubDate: str('pubDate'),
    link: str('link'),
  };
}

function parseItem(s: string): FeedEpisode | null {
  let enclosure: FeedEnclosure | null = null;
  const enc = element(s, 'enclosure');
  const encUrl = enc ? attr(enc.attrs, 'url') : null;
  if (enc && encUrl) {
    enclosure = { url: encUrl.trim(), type: attr(enc.attrs, 'type'), length: attr(enc.attrs, 'length') };
  } else {
    for (const mc of allElements(s, 'media:content')) {
      const url = attr(mc.attrs, 'url');
      const type = attr(mc.attrs, 'type') ?? '';
      if (url && type.startsWith('audio')) {
        enclosure = { url: url.trim(), type, length: attr(mc.attrs, 'fileSize') };
        break;
      }
    }
  }
  if (!enclosure) return null;

  const content = field(s, 'content:encoded');
  const rawDescription = field(s, 'description') || field(s, 'itunes:summary');
  const description = sanitizeHtml(content || rawDescription);
  const duration = field(s, 'itunes:duration');
  const durationSeconds = timestampToSeconds(duration);
  const pubDate = field(s, 'pubDate');
  const pub = pubDate ? new Date(pubDate) : null;

  let chaptersUrl: string | null = null;
  let chaptersType: string | null = null;
  const pc = element(s, 'podcast:chapters');
  if (pc) {
    chaptersUrl = attr(pc.attrs, 'url');
    chaptersType = attr(pc.attrs, 'type') || 'application/json';
  }

  let chapters: FeedEpisode['chapters'] = [];
  const psc = element(s, 'psc:chapters');
  if (psc?.inner && durationSeconds) {
    const raw = allElements(psc.inner, 'psc:chapter').map((el, i) => ({
      id: i,
      title: attr(el.attrs, 'title') ?? '',
      start: timestampToSeconds(attr(el.attrs, 'start')),
    }));
    if (raw.length && raw.every((c) => c.title && c.start != null)) {
      chapters = raw.map((c, i) => ({
        id: c.id, title: c.title, start: c.start!, end: raw[i + 1]?.start ?? durationSeconds,
      }));
    }
  }

  return {
    title: field(s, 'title'),
    subtitle: sanitizeHtml(field(s, 'itunes:subtitle')),
    description,
    descriptionPlain: stripAllTags(rawDescription || content),
    pubDate,
    episodeType: field(s, 'itunes:episodeType'),
    season: field(s, 'itunes:season'),
    episode: field(s, 'itunes:episode'),
    author: field(s, 'itunes:author'),
    duration,
    durationSeconds,
    explicit: field(s, 'itunes:explicit'),
    publishedAt: pub && !isNaN(pub.valueOf()) ? pub.valueOf() : null,
    enclosure,
    guid: field(s, 'guid') || null,
    chaptersUrl,
    chaptersType,
    chapters,
  };
}

export function episodeKey(e: { guid: string | null; enclosure: { url: string } }): string {
  return e.guid || e.enclosure.url;
}

export function parseFeed(xml: string, opts: ParseOpts = {}): ParsedFeed | null {
  const chStart = openTagAt(xml, 'channel', 0);
  if (chStart === -1 || openTagAt(xml, 'rss', 0) === -1) return null;
  const chEnd = xml.lastIndexOf('</channel>');
  const end = chEnd === -1 ? xml.length : chEnd;
  const firstItem = openTagAt(xml, 'item', chStart, end);
  // Channel fields are read only from before the first item, so an item's
  // <title> can't be mistaken for the show's (ABS's xml2js does the same by
  // structure). A feed that puts channel tags after its items is rare enough
  // to fall back to scanning past them.
  // Sliced out first: a tag the header lacks would otherwise be searched for
  // through the whole document (indexOf doesn't stop at `to`), once per tag —
  // 13 ms of a poll on a 20 MB feed.
  const header = xml.slice(chStart, firstItem === -1 ? end : firstItem);
  const metadata = parseChannel(header, 0, header.length);
  if (!metadata.title && firstItem !== -1) {
    const lastItemEnd = xml.lastIndexOf('</item>', end);
    if (lastItemEnd !== -1) {
      const tail = xml.slice(lastItemEnd, end);
      Object.assign(metadata, { title: field(tail, 'title') || null });
    }
  }

  const episodes: FeedEpisode[] = [];
  let itemsScanned = 0;
  let stoppedEarly = false;
  let knownRun = 0;
  let pos = firstItem;
  while (pos !== -1 && pos < end) {
    const close = xml.indexOf('</item>', pos);
    if (close === -1) break;
    itemsScanned++;
    const ep = parseItem(xml.slice(pos, close));
    if (ep) {
      episodes.push(ep);
      if (opts.known && opts.stopAfterKnown) {
        knownRun = opts.known.has(episodeKey(ep)) ? knownRun + 1 : 0;
        if (knownRun >= opts.stopAfterKnown && newestFirst(episodes)) { stoppedEarly = true; break; }
      }
    }
    if (opts.maxItems && episodes.length >= opts.maxItems) { stoppedEarly = true; break; }
    pos = openTagAt(xml, 'item', close + 7, end);
  }
  return { metadata, episodes, itemsScanned, stoppedEarly };
}

function newestFirst(eps: FeedEpisode[]): boolean {
  const dated = eps.filter((e) => e.publishedAt != null);
  if (dated.length < 2) return false;
  return dated[0]!.publishedAt! >= dated[dated.length - 1]!.publishedAt!;
}

// Decode a feed body honouring the charset in Content-Type or the XML prolog
// (ABS special-cases ISO-8859-1; TextDecoder handles the general case).
export function decodeFeedBytes(bytes: ArrayBuffer, contentType: string | null): string {
  let charset = /charset=([^;]+)/i.exec(contentType ?? '')?.[1]?.trim().replace(/["']/g, '');
  if (!charset) {
    const head = new TextDecoder('latin1').decode(bytes.slice(0, 200));
    charset = /encoding=["']([^"']+)["']/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// ─── OPML ────────────────────────────────────────────────────────────────────

export function parseOpml(text: string): Array<{ title: string; feedUrl: string }> {
  const out: Array<{ title: string; feedUrl: string }> = [];
  for (const el of allElements(text, 'outline')) {
    const url = attr(el.attrs, 'xmlUrl');
    if (!url) continue;
    out.push({ title: attr(el.attrs, 'title') ?? attr(el.attrs, 'text') ?? '', feedUrl: url });
  }
  return out;
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function buildOpml(title: string, feeds: Array<{ title: string; feedUrl: string; description?: string | null; pageUrl?: string | null; language?: string | null }>): string {
  const lines = feeds.map((f) => {
    const extra = [
      f.description ? ` description="${xmlEscape(stripAllTags(f.description).replace(/\s+/g, ' ').slice(0, 500))}"` : '',
      f.pageUrl ? ` htmlUrl="${xmlEscape(f.pageUrl)}"` : '',
      f.language ? ` language="${xmlEscape(f.language)}"` : '',
    ].join('');
    return `    <outline type="rss" text="${xmlEscape(f.title)}" title="${xmlEscape(f.title)}" xmlUrl="${xmlEscape(f.feedUrl)}"${extra}/>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="1.0">\n  <head>\n    <title>${xmlEscape(title)}</title>\n  </head>\n  <body>\n${lines.join('\n')}\n  </body>\n</opml>\n`;
}
