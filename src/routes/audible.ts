import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth, canAddBooks, type AuthVars } from '../auth/middleware';
import { getTenantSetting, setTenantSetting } from '../db/settings';
import { recordBookAsins } from '../lib/book-asins';
import { runAndWait, runAsync, getJob, getJobLog, cancelJob, wharfConfigured, type WharfJob } from '../lib/wharf';
import {
  audibleAllowed, audibleOrigin, tenantAccounts, accountByName, adoptLegacyAccounts, newNodeName,
  createSync, setSyncJob, dropSync, deliveryTallies, redeliver, audibleDeliveryPump, latestDeliveries, type AudibleAccountRow,
} from '../lib/audible-delivery';

// Audible library backup — mounted at /api/admin/audible. The work runs on
// wharf (project "audible", see wharf-project/audible/ in this repo); the
// shim drives it, shows progress, and (since 2026-10-15) delivers each
// finished book into the library's own storage (src/lib/audible-delivery.ts).
//
// Which libraries: the instance owner's always, any other once the instance
// owner allows it (/admin → All users). The node keeps ONE instance-wide set
// of accounts, so each library's name for an account ("mum") maps to a node
// name of its own (audible_accounts, migration 0031); nothing here passes a
// library's name to the node. Within a library the surface follows the
// members_can_add switch (2026-09-05): the owner sees every account of the
// library; a member who may add books sees, syncs and unlinks only the
// accounts they linked, and only their own jobs.
//
//   GET    accounts                → linked Audible accounts (+ logins in progress)
//   POST   accounts/start          {account, marketplace} → {login_url}
//   POST   accounts/finish         {account, response_url}
//   DELETE accounts/:name
//   GET    library?account=&refresh=1
//   POST   sync                    {account, asins|"all", libraryId, force?} → {jobId}
//   GET    jobs                    recent sync jobs for this tenant (with live state + delivery)
//   GET    jobs/:id, jobs/:id/log?offset=, POST jobs/:id/cancel, POST jobs/:id/redeliver

export const audibleRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>();
audibleRoutes.use('*', requireAuth);
audibleRoutes.use('*', async (c, next) => {
  if (!(await canAddBooks(c))) return c.json({ error: 'The library owner has not enabled adding books for members' }, 403);
  // 403 also hides the /admin card. Until 2026-10-15 any library's owner
  // could reach every account on the node, and syncs uploaded with the
  // instance owner's pCloud token.
  if (!(await audibleAllowed(c.env, c.get('tenantId')))) return c.json({ error: "Audible import isn't turned on for this library" }, 403);
  if (!wharfConfigured(c.env)) return c.json({ error: 'Audible import is not configured on this shim (needs the wharf-router binding and ROUTER_TOKEN)' }, 503);
  await next();
});

const PROJECT = 'audible';
const JOBS_KEY = 'audible_jobs';
const ACCOUNT_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

type SyncJobRecord = { id: string; account: string; libraryId: string; count: number | 'all'; startedAt: number; scanned?: boolean; userId?: string; syncId?: string };

async function jobRecords(env: Env, tenantId: string): Promise<SyncJobRecord[]> {
  try { return JSON.parse((await getTenantSetting(env, tenantId, JOBS_KEY)) ?? '[]') as SyncJobRecord[]; } catch { return []; }
}

type Ctx = { env: Env; get: (k: 'tenantRole' | 'tenantId' | 'userId') => string };

// The library's account by its name, if the caller may use it: the owner
// every account of the library, a member only those they linked.
async function accountFor(c: Ctx, name: string): Promise<AudibleAccountRow | null> {
  if (!ACCOUNT_RE.test(name)) return null;
  const row = await accountByName(c.env, c.get('tenantId'), name);
  if (!row) return null;
  return c.get('tenantRole') === 'owner' || row.user_id === c.get('userId') ? row : null;
}

