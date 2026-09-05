import { createMiddleware } from 'hono/factory';
import type { Env } from '../types';
import { verifyAccessToken, type AccessClaims } from './tokens';
import { findUserById, type UserRow } from '../db/users';
import { getActiveMembership, type TenantRole } from '../db/tenants';
import { membersCanAdd } from '../db/settings';

export type AuthVars = {
  userId: string;
  user: UserRow;
  claims: AccessClaims;
  // The tenant this request acts within, resolved from the user's membership.
  // Every tenant-scoped query reads this via c.get('tenantId'). Resolved here
  // (not from the JWT) so a membership change / tenant switch takes effect
  // without re-issuing the 30-day access token.
  tenantId: string;
  tenantRole: TenantRole;
};

// Requires a valid access token. We accept it from any of:
//   1. Authorization: Bearer <jwt>     (typical API client / fetch with creds)
//   2. ?token=<jwt> query              (audio/img elements that can't set headers)
//   3. accessToken=<jwt> cookie        (the bundled web UI on the same origin)
export const requireAuth = createMiddleware<{ Bindings: Env; Variables: AuthVars }>(
  async (c, next) => {
    const token =
      bearerToken(c.req.raw)
      ?? c.req.query('token')
      ?? cookieToken(c.req.raw);
    if (!token) return c.json({ error: 'Unauthorized' }, 401);

    const claims = await verifyAccessToken(c.env, token);
    if (!claims) return c.json({ error: 'Unauthorized' }, 401);

    const user = await findUserById(c.env, claims.userId);
    if (!user || user.is_active !== 1 || user.is_locked === 1) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // Resolve the active tenant from membership. `?tenant=` lets a multi-tenant
    // user switch context for a single request (validated against membership).
    const membership = await getActiveMembership(c.env, user.id, c.req.query('tenant'));
    if (!membership) return c.json({ error: 'No tenant membership' }, 403);

    c.set('userId', user.id);
    c.set('user', user);
    c.set('claims', claims);
    c.set('tenantId', membership.tenantId);
    c.set('tenantRole', membership.role);
    await next();
  },
);

// Owner-only gate for anything that changes the shape of the tenant's
// library or spends the owner's accounts irreversibly: connecting or
// removing storage, deleting books (and their files), inviting members,
// crawler control. A member with all of that was the state of things until
// 2026-09-05 — every admin route was open to any active member.
export const requireTenantOwner = createMiddleware<{ Bindings: Env; Variables: AuthVars }>(
  async (c, next) => {
    if (c.get('tenantRole') !== 'owner') {
      return c.json({ error: 'Only the library owner can do this' }, 403);
    }
    return next();
  },
);

// "May add books": the owner always, members only when the tenant's
// members_can_add switch is on. Covers uploads, fetch-from-URL, zip extract,
// add-by-path, AudioBookBay grabs (resolve + Real-Debrid) and Audible.
export async function canAddBooks(c: { env: Env; get: (k: 'tenantRole' | 'tenantId') => string }): Promise<boolean> {
  if (c.get('tenantRole') === 'owner') return true;
  return membersCanAdd(c.env, c.get('tenantId'));
}

export const requireCanAdd = createMiddleware<{ Bindings: Env; Variables: AuthVars }>(
  async (c, next) => {
    if (!(await canAddBooks(c))) {
      return c.json({ error: 'The library owner has not enabled adding books for members' }, 403);
    }
    return next();
  },
);

function bearerToken(req: Request): string | null {
  const h = req.headers.get('authorization');
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]! : null;
}

function cookieToken(req: Request): string | null {
  const h = req.headers.get('cookie');
  if (!h) return null;
  for (const pair of h.split(/;\s*/)) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq);
    if (name === 'accessToken') return decodeURIComponent(pair.slice(eq + 1));
  }
  return null;
}
