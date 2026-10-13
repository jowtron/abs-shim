import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth, requireCanAdd, type AuthVars } from '../auth/middleware';
import { analysisRunsReport } from '../db/analysis-runs';

// /api/analysis (shim-only): the episode analysis run log (migration 0027),
// for Pholia's Settings "Episode analysis" section and /admin. canAdd, the
// tier that can start a run and so spend on one. The shape is a contract
// with Pholia (2026-10-13): change it in both repos or not at all.

export const analysisRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>();
analysisRoutes.use('*', requireAuth);

// GET /api/analysis/runs?limit=50&before=<created_at ms>&showId=<libraryItemId>&tz=<IANA>
// → {totals, months, shows, active, runs, nextBefore}. `totals`, `months`
// (newest first, up to 12, calendar months in `tz`, UTC by default) and
// `shows` cover the caller's tenant, or the one show; `runs` is a page,
// newest first; `active` is what is queued or running now. limit=0 answers
// everything but runs.
analysisRoutes.get('/runs', requireCanAdd, async (c) => {
  const limitRaw = Number(c.req.query('limit') ?? 50);
  const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(0, Math.floor(limitRaw))) : 50;
  const beforeRaw = Number(c.req.query('before'));
  const before = Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : null;
  const showId = c.req.query('showId') || null;
  const tz = c.req.query('tz') || 'UTC';
  return c.json(await analysisRunsReport(c.env, c.get('tenantId'), { limit, before, showId, tz }));
});
