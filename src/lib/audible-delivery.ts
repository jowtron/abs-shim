// Audible imports delivered into each library's own storage (2026-10-15).
//
// The audible wharf node (wharf-project/audible, on stereo-au) downloads,
// decrypts and builds each m4b, stages it in R2 (bucket
// abs-shim-audible-staging, bound here as AUDIBLE_STAGING) and posts a notice
// to /api/audible-node/staged. The rest is Rhapsode's, with the library's own
// credentials: pCloud is asked to pull the staged file from a signed URL on
// this Worker (downloadfileasync, as fetch-from-URL does), the file is
// stat-polled to its exact size, registered as a book, and the staged copy is
// deleted. Until then the node uploaded with the instance owner's rclone
// pCloud token, so another library's books would have landed in his pCloud.
//
// The pump runs on the 2-minute cron and straight after each notice.

import type { Env } from '../types';
import { getTenantSetting } from '../db/settings';
import { loadPcloudFolder, joinPcloudPath } from '../storage/pcloud-folder';
import { pcloudStat, pcloudEnsureFolder, pcloudDownloadFileAsync, pcloudDeleteFile } from '../storage/pcloud';
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
    `INSERT INTO audible_deliveries (id, sync_id, asin, title, staged_key, size_bytes, rel_path, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
     ON CONFLICT(sync_id, asin) DO UPDATE SET
       title = excluded.title, staged_key = excluded.staged_key, size_bytes = excluded.size_bytes,
       rel_path = excluded.rel_path, state = 'queued', error = NULL, attempts = 0, started_at = NULL,
       pull_requested_at = NULL, first_fetch_at = NULL, updated_at = excluded.updated_at
     WHERE audible_deliveries.state = 'error'
     RETURNING id`,
  ).bind('ad_' + randomHex(8), sync.id, asin, title, key, bytes, relPath, now, now).first<{ id: string }>();
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
    `SELECT staged_key, size_bytes, first_fetch_at FROM audible_deliveries WHERE id = ? AND state = 'fetching' AND attempts = ?`,
  ).bind(id, attempt).first<{ staged_key: string; size_bytes: number; first_fetch_at: number | null }>();
  if (!row) return new Response('Not found', { status: 404 });
  // Proof that pCloud came for it (checkPull's 15-minute rule).
  if (!row.first_fetch_at) {
    await env.DB.prepare(`UPDATE audible_deliveries SET first_fetch_at = ? WHERE id = ? AND first_fetch_at IS NULL`).bind(Date.now(), id).run();
  }
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
  if (req.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });
  const obj = await env.AUDIBLE_STAGING.get(row.staged_key, range ? { range } : undefined);
  if (!obj) return new Response('Not found', { status: 404 });
  return new Response(obj.body, { status: range ? 206 : 200, headers });
}

// ─── The pump ───────────────────────────────────────────────────────────────

type DeliveryRow = {
  id: string; sync_id: string; asin: string; title: string | null; staged_key: string; size_bytes: number;
  rel_path: string; state: string; error: string | null; attempts: number; started_at: number | null;
  pull_requested_at: number | null; first_fetch_at: number | null;
  tenant_id: string; folder_id: string; library_id: string;
};

// A pull of a 1 GB book takes minutes. One pCloud never fetches is retried
// after NO_FETCH_MS (it answers result 0 either way); one that started gets
// PULL_GIVE_UP_MS.
const PULL_GIVE_UP_MS = 3 * 3600_000;
const NO_FETCH_MS = 15 * 60_000;
// A claim cut off before pCloud was asked (a notice's waitUntil has 30 s).
const STUCK_CLAIM_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
// pCloud pulls running at once, across the instance.
const MAX_PULLING = 3;
const RETRY_WAIT_MS = 10 * 60_000;
// pCloud's `created` is to the second, and its clock isn't ours.
const CLOCK_SLACK_MS = 60_000;

const SELECT_DELIVERY = `SELECT d.*, s.tenant_id, s.folder_id, s.library_id
  FROM audible_deliveries d JOIN audible_syncs s ON s.id = d.sync_id`;

