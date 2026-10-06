import { Hono } from 'hono';
import type { Env } from '../types';
import { keyMatches, recordReport, type NodeReport } from '../lib/node-health';

// POST /api/node-health — a wharf node's hourly "is rclone's pCloud token
// still accepted?" report (ops/pcloud-health/). Not user auth: the nodes
// hold one shared key, the NODE_HEALTH_KEY secret, and nothing else. All
// the decisions (what counts as revoked, when to push) are in
// src/lib/node-health.ts.
export const nodeHealthRoutes = new Hono<{ Bindings: Env }>();

nodeHealthRoutes.post('/', async (c) => {
  const expected = c.env.NODE_HEALTH_KEY;
  if (!expected) return c.json({ error: 'not configured' }, 503);
  const given = (c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!given || !(await keyMatches(given, expected))) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json<Partial<NodeReport>>().catch(() => null);
  const node = typeof body?.node === 'string' ? body.node.trim() : '';
  if (!body || !/^[\w.-]{1,40}$/.test(node) || typeof body.ok !== 'boolean') {
    return c.json({ error: 'expected {node, ok, exitCode?, output?, uses?}' }, 400);
  }
  const report: NodeReport = { node, ok: body.ok };
  if (typeof body.exitCode === 'number') report.exitCode = body.exitCode;
  if (typeof body.output === 'string') report.output = body.output;
  if (typeof body.uses === 'string') report.uses = body.uses;
  return c.json(await recordReport(c.env, report));
});
