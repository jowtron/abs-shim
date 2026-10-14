import type { Env } from '../types';
import { sha256Hex } from '../auth/tokens';
import { hashPassword, passwordProblem } from '../auth/password';
import type { UserRow } from '../db/users';
import { emailConfigured, sendEmail, simpleEmail } from './email';

// Passwords: change, forget, reset (migration 0029, 2026-10-14). Until then
// nobody could change a password, there was no "forgot password", and the
// only recovery was writing a hash into D1 by hand.
//
// - A reset LINK is `<origin>/reset#t=<secret>`: the secret travels in the
//   fragment, so it never reaches a server log or a Referer; the page POSTs
//   it. Only its SHA-256 is stored. A link works once, and every unused link
//   of that user dies with the next password change, whatever made it.
// - "Forgot password?" emails one (1 hour) to the account's address. The
//   answer is the same whether or not anything was sent, so the form can't
//   be used to find out who has an account, and the sending happens after
//   the response (waitUntil), so its timing can't either.
// - The instance owner can make one in /admin to hand over by text (24 hours),
//   for an account with no email.
// - A reset signs the account out everywhere (`users.tokens_valid_after`, a
//   stamp every token must match, checked in requireAuth; refresh tokens
//   deleted) and removes its passkeys, which a stolen token could otherwise
//   have planted to outlive the reset. A change made while signed in signs
//   out only when asked, and keeps the device that made it.

export const EMAIL_LINK_TTL_MS = 60 * 60 * 1000;
export const OWNER_LINK_TTL_MS = 24 * 60 * 60 * 1000;

// Per-IP and per-account throttles share the signup limiter DO; the key
// prefix gives each its own counter.
export async function allow(env: Env, key: string, limit: number, windowMs: number): Promise<{ allowed: boolean; retryAfter: number }> {
  const stub = env.SIGNUP_LIMITER.get(env.SIGNUP_LIMITER.idFromName(key));
  return stub.fetch('https://do/limit', {
    method: 'POST',
    body: JSON.stringify({ limit, windowMs }),
  }).then((r) => r.json() as Promise<{ allowed: boolean; retryAfter: number }>);
}

function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function resetUrl(origin: string, secret: string): string {
  return `${origin.replace(/\/+$/, '')}/reset#t=${secret}`;
}

// The origin links point at: the one the request came in on, so the link
// opens where the person already is (Cloudflare routes by hostname, so it can
// only be one of this Worker's own). Not PUBLIC_ORIGIN: that is the address
// wharf nodes fetch audio from, which needn't be the one people use.
export function linkOrigin(_env: Env, requestUrl: string): string {
  return new URL(requestUrl).origin;
}