// A job id must be one of this library's records (and the member's own).
async function jobRecord(c: Ctx, jobId: string): Promise<SyncJobRecord | null> {
  const r = (await jobRecords(c.env, c.get('tenantId'))).find((x) => x.id === jobId);
  if (!r) return null;
  return c.get('tenantRole') === 'owner' || r.userId === c.get('userId') ? r : null;
}

const err = (e: unknown) => (e as Error).message;

// Every wharf call is a job round trip (a second or three), so the UI
// paints from a per-tenant snapshot in tenant_settings first and refreshes
// live in the background: GET without ?live=1 returns the snapshot when
// there is one (and refreshes it after the response); ?live=1 waits for
// wharf and stores the result.
async function snapshot<T>(c: { env: Env }, tenantId: string, key: string): Promise<T | null> {
  try { const v = await getTenantSetting(c.env, tenantId, key); return v ? JSON.parse(v) as T : null; } catch { return null; }
}

async function cachedOrLive<T extends object>(c: { env: Env; executionCtx: ExecutionContext }, tenantId: string, key: string, live: boolean, fetchLive: () => Promise<T>): Promise<T & { cached?: boolean; cachedAt?: number }> {
  if (!live) {
    const snap = await snapshot<T & { cachedAt?: number }>(c, tenantId, key);
    if (snap) {
      c.executionCtx.waitUntil(fetchLive().then((v) => setTenantSetting(c.env, tenantId, key, JSON.stringify({ ...v, cachedAt: Date.now() }))).catch(() => undefined));
      return { ...snap, cached: true };
    }
  }
  const v = await fetchLive();
  c.executionCtx.waitUntil(setTenantSetting(c.env, tenantId, key, JSON.stringify({ ...v, cachedAt: Date.now() })).catch(() => undefined));
  return v;
}

type NodeAccount = { account: string; [k: string]: unknown };
type AccountList = { ok: boolean; accounts: NodeAccount[]; pending: string[] };

// The node's instance-wide list, cut down to this library's accounts and
// renamed to the library's names. The snapshot stores this, never the
// node's list.
async function libraryAccounts(env: Env, tenantId: string): Promise<AccountList & { owners: Record<string, string> }> {
  const r = await runAndWait<AccountList>(env, PROJECT, 'accounts', {}, 30_000);
  const onNode = (r.accounts ?? []).map((a) => a.account);
  if (onNode.length) {
    // The whole table: it is one row per linked account, and an IN list
    // would hit D1's 100-parameter limit.
    const known = new Set((await env.DB.prepare(
      `SELECT node_name FROM audible_accounts`,
    ).all<{ node_name: string }>()).results.map((x) => x.node_name));
    const orphans = onNode.filter((n) => !known.has(n));
    if (orphans.length) await adoptLegacyAccounts(env, tenantId, orphans);
  }
  const rows = await tenantAccounts(env, tenantId);
  const byNode = new Map(rows.map((x) => [x.node_name, x]));
  return {
    ok: r.ok,
    accounts: (r.accounts ?? []).filter((a) => byNode.has(a.account)).map((a) => ({ ...a, account: byNode.get(a.account)!.name })),
    pending: (r.pending ?? []).filter((p) => byNode.has(p)).map((p) => byNode.get(p)!.name),
    // name → userId, so a member's view can be filtered from the snapshot.
    owners: Object.fromEntries(rows.map((x) => [x.name, x.user_id])),
  };
}

audibleRoutes.get('/accounts', async (c) => {
  try {
    // _v2: the old key held the node's whole instance-wide list.
    const r = await cachedOrLive(c, c.get('tenantId'), 'audible_accounts_v2', c.req.query('live') === '1',
      () => libraryAccounts(c.env, c.get('tenantId')));
    const owners = r.owners ?? {};
    const { owners: _o, ...out } = r;
    if (c.get('tenantRole') === 'owner') return c.json(out);
    const me = c.get('userId');
    return c.json({
      ...out,
      accounts: (out.accounts ?? []).filter((a) => owners[a.account] === me),
      pending: (out.pending ?? []).filter((a) => owners[a] === me),
    });
  } catch (e) {
    return c.json({ error: err(e) }, 502);
  }
});

