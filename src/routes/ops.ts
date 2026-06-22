// Internal ops dashboard API. Read-only aggregate stats for the owner, gated
// by Cloudflare Access (NOT the normal user auth) — see src/ops/access.ts.
// Mounted at /api/ops from index.ts, before the SPA notFound fallback.
//
// Phase 1 (pre-tenancy): global counts. When tenancy lands (migration 0004),
// this gains a per-tenant breakdown — the response shape is additive.

import { Hono } from 'hono';
import type { Env } from '../types';
import { requireOpsAccess } from '../ops/access';
import { SERVER_VERSION } from '../lib/server-settings';
import { redactSecrets, safeJson } from '../lib/redact';

export const opsRoutes = new Hono<{ Bindings: Env }>();

opsRoutes.use('*', requireOpsAccess);

opsRoutes.get('/stats', async (c) => {
  const db = c.env.DB;

  const [
    users, libraries, items, storage,
    usersByType, foldersByProvider, oauthByProvider,
    folders, recentUsers,
  ] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM libraries').first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM library_items WHERE is_missing = 0').first<{ n: number }>(),
    db.prepare('SELECT COALESCE(SUM(size_bytes),0) AS bytes, COALESCE(SUM(duration_seconds),0) AS secs FROM audio_files').first<{ bytes: number; secs: number }>(),
    db.prepare('SELECT type, COUNT(*) AS n FROM users GROUP BY type').all<{ type: string; n: number }>(),
    db.prepare("SELECT COALESCE(provider,'public_url') AS provider, COUNT(*) AS n FROM library_folders GROUP BY provider").all<{ provider: string; n: number }>(),
    db.prepare('SELECT provider, COUNT(*) AS n FROM oauth_profiles GROUP BY provider').all<{ provider: string; n: number }>(),
    db.prepare(
      `SELECT lf.id, lf.provider, lf.config_json, lf.filedn_base_url, l.name AS library_name
         FROM library_folders lf JOIN libraries l ON l.id = lf.library_id
        ORDER BY lf.added_at ASC`,
    ).all<{ id: string; provider: string | null; config_json: string | null; filedn_base_url: string | null; library_name: string }>(),
    db.prepare('SELECT id, username, email, type, created_at, last_seen FROM users ORDER BY created_at DESC LIMIT 100').all<{ id: string; username: string; email: string | null; type: string; created_at: number; last_seen: number | null }>(),
  ]);

  return c.json({
    generatedAt: Date.now(),
    version: SERVER_VERSION,
    totals: {
      users: users?.n ?? 0,
      libraries: libraries?.n ?? 0,
      items: items?.n ?? 0,
      storageBytes: storage?.bytes ?? 0,
      durationSeconds: storage?.secs ?? 0,
    },
    usersByType: usersByType.results,
    foldersByProvider: foldersByProvider.results,
    oauthByProvider: oauthByProvider.results,
    // "What servers/storage they've added" — redact any secrets in config_json.
    folders: folders.results.map((f) => ({
      id: f.id,
      libraryName: f.library_name,
      provider: f.provider ?? 'public_url',
      config: redactSecrets(safeJson(f.config_json)),
      legacyBaseUrl: f.filedn_base_url,
    })),
    users: recentUsers.results,
  });
});
