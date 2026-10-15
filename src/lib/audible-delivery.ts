// Audible imports delivered into each library's own storage (2026-10-15).
//
// The audible wharf node (wharf-project/audible, on stereo-au) downloads,
// decrypts and builds each m4b, stages it in R2 (bucket
// abs-shim-audible-staging, bound here as AUDIBLE_STAGING) and posts a notice
// to /api/audible-node/staged. The rest is Rhapsode's, with the library's own
// credentials, into the folder the sync chose:
//   - pCloud is asked to pull the staged file from a signed URL on this
//     Worker (downloadfileasync, as fetch-from-URL does), and the file is
//     stat-polled to its exact size (audibleDeliveryPump);
//   - S3 and WebDAV can't pull, so the Worker pushes it, 64 MiB at a time,
//     on the cron (audiblePushPump): an S3 multipart upload, or a WebDAV
//     temporary file grown by appends (one PUT where the server can't
//     append) and moved into place when whole.
// Then it is registered as a book and the staged copy is deleted. Until then
// the node uploaded with the instance owner's rclone pCloud token, so another
// library's books would have landed in his pCloud.

import type { Env } from '../types';
import { getTenantSetting } from '../db/settings';
import { loadPcloudFolder, joinPcloudPath } from '../storage/pcloud-folder';
import { pcloudStat, pcloudEnsureFolder, pcloudDownloadFileAsync, pcloudDeleteFile } from '../storage/pcloud';
import { getAdapter, type FolderRow } from '../storage/factory';
import { S3Adapter } from '../storage/s3';
import { WebDAVAdapter } from '../storage/webdav';
import { StorageWriteError, type StoredFile } from '../storage/adapter';
import { addBookByPath } from '../scanner/scan';
import { recordBookAsins } from './book-asins';

const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const randomHex = (n: number) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function audibleOrigin(env: Env): string {
  return (env.PUBLIC_ORIGIN ?? 'https://rhapsode.jderrick.app').replace(/\/+$/, '');
}

// ─── Who may use it ─────────────────────────────────────────────────────────

export const AUDIBLE_ALLOWED_KEY = 'audible_allowed';

async function tenantOwner(env: Env, tenantId: string): Promise<{ id: string; type: string } | null> {
  return env.DB.prepare(
    `SELECT u.id, u.type FROM tenants t JOIN users u ON u.id = t.owner_user_id WHERE t.id = ?`,
  ).bind(tenantId).first<{ id: string; type: string }>();
}

export async function isInstanceOwnerTenant(env: Env, tenantId: string): Promise<boolean> {
  const o = await tenantOwner(env, tenantId);
  return o?.type === 'root' || o?.type === 'admin';
}

// The instance owner's own library always; any other only once the instance
// owner has allowed it (/admin → All users). Each linked Audible account is a
// registered Amazon device whose sign-in then lives on Joseph's home server,
// so it is offered to people he chooses, not to every signup.
export async function audibleAllowed(env: Env, tenantId: string): Promise<boolean> {
  if (await isInstanceOwnerTenant(env, tenantId)) return true;
  return (await getTenantSetting(env, tenantId, AUDIBLE_ALLOWED_KEY)) === '1';
}

// ─── Accounts: a library's name ↔ the node's name ───────────────────────────

export type AudibleAccountRow = { node_name: string; tenant_id: string; user_id: string; name: string; created_at: number };

// What this code names new accounts on the node. Never adopted as legacy.
const GENERATED_NODE_NAME = /^t-[0-9a-f]{12}$/;
export const newNodeName = () => 't-' + randomHex(6);

export async function tenantAccounts(env: Env, tenantId: string): Promise<AudibleAccountRow[]> {
  return (await env.DB.prepare(
    `SELECT * FROM audible_accounts WHERE tenant_id = ? ORDER BY name`,
  ).bind(tenantId).all<AudibleAccountRow>()).results;
}

export async function accountByName(env: Env, tenantId: string, name: string): Promise<AudibleAccountRow | null> {
  return env.DB.prepare(
    `SELECT * FROM audible_accounts WHERE tenant_id = ? AND name = ?`,
  ).bind(tenantId, name).first<AudibleAccountRow>();
}

// Accounts on the node with no row were linked before migration 0031 by the
// instance owner without an owner entry (bestijow): they are his library's.
// Only his library adopts, and never a name this code generated.
export async function adoptLegacyAccounts(env: Env, tenantId: string, nodeNames: string[]): Promise<void> {
  const orphans = nodeNames.filter((n) => !GENERATED_NODE_NAME.test(n));
  if (!orphans.length || !(await isInstanceOwnerTenant(env, tenantId))) return;
  const owner = await tenantOwner(env, tenantId);
  if (!owner) return;
  const now = Date.now();
  await env.DB.batch(orphans.map((n) => env.DB.prepare(
    `INSERT OR IGNORE INTO audible_accounts (node_name, tenant_id, user_id, name, created_at)
       SELECT ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM audible_accounts WHERE tenant_id = ? AND name = ?)`,
  ).bind(n, tenantId, owner.id, n, now, tenantId, n)));
}

// ─── Syncs ──────────────────────────────────────────────────────────────────

export type AudibleSyncRow = {
  id: string; tenant_id: string; user_id: string; node_name: string; account: string;
  library_id: string; folder_id: string; job_id: string | null; token_hash: string; created_at: number;
};

// A sync's token is good for its job's 48 h limit plus a day for the last
// title's notice to arrive.
const SYNC_TOKEN_MS = 3 * 24 * 3600_000;

export async function createSync(env: Env, s: {
  tenantId: string; userId: string; nodeName: string; account: string; libraryId: string; folderId: string;
}): Promise<{ id: string; token: string }> {
  const id = 'as_' + randomHex(8);
  const token = randomHex(32);
  await env.DB.prepare(
    `INSERT INTO audible_syncs (id, tenant_id, user_id, node_name, account, library_id, folder_id, token_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, s.tenantId, s.userId, s.nodeName, s.account, s.libraryId, s.folderId, await sha256(token), Date.now()).run();
  return { id, token };
}

export async function setSyncJob(env: Env, syncId: string, jobId: string): Promise<void> {
  await env.DB.prepare(`UPDATE audible_syncs SET job_id = ? WHERE id = ?`).bind(jobId, syncId).run();
}

export async function dropSync(env: Env, syncId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM audible_syncs WHERE id = ?`).bind(syncId).run();
}

export async function authSync(env: Env, syncId: unknown, token: string | null): Promise<AudibleSyncRow | null> {
  if (typeof syncId !== 'string' || !/^as_[0-9a-f]{16}$/.test(syncId) || !token) return null;
  const row = await env.DB.prepare(`SELECT * FROM audible_syncs WHERE id = ?`).bind(syncId).first<AudibleSyncRow>();
  if (!row || Date.now() - row.created_at > SYNC_TOKEN_MS) return null;
  return sameString(await sha256(token), row.token_hash) ? row : null;
}

