import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth, type AuthVars } from '../auth/middleware';
import { getTenantSetting, setTenantSetting } from '../db/settings';
import { runAndWait, runAsync, getJob, getJobLog, cancelJob, wharfConfigured, type WharfJob } from '../lib/wharf';

// Audible library backup — mounted at /api/admin/audible. The work runs on
// wharf (project "audible", see wharf-project/audible/ in this repo); the
// shim only drives it and shows progress. Accounts on the wharf project are
// instance-wide (one box serves every tenant), so this surface is limited
// to tenant owners.
//
//   GET    accounts                → linked Audible accounts (+ logins in progress)
//   POST   accounts/start          {account, marketplace} → {login_url}
//   POST   accounts/finish         {account, response_url}
//   DELETE accounts/:name
//   GET    library?account=&refresh=1
//   POST   sync                    {account, asins|"all", libraryId, force?} → {jobId}
//   GET    jobs                    recent sync jobs for this tenant (with live state)
//   GET    jobs/:id, jobs/:id/log?offset=, POST jobs/:id/cancel
//
// The browser polls a sync job's state + log and, once it succeeds, calls
// the library scan route so the new m4b files register — same tail as an
// AudioBookBay grab.

export const audibleRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>();
audibleRoutes.use('*', requireAuth);
audibleRoutes.use('*', async (c, next) => {
  if (c.get('tenantRole') !== 'owner') return c.json({ error: 'Only the tenant owner can use the Audible importer' }, 403);
  if (!wharfConfigured(c.env)) return c.json({ error: 'Audible import is not configured on this shim (needs the wharf-router binding and ROUTER_TOKEN)' }, 503);
  await next();
});

const PROJECT = 'audible';
const JOBS_KEY = 'audible_jobs';
const ACCOUNT_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

type SyncJobRecord = { id: string; account: string; libraryId: string; count: number | 'all'; startedAt: number; scanned?: boolean };

async function jobRecords(env: Env, tenantId: string): Promise<SyncJobRecord[]> {
  try { return JSON.parse((await getTenantSetting(env, tenantId, JOBS_KEY)) ?? '[]') as SyncJobRecord[]; } catch { return []; }
}

const err = (e: unknown) => (e as Error).message;

audibleRoutes.get('/accounts', async (c) => {
  try {
    return c.json(await runAndWait(c.env, PROJECT, 'accounts', {}, 30_000));
  } catch (e) {
    return c.json({ error: err(e) }, 502);
  }
});

audibleRoutes.post('/accounts/start', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { account?: string; marketplace?: string };
  const account = String(body.account ?? '').trim().toLowerCase();
  if (!ACCOUNT_RE.test(account)) return c.json({ error: 'Account name: 1-32 lowercase letters, digits or dashes' }, 400);
  try {
    return c.json(await runAndWait(c.env, PROJECT, 'auth_start', { account, marketplace: body.marketplace ?? 'au' }, 60_000));
  } catch (e) {
    return c.json({ error: err(e) }, 502);
  }
});

audibleRoutes.post('/accounts/finish', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { account?: string; response_url?: string };
  const account = String(body.account ?? '').trim().toLowerCase();
  const url = String(body.response_url ?? '').trim();
  if (!ACCOUNT_RE.test(account) || !url) return c.json({ error: 'account and response_url required' }, 400);
  try {
    return c.json(await runAndWait(c.env, PROJECT, 'auth_finish', { account, response_url: url }, 90_000));
  } catch (e) {
    return c.json({ error: err(e) }, 502);
  }
});

audibleRoutes.delete('/accounts/:name', async (c) => {
  const account = c.req.param('name');
  if (!ACCOUNT_RE.test(account)) return c.json({ error: 'bad account' }, 400);
  try {
    await runAndWait(c.env, PROJECT, 'remove_account', { account }, 30_000);
    return c.body(null, 204);
  } catch (e) {
    return c.json({ error: err(e) }, 502);
  }
});

audibleRoutes.get('/library', async (c) => {
  const account = (c.req.query('account') ?? '').trim();
  if (!ACCOUNT_RE.test(account)) return c.json({ error: 'account required' }, 400);
  const refresh = c.req.query('refresh') === '1';
  try {
    return c.json(await runAndWait(c.env, PROJECT, 'library', { account, refresh }, refresh ? 240_000 : 30_000));
  } catch (e) {
    return c.json({ error: err(e) }, 502);
  }
});

