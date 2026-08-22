// Encryption at rest for per-tenant secrets (ABB password, Real-Debrid
// token, ABB session cookie) in D1. AES-256-GCM with a key from the
// SETTINGS_KEY wrangler secret (base64, 32 bytes). Without the key the
// routes refuse to store secrets rather than silently falling back to
// plaintext. Stored form: "enc:v1:<iv b64>:<ciphertext+tag b64>".
//
// Values that don't carry the prefix are returned as-is so rows written
// before this existed keep working; they are re-encrypted the next time
// they're saved.

import type { Env } from '../types';

const PREFIX = 'enc:v1:';

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function importKey(env: Env): Promise<CryptoKey> {
  if (!env.SETTINGS_KEY) {
    throw new Error('SETTINGS_KEY is not configured (wrangler secret put SETTINGS_KEY — 32 random bytes, base64)');
  }
  const raw = unb64(env.SETTINGS_KEY.trim());
  if (raw.byteLength !== 32) throw new Error('SETTINGS_KEY must decode to exactly 32 bytes');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function sealSecret(env: Env, plaintext: string): Promise<string> {
  const key = await importKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return `${PREFIX}${b64(iv)}:${b64(new Uint8Array(ct))}`;
}

export async function openSecret(env: Env, stored: string | null): Promise<string | null> {
  if (stored == null) return null;
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext row
  const [ivB64, ctB64] = stored.slice(PREFIX.length).split(':');
  if (!ivB64 || !ctB64) throw new Error('Corrupt encrypted setting');
  const key = await importKey(env);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB64) }, key, unb64(ctB64));
  return new TextDecoder().decode(pt);
}

export const secretsConfigured = (env: Env): boolean => !!env.SETTINGS_KEY;
