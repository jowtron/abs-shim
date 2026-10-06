import type { Env } from '../types';
import { sendPushover } from './notify';

// rclone's pCloud token, watched from the nodes that hold it (2026-10-06).
//
// pCloud revoked rclone's authorization on 2026-10-05 (error 2095) and
// nothing said so: eastsidefm logged "Upload complete" while losing three
// episodes, and an Audible sync downloaded titles only to fail at the pCloud
// step. Each node with the token (wharf-syd-1 for eastsidefm, stereo-au for
// the Audible sync) runs `rclone about pcloud:` hourly from a systemd timer
// (ops/pcloud-health/) and posts the outcome here, because the Pushover keys
// live only in this Worker. The node sends rclone's raw output and the
// Worker decides what it means, so a change of wording ships with the shim.
//
// One server_settings row per node: a shared blob would lose a report when
// two nodes post in the same second.

const KEY_PREFIX = 'node_health:pcloud-rclone:';
const REALERT_MS = 12 * 3600_000;     // a failure that persists pings twice a day, not hourly
const SILENT_MS = 3 * 3600_000;       // three missed hourly reports = the checker itself is down
const OTHER_STREAK = 3;               // a network blip isn't news; three hours of them is
const REAUTH_HINT = 'Fix, on the Mac: ~/Claude_Code/ABS_shim/ops/pcloud-health/pcloud-reauth.sh';

// pCloud's "your credentials are no good" family: 1000 log in required,
// 2000 log in failed, 2094 invalid token, 2095 revoked token.
const AUTH_RE = /\((1000|2000|2094|2095)\)|\b(2094|2095)\b|access_token|re-?authori[sz]e|log in (required|failed)/i;

export type NodeReport = { node: string; ok: boolean; exitCode?: number; output?: string; uses?: string };

type Alerted = { kind: 'auth' | 'other' | 'silent'; at: number };

type NodeState = {
  node: string;
  uses: string;
  lastAt: number;
  ok: boolean;
  kind: 'ok' | 'auth' | 'other';
  detail: string;
  failStreak: number;
  lastOkAt: number | null;
  alerted: Alerted | null;
};

export function classifyFailure(output: string): 'auth' | 'other' {
  return AUTH_RE.test(output) ? 'auth' : 'other';
}

// The line of rclone's output that says what went wrong, without the
// timestamp and log-level prefix.
function headline(output: string): string {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  const pick = lines.find((l) => AUTH_RE.test(l)) ?? lines.find((l) => /error|failed/i.test(l)) ?? lines[lines.length - 1] ?? '';
  return pick.replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d\s+/, '').replace(/^(ERROR|CRITICAL|NOTICE)\s*:\s*/, '').slice(0, 300);
}

async function load(env: Env, node: string): Promise<NodeState | null> {
  const row = await env.DB.prepare('SELECT value FROM server_settings WHERE key = ?').bind(KEY_PREFIX + node).first<{ value: string }>();
  if (!row) return null;
  try { return JSON.parse(row.value) as NodeState; } catch { return null; }
}

async function save(env: Env, s: NodeState): Promise<void> {
  await env.DB.prepare('INSERT INTO server_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(KEY_PREFIX + s.node, JSON.stringify(s)).run();
}

function since(ms: number): string {
  const h = Math.round(ms / 3600_000);
  return h >= 48 ? `${Math.round(h / 24)} days` : h >= 1 ? `${h} h` : `${Math.max(1, Math.round(ms / 60_000))} min`;
}

export async function recordReport(env: Env, r: NodeReport): Promise<{ alerted: string | null }> {
  const now = Date.now();
  const prev = await load(env, r.node);
  const output = (r.output ?? '').slice(-2000);
  const s: NodeState = prev ?? { node: r.node, uses: '', lastAt: 0, ok: true, kind: 'ok', detail: '', failStreak: 0, lastOkAt: null, alerted: null };
  s.lastAt = now;
  if (r.uses) s.uses = r.uses.slice(0, 120);
  const uses = s.uses ? ` (${s.uses})` : '';
  let push: { title: string; message: string } | null = null;

  if (r.ok) {
    if (s.alerted) {
      push = s.alerted.kind === 'silent'
        ? { title: `pCloud check: ${r.node} reporting again`, message: `${r.node} is checking rclone's pCloud token again, and it works.` }
        : { title: `pCloud OK again on ${r.node}`, message: `rclone on ${r.node}${uses} can reach pCloud again${s.lastOkAt ? ` (it couldn't for ${since(now - s.lastOkAt)})` : ''}.` };
    }
    Object.assign(s, { ok: true, kind: 'ok', detail: '', failStreak: 0, lastOkAt: now, alerted: null });
  } else {
    const kind = classifyFailure(output);
    s.ok = false;
    s.kind = kind;
    s.detail = headline(output) || `rclone exited ${r.exitCode ?? '?'}`;
    s.failStreak++;
    const already = s.alerted && s.alerted.kind === kind && now - s.alerted.at < REALERT_MS;
    if (!already && (kind === 'auth' || s.failStreak >= OTHER_STREAK)) {
      push = kind === 'auth'
        ? {
            title: `pCloud refused rclone on ${r.node}`,
            message: `${s.detail}\n\nUntil it's re-authorised, ${s.uses || 'whatever uses it'} can't write to pCloud.\n${REAUTH_HINT}`,
          }
        : {
            title: `rclone can't reach pCloud from ${r.node}`,
            message: `${s.failStreak} hourly checks in a row failed${uses}:\n${s.detail}`,
          };
      s.alerted = { kind, at: now };
    }
  }
  await save(env, s);
  if (push) {
    await sendPushover(env, { ...push, url: (env.PUBLIC_ORIGIN ?? 'https://abs-shim.jderrick.app') + '/admin', urlTitle: 'Open /admin' })
      .catch(() => undefined);
  }
  return { alerted: push?.title ?? null };
}

// Cron: a node that stops reporting is as silent as a revoked token, so say
// so after three missed hours. A range on the primary key, not LIKE, so it
// reads only these rows.
export async function checkSilentNodes(env: Env): Promise<void> {
  const rows = await env.DB.prepare('SELECT value FROM server_settings WHERE key >= ? AND key < ?')
    .bind(KEY_PREFIX, KEY_PREFIX + '\uffff').all<{ value: string }>();
  const now = Date.now();
  for (const row of rows.results) {
    let s: NodeState;
    try { s = JSON.parse(row.value) as NodeState; } catch { continue; }
    if (now - s.lastAt < SILENT_MS) continue;
    if (s.alerted?.kind === 'silent' && now - s.alerted.at < REALERT_MS) continue;
    s.alerted = { kind: 'silent', at: now };
    await save(env, s);
    await sendPushover(env, {
      title: `pCloud check: nothing from ${s.node}`,
      message: `${s.node} last reported on rclone's pCloud token ${since(now - s.lastAt)} ago. The node, its timer or its network is down, so a revoked token there would go unnoticed.\nssh in and check: systemctl status pcloud-health.timer`,
    }).catch(() => undefined);
  }
}

// Constant-time comparison of the bearer key, via fixed-length digests.
export async function keyMatches(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}