// The destination is the library's pCloud folder root (library_folders
// config.rootPath, e.g. "/Public Folder/audiobooks"); the handler rclones
// into pcloud:<root>/<Title - Author>/<Title>.m4b.
audibleRoutes.post('/sync', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { account?: string; asins?: string[] | 'all'; libraryId?: string; force?: boolean; quality?: string };
  const account = String(body.account ?? '').trim().toLowerCase();
  if (!ACCOUNT_RE.test(account)) return c.json({ error: 'account required' }, 400);
  const asins = body.asins === 'all' ? 'all' : (Array.isArray(body.asins) ? body.asins.filter((a) => typeof a === 'string' && /^[A-Z0-9]{10}$/.test(a)).slice(0, 500) : []);
  if (asins !== 'all' && !asins.length) return c.json({ error: 'pick at least one title' }, 400);
  const libraryId = String(body.libraryId ?? '');
  const folder = await c.env.DB.prepare(
    "SELECT config_json FROM library_folders WHERE library_id = ? AND tenant_id = ? AND provider = 'pcloud_oauth' ORDER BY added_at ASC LIMIT 1",
  ).bind(libraryId, c.get('tenantId')).first<{ config_json: string }>();
  if (!folder) return c.json({ error: 'That library has no pCloud folder to sync into' }, 400);
  let root = '';
  try { root = String((JSON.parse(folder.config_json) as { rootPath?: string }).rootPath ?? ''); } catch { /* fall through */ }
  root = root.replace(/^\/+|\/+$/g, '');
  if (!root) return c.json({ error: 'The pCloud folder has no rootPath' }, 400);
  try {
    const args: Record<string, unknown> = { account, asins, dest_root: root, force: !!body.force };
    if (body.quality && ['best', 'high', 'normal'].includes(body.quality)) args['quality'] = body.quality;
    const id = await runAsync(c.env, PROJECT, 'sync', args);
    const recs = await jobRecords(c.env, c.get('tenantId'));
    recs.unshift({ id, account, libraryId, count: asins === 'all' ? 'all' : asins.length, startedAt: Date.now() });
    await setTenantSetting(c.env, c.get('tenantId'), JOBS_KEY, JSON.stringify(recs.slice(0, 20)));
    return c.json({ jobId: id });
  } catch (e) {
    return c.json({ error: err(e) }, 502);
  }
});

audibleRoutes.get('/jobs', async (c) => {
  const recs = await jobRecords(c.env, c.get('tenantId'));
  const out = await Promise.all(recs.map(async (r) => {
    let job: WharfJob | null = null;
    try { job = await getJob(c.env, r.id); } catch { /* router unreachable / job expired */ }
    return { ...r, state: job?.state ?? 'unknown', result: job?.result ?? null, error: job?.error ?? null, endedAt: job?.ended_at ?? null };
  }));
  return c.json({ jobs: out });
});

// Mark a job's post-sync scan as done so the UI doesn't re-scan on every load.
audibleRoutes.post('/jobs/:id/scanned', async (c) => {
  const recs = await jobRecords(c.env, c.get('tenantId'));
  const r = recs.find((x) => x.id === c.req.param('id'));
  if (r) { r.scanned = true; await setTenantSetting(c.env, c.get('tenantId'), JOBS_KEY, JSON.stringify(recs)); }
  return c.json({ ok: true });
});

audibleRoutes.get('/jobs/:id', async (c) => {
  try {
    return c.json(await getJob(c.env, c.req.param('id')));
  } catch (e) {
    return c.json({ error: err(e) }, 502);
  }
});

audibleRoutes.get('/jobs/:id/log', async (c) => {
  const offset = Number(c.req.query('offset') ?? '0') || 0;
  const tail = c.req.query('tail') ? Number(c.req.query('tail')) : undefined;
  try {
    return c.json(await getJobLog(c.env, c.req.param('id'), tail != null ? { tail } : { offset }));
  } catch (e) {
    return c.json({ error: err(e) }, 502);
  }
});

audibleRoutes.post('/jobs/:id/cancel', async (c) => {
  try {
    await cancelJob(c.env, c.req.param('id'));
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: err(e) }, 502);
  }
});
