// The `accessToken` cookie that keeps the same-origin pages (the bundled ABS
// web UI and /admin) signed in.
//
// It used to be Max-Age=3600 while the token inside it was good for 30 days,
// so the browser threw away a perfectly valid session after an hour and the
// admin page asked for a password again every visit — Pholia, holding the
// same token in localStorage, stayed signed in for a month. The cookie now
// matches the token's own lifetime; shortening it never bought any security,
// since the token is equally valid either way.
//
// `Secure` is added only on https so local http dev still works.

import { ACCESS_TTL_SECONDS } from './tokens';

export function sessionCookie(token: string, requestUrl: string): string {
  const secure = requestUrl.startsWith('https://') ? '; Secure' : '';
  return `accessToken=${token}; Path=/; Max-Age=${ACCESS_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure}`;
}

export function clearSessionCookie(requestUrl: string): string {
  const secure = requestUrl.startsWith('https://') ? '; Secure' : '';
  return `accessToken=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
}
