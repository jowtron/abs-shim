import type { Env } from '../types';

export async function insertRefreshToken(env: Env, args: {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: number;
  deviceInfo?: Record<string, unknown>;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, device_info, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    args.id, args.userId, args.tokenHash, args.expiresAt,
    JSON.stringify(args.deviceInfo ?? {}), Date.now(),
  ).run();
}

export async function findRefreshTokenByHash(env: Env, hash: string) {
  return env.DB.prepare(
    `SELECT id, user_id, expires_at FROM refresh_tokens WHERE token_hash = ?`,
  ).bind(hash).first<{ id: string; user_id: string; expires_at: number }>();
}

export async function deleteRefreshToken(env: Env, id: string): Promise<void> {
  await env.DB.prepare('DELETE FROM refresh_tokens WHERE id = ?').bind(id).run();
}
