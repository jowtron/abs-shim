import type { Env } from '../types';
import { sha256Hex } from '../auth/tokens';

// Keys the catalogue's wharf nodes send as X-Node-Key instead of signing in
// as the owner (migration 0030). Made and revoked by the instance owner in
// /admin; only the hash is stored, so a key is shown once and never again.

export type NodeKey = { id: string; name: string; created_at: number; last_used_at: number | null };

const PREFIX = 'rnk_';
const TOUCH_EVERY_MS = 60_000;

export const NODE_NAME_RE = /^[\w.-]{1,40}$/;

export async function createNodeKey(env: Env, name: string, createdBy: string): Promise<{ id: string; name: string; key: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = PREFIX + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const id = 'nk_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  await env.DB.prepare(
    'INSERT INTO node_keys (id, name, key_hash, created_at, created_by) VALUES (?, ?, ?, ?, ?)',
  ).bind(id, name, await sha256Hex(key), Date.now(), createdBy).run();
  return { id, name, key };
}

export async function listNodeKeys(env: Env): Promise<NodeKey[]> {
  const rows = await env.DB.prepare(
    'SELECT id, name, created_at, last_used_at FROM node_keys WHERE revoked_at IS NULL ORDER BY name, created_at',
  ).all<NodeKey>();
  return rows.results;
}

export async function revokeNodeKey(env: Env, id: string): Promise<boolean> {
  const r = await env.DB.prepare(
    'UPDATE node_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
  ).bind(Date.now(), id).run();
  return (r.meta.changes ?? 0) > 0;
}

// Looked up by hash: the key is 256 random bits, so an equality lookup on
// its SHA-256 says nothing a timing attack could use.
export async function nodeForKey(env: Env, key: string): Promise<NodeKey | null> {
  if (!key.startsWith(PREFIX) || key.length > 100) return null;
  return env.DB.prepare(
    'SELECT id, name, created_at, last_used_at FROM node_keys WHERE key_hash = ? AND revoked_at IS NULL',
  ).bind(await sha256Hex(key)).first<NodeKey>();
}

// Nodes call every few seconds; a write per call would be most of the
// table's traffic for a "last used" that only needs the minute.
export async function touchNodeKey(env: Env, k: NodeKey): Promise<void> {
  const now = Date.now();
  if (k.last_used_at && now - k.last_used_at < TOUCH_EVERY_MS) return;
  await env.DB.prepare(
    'UPDATE node_keys SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)',
  ).bind(now, k.id, now - TOUCH_EVERY_MS).run();
}