audibleRoutes.post('/accounts/start', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { account?: string; marketplace?: string };
  const name = String(body.account ?? '').trim().toLowerCase();
  if (!ACCOUNT_RE.test(name)) return c.json({ error: 'Account name: 1-32 lowercase letters, digits or dashes' }, 400);
  const tenantId = c.get('tenantId');
  // Claim the name for whoever starts the link. A member can't take over a
  // name someone else in the library already linked; a name another library
  // uses is no concern, since it gets a node name of its own.
  let row = await accountByName(c.env, tenantId, name);
  if (row && c.get('tenantRole') !== 'owner' && row.user_id !== c.get('userId')) {
    return c.json({ error: 'That account name is already linked by someone else' }, 409);
  }
  if (!row) {
    row = { node_name: newNodeName(), tenant_id: tenantId, user_id: c.get('userId'), name, created_at: Date.now() };
    await c.env.DB.prepare(
      `INSERT INTO audible_accounts (node_name, tenant_id, user_id, name, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).bind(row.node_name, row.tenant_id, row.user_id, row.name, row.created_at).run();
  }
  try {
    const r = await runAndWait<Record<string, unknown>>(c.env, PROJECT, 'auth_start', { account: row.node_name, marketplace: body.marketplace ?? 'au' }, 60_000);
    return c.json({ ...r, account: name });
  } catch (e) {
    return c.json({ error: err(e).replaceAll(row.node_name, name) }, 502);
  }
});

audibleRoutes.post('/accounts/finish', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { account?: string; response_url?: string };
  const name = String(body.account ?? '').trim().toLowerCase();
  const url = String(body.response_url ?? '').trim();
  if (!ACCOUNT_RE.test(name) || !url) return c.json({ error: 'account and response_url required' }, 400);
  const row = await accountFor(c, name);
  if (!row) return c.json({ error: 'Not found' }, 404);
  try {
    const r = await runAndWait<Record<string, unknown>>(c.env, PROJECT, 'auth_finish', { account: row.node_name, response_url: url }, 90_000);
    return c.json({ ...r, account: name });
  } catch (e) {
    return c.json({ error: err(e).replaceAll(row.node_name, name) }, 502);
  }
});

audibleRoutes.delete('/accounts/:name', async (c) => {
  const name = c.req.param('name');
  const row = await accountFor(c, name);
  if (!row) return c.json({ error: 'Not found' }, 404);
  try {
    await runAndWait(c.env, PROJECT, 'remove_account', { account: row.node_name }, 30_000);
    await c.env.DB.prepare(`DELETE FROM audible_accounts WHERE node_name = ?`).bind(row.node_name).run();
    return c.body(null, 204);
  } catch (e) {
    return c.json({ error: err(e).replaceAll(row.node_name, name) }, 502);
  }
});

audibleRoutes.get('/library', async (c) => {
  const name = (c.req.query('account') ?? '').trim();
  const row = await accountFor(c, name);
  if (!row) return c.json({ error: 'Not found' }, 404);
  const refresh = c.req.query('refresh') === '1';
  try {
    // Keyed by the node name, so a name reused for a different account
    // never shows the old one's cached titles (old accounts: the same key).
    const out = await cachedOrLive(c, c.get('tenantId'), 'audible_library:' + row.node_name, refresh || c.req.query('live') === '1',
      () => runAndWait<{ ok: boolean; account: string; fetched_at: number; items: unknown[] }>(c.env, PROJECT, 'library', { account: row.node_name, refresh }, refresh ? 240_000 : 30_000)
        .then((v) => {
          // Each synced title's ASIN onto its book (src/lib/book-asins.ts).
          const recs = (v.items as Array<{ asin?: string; synced?: { path?: string } | null }>)
            .filter((i) => i.asin && i.synced?.path).map((i) => ({ asin: i.asin!, path: i.synced!.path! }));
          c.executionCtx.waitUntil(recordBookAsins(c.env, c.get('tenantId'), recs).catch(() => 0));
          return { ...v, account: name };
        }));
    // Overlaid on every answer, snapshot or live: delivery is Rhapsode's.
    const deliveries = await latestDeliveries(c.env, c.get('tenantId'), row.node_name);
    if (deliveries.size) {
      out.items = (out.items as Array<{ asin?: string; synced?: unknown }>).map((i) => {
        const d = i.asin ? deliveries.get(i.asin) : undefined;
        if (!d || !i.synced || d.state === 'done') return i;
        return d.state === 'error' ? { ...i, synced: null, deliveryError: d.error } : { ...i, delivering: true };
      });
    }
    return c.json(out);
  } catch (e) {
    return c.json({ error: err(e).replaceAll(row.node_name, name) }, 502);
  }
});

// The node stages each finished m4b and posts it back (deliver.url, with a
// token good only for this sync); Rhapsode copies it into the library's
// first pCloud folder, under Audible/<account>/<Title - Author>/, and adds
// it as a book. S3 and WebDAV libraries aren't delivered to yet.
audibleRoutes.post('/sync', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { account?: string; asins?: string[] | 'all'; libraryId?: string; force?: boolean; quality?: string };
  const name = String(body.account ?? '').trim().toLowerCase();
  const row = await accountFor(c, name);
  if (!row) return c.json({ error: 'Not found' }, 404);
  if (!c.env.AUDIBLE_STAGING) return c.json({ error: 'Audible delivery is not configured (AUDIBLE_STAGING binding)' }, 503);
  const asins = body.asins === 'all' ? 'all' : (Array.isArray(body.asins) ? body.asins.filter((a) => typeof a === 'string' && /^[A-Z0-9]{10}$/.test(a)).slice(0, 500) : []);
  if (asins !== 'all' && !asins.length) return c.json({ error: 'pick at least one title' }, 400);
  const libraryId = String(body.libraryId ?? '');
  const folder = await c.env.DB.prepare(
    "SELECT id FROM library_folders WHERE library_id = ? AND tenant_id = ? AND provider = 'pcloud_oauth' ORDER BY added_at ASC LIMIT 1",
  ).bind(libraryId, c.get('tenantId')).first<{ id: string }>();
  if (!folder) return c.json({ error: 'That library has no pCloud folder to sync into' }, 400);
  // Titles the node handed over but whose copy failed: the node counts them
  // as synced, so they are named for it to do again.
  const failed = [...(await latestDeliveries(c.env, c.get('tenantId'), row.node_name))]
    .filter(([asin, d]) => d.state === 'error' && (asins === 'all' || asins.includes(asin))).map(([asin]) => asin);
  const sync = await createSync(c.env, {
    tenantId: c.get('tenantId'), userId: c.get('userId'), nodeName: row.node_name, account: name, libraryId, folderId: folder.id,
  });
  try {
    const args: Record<string, unknown> = {
      account: row.node_name, asins, force: !!body.force,
      path_prefix: `Audible/${name}`, redo: failed.slice(0, 500),
      deliver: { url: audibleOrigin(c.env) + '/api/audible-node/staged', sync: sync.id, token: sync.token },
    };
    if (body.quality && ['best', 'high', 'normal'].includes(body.quality)) args['quality'] = body.quality;
    const id = await runAsync(c.env, PROJECT, 'sync', args);
    await setSyncJob(c.env, sync.id, id);
    const recs = await jobRecords(c.env, c.get('tenantId'));
    recs.unshift({ id, account: name, libraryId, count: asins === 'all' ? 'all' : asins.length, startedAt: Date.now(), userId: c.get('userId'), syncId: sync.id });
    await setTenantSetting(c.env, c.get('tenantId'), JOBS_KEY, JSON.stringify(recs.slice(0, 20)));
    return c.json({ jobId: id });
  } catch (e) {
    await dropSync(c.env, sync.id).catch(() => undefined);
    return c.json({ error: err(e).replaceAll(row.node_name, name) }, 502);
  }
});

audibleRoutes.get('/jobs', async (c) => {
  let recs = await jobRecords(c.env, c.get('tenantId'));
  if (c.get('tenantRole') !== 'owner') recs = recs.filter((r) => r.userId === c.get('userId'));
  const tallies = await deliveryTallies(c.env, recs.map((r) => r.syncId).filter((s): s is string => !!s));
  const out = await Promise.all(recs.map(async (r) => {
    let job: WharfJob | null = null;
    try { job = await getJob(c.env, r.id); } catch { /* router unreachable / job expired */ }
    return {
      ...r, state: job?.state ?? 'unknown', result: job?.result ?? null, error: job?.error ?? null, endedAt: job?.ended_at ?? null,
      // Present on jobs that deliver through Rhapsode (each book registers
      // as it lands, so the UI doesn't scan for them).
      ...(r.syncId ? { delivery: tallies[r.syncId] ?? null } : {}),
    };
  }));
  return c.json({ jobs: out });
});

// Mark a job's post-sync scan as done so the UI doesn't re-scan on every load.
audibleRoutes.post('/jobs/:id/scanned', async (c) => {
  if (!(await jobRecord(c, c.req.param('id')))) return c.json({ error: 'Not found' }, 404);
  const recs = await jobRecords(c.env, c.get('tenantId'));
  const r = recs.find((x) => x.id === c.req.param('id'));
  if (r) { r.scanned = true; await setTenantSetting(c.env, c.get('tenantId'), JOBS_KEY, JSON.stringify(recs)); }
  // The books now exist in D1, so their ASINs can be recorded.
  try {
    const job = await getJob(c.env, c.req.param('id'));
    const done = ((job?.result as { done?: Array<{ asin?: string; path?: string }> } | null)?.done ?? [])
      .filter((d) => d.asin && d.path).map((d) => ({ asin: d.asin!, path: d.path! }));
    if (done.length) c.executionCtx.waitUntil(recordBookAsins(c.env, c.get('tenantId'), done).catch(() => 0));
  } catch { /* router unreachable: the library view records them later */ }
  return c.json({ ok: true });
});

// Failed deliveries whose staged copy is still there (7 days) go round again.
audibleRoutes.post('/jobs/:id/redeliver', async (c) => {
  const r = await jobRecord(c, c.req.param('id'));
  if (!r?.syncId) return c.json({ error: 'Not found' }, 404);
  const n = await redeliver(c.env, r.syncId);
  if (n) c.executionCtx.waitUntil(audibleDeliveryPump(c.env).catch(() => []));
  return c.json({ ok: true, requeued: n });
});

audibleRoutes.get('/jobs/:id', async (c) => {
  if (!(await jobRecord(c, c.req.param('id')))) return c.json({ error: 'Not found' }, 404);
  try {
    // Not the args: they carry the sync's delivery token.
    const { args: _args, ...job } = await getJob(c.env, c.req.param('id')) as WharfJob & { args?: unknown };
    return c.json(job);
  } catch (e) {
    return c.json({ error: err(e) }, 502);
  }
});

audibleRoutes.get('/jobs/:id/log', async (c) => {
  const offset = Number(c.req.query('offset') ?? '0') || 0;
  const tail = c.req.query('tail') ? Number(c.req.query('tail')) : undefined;
  if (!(await jobRecord(c, c.req.param('id')))) return c.json({ error: 'Not found' }, 404);
  try {
    return c.json(await getJobLog(c.env, c.req.param('id'), tail != null ? { tail } : { offset }));
  } catch (e) {
    return c.json({ error: err(e) }, 502);
  }
});

audibleRoutes.post('/jobs/:id/cancel', async (c) => {
  if (!(await jobRecord(c, c.req.param('id')))) return c.json({ error: 'Not found' }, 404);
  try {
    await cancelJob(c.env, c.req.param('id'));
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: err(e) }, 502);
  }
});
