import type { Env } from '../types';

export type TenantRole = 'owner' | 'member';

export type TenantRow = {
  id: string;
  name: string;
  owner_user_id: string;
  created_at: number;
  updated_at: number;
};

export type Membership = { tenantId: string; role: TenantRole };

// Resolve the tenant a request acts within, from the authenticated user's
// memberships. Selection rule:
//   1. If `preferred` is given AND the user is a member of it, use it
//      (supports an explicit ?tenant= switch).
//   2. Otherwise the membership flagged is_default = 1.
//   3. Otherwise the earliest-joined membership.
// Returns null if the user has no memberships (a pending signup, or data drift).
export async function getActiveMembership(
  env: Env,
  userId: string,
  preferred?: string | null,
): Promise<Membership | null> {
  if (preferred) {
    const m = await env.DB.prepare(
      'SELECT tenant_id, role FROM tenant_members WHERE user_id = ? AND tenant_id = ?',
    ).bind(userId, preferred).first<{ tenant_id: string; role: string }>();
    if (m) return { tenantId: m.tenant_id, role: m.role as TenantRole };
  }
  const row = await env.DB.prepare(
    `SELECT tenant_id, role FROM tenant_members
       WHERE user_id = ?
       ORDER BY is_default DESC, created_at ASC
       LIMIT 1`,
  ).bind(userId).first<{ tenant_id: string; role: string }>();
  if (!row) return null;
  return { tenantId: row.tenant_id, role: row.role as TenantRole };
}

export async function listMemberships(env: Env, userId: string): Promise<Array<Membership & { name: string; isDefault: boolean }>> {
  const r = await env.DB.prepare(
    `SELECT tm.tenant_id, tm.role, tm.is_default, t.name
       FROM tenant_members tm JOIN tenants t ON t.id = tm.tenant_id
      WHERE tm.user_id = ?
      ORDER BY tm.is_default DESC, tm.created_at ASC`,
  ).bind(userId).all<{ tenant_id: string; role: string; is_default: number; name: string }>();
  return r.results.map((m) => ({
    tenantId: m.tenant_id,
    role: m.role as TenantRole,
    name: m.name,
    isDefault: m.is_default === 1,
  }));
}

export type TenantMember = {
  userId: string;
  username: string;
  email: string | null;
  role: TenantRole;
  isDefault: boolean;
  createdAt: number;
};

// All members of a tenant (for the admin "Library members" panel). Owner first,
// then by join order.
export async function listTenantMembers(env: Env, tenantId: string): Promise<TenantMember[]> {
  const r = await env.DB.prepare(
    `SELECT tm.user_id, tm.role, tm.is_default, tm.created_at, u.username, u.email
       FROM tenant_members tm JOIN users u ON u.id = tm.user_id
      WHERE tm.tenant_id = ?
      ORDER BY (tm.role = 'owner') DESC, tm.created_at ASC`,
  ).bind(tenantId).all<{ user_id: string; role: string; is_default: number; created_at: number; username: string; email: string | null }>();
  return r.results.map((m) => ({
    userId: m.user_id,
    username: m.username,
    email: m.email,
    role: m.role as TenantRole,
    isDefault: m.is_default === 1,
    createdAt: m.created_at,
  }));
}

// Remove a user from a tenant. A user with no remaining membership can no longer
// resolve a tenant in requireAuth, so they lose access (their account row stays).
export async function removeMember(env: Env, tenantId: string, userId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM tenant_members WHERE tenant_id = ? AND user_id = ?')
    .bind(tenantId, userId).run();
}

// Flip which tenant is the user's default (used by the /api/me/tenant switch).
export async function setDefaultTenant(env: Env, userId: string, tenantId: string): Promise<boolean> {
  const member = await env.DB.prepare(
    'SELECT 1 AS x FROM tenant_members WHERE user_id = ? AND tenant_id = ?',
  ).bind(userId, tenantId).first<{ x: number }>();
  if (!member) return false;
  await env.DB.batch([
    env.DB.prepare('UPDATE tenant_members SET is_default = 0 WHERE user_id = ?').bind(userId),
    env.DB.prepare('UPDATE tenant_members SET is_default = 1 WHERE user_id = ? AND tenant_id = ?').bind(userId, tenantId),
  ]);
  return true;
}
