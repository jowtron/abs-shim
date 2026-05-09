import type { Env } from '../types';

export type ListeningSessionRow = {
  id: string;
  user_id: string;
  library_item_id: string | null;
  display_title: string | null;
  display_author: string | null;
  duration_seconds: number;
  play_method: number;
  media_player: string | null;
  device_info: string;
  server_version: string | null;
  date_started: number;
  current_time_seconds: number;
  time_listening_seconds: number;
  start_time_seconds: number;
  closed_at: number | null;
  updated_at: number;
};

export async function insertListeningSession(env: Env, row: ListeningSessionRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO listening_sessions (
       id, user_id, library_item_id, display_title, display_author,
       duration_seconds, play_method, media_player, device_info,
       server_version, date_started, current_time_seconds,
       time_listening_seconds, start_time_seconds, closed_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    row.id, row.user_id, row.library_item_id, row.display_title, row.display_author,
    row.duration_seconds, row.play_method, row.media_player, row.device_info,
    row.server_version, row.date_started, row.current_time_seconds,
    row.time_listening_seconds, row.start_time_seconds, row.closed_at, row.updated_at,
  ).run();
}

export async function getSessionById(env: Env, id: string): Promise<ListeningSessionRow | null> {
  return env.DB.prepare('SELECT * FROM listening_sessions WHERE id = ?').bind(id).first<ListeningSessionRow>();
}

export async function listSessionsByUser(env: Env, userId: string, opts: { limit?: number; offset?: number } = {}): Promise<{ rows: ListeningSessionRow[]; total: number }> {
  const limit = opts.limit ?? 10;
  const offset = opts.offset ?? 0;
  const rowsR = await env.DB.prepare(
    'SELECT * FROM listening_sessions WHERE user_id = ? ORDER BY date_started DESC LIMIT ? OFFSET ?',
  ).bind(userId, limit, offset).all<ListeningSessionRow>();
  const totalR = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM listening_sessions WHERE user_id = ?',
  ).bind(userId).first<{ n: number }>();
  return { rows: rowsR.results, total: totalR?.n ?? 0 };
}
