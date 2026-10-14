import { Hono, type Context } from 'hono';
import type { Env } from '../types';
import { requireAuth, type AuthVars } from '../auth/middleware';
import { verifyPassword, passwordProblem } from '../auth/password';
import { issueAccessToken } from '../auth/tokens';
import { sessionCookie } from '../auth/cookie';
import { emailConfigured } from '../lib/email';
import {
  allow, setPassword, dropEmailedLinks, linkOrigin, plausibleEmail,
  sendPasswordChangedNotice, sendEmailChangedNotice,
} from '../lib/password-reset';

// The signed-in user's own account: email and password. Mounted at /api/me
// beside the ABS routes there. GET/PATCH /account are shim-only (/admin's
// "Your account" card); PATCH /password is ABS's own change-password route
// (MeController.updatePassword), so the bundled web UI's Account page and any
// ABS app that offers it work too. src/lib/password-reset.ts has the rules.

type C = Context<{ Bindings: Env; Variables: AuthVars }>;

export const accountRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>();

accountRoutes.get('/account', requireAuth, (c) => {
  const u = c.get('user');
  return c.json({
    id: u.id,
    username: u.username,
    email: u.email,
    type: u.type,
    hasPassword: u.password_hash !== null,
    emailEnabled: emailConfigured(c.env),
  });
});

type Change = { currentPassword: string; email?: string | null; newPassword?: string; signOutOthers?: boolean };
type ChangeResult =
  | { ok: true; email: string | null; passwordChanged: boolean; accessToken: string | null }
  | { ok: false; status: 400 | 403 | 429; error: string };

// Both routes come here. Every change needs the current password: a device
// left signed in must not be enough to move the account's recovery address
// or lock its owner out. Ten tries per account per 15 minutes.
async function applyChange(c: C, ch: Change): Promise<ChangeResult> {
  const user = c.get('user');
  if (user.password_hash === null) {
    return { ok: false, status: 400, error: 'This account has no password. Ask the person who runs the server for a reset link.' };
  }
  const rl = await allow(c.env, `pw-check:${user.id}`, 10, 15 * 60_000);
  if (!rl.allowed) return { ok: false, status: 429, error: 'Too many attempts. Please try again later.' };
  if (!(await verifyPassword(ch.currentPassword, user.password_hash))) {
    return { ok: false, status: 403, error: 'Invalid password' };
  }

  let email = user.email;
  const emailChanging = ch.email !== undefined && (ch.email?.trim() || null) !== (user.email || null);
  if (emailChanging) {
    email = ch.email?.trim() || null;
    if (email && !plausibleEmail(email)) return { ok: false, status: 400, error: 'That doesn’t look like an email address.' };
  }
  const newPassword = ch.newPassword ?? '';
  if (newPassword) {
    const problem = passwordProblem(newPassword, user.username);
    if (problem) return { ok: false, status: 400, error: problem };
  }

  if (emailChanging) {
    await c.env.DB.prepare('UPDATE users SET email = ? WHERE id = ?').bind(email, user.id).run();
    await dropEmailedLinks(c.env, user.id);
  }
  let accessToken: string | null = null;
  if (newPassword) {
    const gen = await setPassword(c.env, user.id, newPassword, { signOutEverywhere: !!ch.signOutOthers });
    if (gen != null) {
      // The new stamp just killed this device's token too: hand it a new one.
      accessToken = (await issueAccessToken(c.env, { id: user.id, username: user.username, tokens_valid_after: gen })).token;
      c.header('Set-Cookie', sessionCookie(accessToken, c.req.url), { append: true });
    }
  }

  const origin = linkOrigin(c.env, c.req.url);
  const notices: Promise<void>[] = [];
  if (emailChanging && user.email) notices.push(sendEmailChangedNotice(c.env, user, user.email, origin, !email));
  if (newPassword) notices.push(sendPasswordChangedNotice(c.env, { ...user, email }, origin, ch.signOutOthers ? 'others' : 'none'));
  if (notices.length) c.executionCtx.waitUntil(Promise.all(notices).then(() => {}));
  return { ok: true, email, passwordChanged: !!newPassword, accessToken };
}

// Body: { currentPassword, email?: string|null, newPassword?, signOutOthers? }
// → { ok, email, passwordChanged, accessToken (only when signed out others) }.
accountRoutes.patch('/account', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (typeof body?.['currentPassword'] !== 'string') return c.json({ error: 'Enter your current password.' }, 400);
  const ch: Change = { currentPassword: body['currentPassword'] };
  if (body['email'] === null || typeof body['email'] === 'string') ch.email = body['email'] as string | null;
  if (typeof body['newPassword'] === 'string') ch.newPassword = body['newPassword'];
  if (body['signOutOthers'] === true) ch.signOutOthers = true;
  if (ch.email === undefined && !ch.newPassword) return c.json({ error: 'Nothing to change.' }, 400);
  const r = await applyChange(c, ch);
  if (!r.ok) return c.json({ error: r.error }, r.status);
  return c.json(r);
});

// ABS: body { password, newPassword } → 200 { success: true }, or 200
// { error } (ABS answers a wrong password with 200 and an error message, and
// its web UI shows `error`). Never signs other devices out: ABS doesn't.
accountRoutes.patch('/password', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null) as { password?: unknown; newPassword?: unknown } | null;
  if (typeof body?.password !== 'string' || typeof body?.newPassword !== 'string' || !body.newPassword) {
    return c.json({ error: 'Invalid password or new password' }, 400);
  }
  const r = await applyChange(c, { currentPassword: body.password, newPassword: body.newPassword });
  if (!r.ok) return r.status === 429 ? c.json({ error: r.error }, 429) : c.json({ error: r.error });
  return c.json({ success: true });
});
