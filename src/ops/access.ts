// Cloudflare Access gate for the internal /ops surface.
//
// The Access application sits in front of /ops and /api/ops at the edge, so a
// caller without a valid Access session is bounced to CF's login BEFORE the
// request reaches this Worker. But this Worker's origin is ALSO publicly
// reachable on the same hostname (it serves /login, /status, the ABS API), so
// a direct origin hit can bypass Access. The `Cf-Access-Authenticated-User-Email`
// header alone is therefore forgeable — we MUST verify the signed
// `Cf-Access-Jwt-Assertion` (RS256, signed by the team's keys) ourselves.
// This middleware is defense-in-depth on top of the edge Access policy.

import { createMiddleware } from 'hono/factory';
import type { Env } from '../types';

type Jwk = { kid: string; kty: string; n: string; e: string; alg?: string };

// Module-scoped caches (persist across requests within an isolate).
let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;
const importedKeys = new Map<string, CryptoKey>();
const JWKS_TTL_MS = 60 * 60 * 1000; // 1h

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeSegment(seg: string): Record<string, unknown> | null {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(seg))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function teamBase(env: Env): string | null {
  const t = env.OPS_ACCESS_TEAM_DOMAIN?.trim();
  if (!t) return null;
  return (t.startsWith('http') ? t : `https://${t}`).replace(/\/$/, '');
}

async function getSigningKey(env: Env, kid: string): Promise<CryptoKey | null> {
  const cached = importedKeys.get(kid);
  if (cached) return cached;

  const base = teamBase(env);
  if (!base) return null;

  if (!jwksCache || Date.now() - jwksCache.fetchedAt > JWKS_TTL_MS) {
    const res = await fetch(`${base}/cdn-cgi/access/certs`);
    if (!res.ok) return null;
    const body = (await res.json()) as { keys?: Jwk[] };
    jwksCache = { keys: body.keys ?? [], fetchedAt: Date.now() };
    importedKeys.clear();
  }

  const jwk = jwksCache.keys.find((k) => k.kid === kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  importedKeys.set(kid, key);
  return key;
}

// Verify a CF Access JWT and return the authenticated email, or null if the
// token is missing/invalid/expired or fails the aud/iss checks.
export async function verifyAccessJwt(env: Env, token: string): Promise<string | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const h = parts[0]!, p = parts[1]!, s = parts[2]!;
  const header = decodeSegment(h);
  const payload = decodeSegment(p);
  if (!header || !payload) return null;
  const kid = header['kid'];
  if (header['alg'] !== 'RS256' || typeof kid !== 'string') return null;

  const key = await getSigningKey(env, kid);
  if (!key) return null;

  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload['exp'] === 'number' && payload['exp'] < now) return null;
  if (typeof payload['nbf'] === 'number' && payload['nbf'] > now + 60) return null;

  const aud = env.OPS_ACCESS_AUD?.trim();
  if (aud) {
    const auds = Array.isArray(payload['aud']) ? payload['aud'] : [payload['aud']];
    if (!auds.includes(aud)) return null;
  }

  const base = teamBase(env);
  if (base && typeof payload['iss'] === 'string' && payload['iss'].replace(/\/$/, '') !== base) {
    return null;
  }

  const email = typeof payload['email'] === 'string' ? payload['email'].trim().toLowerCase() : '';
  return email || null;
}

// Hono middleware: require a valid CF Access assertion whose email is in the
// allowlist. Default-deny if the allowlist or team domain is unconfigured.
export const requireOpsAccess = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const token = c.req.header('Cf-Access-Jwt-Assertion');
  if (!token) return c.json({ error: 'Unauthorized — Cloudflare Access required' }, 401);

  const email = await verifyAccessJwt(c.env, token);
  if (!email) return c.json({ error: 'Unauthorized — invalid Access token' }, 401);

  const allow = (c.env.OPS_ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (allow.length === 0 || !allow.includes(email)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  await next();
});
