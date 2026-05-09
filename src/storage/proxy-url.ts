// HMAC-signed proxy URL minting + verification.
//
// Used by adapters that can't 302 directly to their storage (WebDAV — no
// presigned URL concept). The Worker mints a URL like
//   /public/proxy/<folderId>/<relPath>?exp=<ms>&sig=<hex>
// and the proxy route validates the signature + expiry before fetching from
// the backend and streaming bytes to the client.
//
// Signing key = JWT_SECRET. We don't introduce a new secret — JWT_SECRET is
// already required for the auth flow and is already a 32+ byte random value.

import type { Env } from '../types';

const enc = new TextEncoder();

const STREAM_EXPIRES_MS = 6 * 60 * 60 * 1000;       // 6h, like S3 presigned default
const PROBE_EXPIRES_MS = 60 * 60 * 1000;            // 1h

export type ProxyKind = 'stream' | 'probe';

export async function signProxyUrl(opts: {
  env: Env;
  origin: string;             // 'https://abs-shim.workers.dev' — base for absolute URL
  folderId: string;
  relPath: string;
  kind: ProxyKind;
}): Promise<{ url: string; expiresAt: number }> {
  const expiresAt = Date.now() + (opts.kind === 'stream' ? STREAM_EXPIRES_MS : PROBE_EXPIRES_MS);
  const sig = await sign(opts.env, opts.folderId, opts.relPath, expiresAt);
  const u = new URL(opts.origin);
  u.pathname = `/public/proxy/${encodeURIComponent(opts.folderId)}/${opts.relPath.split('/').map(encodeURIComponent).join('/')}`;
  u.searchParams.set('exp', String(expiresAt));
  u.searchParams.set('sig', sig);
  return { url: u.toString(), expiresAt };
}

export async function verifyProxyUrl(opts: {
  env: Env;
  folderId: string;
  relPath: string;
  exp: string;
  sig: string;
}): Promise<boolean> {
  const expMs = Number(opts.exp);
  if (!Number.isFinite(expMs) || expMs < Date.now()) return false;
  const expected = await sign(opts.env, opts.folderId, opts.relPath, expMs);
  // Constant-time string compare.
  if (expected.length !== opts.sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ opts.sig.charCodeAt(i);
  return diff === 0;
}

async function sign(env: Env, folderId: string, relPath: string, expMs: number): Promise<string> {
  const secret = env.JWT_SECRET ?? '';
  if (!secret) throw new Error('JWT_SECRET not configured');
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign'],
  );
  const msg = `${folderId}|${relPath}|${expMs}`;
  const sigBytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
  return Array.from(sigBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
