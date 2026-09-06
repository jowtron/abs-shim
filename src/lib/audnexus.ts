// Author images and biographies from Audnexus (https://api.audnex.us), the
// same free, keyless source real Audiobookshelf uses. Two calls per author:
// a name search that returns candidates, then the record for the chosen
// ASIN. The search is loose — "Philippa Gregory" also returns book titles
// containing "Gregory", and "Dennis E. Taylor" returns both "Dennis E Taylor"
// and "Dennis E. Taylor" — so the candidate must match the requested name
// exactly once case, punctuation and accents are ignored.
import type { Env } from '../types';

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

export async function getAuthorMeta(env: Env, authorId: string): Promise<AuthorMetaRow | null> {
  return env.DB.prepare('SELECT * FROM author_meta WHERE author_id = ?').bind(authorId).first<AuthorMetaRow>();
}

export async function getAuthorMetasForLibrary(env: Env, libraryId: string): Promise<Map<string, AuthorMetaRow>> {
  const r = await env.DB.prepare('SELECT * FROM author_meta WHERE library_id = ?').bind(libraryId).all<AuthorMetaRow>();
  return new Map(r.results.map((row) => [row.author_id, row]));
}

// True when a lookup is due: never checked, or a miss old enough to retry.
export function needsLookup(row: AuthorMetaRow | null | undefined): boolean {
  if (!row || !row.checked_at) return true;
  if (row.asin) return false;
  return Date.now() - row.checked_at > RETRY_MISS_MS;
}

function normName(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export type AudnexusAuthor = { asin: string; description: string | null; image: string | null };

export async function lookupAudnexus(name: string): Promise<AudnexusAuthor | null> {
  const headers = { Accept: 'application/json' };
  const q = await fetch(`https://api.audnex.us/authors?name=${encodeURIComponent(name)}&region=us`, { headers });
  if (q.status === 404) return null;
  if (!q.ok) throw new Error(`audnexus search ${q.status}`);
  const list = (await q.json()) as Array<{ asin?: string; name?: string }>;
  const want = normName(name);
  const hit = Array.isArray(list) ? list.find((a) => a.name && a.asin && normName(a.name) === want) : undefined;
  if (!hit?.asin) return null;
  const d = await fetch(`https://api.audnex.us/authors/${encodeURIComponent(hit.asin)}?region=us`, { headers });
  if (d.status === 404) return null;
  if (!d.ok) throw new Error(`audnexus author ${d.status}`);
  const j = (await d.json()) as { asin?: string; description?: string; image?: string };
  const description = typeof j.description === 'string' && j.description.trim() ? j.description.trim() : null;
  const image = typeof j.image === 'string' && /^https?:\/\//.test(j.image) ? j.image : null;
  return { asin: j.asin ?? hit.asin, description, image };
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
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO author_meta (author_id, tenant_id, library_id, name, asin, description, image_url, image_r2, checked_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT(author_id) DO UPDATE SET
       name = excluded.name,
       asin = COALESCE(excluded.asin, author_meta.asin),
       description = COALESCE(excluded.description, author_meta.description),
       image_url = COALESCE(excluded.image_url, author_meta.image_url),
       checked_at = excluded.checked_at,
       updated_at = excluded.updated_at`,
  ).bind(a.authorId, a.tenantId, a.libraryId, a.name, found?.asin ?? null, found?.description ?? null, found?.image ?? null, checkedAt, now).run();
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