// Storage a sync can deliver into, in the order one is picked when the sync
// doesn't name a folder: pCloud first (what every sync before 2026-10-15
// used), then S3, then WebDAV, oldest folder first within each.
export async function deliveryFolder(env: Env, tenantId: string, libraryId: string, folderId?: string | null):
  Promise<{ id: string; provider: string } | null> {
  const rows = (await env.DB.prepare(
    `SELECT id, provider FROM library_folders
      WHERE library_id = ? AND tenant_id = ? AND provider IN ('pcloud_oauth', 's3', 'webdav')
      ORDER BY CASE provider WHEN 'pcloud_oauth' THEN 0 WHEN 's3' THEN 1 ELSE 2 END, added_at ASC`,
  ).bind(libraryId, tenantId).all<{ id: string; provider: string }>()).results;
  if (folderId) return rows.find((r) => r.id === folderId) ?? null;
  return rows[0] ?? null;
}

// ─── A staged title arrives ─────────────────────────────────────────────────

// One path segment as the node names it (L.safe_name): no separators, no
// dot-only names, nothing unprintable.
function safeSegment(s: unknown, max: number): string | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t || t.length > max || t === '.' || t === '..' || /[/\\\u0000-\u001f\u007f]/.test(t)) return null;
  return t;
}

export async function recordStaged(env: Env, sync: AudibleSyncRow, body: Record<string, unknown>):
  Promise<{ ok: true; id: string; relPath: string } | { ok: false; status: 400 | 409 | 503; error: string }> {
  if (!env.AUDIBLE_STAGING) return { ok: false, status: 503, error: 'AUDIBLE_STAGING is not bound' };
  const asin = String(body['asin'] ?? '');
  const folder = safeSegment(body['folder'], 200);
  const file = safeSegment(body['file'], 200);
  const key = String(body['key'] ?? '');
  const bytes = Number(body['bytes']);
  if (!/^[A-Z0-9]{10}$/.test(asin)) return { ok: false, status: 400, error: 'bad asin' };
  if (!folder || !file || !/\.m4b$/i.test(file)) return { ok: false, status: 400, error: 'bad folder or file name' };
  // A node can only hand over what it staged under its own account's prefix.
  if (!key.startsWith(sync.node_name + '/') || key.includes('..') || key.length > 600) return { ok: false, status: 400, error: 'bad staging key' };
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return { ok: false, status: 400, error: 'bad size' };
  const head = await env.AUDIBLE_STAGING.head(key);
  if (!head) return { ok: false, status: 400, error: 'nothing staged under that key' };
  if (head.size !== bytes) return { ok: false, status: 409, error: `staged object is ${head.size} bytes, notice says ${bytes}` };
  const title = typeof body['title'] === 'string' ? body['title'].slice(0, 300) : null;
  let relPath = `Audible/${sync.account}/${folder}/${file}`;
  // Two titles can share "Title - Author" (a subtitle isn't in it, and long
  // names are cut at 150 characters). The second gets its ASIN in the folder
  // name, so neither lands on, or is mistaken for, the other's file.
  if (await pathTakenByAnother(env, sync.folder_id, relPath, asin)) {
    relPath = `Audible/${sync.account}/${folder} [${asin}]/${file}`;
  }
  const now = Date.now();
  // A repeated notice (the node retrying after a lost answer) leaves a
  // delivery that is under way alone; only a failed one starts over.
  const row = await env.DB.prepare(
    `INSERT INTO audible_deliveries (id, sync_id, asin, title, staged_key, staged_etag, size_bytes, rel_path, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
     ON CONFLICT(sync_id, asin) DO UPDATE SET
       title = excluded.title, staged_key = excluded.staged_key, staged_etag = excluded.staged_etag,
       size_bytes = excluded.size_bytes, rel_path = excluded.rel_path, state = 'queued', error = NULL,
       attempts = 0, started_at = NULL, pull_requested_at = NULL, first_fetch_at = NULL,
       upload_id = NULL, upload_parts = NULL, lease_until = NULL, replaces_size = NULL,
       -- Kept only for the same path: a file at a NEW path that appeared after
       -- a write to the old one is not ours.
       first_write_at = CASE WHEN audible_deliveries.rel_path = excluded.rel_path THEN audible_deliveries.first_write_at END,
       updated_at = excluded.updated_at
     WHERE audible_deliveries.state = 'error'
     RETURNING id`,
  ).bind('ad_' + randomHex(8), sync.id, asin, title, key, head.etag, bytes, relPath, now, now).first<{ id: string }>();
  if (row) return { ok: true, id: row.id, relPath };
  const existing = await env.DB.prepare(
    `SELECT id, rel_path FROM audible_deliveries WHERE sync_id = ? AND asin = ?`,
  ).bind(sync.id, asin).first<{ id: string; rel_path: string }>();
  return { ok: true, id: existing?.id ?? '', relPath: existing?.rel_path ?? relPath };
}

// Another title's delivery (not a failed one) or another title's book
// already at this path in this folder.
async function pathTakenByAnother(env: Env, folderId: string, relPath: string, asin: string): Promise<boolean> {
  const dir = relPath.slice(0, relPath.lastIndexOf('/'));
  const hit = await env.DB.prepare(
    `SELECT 1 FROM audible_deliveries d JOIN audible_syncs s ON s.id = d.sync_id
      WHERE d.rel_path = ? AND s.folder_id = ? AND d.asin != ? AND d.state != 'error'
     UNION ALL
     SELECT 1 FROM library_items li JOIN book_metadata bm ON bm.library_item_id = li.id
      WHERE li.folder_id = ? AND li.rel_path IN (?, ?) AND bm.asin IS NOT NULL AND bm.asin != '' AND bm.asin != ?
     LIMIT 1`,
  ).bind(relPath, folderId, asin, folderId, dir, relPath, asin).first();
  return !!hit;
}

// ─── The signed URL pCloud pulls from ───────────────────────────────────────

// pCloud may take a while to get to a queued pull; a retry mints a fresh one.
const STAGED_URL_MS = 24 * 3600_000;

async function stagedSig(env: Env, id: string, attempt: number, exp: number): Promise<string> {
  const secret = env.JWT_SECRET ?? '';
  if (!secret) throw new Error('JWT_SECRET not configured');
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  // Prefixed, so it can never verify as a /public/proxy signature or vice versa.
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(`audible-staged\n${id}\n${attempt}\n${exp}`)));
}

// Bound to the attempt: a pull pCloud only gets round to after it was
// retried finds a dead link, instead of saving a second copy as "name (1)".
async function stagedUrl(env: Env, id: string, attempt: number): Promise<string> {
  const exp = Date.now() + STAGED_URL_MS;
  return `${audibleOrigin(env)}/public/audible-staged/${id}?a=${attempt}&exp=${exp}&sig=${await stagedSig(env, id, attempt, exp)}`;
}