// checkPulls false (a notice's waitUntil): only start new pulls. Checking
// running ones means pCloud stats, which can take minutes while a file is
// being written, and the 30 s cap would cut a claim off half-way.
export async function audibleDeliveryPump(env: Env, opts: { checkPulls?: boolean } = {}): Promise<string[]> {
  if (!env.AUDIBLE_STAGING) return [];
  const log: string[] = [];
  const now = Date.now();
  // Claimed but never handed to pCloud: back to the queue, attempt refunded.
  await env.DB.prepare(
    `UPDATE audible_deliveries SET state = 'queued', attempts = MAX(attempts - 1, 0), started_at = NULL, updated_at = ?
      WHERE state = 'fetching' AND pull_requested_at IS NULL AND started_at < ?`,
  ).bind(now, now - STUCK_CLAIM_MS).run();
  if (opts.checkPulls !== false) {
    const pulling = (await env.DB.prepare(
      `${SELECT_DELIVERY} WHERE d.state = 'fetching' AND d.pull_requested_at IS NOT NULL ORDER BY d.updated_at LIMIT 10`,
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
  const busy = (await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM audible_deliveries WHERE state = 'fetching'`,
  ).first<{ n: number }>())?.n ?? 0;
  if (busy >= MAX_PULLING) return log;
  // A retry waits RETRY_WAIT_MS per attempt so far, so a pCloud hiccup
  // doesn't use up all the attempts in three cron ticks.
  const queued = (await env.DB.prepare(
    `${SELECT_DELIVERY} WHERE d.state = 'queued' AND d.updated_at <= ? - d.attempts * ? ORDER BY d.updated_at LIMIT ?`,
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

// A file pCloud created at this path after one of our pulls of this title
// into it was accepted: an unfinished pull of ours, safe to replace. Anything
// older (or with no pull of ours behind it) is someone's file.
async function ourUnfinishedPull(env: Env, d: DeliveryRow, created: string | undefined): Promise<boolean> {
  const at = created ? Date.parse(created) : NaN;
  if (!Number.isFinite(at)) return false;
  const first = await env.DB.prepare(
    `SELECT MIN(d.pull_requested_at) AS t FROM audible_deliveries d JOIN audible_syncs s ON s.id = d.sync_id
      WHERE d.rel_path = ? AND s.folder_id = ? AND d.asin = ? AND d.pull_requested_at IS NOT NULL`,
  ).bind(d.rel_path, d.folder_id, d.asin).first<{ t: number | null }>();
  return first?.t != null && at >= first.t - CLOCK_SLACK_MS;
}

async function startPull(env: Env, d: DeliveryRow, log: string[]): Promise<void> {
  const t = await loadTarget(env, d);
  const existing = await pcloudStat(t.profile, t.abs);
  if (existing && !existing.isfolder && existing.size === d.size_bytes) {
    await land(env, d, log);
    return;
  }
  if (!(await env.AUDIBLE_STAGING!.head(d.staged_key))) {
    await fail(env, d, 'The staged copy is gone (staging keeps files 7 days); sync the title again.');
    return;
  }
  if (existing) {
    // pCloud would save beside it as "name (1)" and the book would point at
    // the old file.
    if (existing.isfolder || !(await ourUnfinishedPull(env, d, existing.created))) {
      await fail(env, d, `A different file is already at ${t.abs}; delete or rename it in pCloud, then sync the title again.`);
      return;
    }
    await pcloudDeleteFile(t.profile, t.abs);
  }
  const slash = t.abs.lastIndexOf('/');
  const folderId = await pcloudEnsureFolder(t.profile, t.abs.slice(0, slash) || '/');
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
  // The file is in the library's storage either way, so the staged copy
  // goes; "Retry failed" re-registers the file already there, and a scan
  // would find it too.
  await env.AUDIBLE_STAGING!.delete(d.staged_key);
  await env.DB.prepare(
    `UPDATE audible_deliveries SET state = ?, error = ?, library_item_id = ?, updated_at = ? WHERE id = ? AND state = 'fetching'`,
  ).bind(problem ? 'error' : 'done', problem ? `Copied, but not added to the library: ${problem}` : null, itemId, Date.now(), d.id).run();
  log.push(`${d.asin}: ${problem ? 'copied, not registered: ' + problem : 'landed → ' + d.rel_path}`);
}

async function retryOrFail(env: Env, d: DeliveryRow, why: string): Promise<void> {
  if (d.attempts >= MAX_ATTEMPTS) return fail(env, d, why);
  await env.DB.prepare(
    `UPDATE audible_deliveries SET state = 'queued', error = ?, started_at = NULL, updated_at = ? WHERE id = ? AND state = 'fetching'`,
  ).bind(why, Date.now(), d.id).run();
}

async function fail(env: Env, d: DeliveryRow, why: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE audible_deliveries SET state = 'error', error = ?, updated_at = ? WHERE id = ? AND state = 'fetching'`,
  ).bind(why.slice(0, 500), Date.now(), d.id).run();
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
            pull_requested_at = NULL, first_fetch_at = NULL, updated_at = ?
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
