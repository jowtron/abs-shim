import { Hono } from 'hono';
import type { Env } from '../types';
import { hashPassword } from '../auth/password';
import { findUserByUsername, insertUser } from '../db/users';
import { getSignupMode } from '../db/settings';
import { getRedeemableInvite } from '../db/invites';
import { verifyTurnstile, sendPushover } from '../lib/notify';

// Public, unauthenticated self-serve signup. Mounted at /api/signup.
//
// Two paths:
//   - With a valid invite code → the user is created ACTIVE and joins the
//     invite's tenant as a member immediately (the invite IS the
//     authorization). This is the "join my household" / family-sharing path.
//   - Without an invite → approval-based: a *pending* user (is_active=0) with
//     NO tenant; the instance owner approves it from /admin, which activates
//     the user and provisions their own tenant. /login blocks inactive users.
//
// Abuse controls (this endpoint is reachable by anyone):
//   - per-IP rate limit via SignupRateLimitDO (in-memory wouldn't survive the
//     stateless isolate model);
//   - a global cap on outstanding pending rows, so an IP-rotating botnet still
//     can't bury real signups or hammer D1 writes;
//   - uniform responses that never reveal whether a username/email exists.

export const signupRoutes = new Hono<{ Bindings: Env }>();

const REGISTER_LIMIT = 5;                 // attempts per IP per window
const REGISTER_WINDOW_MS = 10 * 60_000;   // 10 minutes
const MAX_PENDING = 50;                    // instance-wide outstanding cap

signupRoutes.post('/register', async (c) => {
  // Per-IP throttle first — cheapest rejection, and runs before any DB work.
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const stub = c.env.SIGNUP_LIMITER.get(c.env.SIGNUP_LIMITER.idFromName(ip));
  const rl = await stub.fetch('https://do/limit', {
    method: 'POST',
    body: JSON.stringify({ limit: REGISTER_LIMIT, windowMs: REGISTER_WINDOW_MS }),
  }).then((r) => r.json() as Promise<{ allowed: boolean; retryAfter: number }>);
  if (!rl.allowed) {
    return c.json(
      { error: 'Too many signup attempts. Please try again later.' },
      429,
      { 'Retry-After': String(rl.retryAfter) },
    );
  }

  const body = await c.req.json().catch(() => null) as
    { username?: string; password?: string; email?: string; turnstileToken?: string; inviteCode?: string } | null;

  // Bot defense — verify the Turnstile token (no-op until TURNSTILE_SECRET set).
  if (!(await verifyTurnstile(c.env, body?.turnstileToken, ip))) {
    return c.json({ error: 'Verification failed. Please retry the challenge.' }, 403);
  }

  const username = body?.username?.trim();
  const password = body?.password;
  const email = body?.email?.trim() || null;
  const inviteCode = body?.inviteCode?.trim();
  if (!username || !password) {
    return c.json({ error: 'username and password are required' }, 400);
  }
  // Password rules: ≥ 10 chars and not equal to the username.
  if (password.length < 10) {
    return c.json({ error: 'Password must be at least 10 characters.' }, 400);
  }
  if (password.toLowerCase() === username.toLowerCase()) {
    return c.json({ error: 'Password must not match the username.' }, 400);
  }

  // ── Invite path: active immediately, joins the invite's tenant ──────────────
  if (inviteCode) {
    const invite = await getRedeemableInvite(c.env, inviteCode);
    if (!invite || !invite.tenant_id) {
      return c.json({ error: 'This invite is invalid or has expired.' }, 400);
    }
    // A valid invite is an authorized join, so a clear "username taken" here is
    // acceptable (and lets the invitee retry without burning the invite).
    if (await findUserByUsername(c.env, username)) {
      return c.json({ error: 'That username is taken — please choose another.' }, 409);
    }
    const now = Date.now();
    const userId = crypto.randomUUID();
    await insertUser(c.env, {
      id: userId, username, email, type: 'user',
      password_hash: await hashPassword(password), google_sub: null,
      is_active: 1, is_locked: 0, signup_status: 'active',
      permissions: '{}', libraries_accessible: '[]', item_tags_selected: '[]',
      created_at: now, last_seen: null,
    });
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO tenant_members (tenant_id, user_id, role, is_default, created_at) VALUES (?, ?, ?, 1, ?)`,
      ).bind(invite.tenant_id, userId, invite.role || 'member', now),
      c.env.DB.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?').bind(userId, now, invite.code),
    ]);
    c.executionCtx.waitUntil(sendPushover(c.env, {
      title: 'ABS Shim — member joined',
      message: `${username} joined a shared library via invite.`,
    }));
    return c.json({ status: 'active', message: 'Your account is ready — you can sign in now.' });
  }

  // ── No invite → approval path ───────────────────────────────────────────────
  if ((await getSignupMode(c.env)) === 'closed') {
    return c.json({ error: 'Signups are currently closed.' }, 403);
  }

  // Global pending cap — bounds DB abuse even past the per-IP throttle.
  const pending = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM users WHERE signup_status = 'pending'`,
  ).first<{ n: number }>();
  if ((pending?.n ?? 0) >= MAX_PENDING) {
    return c.json({ error: 'Signups are temporarily unavailable. Please try again later.' }, 503);
  }

  // Enumeration-safe: never reveal whether the username/email is taken. If it
  // exists we simply don't create a duplicate, and return the same response.
  const existing = await findUserByUsername(c.env, username);
  if (!existing) {
    const now = Date.now();
    await insertUser(c.env, {
      id: crypto.randomUUID(),
      username,
      email,
      type: 'user',
      password_hash: await hashPassword(password),
      google_sub: null,
      is_active: 0,            // pending — /login rejects is_active != 1
      is_locked: 0,
      signup_status: 'pending',
      permissions: '{}',
      libraries_accessible: '[]',
      item_tags_selected: '[]',
      created_at: now,
      last_seen: null,
    });
    // Ping the owner (best-effort, non-blocking). Only on a genuinely new
    // request, so a duplicate-username probe can't be used to spam pushes.
    c.executionCtx.waitUntil(sendPushover(c.env, {
      title: 'ABS Shim — new access request',
      message: `${username}${email ? ` (${email})` : ''} requested an account.`,
      url: 'https://abs-shim.jderrick.app/admin',
      urlTitle: 'Review in admin',
      priority: 1, // high — surface it past quiet hours
    }));
  }

  return c.json({ status: 'pending', message: 'Your account has been submitted and is awaiting approval.' });
});
