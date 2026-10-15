import { Hono } from 'hono';
import type { Env } from '../types';
import { authSync, recordStaged, audibleDeliveryPump } from '../lib/audible-delivery';

// The audible wharf node's side of a sync (src/lib/audible-delivery.ts).
// Mounted at /api/audible-node. Authenticated by the sync's own token, sent
// in the job's args (`deliver.token`) and good only for posting that sync's
// titles; no user session is involved.
//
//   POST staged  {sync, ping: true}                                → {ok}
//   POST staged  {sync, asin, title, folder, file, key, bytes}     → {ok, id, relPath}

export const audibleNodeRoutes = new Hono<{ Bindings: Env }>();

audibleNodeRoutes.post('/staged', async (c) => {
  const auth = c.req.header('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return c.json({ error: 'JSON body required' }, 400);
  const sync = await authSync(c.env, body['sync'], token);
  if (!sync) return c.json({ error: 'Unknown sync or bad token' }, 401);
  // The node checks it can reach us before downloading anything.
  if (body['ping'] === true) return c.json({ ok: true });
  const r = await recordStaged(c.env, sync, body);
  if (!r.ok) return c.json({ error: r.error }, r.status);
  // Start its pull now; checking running pulls is the cron's (slow pCloud
  // stats don't fit in a waitUntil).
  c.executionCtx.waitUntil(
    audibleDeliveryPump(c.env, { checkPulls: false })
      .then((log) => { if (log.length) console.log('[audible] ' + log.join(' | ')); })
      .catch((e: Error) => console.error('[audible] pump failed: ' + e.message)),
  );
  return c.json({ ok: true, id: r.id, relPath: r.relPath });
});
