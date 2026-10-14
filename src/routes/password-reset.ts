import { Hono } from 'hono';
import type { Env } from '../types';
import { verifyTurnstile, sendPushover } from '../lib/notify';
import { emailConfigured } from '../lib/email';
import {
  allow, accountsForLogin, sendResetEmails, findResetLink, completeReset,
  linkOrigin, sendPasswordChangedNotice,
} from '../lib/password-reset';

// Public "Forgot password?" API, mounted at /api/password-reset. The page is
// /reset (src/lib/reset-html.ts); the rules are in src/lib/password-reset.ts.

export const passwordResetRoutes = new Hono<{ Bindings: Env }>();

const SENT_MESSAGE = 'If that account has an email address, a link to reset its password is on its way. It works for an hour. Check your spam folder if it doesn’t arrive.';

// Body: { login: username or email, turnstileToken }.
passwordResetRoutes.post('/request', async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const rl = await allow(c.env, `reset:${ip}`, 5, 15 * 60_000);
  if (!rl.allowed) {
    return c.json({ error: 'Too many attempts. Please try again later.' }, 429, { 'Retry-After': String(rl.retryAfter) });
  }
  const body = await c.req.json().catch(() => null) as { login?: string; turnstileToken?: string } | null;
  if (!(await verifyTurnstile(c.env, body?.turnstileToken, ip))) {
    return c.json({ error: 'Verification failed. Please retry the challenge.' }, 403);
  }
  const login = body?.login?.trim() ?? '';
  if (!login) return c.json({ error: 'Enter your username or email address.' }, 400);
  // Saying so tells nobody anything about any account, and beats a promise
  // of an email that can never come.
  if (!emailConfigured(c.env)) {
    return c.json({ error: 'This server can’t send email. Ask the person who runs it for a reset link.' }, 503);
  }
  const origin = linkOrigin(c.env, c.req.url);
  c.executionCtx.waitUntil(
    accountsForLogin(c.env, login)
      .then((users) => sendResetEmails(c.env, users, origin))
      .catch((e) => console.log('[password-reset] request failed', e instanceof Error ? e.message : String(e))),
  );
  return c.json({ ok: true, message: SENT_MESSAGE });
});

// Throttles guessing at links (hopeless at 256 bits, but cheap to bound).
async function tryLimit(c: { env: Env; req: { header: (n: string) => string | undefined } }) {
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  return allow(c.env, `reset-try:${ip}`, 30, 15 * 60_000);
}

// Body: { token } → { valid, username?, expiresAt? }. The page asks first so
// a dead link says so before anyone types a new password.
passwordResetRoutes.post('/check', async (c) => {
  const rl = await tryLimit(c);
  if (!rl.allowed) return c.json({ error: 'Too many attempts. Please try again later.' }, 429, { 'Retry-After': String(rl.retryAfter) });
  const body = await c.req.json().catch(() => null) as { token?: string } | null;
  const found = await findResetLink(c.env, body?.token ?? '');
  if (!found) return c.json({ valid: false });
  return c.json({ valid: true, username: found.user.username, expiresAt: found.expiresAt });
});

// Body: { token, password } → { ok, username }.
passwordResetRoutes.post('/complete', async (c) => {
  const rl = await tryLimit(c);
  if (!rl.allowed) return c.json({ error: 'Too many attempts. Please try again later.' }, 429, { 'Retry-After': String(rl.retryAfter) });
  const body = await c.req.json().catch(() => null) as { token?: string; password?: string } | null;
  if (typeof body?.password !== 'string') return c.json({ error: 'Choose a new password.' }, 400);
  const r = await completeReset(c.env, body.token ?? '', body.password);
  if (!r.ok) return c.json({ error: r.error }, r.status);
  const origin = linkOrigin(c.env, c.req.url);
  c.executionCtx.waitUntil(Promise.all([
    sendPasswordChangedNotice(c.env, r.user, origin, 'all'),
    sendPushover(c.env, { title: 'Rhapsode — password reset', message: `${r.user.username} reset their password.` }),
  ]).then(() => {}));
  return c.json({ ok: true, username: r.user.username });
});
