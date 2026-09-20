// Splitting "A, B, C" author/narrator strings into people, in ONE place.
//
// Author ids are derived hashes of (libraryId, 'author', name), not rows in a
// table, so every place that splits an author string has to split it the same
// way or the ids stop matching and an author link 404s. Before 2026-09-21
// there were five copies of the split: two in abs-shapes.ts, one in each of
// routes/authors.ts, routes/library.ts and lib/ids.ts, and the search route's
// copy also split on ';', '&' and ' and ', so a search result's author id
// could differ from the same author's id in the listing. Import this instead
// of writing another `.split(',')`.
//
// Delimiters are ',' and ';' only. '&' and ' and ' are deliberately NOT
// delimiters: they appear inside real names ("Simon & Garfunkel"-shaped
// credits) and no row in this database uses them as separators.

// Post-nominal letters that are not part of a person's name. Stripping them
// matters for more than tidiness: "Paul T. Mason, MS, Randi Kreger" split to
// three names, and the bogus third one ("MS") became an author in the
// listing with its own id, its own Audnexus miss and its own empty photo.
//
// NOT in this list, on purpose: Jr, Sr, II, III, IV. Those disambiguate real
// people and belong to the name.
const POST_NOMINALS = new Set([
  'ms', 'ma', 'md', 'phd', 'psyd', 'edd', 'jd', 'llb', 'llm', 'mba', 'msw',
  'lcsw', 'lmft', 'lpc', 'rn', 'bsn', 'dds', 'dvm', 'dpt', 'esq', 'cfa',
  'cpa', 'mph', 'mfa', 'bsc', 'msc', 'facs', 'faan', 'frcp', 'mrcp',
]);

// A token is a credential only when it LOOKS like one: it carries periods
// (M.S., Ph.D.) or it is written in capitals (MS, RN). A lower- or
// mixed-case token is left alone, which is what keeps the surname in
// "Yo-Yo Ma" from being read as a Master of Arts.
function isPostNominal(token: string): boolean {
  const key = token.toLowerCase().replace(/[^a-z]/g, '');
  if (!key || !POST_NOMINALS.has(key)) return false;
  return token.includes('.') || (token === token.toUpperCase() && /[A-Z]/.test(token));
}

// Drop credential tokens from both ends of one name. Audnexus lists the
// author of "Stop Walking on Eggshells" as "M.S. Paul T. Mason", with the
// credential LEADING, so trimming only the tail would still miss him.
// Interior tokens are never touched.
export function stripPostNominals(name: string): string {
  let tokens = name.split(/\s+/).filter(Boolean);
  while (tokens.length && isPostNominal(tokens[0]!)) tokens = tokens.slice(1);
  while (tokens.length && isPostNominal(tokens[tokens.length - 1]!)) tokens = tokens.slice(0, -1);
  // Trim stray commas and space only. NOT a trailing period: that would
  // rewrite "Martin Luther King Jr." to "…Jr", a different name and so a
  // different derived author id.
  return tokens.join(' ').replace(/^[,\s]+|[,\s]+$/g, '').trim();
}

// "Paul T. Mason, MS, Randi Kreger" → ["Paul T. Mason", "Randi Kreger"].
// A fragment that is nothing but credentials disappears entirely.
export function splitPersonNames(s: string | null | undefined): string[] {
  if (!s) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of s.split(/[,;]/)) {
    const name = stripPostNominals(part.trim());
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;   // "Lee Child, Lee Child" is one author
    seen.add(key);
    out.push(name);
  }
  return out;
}

// Comparison key for matching a name against a third-party record: case,
// accents and punctuation removed, credentials stripped. "M.S. Paul T.
// Mason" and "Paul T. Mason, MS" both reduce to "paul t mason".
export function personNameKey(s: string): string {
  return stripPostNominals(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
