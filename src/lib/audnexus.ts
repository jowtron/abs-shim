// Author images and biographies from Audnexus (https://api.audnex.us), the
// same free, keyless source real Audiobookshelf uses. Two calls per author:
// a name search that returns candidates, then the record for the chosen
// ASIN. The search is loose — "Philippa Gregory" also returns book titles
// containing "Gregory", and "Dennis E. Taylor" returns both "Dennis E Taylor"
// and "Dennis E. Taylor" — so the candidate must match the requested name
// exactly once case, punctuation and accents are ignored.
import type { Env } from '../types';
import { personNameKey } from './names';

export type AuthorMetaRow = {
  author_id: string;
  tenant_id: string;
  library_id: string;
  name: string;
  asin: string | null;
  description: string | null;
  image_url: string | null;
  image_r2: string | null;
  checked_at: number | null;
  updated_at: number;
};

const RETRY_MISS_MS = 30 * 24 * 3600 * 1000;
const RETRY_ERROR_MS = 3600 * 1000;
// How many of the matching ASINs to open before choosing. Audnexus returns
// one entry per BOOK, so a prolific author comes back a dozen times over two
// or three ASINs; 4 detail fetches is enough to see all of them.
const MAX_CANDIDATES = 4;

export async function getAuthorMeta(env: Env, authorId: string): Promise<AuthorMetaRow | null> {
  return env.DB.prepare('SELECT * FROM author_meta WHERE author_id = ?').bind(authorId).first<AuthorMetaRow>();
}

export async function getAuthorMetasForLibrary(env: Env, libraryId: string): Promise<Map<string, AuthorMetaRow>> {
  const r = await env.DB.prepare('SELECT * FROM author_meta WHERE library_id = ?').bind(libraryId).all<AuthorMetaRow>();
  return new Map(r.results.map((row) => [row.author_id, row]));
}

// True when a lookup is due: never checked, or old enough to retry.
//
// A row holding an ASIN but no picture is NOT finished. Audnexus keeps
// several ASINs per author (roughly one per publisher imprint) and only
// some carry the photo and biography: Rick Riordan's B0C7WDNTN3 is empty
// while his B001HD0WE8 has both. Until 2026-09-21 any ASIN at all ended the
// search forever, so an author who landed on an empty record never got a
// picture. Retry those on the same 30-day clock as an outright miss, which
// also picks up authors Audnexus photographs later.
export function needsLookup(row: AuthorMetaRow | null | undefined): boolean {
  if (!row || !row.checked_at) return true;
  if (row.asin && row.image_url) return false;
  return Date.now() - row.checked_at > RETRY_MISS_MS;
}

export type AudnexusAuthor = { asin: string; description: string | null; image: string | null };

async function fetchAuthorRecord(asin: string): Promise<AudnexusAuthor | null> {
  const d = await fetch(`https://api.audnex.us/authors/${encodeURIComponent(asin)}?region=us`, {
    headers: { Accept: 'application/json' },
  });
  if (d.status === 404) return null;
  if (!d.ok) throw new Error(`audnexus author ${d.status}`);
  const j = (await d.json()) as { asin?: string; description?: string; image?: string };
  const description = typeof j.description === 'string' && j.description.trim() ? j.description.trim() : null;
  const image = typeof j.image === 'string' && /^https?:\/\//.test(j.image) ? j.image : null;
  return { asin: j.asin ?? asin, description, image };
}

