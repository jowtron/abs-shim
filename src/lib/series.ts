// Series name + sequence derivation for a book.
//
// Sources, in order of trust:
//   1. Explicit tags. ABS and mp3tag write `----:com.apple.iTunes:SERIES` /
//      `SERIES-PART`; Apple Books uses ©mvn/©mvi ("movement"); Audible rips
//      often land in tvsh/tves (show/episode); ©grp (grouping) is frequently
//      "Series, Book N".
//   2. The folder / title / album text. AudioBookBay releases almost always
//      encode it in the folder name ("Starship Raider Paragon Space, Book 2 -
//      Jarom Strong") while the m4b tags carry only the bare title. We strip
//      the known title and author, then look for "…, Book N".
// Returns null rather than guessing when there is no numeric sequence — a
// series badge with no number is worse than none. Sequence is kept as a
// string (D1 column is TEXT; ABS allows "1.5", "0", "2a").

export type SeriesHint = {
  tags?: Record<string, string> | undefined;
  title?: string | null | undefined;
  author?: string | null | undefined;
  album?: string | null | undefined;
  folderName?: string | null | undefined;
};

export type SeriesInfo = { name: string; sequence: string | null };

// Tolerates "Book 2", "Book, 3" (ABB typo seen in the wild), "#2", "Vol. 2",
// "2 of 3", and trailing junk left after stripping the author (" -").
const SEQ_RE = /^(.*?)[\s,:\-–—(]*(?:book|bk|part|pt|vol(?:ume)?|volume|#|no\.?|episode|ep)\.?[\s,.]*(\d+(?:\.\d+)?)[\s)]*(?:\s*(?:of|\/)\s*\d+)?[\s,:\-–—)]*$/i;

function clean(s: string): string {
  return s.replace(/^[\s,:\-–—(]+|[\s,:\-–—)]+$/g, '').trim();
}

function tag(tags: Record<string, string> | undefined, ...keys: string[]): string | undefined {
  if (!tags) return undefined;
  for (const k of keys) {
    const hit = Object.keys(tags).find((t) => t.toLowerCase() === k.toLowerCase());
    if (hit && tags[hit]?.trim()) return tags[hit]!.trim();
  }
  return undefined;
}

// "Paragon Space, Book 2" / "Paragon Space #2" / "Paragon Space 2 of 3" → parts.
export function splitSeriesText(text: string): SeriesInfo | null {
  const m = SEQ_RE.exec(clean(text));
  if (!m) return null;
  let name = clean(m[1]!);
  // "Heaven's River: Bobiverse, Book 4" — the series is what follows the
  // last colon, the title is before it.
  if (name.includes(':')) name = clean(name.slice(name.lastIndexOf(':') + 1));
  if (!name) return null;
  return { name, sequence: m[2]! };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Remove the title and author from a folder/title string so what's left is
// the series part. Case-insensitive; tolerates the title appearing with a
// trailing ":" or " -".
function stripKnown(text: string, ...known: Array<string | null | undefined>): string {
  let out = text;
  for (const k of known) {
    if (!k || k.length < 3) continue;
    out = out.replace(new RegExp(escapeRe(k), 'ig'), ' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function deriveSeries(h: SeriesHint): SeriesInfo | null {
  const tags = h.tags;
  // 1. Explicit series tags.
  const explicitName = tag(tags, '----:com.apple.iTunes:SERIES', '----:com.apple.iTunes:series', '©mvn', 'tvsh');
  if (explicitName) {
    const seq = tag(tags, '----:com.apple.iTunes:SERIES-PART', '----:com.apple.iTunes:series-part', '©mvi', 'tves', 'tvsn');
    // The name field itself may carry "Series, Book 2".
    const fromName = splitSeriesText(explicitName);
    if (seq && /^\d+(\.\d+)?$/.test(seq)) return { name: fromName?.name ?? explicitName, sequence: seq };
    if (fromName) return fromName;
    return { name: explicitName, sequence: seq ?? null };
  }
  const grp = tag(tags, '©grp');
  if (grp) {
    const s = splitSeriesText(grp);
    if (s) return s;
  }
  // 2. Text heuristics. Try the folder name first (ABB convention), then the
  //    title/album themselves ("Starship Raider: Paragon Space, Book 2").
  const candidates = [h.folderName, h.album, h.title].filter((x): x is string => !!x);
  for (const raw of candidates) {
    const isTitle = raw === h.title;
    // For the title itself only strip the author; stripping the title would
    // leave nothing.
    const stripped = clean(isTitle ? stripKnown(raw, h.author) : stripKnown(raw, h.title, h.author));
    const s = splitSeriesText(stripped);
    if (s && s.name.length >= 2 && !/^\d+$/.test(s.name)) return s;
  }
  return null;
}
