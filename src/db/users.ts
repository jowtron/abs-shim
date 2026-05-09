import type { Env } from '../types';

export type UserRow = {
  id: string;
  username: string;
  email: string | null;
  type: string;
  password_hash: string | null;
  google_sub: string | null;
  is_active: number;
  is_locked: number;
  permissions: string;
  libraries_accessible: string;
  item_tags_selected: string;
  created_at: number;
  last_seen: number | null;
};

export const ROOT_PERMISSIONS = {
  download: true,
  update: true,
  delete: true,
  upload: true,
  createEreader: true,
  accessAllLibraries: true,
  accessAllTags: true,
  accessExplicitContent: true,
  selectedTagsNotAccessible: false,
};

export async function countUsers(env: Env): Promise<number> {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  return r?.n ?? 0;
}

export async function findUserByUsername(env: Env, username: string): Promise<UserRow | null> {
  return env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first<UserRow>();
}

export async function findUserById(env: Env, id: string): Promise<UserRow | null> {
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
}

export async function insertUser(env: Env, row: UserRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (
       id, username, email, type, password_hash, google_sub,
       is_active, is_locked, permissions, libraries_accessible,
       item_tags_selected, created_at, last_seen
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    row.id, row.username, row.email, row.type, row.password_hash, row.google_sub,
    row.is_active, row.is_locked, row.permissions, row.libraries_accessible,
    row.item_tags_selected, row.created_at, row.last_seen,
  ).run();
}

export async function touchLastSeen(env: Env, userId: string): Promise<void> {
  await env.DB.prepare('UPDATE users SET last_seen = ? WHERE id = ?')
    .bind(Date.now(), userId).run();
}

// Shape a UserRow into the ABS user payload (sans tokens — the caller adds
// them depending on whether this is /login, /api/me, /api/authorize). Pass
// `mediaProgress` to populate the corresponding field; defaults to empty.
export function toAbsUser(row: UserRow, mediaProgress: unknown[] = []) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    type: row.type,
    token: '', // legacy field; clients still read it. Filled by caller.
    mediaProgress,
    seriesHideFromContinueListening: [] as unknown[],
    bookmarks: [] as unknown[],
    isActive: row.is_active === 1,
    isLocked: row.is_locked === 1,
    lastSeen: row.last_seen,
    createdAt: row.created_at,
    permissions: JSON.parse(row.permissions || '{}'),
    librariesAccessible: JSON.parse(row.libraries_accessible || '[]'),
    itemTagsSelected: JSON.parse(row.item_tags_selected || '[]'),
    hasOpenIDLink: row.google_sub !== null,
  };
}
