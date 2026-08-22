import type { Env } from '../types';

// Tiny key/value accessor over the server_settings table (migration 0001).
// Used for instance-wide toggles that aren't part of the static ABS
// serverSettings() shape — currently just the signup mode.

export type SignupMode = 'approval' | 'closed';

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const r = await env.DB.prepare('SELECT value FROM server_settings WHERE key = ?')
    .bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO server_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).bind(key, value).run();
}

// Self-serve signup gate. Defaults to 'approval' (the chosen model: anyone may
// request, but accounts stay inactive until the instance owner approves them);
// 'closed' turns off new signups entirely without a redeploy.
export async function getSignupMode(env: Env): Promise<SignupMode> {
  const v = await getSetting(env, 'signup_mode');
  return v === 'closed' ? 'closed' : 'approval';
}

// ─── Per-tenant settings (migration 0005) ───────────────────────────────────

export async function getTenantSetting(env: Env, tenantId: string, key: string): Promise<string | null> {
  const r = await env.DB.prepare('SELECT value FROM tenant_settings WHERE tenant_id = ? AND key = ?')
    .bind(tenantId, key).first<{ value: string }>();
  return r?.value ?? null;
}

export async function setTenantSetting(env: Env, tenantId: string, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tenant_settings (tenant_id, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(tenantId, key, value, Date.now()).run();
}

export async function deleteTenantSetting(env: Env, tenantId: string, key: string): Promise<void> {
  await env.DB.prepare('DELETE FROM tenant_settings WHERE tenant_id = ? AND key = ?').bind(tenantId, key).run();
}
