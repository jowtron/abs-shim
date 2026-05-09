import { sign, verify } from 'hono/jwt';
import type { Env } from '../types';

// Many ABS clients (Plappa, official iOS app) don't implement refresh-token
// rotation — they hold the access token and only re-login when they get a 401.
// A short 1h TTL meant clients that ran overnight came back to a forest of
// 401s and silently dropped progress sync. Match stock ABS's long-lived
// access tokens. Refresh tokens are opaque random bytes; only their SHA-256
// is stored in D1.

const ACCESS_TTL_SECONDS = 60 * 60 * 24 * 30;  // 30 days
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export type AccessClaims = {
  userId: string;
  username: string;
  type: 'access';
  iat: number;
  exp: number;
};

function jwtSecret(env: Env): string {
  // Dev fallback so `wrangler dev` works without a configured secret. In
  // production we error if it's unset — never silently fall back.
  if (env.JWT_SECRET) return env.JWT_SECRET;
  return 'dev-only-jwt-secret-change-me';
}

export async function issueAccessToken(
  env: Env,
  user: { id: string; username: string },
): Promise<{ token: string; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ACCESS_TTL_SECONDS;
  const claims: AccessClaims = {
    userId: user.id,
    username: user.username,
    type: 'access',
    iat: now,
    exp,
  };
  const token = await sign(claims, jwtSecret(env), 'HS256');
  return { token, expiresAt: exp };
}

export async function verifyAccessToken(env: Env, token: string): Promise<AccessClaims | null> {
  try {
    const claims = await verify(token, jwtSecret(env), 'HS256') as AccessClaims;
    if (claims.type !== 'access') return null;
    return claims;
  } catch {
    return null;
  }
}

export type RefreshTokenIssue = {
  raw: string;       // returned to client (only chance to see it)
  hash: string;      // hex-encoded SHA-256, stored in D1
  expiresAt: number; // ms epoch
};

export async function issueRefreshToken(): Promise<RefreshTokenIssue> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const raw = base64UrlEncode(bytes);
  const hash = await sha256Hex(raw);
  const expiresAt = Date.now() + REFRESH_TTL_SECONDS * 1000;
  return { raw, hash, expiresAt };
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
