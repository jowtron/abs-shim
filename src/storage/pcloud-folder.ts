// A pCloud-OAuth library folder with its profile, for code that writes into
// it: /admin's upload and fetch-from-URL routes, and the Audible delivery
// pump (src/lib/audible-delivery.ts). Moved out of src/routes/admin.ts.

import type { Env } from '../types';
import { getFolderById } from '../db/library';
import type { OAuthProfileRow } from './factory';
import type { PcloudProfile } from './pcloud';

// Load a pCloud-OAuth folder + its profile. Returns the same Response shape
// as a Hono handler when the lookup fails so callers can `return` directly.
export async function loadPcloudFolder(env: Env, folderId: string, tenantId: string): Promise<
  { ok: true; folder: NonNullable<Awaited<ReturnType<typeof getFolderById>>>; profile: PcloudProfile; rootPath: string }
  | { ok: false; status: number; error: string }
> {
  const folder = await getFolderById(env, folderId, tenantId);
  if (!folder) return { ok: false, status: 404, error: 'Folder not found' };
  if (folder.provider !== 'pcloud_oauth') {
    return { ok: false, status: 400, error: 'Upload is only supported on pcloud_oauth folders' };
  }
  if (!folder.profile_id) return { ok: false, status: 400, error: 'Folder has no profile_id' };
  const profileRow = await env.DB.prepare(
    'SELECT * FROM oauth_profiles WHERE id = ? AND tenant_id = ?',
  ).bind(folder.profile_id, tenantId).first<OAuthProfileRow>();
  if (!profileRow) return { ok: false, status: 404, error: 'pCloud profile missing' };
  const apiHost = profileRow.api_host ?? 'api.pcloud.com';
  const profile: PcloudProfile = { accessToken: profileRow.access_token, apiHost };
  let rootPath = '/';
  try {
    const cfg = JSON.parse(folder.config_json ?? '{}') as { rootPath?: string };
    rootPath = cfg.rootPath ?? '/';
  } catch { /* default */ }
  return { ok: true, folder, profile, rootPath };
}

// Build an absolute pCloud path from a folder's rootPath + a user-supplied
// relPath. Defends against path-traversal (../) so a compromised browser
// can't write outside the configured audiobook root.
export function joinPcloudPath(rootPath: string, relPath: string): string {
  const cleanRoot = rootPath.replace(/\/+$/, '') || '/';
  const cleanRel = relPath.replace(/^\/+/, '').replace(/\\/g, '/');
  if (cleanRel.split('/').some((seg) => seg === '..' || seg === '')) {
    throw new Error(`Invalid relPath: ${relPath}`);
  }
  return cleanRoot === '/' ? `/${cleanRel}` : `${cleanRoot}/${cleanRel}`;
}