// GET/HEAD /public/audible-staged/:id — the staged m4b, for pCloud's pull.
export async function serveStaged(env: Env, req: Request, id: string): Promise<Response> {
  const url = new URL(req.url);
  const exp = Number(url.searchParams.get('exp'));
  const attempt = Number(url.searchParams.get('a'));
  const sig = url.searchParams.get('sig') ?? '';
  if (!env.AUDIBLE_STAGING || !/^ad_[0-9a-f]{16}$/.test(id) || !Number.isFinite(exp) || exp < Date.now()
    || !Number.isSafeInteger(attempt) || !sameString(await stagedSig(env, id, attempt, exp), sig)) {
    return new Response('Not found', { status: 404 });
  }
  const row = await env.DB.prepare(
    `SELECT staged_key, staged_etag, size_bytes, first_fetch_at FROM audible_deliveries WHERE id = ? AND state = 'fetching' AND attempts = ?`,
  ).bind(id, attempt).first<{ staged_key: string; staged_etag: string | null; size_bytes: number; first_fetch_at: number | null }>();
  if (!row) return new Response('Not found', { status: 404 });
  const headers = new Headers({ 'Content-Type': 'audio/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('Range') ?? '');
  let range: { offset: number; length: number } | null = null;
  if (m && (m[1] || m[2])) {
    const size = row.size_bytes;
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    range = { offset: start, length: end - start + 1 };
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  headers.set('Content-Length', String(range ? range.length : row.size_bytes));
  // Gone, or re-staged by a newer sync of the title since this one was
  // handed over: a 404, and not counted as pCloud having come for it.
  let body: ReadableStream | null = null;
  if (req.method === 'HEAD') {
    const head = await env.AUDIBLE_STAGING.head(row.staged_key);
    if (!head || (row.staged_etag && head.etag !== row.staged_etag)) return new Response('Not found', { status: 404 });
  } else {
    const obj = await env.AUDIBLE_STAGING.get(row.staged_key, {
      ...(range ? { range } : {}), ...(row.staged_etag ? { onlyIf: { etagMatches: row.staged_etag } } : {}),
    });
    if (!obj || !('body' in obj)) return new Response('Not found', { status: 404 });
    body = obj.body;
  }
  // Proof that pCloud came for it (checkPull's 15-minute rule).
  if (!row.first_fetch_at) {
    await env.DB.prepare(`UPDATE audible_deliveries SET first_fetch_at = ? WHERE id = ? AND first_fetch_at IS NULL`).bind(Date.now(), id).run();
  }
  return new Response(body, { status: range ? 206 : 200, headers });
}

// ─── The pumps ──────────────────────────────────────────────────────────────

type DeliveryRow = {
  id: string; sync_id: string; asin: string; title: string | null; staged_key: string; staged_etag: string | null;
  size_bytes: number; rel_path: string; state: string; error: string | null; attempts: number; started_at: number | null;
  pull_requested_at: number | null; first_fetch_at: number | null; first_write_at: number | null;
  upload_id: string | null; upload_parts: string | null; lease_until: number | null; replaces_size: number | null;
  tenant_id: string; folder_id: string; library_id: string; provider: string;
};

// A pull of a 1 GB book takes minutes. One pCloud never fetches is retried
// after NO_FETCH_MS (it answers result 0 either way); one that started gets
// PULL_GIVE_UP_MS.
const PULL_GIVE_UP_MS = 3 * 3600_000;
const NO_FETCH_MS = 15 * 60_000;
// A claim cut off before anything was written (a notice's waitUntil has 30 s).
const STUCK_CLAIM_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
// pCloud pulls under way at once, across the instance (pushes have their
// own MAX_PUSHING, so slow S3/WebDAV books never hold up pCloud libraries).
const MAX_PULLING = 3;
const RETRY_WAIT_MS = 10 * 60_000;
// Storage clocks are to the second, and aren't ours.
const CLOCK_SLACK_MS = 60_000;

// Deliveries under way into the given kinds of storage.
const ACTIVE_COUNT = (...providers: string[]) => `SELECT COUNT(*) FROM audible_deliveries da
  JOIN audible_syncs sa ON sa.id = da.sync_id JOIN library_folders fa ON fa.id = sa.folder_id
  WHERE da.state = 'fetching' AND fa.provider IN (${providers.map((p) => `'${p}'`).join(', ')})`;

const SELECT_DELIVERY = `SELECT d.*, s.tenant_id, s.folder_id, s.library_id, f.provider
  FROM audible_deliveries d JOIN audible_syncs s ON s.id = d.sync_id JOIN library_folders f ON f.id = s.folder_id`;

// pCloud folders. checkPulls false (a notice's waitUntil): only start new
// pulls. Checking running ones means pCloud stats, which can take minutes
// while a file is being written, and the 30 s cap would cut a claim off
// half-way.
export async function audibleDeliveryPump(env: Env, opts: { checkPulls?: boolean } = {}): Promise<string[]> {
  if (!env.AUDIBLE_STAGING) return [];
  const log: string[] = [];
  const now = Date.now();
  // Claimed but nothing written yet: back to the queue, attempt refunded.
  // Not a push some run still holds (its first look can take a while).
  await env.DB.prepare(
    `UPDATE audible_deliveries SET state = 'queued', attempts = MAX(attempts - 1, 0), started_at = NULL, lease_until = NULL, updated_at = ?
      WHERE state = 'fetching' AND pull_requested_at IS NULL AND started_at < ? AND (lease_until IS NULL OR lease_until < ?)`,
  ).bind(now, now - STUCK_CLAIM_MS, now).run();
  // A sync whose folder was detached since: nothing to copy into.
  await env.DB.prepare(
    `UPDATE audible_deliveries SET state = 'error', error = 'The storage this sync was copying into was removed from the library; sync the title again.', updated_at = ?
      WHERE state IN ('queued', 'fetching')
        AND sync_id IN (SELECT s.id FROM audible_syncs s WHERE NOT EXISTS (SELECT 1 FROM library_folders f WHERE f.id = s.folder_id))`,
  ).bind(now).run();
  if (opts.checkPulls !== false) {
    const pulling = (await env.DB.prepare(
      `${SELECT_DELIVERY} WHERE d.state = 'fetching' AND d.pull_requested_at IS NOT NULL AND f.provider = 'pcloud_oauth' ORDER BY d.updated_at LIMIT 10`,
    ).all<DeliveryRow>()).results;
    for (const d of pulling) {
      try {
        await checkPull(env, d, log);
      } catch (e) {
        log.push(`${d.asin}: stat failed: ${(e as Error).message}`);
        if (Date.now() - (d.pull_requested_at ?? 0) > PULL_GIVE_UP_MS) {
          await retryOrFail(env, d, `pCloud couldn't be asked about the copy: ${(e as Error).message}`);
        }
      }
    }
  }
  const busy = (await env.DB.prepare(`SELECT (${ACTIVE_COUNT('pcloud_oauth')}) AS n`).first<{ n: number }>())?.n ?? 0;
  if (busy >= MAX_PULLING) return log;
  // A retry waits RETRY_WAIT_MS per attempt so far, so a pCloud hiccup
  // doesn't use up all the attempts in three cron ticks.
  const queued = (await env.DB.prepare(
    `${SELECT_DELIVERY} WHERE d.state = 'queued' AND f.provider = 'pcloud_oauth' AND d.updated_at <= ? - d.attempts * ?
      ORDER BY d.updated_at LIMIT ?`,
  ).bind(Date.now(), RETRY_WAIT_MS, MAX_PULLING - busy).all<DeliveryRow>()).results;
  for (const d of queued) {
    const t = Date.now();
    // The cron and a notice's waitUntil can both get here: one claim wins.
    const claimed = await env.DB.prepare(
      `UPDATE audible_deliveries SET state = 'fetching', started_at = ?, attempts = attempts + 1,
              pull_requested_at = NULL, first_fetch_at = NULL, updated_at = ?
        WHERE id = ? AND state = 'queued'`,
    ).bind(t, t, d.id).run();
    if (!claimed.meta.changes) continue;
    d.attempts += 1;
    d.started_at = t;
    try {
      await startPull(env, d, log);
    } catch (e) {
      log.push(`${d.asin}: ${(e as Error).message}`);
      await retryOrFail(env, d, (e as Error).message);
    }
  }
  return log;
}

async function loadTarget(env: Env, d: DeliveryRow) {
  const loaded = await loadPcloudFolder(env, d.folder_id, d.tenant_id);
  if (!loaded.ok) throw new Error(`the library's pCloud folder: ${loaded.error}`);
  const abs = joinPcloudPath(loaded.rootPath, d.rel_path);
  return { ...loaded, abs };
}

// A file that appeared at this path after we first set out to write this
// title there (first_write_at, any delivery of the same title into the same
// path): one of ours, unfinished or from an earlier sync, safe to replace.
// Anything older, or with no write of ours behind it, is someone's file.
async function ourEarlierWrite(env: Env, d: DeliveryRow, at: number | null): Promise<boolean> {
  if (at == null || !Number.isFinite(at)) return false;
  const first = await env.DB.prepare(
    `SELECT MIN(COALESCE(d.first_write_at, d.pull_requested_at)) AS t FROM audible_deliveries d JOIN audible_syncs s ON s.id = d.sync_id
      WHERE d.rel_path = ? AND s.folder_id = ? AND d.asin = ? AND (d.first_write_at IS NOT NULL OR d.pull_requested_at IS NOT NULL)`,
  ).bind(d.rel_path, d.folder_id, d.asin).first<{ t: number | null }>();
  return first?.t != null && at >= first.t - CLOCK_SLACK_MS;
}

const differentFile = (where: string) =>
  `A different file is already at ${where}; delete or rename it, then sync the title again.`;

async function startPull(env: Env, d: DeliveryRow, log: string[]): Promise<void> {
  const t = await loadTarget(env, d);
  const existing = await pcloudStat(t.profile, t.abs);
  if (existing && !existing.isfolder && existing.size === d.size_bytes) {
    await land(env, d, log);
    return;
  }
  if (!(await stagedIsCurrent(env, d))) {
    await fail(env, d, STAGED_GONE);
    return;
  }
  if (existing) {
    // pCloud would save beside it as "name (1)" and the book would point at
    // the old file.
    const refusal = await replaceRefusal(env, d, {
      size: existing.size ?? 0, modifiedAt: existing.created ? Date.parse(existing.created) : null, isDir: !!existing.isfolder,
    });
    if (refusal) {
      await fail(env, d, refusal.replace(d.rel_path, t.abs));
      return;
    }
    await pcloudDeleteFile(t.profile, t.abs);
  }
  const slash = t.abs.lastIndexOf('/');
  const folderId = await pcloudEnsureFolder(t.profile, t.abs.slice(0, slash) || '/');
  // Stamped before asking: once asked, pCloud may create the file at once.
  const at = Date.now();
  await env.DB.prepare(
    `UPDATE audible_deliveries SET first_write_at = COALESCE(first_write_at, ?) WHERE id = ?`,
  ).bind(at, d.id).run();
  await pcloudDownloadFileAsync(t.profile, { url: await stagedUrl(env, d.id, d.attempts), folderId, name: t.abs.slice(slash + 1) });
  await env.DB.prepare(
    `UPDATE audible_deliveries SET pull_requested_at = ?, updated_at = ? WHERE id = ? AND state = 'fetching'`,
  ).bind(Date.now(), Date.now(), d.id).run();
  log.push(`${d.asin}: pCloud pulling ${(d.size_bytes / 1048576).toFixed(0)} MB → ${d.rel_path}`);
}

async function checkPull(env: Env, d: DeliveryRow, log: string[]): Promise<void> {
  const t = await loadTarget(env, d);
  const st = await pcloudStat(t.profile, t.abs);
  if (st && !st.isfolder && st.size === d.size_bytes) {
    await land(env, d, log);
    return;
  }
  const since = Date.now() - (d.pull_requested_at ?? 0);
  if (!d.first_fetch_at && since > NO_FETCH_MS) {
    await retryOrFail(env, d, "pCloud accepted the copy but never fetched the file");
  } else if (since > PULL_GIVE_UP_MS) {
    await retryOrFail(env, d, `pCloud hadn't finished pulling it after 3 hours (${st?.size ?? 0} of ${d.size_bytes} bytes)`);
  }
}

// ─── Pushing into S3 and WebDAV ─────────────────────────────────────────────

// One piece: an S3 part or a WebDAV append. Under Cloudflare's 100 MB limit
// on one upload to a proxied host, and S3's part rules (5 MiB to 5 GiB,
// at most 10,000 parts; R2 wants every part but the last the same size, so
// don't change this while an S3 upload is under way: it would resume with
// parts of another size).
const PIECE_BYTES = 64 * 1048576;
// A piece at a slow 0.5 MB/s takes about two minutes.
const PIECE_TIMEOUT_MS = 5 * 60_000;
// The cron's invocation lives 15 minutes. Pieces are started for 8 of them.
const PUSH_BUDGET_MS = 8 * 60_000;
// Held across the whole invocation and then some, so a tick two minutes
// later never pushes the same row.
const PUSH_LEASE_MS = 16 * 60_000;
// A WebDAV server that can't append gets the whole book in one PUT, started
// only in an invocation's first minute and given 13 of its 15.
const SINGLE_PUT_START_MS = 60_000;
const SINGLE_PUT_TIMEOUT_MS = 13 * 60_000;
const PUSH_GIVE_UP_MS = 6 * 3600_000;
const MAX_PUSHING = 3;

type PushTarget = { kind: 's3'; a: S3Adapter } | { kind: 'webdav'; a: WebDAVAdapter };

async function pushTarget(env: Env, d: DeliveryRow): Promise<PushTarget> {
  const folder = await env.DB.prepare(
    `SELECT * FROM library_folders WHERE id = ? AND tenant_id = ?`,
  ).bind(d.folder_id, d.tenant_id).first<FolderRow>();
  if (!folder) throw new Error("the library's storage folder is gone");
  const a = await getAdapter(env, folder);
  if (a instanceof S3Adapter) return { kind: 's3', a };
  if (a instanceof WebDAVAdapter) return { kind: 'webdav', a };
  throw new Error(`can't copy into ${folder.provider} storage`);
}

// A WebDAV upload: appended pieces ('a') or one PUT ('s'), and the tag that
// names its temporary file. Fixed for the life of the upload, so a passing
// failure can't switch a half-sent book to the other way.
type DavUpload = { mode: 'a' | 's'; tag: string };
const parseDav = (id: string | null): DavUpload | null => {
  const m = /^([as]):([0-9a-f]{8})$/.exec(id ?? '');
  return m ? { mode: m[1] as 'a' | 's', tag: m[2]! } : null;
};
// Beside the book, with a short name of its own (the book's file name can
// already be near the 255-byte limit), hidden, and not an audio extension, so
// a scan never registers it.
const davTemp = (d: DeliveryRow, tag: string) => `${d.rel_path.slice(0, d.rel_path.lastIndexOf('/'))}/.rhapsode-${tag}.part`;

// S3 says NoSuchUpload. Some S3-compatible servers just answer 404, which
// could also mean something else answering 404 to everything, so that one
// costs an attempt.
const noSuchUpload = (e: unknown) => e instanceof StorageWriteError && e.code === 'NoSuchUpload';
const bare404 = (e: unknown) => e instanceof StorageWriteError && e.status === 404 && e.code !== 'NoSuchUpload';

// S3 and WebDAV folders, from the cron only (a request's waitUntil has 30 s;
// a piece can take minutes). Works one row at a time for up to 8 minutes,
// each row once per run: an upload already under way first, then a new one,
// at most one per folder at a time (a home NAS shouldn't take three books at
// once) and MAX_PUSHING across the instance. A book bigger than a tick's
// worth carries on at the next tick from what was sent.
export async function audiblePushPump(env: Env): Promise<string[]> {
  if (!env.AUDIBLE_STAGING) return [];
  const log: string[] = [];
  const t0 = Date.now();
  const deadline = t0 + PUSH_BUDGET_MS;
  const tried = new Set<string>();
  while (Date.now() < deadline) {
    const d = await nextPush(env, tried);
    if (!d) break;
    tried.add(d.id);
    try {
      await pushOne(env, d, { t0, deadline }, log);
    } catch (e) {
      log.push(`${d.asin}: ${(e as Error).message}`);
      await pushFailed(env, d, e).catch(() => undefined);
    } finally {
      await env.DB.prepare(`UPDATE audible_deliveries SET lease_until = NULL WHERE id = ? AND lease_until = ?`)
        .bind(d.id, d.lease_until).run().catch(() => undefined);
    }
  }
  return log;
}

async function nextPush(env: Env, tried: Set<string>): Promise<DeliveryRow | null> {
  const now = Date.now();
  const lease = now + PUSH_LEASE_MS;
  const going = (await env.DB.prepare(
    `${SELECT_DELIVERY} WHERE d.state = 'fetching' AND f.provider IN ('s3', 'webdav')
       AND (d.lease_until IS NULL OR d.lease_until < ?) ORDER BY d.updated_at LIMIT 10`,
  ).bind(now).all<DeliveryRow>()).results.filter((d) => !tried.has(d.id));
  for (const d of going) {
    const r = await env.DB.prepare(
      `UPDATE audible_deliveries SET lease_until = ? WHERE id = ? AND state = 'fetching' AND (lease_until IS NULL OR lease_until < ?)`,
    ).bind(lease, d.id, now).run();
    if (r.meta.changes) return { ...d, lease_until: lease };
  }
  const fresh = (await env.DB.prepare(
    `${SELECT_DELIVERY} WHERE d.state = 'queued' AND f.provider IN ('s3', 'webdav') AND d.updated_at <= ? - d.attempts * ?
     ORDER BY d.updated_at LIMIT 10`,
  ).bind(now, RETRY_WAIT_MS).all<DeliveryRow>()).results.filter((d) => !tried.has(d.id));
  for (const d of fresh) {
    // One statement, so two overlapping runs can't both pass the folder and
    // instance limits.
    const r = await env.DB.prepare(
      `UPDATE audible_deliveries SET state = 'fetching', started_at = ?, attempts = attempts + 1,
              pull_requested_at = NULL, first_fetch_at = NULL, replaces_size = NULL, lease_until = ?, updated_at = ?
        WHERE id = ? AND state = 'queued'
          AND NOT EXISTS (SELECT 1 FROM audible_deliveries d2 JOIN audible_syncs s2 ON s2.id = d2.sync_id
                           WHERE d2.state = 'fetching' AND s2.folder_id = ?)
          AND (${ACTIVE_COUNT('s3', 'webdav')}) < ?`,
    ).bind(now, lease, now, d.id, d.folder_id, MAX_PUSHING).run();
    if (r.meta.changes) {
      return { ...d, state: 'fetching', started_at: now, attempts: d.attempts + 1, pull_requested_at: null, replaces_size: null, lease_until: lease };
    }
  }
  return null;
}

// A write to this row, only while this run still holds it.
async function own(env: Env, d: DeliveryRow, set: string, ...values: unknown[]): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE audible_deliveries SET ${set}, updated_at = ? WHERE id = ? AND state = 'fetching' AND lease_until = ?`,
  ).bind(...values, Date.now(), d.id, d.lease_until).run();
  return !!r.meta.changes;
}

// A piece went up: the attempt is doing its job, so a passing failure later
// doesn't count against it (a 2 GB book over a home link can meet several).
async function progressed(env: Env, d: DeliveryRow, set: string, ...values: unknown[]): Promise<boolean> {
  d.attempts = 1;
  return own(env, d, `${set}, attempts = 1`, ...values);
}

async function pushOne(env: Env, d: DeliveryRow, time: { t0: number; deadline: number }, log: string[]): Promise<void> {
  const target = await pushTarget(env, d);
  if (d.started_at && Date.now() - d.started_at > PUSH_GIVE_UP_MS) {
    await retryOrFail(env, d, "The copy hadn't finished after 6 hours");
    return;
  }
  if (d.pull_requested_at) {
    // Resumed. Finished already, by a run that died in land()?
    const fin = await target.a.stat(d.rel_path);
    if (fin && !fin.isDir && fin.size === d.size_bytes) {
      await cleanupPush(env, d);
      await land(env, d, log);
      return;
    }
  }
  let dav: DavUpload | null = null;
  if (target.kind === 'webdav') {
    dav = parseDav(d.upload_id);
    if (dav?.mode === 's' && d.pull_requested_at) {
      // A one-PUT upload outlived the run that started it.
      await retryOrFail(env, d, 'The upload was cut off. This WebDAV server takes a book in one upload, which gets 13 minutes.');
      return;
    }
    if (dav?.mode === 's' && !d.pull_requested_at) {
      // A new attempt at one PUT gets a new temporary file: dufs refuses a
      // PUT over a non-empty file to an account without delete rights.
      await target.a.remove(davTemp(d, dav.tag)).catch(() => undefined);
      dav = { mode: 's', tag: randomHex(4) };
    }
    if (!dav) {
      const mode = d.size_bytes <= PIECE_BYTES || !(await target.a.supportsAppend()) ? 's' : 'a';
      dav = { mode, tag: randomHex(4) };
    }
    if (dav.mode === 's' && Date.now() - time.t0 > SINGLE_PUT_START_MS) return;   // a later run, from its start
  }
  if (!d.pull_requested_at) {
    // This attempt's first look at the destination.
    const existing = await target.a.stat(d.rel_path);
    if (existing && !existing.isDir && existing.size === d.size_bytes) {
      await cleanupPush(env, d);
      await land(env, d, log);
      return;
    }
    if (!(await stagedIsCurrent(env, d))) {
      await fail(env, d, STAGED_GONE);
      return;
    }
    const refusal = existing ? await replaceRefusal(env, d, existing) : null;
    if (refusal) {
      await fail(env, d, refusal);
      return;
    }
    const at = Date.now();
    const uploadId = dav ? `${dav.mode}:${dav.tag}` : d.upload_id;
    if (!(await own(env, d, 'pull_requested_at = ?, first_write_at = COALESCE(first_write_at, ?), replaces_size = ?, upload_id = ?',
      at, at, existing ? existing.size : null, uploadId))) return;
    d.pull_requested_at = at;
    d.replaces_size = existing ? existing.size : null;
    d.upload_id = uploadId;
  } else if (dav && !d.upload_id) {
    // Resumed after its temporary file was thrown away: a fresh one.
    const uploadId = `${dav.mode}:${dav.tag}`;
    if (!(await own(env, d, 'upload_id = ?', uploadId))) return;
    d.upload_id = uploadId;
  }
  if (target.kind === 's3') await pushS3(env, d, target.a, time.deadline, log);
  else await pushDav(env, d, target.a, dav!, time.deadline, log);
}

// Why a file found at the path may not be replaced, or null if it may: it
// must be one of ours (it appeared after we first set out to write this
// title there) and not a book the library already has (replacing a
// registered file under it would leave its length, chapters and cached
// bytes describing the old one).
async function replaceRefusal(env: Env, d: DeliveryRow, existing: StoredFile): Promise<string | null> {
  if (existing.isDir || !(await ourEarlierWrite(env, d, existing.modifiedAt))) return differentFile(d.rel_path);
  if (await registeredAt(env, d)) {
    return `A different copy of this title is already a book in the library at ${d.rel_path}; remove that book (and its file) first to replace it.`;
  }
  return null;
}

async function registeredAt(env: Env, d: DeliveryRow): Promise<boolean> {
  const dir = d.rel_path.slice(0, d.rel_path.lastIndexOf('/'));
  return !!(await env.DB.prepare(
    `SELECT 1 FROM library_items WHERE folder_id = ? AND rel_path IN (?, ?) LIMIT 1`,
  ).bind(d.folder_id, dir, d.rel_path).first());
}

// Just before completing or moving into place: what is at the path now?
// Nothing, or the file this attempt decided to replace: write. A complete
// copy of this size: it's there already. Anything else appeared since the
// first look and is someone else's.
async function finalCheck(d: DeliveryRow, existing: StoredFile | null): Promise<'write' | 'landed' | 'refuse'> {
  if (!existing) return 'write';
  if (existing.isDir) return 'refuse';
  if (existing.size === d.size_bytes) return 'landed';
  return d.replaces_size != null && existing.size === d.replaces_size ? 'write' : 'refuse';
}

// R2 read of [offset, offset+length) of the staged copy, only while it is
// the object that was handed over.
async function readStaged(env: Env, d: DeliveryRow, offset: number, length: number): Promise<ReadableStream | null> {
  const obj = await env.AUDIBLE_STAGING!.get(d.staged_key, {
    range: { offset, length }, ...(d.staged_etag ? { onlyIf: { etagMatches: d.staged_etag } } : {}),
  });
  return obj && 'body' in obj ? obj.body : null;
}

async function stagedIsCurrent(env: Env, d: DeliveryRow): Promise<boolean> {
  const head = await env.AUDIBLE_STAGING!.head(d.staged_key);
  return !!head && head.size === d.size_bytes && (!d.staged_etag || head.etag === d.staged_etag);
}

const STAGED_GONE = 'The staged copy is gone (staging keeps files 7 days, and a newer sync of the title replaces it); sync the title again.';
const STAGED_WENT = 'The staged copy went away during the upload; sync the title again.';
const mb = (n: number) => (n / 1048576).toFixed(0);

async function pushS3(env: Env, d: DeliveryRow, a: S3Adapter, deadline: number, log: string[]): Promise<void> {
  const total = Math.max(1, Math.ceil(d.size_bytes / PIECE_BYTES));
  let uploadId = d.upload_id;
  let etags: string[] = uploadId ? JSON.parse(d.upload_parts ?? '[]') as string[] : [];
  if (!uploadId) {
    uploadId = await a.createMultipart(d.rel_path, 'audio/mp4');
    etags = [];
    if (!(await own(env, d, 'upload_id = ?, upload_parts = ?', uploadId, '[]'))) {
      await a.abortMultipart(d.rel_path, uploadId).catch(() => undefined);
      return;
    }
    d.upload_id = uploadId;
  }
  for (let n = etags.length; n < total; n++) {
    if (Date.now() > deadline) {
      log.push(`${d.asin}: S3 ${n}/${total} parts sent, carrying on next tick`);
      return;
    }
    const offset = n * PIECE_BYTES;
    const length = Math.min(PIECE_BYTES, d.size_bytes - offset);
    const body = await readStaged(env, d, offset, length);
    if (!body) {
      await fail(env, d, STAGED_WENT);
      return;
    }
    try {
      etags.push(await a.uploadPart(d.rel_path, uploadId, n + 1, body, length, PIECE_TIMEOUT_MS));
    } catch (e) {
      // Aborted by a bucket lifecycle rule, say: start it over (no attempt
      // spent). A bare 404 starts over too, but at the cost of an attempt.
      if (noSuchUpload(e) || bare404(e)) {
        await a.abortMultipart(d.rel_path, uploadId).catch(() => undefined);
        await own(env, d, 'upload_id = NULL, upload_parts = NULL');
        d.upload_id = null;
        log.push(`${d.asin}: S3 forgot the upload; starting it again`);
        if (bare404(e)) await retryOrFail(env, d, (e as Error).message);
        return;
      }
      throw e;
    }
    if (!(await progressed(env, d, 'upload_parts = ?', JSON.stringify(etags)))) return;
  }
  // Completing replaces whatever is at the key, so look first.
  const check = await finalCheck(d, await a.stat(d.rel_path));
  if (check === 'refuse') {
    await fail(env, d, differentFile(d.rel_path));
    return;
  }
  if (check === 'landed') {
    await a.abortMultipart(d.rel_path, uploadId).catch(() => undefined);
  } else {
    try {
      await a.completeMultipart(d.rel_path, uploadId, etags);
    } catch (e) {
      // Completed by a run that died before it could say so? The stat below
      // tells; if not, the next attempt starts a new upload.
      if (!noSuchUpload(e) && !bare404(e)) throw e;
    }
  }
  await own(env, d, 'upload_id = NULL, upload_parts = NULL');
  d.upload_id = null;
  const st = await a.stat(d.rel_path);
  if (st && st.size === d.size_bytes) await land(env, d, log);
  else await retryOrFail(env, d, `S3 holds ${st?.size ?? 'no'} bytes at ${d.rel_path} after the upload, not ${d.size_bytes}`);
}

async function pushDav(env: Env, d: DeliveryRow, a: WebDAVAdapter, dav: DavUpload, deadline: number, log: string[]): Promise<void> {
  const temp = davTemp(d, dav.tag);
  const dir = d.rel_path.slice(0, d.rel_path.lastIndexOf('/'));
  // A temporary file that isn't what we sent is thrown away and the next
  // attempt starts a fresh one; never appended to, never moved into place.
  const discard = async (why: string) => {
    await a.remove(temp).catch(() => undefined);
    await own(env, d, 'upload_id = NULL');
    d.upload_id = null;
    throw new Error(why);
  };
  if (dav.mode === 's') {
    await a.ensureDir(dir);
    const body = await readStaged(env, d, 0, d.size_bytes);
    if (!body) {
      await fail(env, d, STAGED_WENT);
      return;
    }
    log.push(`${d.asin}: WebDAV uploading ${mb(d.size_bytes)} MB in one go`);
    await a.put(temp, body, d.size_bytes, SINGLE_PUT_TIMEOUT_MS);
  } else {
    const st = await a.stat(temp);
    if (!st) await a.ensureDir(dir);
    let have = st?.size ?? 0;
    if (have > d.size_bytes) await discard(`the temporary file holds ${have} bytes, more than the book's ${d.size_bytes}`);
    while (have < d.size_bytes) {
      if (Date.now() > deadline) {
        log.push(`${d.asin}: WebDAV ${mb(have)} of ${mb(d.size_bytes)} MB sent, carrying on next tick`);
        return;
      }
      const length = Math.min(PIECE_BYTES, d.size_bytes - have);
      const body = await readStaged(env, d, have, length);
      if (!body) {
        await fail(env, d, STAGED_WENT);
        return;
      }
      try {
        if (have === 0) await a.put(temp, body, length, PIECE_TIMEOUT_MS);
        else await a.append(temp, body, length, PIECE_TIMEOUT_MS);
      } catch (e) {
        // Listed PATCH but won't append after all: the book goes in one PUT
        // from a later run's start (the pieces so far are thrown away).
        if (e instanceof StorageWriteError && e.code === 'PATCH' && [400, 405, 501].includes(e.status)) {
          await a.remove(temp).catch(() => undefined);
          const single = `s:${randomHex(4)}`;
          await own(env, d, 'upload_id = ?, pull_requested_at = NULL', single);
          log.push(`${d.asin}: the WebDAV server refused to append (${e.message}); sending it in one go instead`);
          return;
        }
        throw e;
      }
      const after = (await a.stat(temp))?.size ?? 0;
      if (after !== have + length) {
        await discard(`the WebDAV server holds ${after} bytes after a piece of ${length} was added to ${have}`);
      }
      have = after;
      if (!(await progressed(env, d, 'error = NULL'))) return;
    }
  }
  const st = await a.stat(temp);
  if (!st || st.size !== d.size_bytes) await discard(`the uploaded file is ${st?.size ?? 0} bytes, not ${d.size_bytes}`);
  const existing = await a.stat(d.rel_path);
  const check = await finalCheck(d, existing);
  if (check === 'refuse') {
    await fail(env, d, differentFile(d.rel_path));
    return;
  }
  if (check === 'landed') await a.remove(temp).catch(() => undefined);
  else await a.move(temp, d.rel_path, !!existing);
  await own(env, d, 'upload_id = NULL');
  d.upload_id = null;
  const fin = await a.stat(d.rel_path);
  if (fin && fin.size === d.size_bytes) await land(env, d, log);
  else await retryOrFail(env, d, `The WebDAV server holds ${fin?.size ?? 'no'} bytes at ${d.rel_path} after the move, not ${d.size_bytes}`);
}

// A push that threw. Refusals that won't change by waiting fail at once,
// saying what to fix; anything else is retried (an S3 upload or a WebDAV
// temporary file is resumed from what was sent).
async function pushFailed(env: Env, d: DeliveryRow, e: unknown): Promise<void> {
  const msg = (e as Error).message ?? String(e);
  if (e instanceof StorageWriteError) {
    const s3 = d.provider === 's3';
    if (!s3 && e.code === 'MOVE' && (e.status === 401 || e.status === 403)) {
      return fail(env, d, `The WebDAV account may upload but not rename files into place (${msg}). dufs needs allow-delete for that. Give it the permission, then use Retry failed.`);
    }
    if (e.status === 401 || e.status === 403) {
      return fail(env, d, `${s3 ? 'The S3 key' : 'The WebDAV account'} isn't allowed to write there (${msg}). Give it write access, then use Retry failed.`);
    }
    if (e.status === 507 || e.code === 'QuotaExceeded' || e.code === 'EntityTooLarge') {
      return fail(env, d, `The storage is full or refused the size (${msg}).`);
    }
    if (e.status === 413 && !s3) {
      return fail(env, d, parseDav(d.upload_id)?.mode === 'a'
        ? `The WebDAV server refused a 64 MB piece (${msg}): something in front of it caps one upload below that.`
        : `The WebDAV server refused a file this big (${msg}). Behind Cloudflare one upload is capped at 100 MB, and this server doesn't take a file in appended pieces.`);
    }
  }
  if ((e as Error).name === 'TimeoutError' && parseDav(d.upload_id)?.mode === 's') {
    return retryOrFail(env, d, 'The upload took longer than 13 minutes. This WebDAV server takes a book in one upload, so it needs about 1.3 MB/s for a 1 GB book.');
  }
  return retryOrFail(env, d, msg);
}

// What a push leaves behind when it gives up for good.
async function cleanupPush(env: Env, d: DeliveryRow): Promise<void> {
  if (!d.upload_id || (d.provider !== 's3' && d.provider !== 'webdav')) return;
  try {
    const t = await pushTarget(env, d);
    if (t.kind === 's3') await t.a.abortMultipart(d.rel_path, d.upload_id);
    else {
      const dav = parseDav(d.upload_id);
      if (dav) await t.a.remove(davTemp(d, dav.tag));
    }
  } catch { /* best effort: an orphaned upload costs storage, not correctness */ }
  await env.DB.prepare(`UPDATE audible_deliveries SET upload_id = NULL, upload_parts = NULL WHERE id = ?`).bind(d.id).run();
}

// ─── Every kind of storage ──────────────────────────────────────────────────

// A pushed row's final change also needs the run's lease: a run that lost it
// (it went quiet for over 16 minutes) must not requeue or fail a row another
// run is now pushing, nor clean up that run's upload.
const leaseCond = (d: DeliveryRow): [string, unknown[]] =>
  d.lease_until != null ? [' AND lease_until = ?', [d.lease_until]] : ['', []];

async function land(env: Env, d: DeliveryRow, log: string[]): Promise<void> {
  let itemId: string | null = null;
  let problem: string | null = null;
  try {
    const r = await addBookByPath(env, d.library_id, d.rel_path, d.tenant_id, { sizeBytes: d.size_bytes, folderId: d.folder_id });
    itemId = r.itemId ?? null;
    if (!r.added && r.reason !== 'Already in library') problem = r.reason ?? 'not added';
  } catch (e) {
    problem = (e as Error).message;
  }
  if (itemId) await recordBookAsins(env, d.tenant_id, [{ asin: d.asin, path: d.rel_path }]).catch(() => 0);
  const [cond, binds] = leaseCond(d);
  const r = await env.DB.prepare(
    `UPDATE audible_deliveries SET state = ?, error = ?, library_item_id = ?, lease_until = NULL, updated_at = ? WHERE id = ? AND state = 'fetching'${cond}`,
  ).bind(problem ? 'error' : 'done', problem ? `Copied, but not added to the library: ${problem}` : null, itemId, Date.now(), d.id, ...binds).run();
  // The file is in the library's storage either way, so the staged copy
  // goes; "Retry failed" re-registers the file already there, and a scan
  // would find it too. Not if a newer sync of the title has re-staged it.
  if (r.meta.changes && await stagedIsCurrent(env, d).catch(() => false)) await env.AUDIBLE_STAGING!.delete(d.staged_key);
  log.push(`${d.asin}: ${problem ? 'copied, not registered: ' + problem : 'landed → ' + d.rel_path}`);
}

async function retryOrFail(env: Env, d: DeliveryRow, why: string): Promise<void> {
  if (d.attempts >= MAX_ATTEMPTS) return fail(env, d, why);
  const [cond, binds] = leaseCond(d);
  await env.DB.prepare(
    `UPDATE audible_deliveries SET state = 'queued', error = ?, started_at = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND state = 'fetching'${cond}`,
  ).bind(why.slice(0, 500), Date.now(), d.id, ...binds).run();
}

async function fail(env: Env, d: DeliveryRow, why: string): Promise<void> {
  const [cond, binds] = leaseCond(d);
  const r = await env.DB.prepare(
    `UPDATE audible_deliveries SET state = 'error', error = ?, lease_until = NULL, updated_at = ? WHERE id = ? AND state = 'fetching'${cond}`,
  ).bind(why.slice(0, 500), Date.now(), d.id, ...binds).run();
  if (r.meta.changes) await cleanupPush(env, d);
}

// ─── For the /admin job list ────────────────────────────────────────────────

export type DeliveryTally = { queued: number; fetching: number; done: number; error: number; errors: Array<{ asin: string; title: string | null; error: string | null }> };

export async function deliveryTallies(env: Env, syncIds: string[]): Promise<Record<string, DeliveryTally>> {
  const out: Record<string, DeliveryTally> = {};
  if (!syncIds.length) return out;
  const rows = (await env.DB.prepare(
    `SELECT sync_id, asin, title, state, error FROM audible_deliveries WHERE sync_id IN (${syncIds.map(() => '?').join(',')})`,
  ).bind(...syncIds).all<{ sync_id: string; asin: string; title: string | null; state: string; error: string | null }>()).results;
  for (const id of syncIds) out[id] = { queued: 0, fetching: 0, done: 0, error: 0, errors: [] };
  for (const r of rows) {
    const t = out[r.sync_id]!;
    if (r.state === 'queued' || r.state === 'fetching' || r.state === 'done' || r.state === 'error') t[r.state]++;
    if (r.state === 'error') t.errors.push({ asin: r.asin, title: r.title, error: r.error });
  }
  return out;
}

// A sync's failed deliveries go round again. Without the staged copy that
// only helps one whose file reached storage (it re-registers); the rest fail
// again at once, saying so.
export async function redeliver(env: Env, syncId: string): Promise<number> {
  const r = await env.DB.prepare(
    `UPDATE audible_deliveries SET state = 'queued', error = NULL, attempts = 0, started_at = NULL,
            pull_requested_at = NULL, first_fetch_at = NULL, upload_id = NULL, upload_parts = NULL,
            lease_until = NULL, replaces_size = NULL, updated_at = ?
      WHERE sync_id = ? AND state = 'error'`,
  ).bind(Date.now(), syncId).run();
  return r.meta.changes ?? 0;
}

// The newest delivery of each title of one account in one library. The node
// marks a title synced once Rhapsode accepts it, but the copy into storage
// can still fail after that: the library listing shows those as not backed
// up, and a sync passes them to the node as `redo`.
export async function latestDeliveries(env: Env, tenantId: string, nodeName: string):
  Promise<Map<string, { state: string; error: string | null }>> {
  const rows = (await env.DB.prepare(
    `SELECT d.asin, d.state, d.error FROM audible_deliveries d JOIN audible_syncs s ON s.id = d.sync_id
      WHERE s.tenant_id = ? AND s.node_name = ? ORDER BY d.created_at`,
  ).bind(tenantId, nodeName).all<{ asin: string; state: string; error: string | null }>()).results;
  return new Map(rows.map((r) => [r.asin, { state: r.state, error: r.error }]));
}