// Search, then open every matching ASIN and keep the fullest record.
//
// The name still has to match exactly once case, punctuation, accents and
// post-nominals are ignored. That guard is load-bearing, not tidiness:
// Audnexus never answers "not found", it answers with a confident record
// for a different human (?name=Yakov%20Rabkin returns William Rabkin), so
// without it the shim would publish a sourced-looking photo and biography
// of the wrong person. Stripping credentials is what lets "Paul T. Mason"
// match their "M.S. Paul T. Mason"; it cannot make two different people
// match, because the remaining words still have to be identical.
export async function lookupAudnexus(name: string): Promise<AudnexusAuthor | null> {
  const headers = { Accept: 'application/json' };
  const q = await fetch(`https://api.audnex.us/authors?name=${encodeURIComponent(name)}&region=us`, { headers });
  if (q.status === 404) return null;
  if (!q.ok) throw new Error(`audnexus search ${q.status}`);
  const list = (await q.json()) as Array<{ asin?: string; name?: string }>;
  if (!Array.isArray(list)) return null;
  const want = personNameKey(name);

  // One entry per book, so dedupe the ASINs and keep search order.
  const asins: string[] = [];
  for (const a of list) {
    if (!a?.asin || !a.name) continue;
    if (personNameKey(a.name) !== want) continue;
    if (!asins.includes(a.asin)) asins.push(a.asin);
  }
  if (!asins.length) return null;

  let best: AudnexusAuthor | null = null;
  for (const asin of asins.slice(0, MAX_CANDIDATES)) {
    const rec = await fetchAuthorRecord(asin).catch(() => null);
    if (!rec) continue;
    // A picture wins; among records that agree on the picture, the one with
    // a biography wins; otherwise the earlier (more relevant) one.
    if (!best
      || (rec.image && !best.image)
      || (!!rec.image === !!best.image && rec.description && !best.description)) {
      best = rec;
    }
    if (best.image && best.description) break;   // nothing better to find
  }
  return best;
}

// Look the author up if due and record the result (or the miss). A network
// or 5xx failure is recorded so it is retried in an hour, not on every
// request and not in 30 days.
export async function ensureAuthorMeta(env: Env, a: { authorId: string; tenantId: string; libraryId: string; name: string }): Promise<AuthorMetaRow | null> {
  const existing = await getAuthorMeta(env, a.authorId);
  if (!needsLookup(existing)) return existing;
  let found: AudnexusAuthor | null = null;
  let checkedAt = Date.now();
  try {
    found = await lookupAudnexus(a.name);
  } catch (e) {
    console.warn(`[audnexus] ${a.name}: ${(e as Error).message}`);
    checkedAt = Date.now() - RETRY_MISS_MS + RETRY_ERROR_MS;
    if (!existing) return null;
  }
  // Merge rather than blindly overwrite: a retry that comes back empty must
  // not wipe a picture we already have. A retry that finds a BETTER record
  // (the point of retrying at all) does replace the stored one, so the ASIN
  // and biography move with the picture.
  const now = Date.now();
  const takeNew = !!found?.image && found.image !== existing?.image_url;
  const asin = takeNew ? found!.asin : (existing?.asin ?? found?.asin ?? null);
  const description = takeNew
    ? (found!.description ?? existing?.description ?? null)
    : (existing?.description ?? found?.description ?? null);
  const imageUrl = found?.image ?? existing?.image_url ?? null;

  // The photo bytes are cached in R2 under authors/<id> and at the edge. If
  // the URL changed, drop the R2 copy so the image route re-fetches. The
  // edge copy is immutable for 30 days and cannot be purged from here, but
  // it only exists once a real picture has been served, and an author who
  // had no photo has nothing cached — which is the case this retry is for.
  if (existing?.image_r2 && imageUrl !== existing.image_url) {
    await env.COVERS.delete(existing.image_r2).catch(() => undefined);
  }

  await env.DB.prepare(
    `INSERT INTO author_meta (author_id, tenant_id, library_id, name, asin, description, image_url, image_r2, checked_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT(author_id) DO UPDATE SET
       name = excluded.name,
       asin = excluded.asin,
       description = excluded.description,
       image_url = excluded.image_url,
       image_r2 = CASE WHEN excluded.image_url IS author_meta.image_url THEN author_meta.image_r2 ELSE NULL END,
       checked_at = excluded.checked_at,
       updated_at = excluded.updated_at`,
  ).bind(a.authorId, a.tenantId, a.libraryId, a.name, asin, description, imageUrl, checkedAt, now).run();
  return getAuthorMeta(env, a.authorId);
}

// The ABS author shape. imagePath is a server filesystem path in real ABS;
// clients never fetch it, they use /api/authors/:id/image and only test
// whether it is null, so any non-null string means "has a picture".
export function authorJson(a: { id: string; name: string; libraryId: string; numBooks: number; meta: AuthorMetaRow | null | undefined }) {
  const m = a.meta ?? null;
  return {
    id: a.id,
    asin: m?.asin ?? null,
    name: a.name,
    description: m?.description ?? null,
    imagePath: m?.image_url ? `/metadata/authors/${a.id}.jpg` : null,
    libraryId: a.libraryId,
    addedAt: m?.updated_at ?? 0,
    updatedAt: m?.updated_at ?? 0,
    numBooks: a.numBooks,
  };
}