// A new link. The owner's hand-out links replace that user's earlier unused
// ones (so "Cancel" and "make another" leave exactly one live link); emailed
// links don't, so asking twice doesn't kill the first email's link.
export async function createResetLink(
  env: Env,
  userId: string,
  createdBy: string | null,
  ttlMs: number,
): Promise<{ secret: string; expiresAt: number }> {
  const secret = newSecret();
  const now = Date.now();
  const expiresAt = now + ttlMs;
  const stmts = [];
  if (createdBy) {
    stmts.push(env.DB.prepare(
      'DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL AND created_by IS NOT NULL',
    ).bind(userId));
  }
  stmts.push(env.DB.prepare(
    'INSERT INTO password_resets (token_hash, user_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(await sha256Hex(secret), userId, createdBy, now, expiresAt));
  await env.DB.batch(stmts);
  return { secret, expiresAt };
}

export async function discardOwnerLinks(env: Env, userId: string): Promise<void> {
  await env.DB.prepare(
    'DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL AND created_by IS NOT NULL',
  ).bind(userId).run();
}

// An account a reset may act on: active, approved, not locked. A link for an
// account that has since been locked stops working (it couldn't sign in anyway).
function resettable(u: UserRow): boolean {
  return u.is_active === 1 && u.is_locked !== 1 && u.signup_status === 'active';
}

export async function findResetLink(env: Env, secret: string): Promise<{ user: UserRow; expiresAt: number } | null> {
  if (!secret || secret.length > 100) return null;
  const row = await env.DB.prepare(
    'SELECT user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?',
  ).bind(await sha256Hex(secret)).first<{ user_id: string; expires_at: number; used_at: number | null }>();
  if (!row || row.used_at != null || row.expires_at <= Date.now()) return null;
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(row.user_id).first<UserRow>();
  if (!user || !resettable(user)) return null;
  return { user, expiresAt: row.expires_at };
}

// Sets a new password. `signOutEverywhere` gives the user a new token stamp,
// which every existing token then fails (the caller re-issues one for the
// device that asked, with the stamp returned here), and drops the refresh
// tokens; `dropPasskeys` removes the account's passkeys too. Every unused
// reset link of the user goes either way. Returns the new stamp, or null.
export async function setPassword(
  env: Env,
  userId: string,
  newPassword: string,
  opts: { signOutEverywhere: boolean; dropPasskeys?: boolean },
): Promise<number | null> {
  const hash = await hashPassword(newPassword);
  const gen = opts.signOutEverywhere ? Date.now() : null;
  const stmts = [
    gen != null
      ? env.DB.prepare('UPDATE users SET password_hash = ?, tokens_valid_after = ? WHERE id = ?').bind(hash, gen, userId)
      : env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, userId),
    env.DB.prepare('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL').bind(userId),
  ];
  if (gen != null) stmts.push(env.DB.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').bind(userId));
  if (opts.dropPasskeys) stmts.push(env.DB.prepare('DELETE FROM webauthn_credentials WHERE user_id = ?').bind(userId));
  await env.DB.batch(stmts);
  return gen;
}

// An address change kills the links already emailed: the old mailbox may be
// exactly why it changed.
export async function dropEmailedLinks(env: Env, userId: string): Promise<void> {
  await env.DB.prepare(
    'DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL AND created_by IS NULL',
  ).bind(userId).run();
}

export type CompleteResult =
  | { ok: true; user: UserRow }
  | { ok: false; status: 400 | 410; error: string };

export async function completeReset(env: Env, secret: string, password: string): Promise<CompleteResult> {
  const found = await findResetLink(env, secret);
  if (!found) return { ok: false, status: 410, error: 'This link has expired or has already been used. Ask for a new one.' };
  const problem = passwordProblem(password, found.user.username);
  if (problem) return { ok: false, status: 400, error: problem };
  // Claim the link before changing anything, so two submits of one link
  // can't both go through.
  const claim = await env.DB.prepare(
    'UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?',
  ).bind(Date.now(), await sha256Hex(secret), Date.now()).run();
  if (!claim.meta.changes) return { ok: false, status: 410, error: 'This link has expired or has already been used. Ask for a new one.' };
  await setPassword(env, found.user.id, password, { signOutEverywhere: true, dropPasskeys: true });
  return { ok: true, user: found.user };
}

// "Forgot password?": accounts matching a username or an email address
// (either case), that can be reset and have an address to send to. An
// address shared by several accounts gets one email per account. The
// resettable test is in the SQL, before the LIMIT, so pending or locked
// accounts sharing an address (signup doesn't verify one) can't crowd out
// the real one.
export async function accountsForLogin(env: Env, login: string): Promise<UserRow[]> {
  const q = login.trim();
  if (!q || q.length > 254) return [];
  const rows = await env.DB.prepare(
    `SELECT * FROM users
      WHERE (username = ? COLLATE NOCASE OR lower(email) = lower(?))
        AND email IS NOT NULL AND email != ''
        AND is_active = 1 AND is_locked = 0 AND signup_status = 'active'
      LIMIT 3`,
  ).bind(q, q).all<UserRow>();
  return rows.results.filter(resettable);
}

const ACCOUNT_EMAILS_PER_HOUR = 3;

// Runs after the response. Sends nothing for an account that has had three
// links this hour, so the form can't be used to flood someone's inbox.
export async function sendResetEmails(env: Env, users: UserRow[], origin: string): Promise<void> {
  if (!emailConfigured(env)) return;
  const host = new URL(origin).host;
  for (const u of users) {
    const rl = await allow(env, `reset-mail:${u.id}`, ACCOUNT_EMAILS_PER_HOUR, 60 * 60_000);
    if (!rl.allowed) {
      console.log('[password-reset] per-account limit reached, not sending');
      continue;
    }
    const { secret } = await createResetLink(env, u.id, null, EMAIL_LINK_TTL_MS);
    const { html, text } = simpleEmail({
      heading: 'Reset your password',
      paragraphs: [
        `Hi ${u.username},`,
        `Someone asked to reset the password for your account ${u.username} on ${host}. If that was you, choose a new one here.`,
      ],
      button: { label: 'Choose a new password', url: resetUrl(origin, secret) },
      footer: `The link works once and stops working in an hour. If you didn't ask for this, you can ignore this email: your password hasn't changed.`,
    });
    await sendEmail(env, { to: u.email!, subject: 'Reset your password', html, text });
  }
}

export async function sendPasswordChangedNotice(env: Env, user: UserRow, origin: string, signedOut: 'all' | 'others' | 'none'): Promise<void> {
  if (!user.email || !emailConfigured(env)) return;
  const host = new URL(origin).host;
  const out = signedOut === 'all'
    ? 'Every device that was signed in to it has been signed out, and its passkeys have been removed.'
    : signedOut === 'others' ? 'Your other devices have been signed out.' : '';
  const { html, text } = simpleEmail({
    heading: 'Your password was changed',
    paragraphs: [
      `The password for ${user.username} on ${host} was changed just now. ${out}`.trim(),
      `If this wasn't you, contact the person who runs ${host} straight away.`,
    ],
  });
  await sendEmail(env, { to: user.email, subject: 'Your password was changed', html, text });
}

// Sent to the OLD address when an account's email changes, so a change made
// by someone else with a signed-in device doesn't go unnoticed.
export async function sendEmailChangedNotice(env: Env, user: UserRow, oldEmail: string, origin: string, removed: boolean): Promise<void> {
  if (!emailConfigured(env)) return;
  const host = new URL(origin).host;
  const { html, text } = simpleEmail({
    heading: removed ? 'Your email address was removed' : 'Your email address was changed',
    paragraphs: [
      removed
        ? `This address was removed from the account ${user.username} on ${host}, so password reset links won't come here any more.`
        : `The account ${user.username} on ${host} now uses a different email address, so password reset links won't come here any more.`,
      `If this wasn't you, contact the person who runs ${host} straight away.`,
    ],
  });
  await sendEmail(env, { to: oldEmail, subject: removed ? 'Your email address was removed' : 'Your email address was changed', html, text });
}

// A loose sanity check, not RFC 5322: one @, something either side, a dot in
// the domain, no spaces, and a length any mail system accepts.
export function plausibleEmail(s: string): boolean {
  return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
