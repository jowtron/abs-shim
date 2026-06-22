import type { Env } from '../types';
import type { TenantRole } from './tenants';

// Tenant invites — the "add someone to my household" path. An invite is tied to
// a specific tenant; redeeming it at signup makes the new user an active member
// of that tenant immediately (no owner approval — the invite IS the
// authorization). Single-use, optionally time-limited, high-entropy code.

export type InviteRow = {
  code: string;
  tenant_id: string | null;
  email: string | null;
  role: string;
  expires_at: number | null;
  created_by: string | null;
  used_by: string | null;
  used_at: number | null;
  created_at: number;
};

// 16 random bytes → 128-bit base64url code (unguessable; brute-force-proof).
function genCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function createInvite(
  env: Env,
  opts: { tenantId: string; role?: TenantRole; createdBy: string; ttlMs?: number },
): Promise<InviteRow> {
  const code = genCode();
  const now = Date.now();
  const expires = opts.ttlMs ? now + opts.ttlMs : null;
  const role = opts.role ?? 'member';
  await env.DB.prepare(
    `INSERT INTO invites (code, tenant_id, email, role, expires_at, created_by, used_by, used_at, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL, ?)`,
  ).bind(code, opts.tenantId, role, expires, opts.createdBy, now).run();
  return {
    code, tenant_id: opts.tenantId, email: null, role, expires_at: expires,
    created_by: opts.createdBy, used_by: null, used_at: null, created_at: now,
  };
}

// A redeemable invite is one that exists, is unused, unexpired, and bound to a
// tenant. Returns null otherwise (uniform "invalid" to the caller).
export async function getRedeemableInvite(env: Env, code: string): Promise<InviteRow | null> {
  const row = await env.DB.prepare('SELECT * FROM invites WHERE code = ?').bind(code).first<InviteRow>();
  if (!row || !row.tenant_id) return null;
  if (row.used_at != null) return null;
  if (row.expires_at != null && row.expires_at < Date.now()) return null;
  return row;
}

export async function markInviteUsed(env: Env, code: string, userId: string): Promise<void> {
  await env.DB.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?')
    .bind(userId, Date.now(), code).run();
}

export async function listOpenInvites(env: Env, tenantId: string): Promise<InviteRow[]> {
  const r = await env.DB.prepare(
    `SELECT * FROM invites WHERE tenant_id = ? AND used_at IS NULL ORDER BY created_at DESC`,
  ).bind(tenantId).all<InviteRow>();
  return r.results;
}

// Revoke an unused invite. Scoped to the tenant so a member can't revoke
// another tenant's invites. Returns whether a row was removed.
export async function deleteInvite(env: Env, code: string, tenantId: string): Promise<boolean> {
  const res = await env.DB.prepare(
    'DELETE FROM invites WHERE code = ? AND tenant_id = ? AND used_at IS NULL',
  ).bind(code, tenantId).run();
  return (res.meta.changes ?? 0) > 0;
}
