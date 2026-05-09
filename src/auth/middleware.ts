import { createMiddleware } from 'hono/factory';
import type { Env } from '../types';
import { verifyAccessToken, type AccessClaims } from './tokens';
import { findUserById, type UserRow } from '../db/users';

export type AuthVars = {
  userId: string;
  user: UserRow;
  claims: AccessClaims;
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

    c.set('userId', user.id);
    c.set('user', user);
    c.set('claims', claims);
    await next();
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
