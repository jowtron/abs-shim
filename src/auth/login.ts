// Which account a /login is for. The "username" field may also hold the
// account's email address (2026-10-14): Joseph signed in to Pholia with his
// email, which /reset accepts, and /login said "Invalid credentials". A real
// username always wins, so nothing that signed in before signs in elsewhere.

import type { Env } from '../types';
import { findUserByUsername, type UserRow } from '../db/users';
import { verifyPassword } from './password';

// Verified against when nobody matched, so an unknown username or email
// costs the same PBKDF2 as a wrong password: /reset goes to some trouble not
// to say which addresses have accounts, and timing here would undo that.
const NOBODY_HASH = 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export type LoginMatch =
  | { ok: true; user: UserRow }
  | { ok: false; ambiguous: boolean };

export async function findLoginAccount(env: Env, login: string, password: string): Promise<LoginMatch> {
  const byName = await findUserByUsername(env, login);
  if (byName) {
    const ok = await verifyPassword(password, byName.password_hash ?? NOBODY_HASH);
    return ok && byName.password_hash !== null ? { ok: true, user: byName } : { ok: false, ambiguous: false };
  }

  const email = login.trim();
  // Emails aren't unique (signup never refuses a taken one, or it would say
  // who has an account), so the password picks among the accounts using it.
  const candidates = email.includes('@')
    ? (await env.DB.prepare(
        `SELECT * FROM users
          WHERE lower(email) = lower(?) AND email != '' AND password_hash IS NOT NULL
          LIMIT 3`,
      ).bind(email).all<UserRow>()).results
    : [];
  if (candidates.length === 0) {
    await verifyPassword(password, NOBODY_HASH);
    return { ok: false, ambiguous: false };
  }
  const matches: UserRow[] = [];
  for (const u of candidates) {
    if (await verifyPassword(password, u.password_hash!)) matches.push(u);
  }
  // Two accounts with this address AND this password: refuse rather than
  // guess. Said only to someone who has just proved the password.
  if (matches.length > 1) return { ok: false, ambiguous: true };
  return matches[0] ? { ok: true, user: matches[0] } : { ok: false, ambiguous: false };
}
