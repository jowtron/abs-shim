import type { Env } from '../types';

// wharf-router client. The shim never addresses an island: it submits jobs
// for a project id and the router forwards them to whichever box hosts
// that project (see docs/wharf-for-new-projects.md in the wharf repo).
// Job ids come back namespaced (`stereo-au.<uuid>`) and are used verbatim.
//
// Same-account transport is the WHARF_ROUTER service binding (wrangler.toml);
// ROUTER_TOKEN is the bearer the router expects on every call.

export type WharfJob = {
  id: string;
  project_id: string;
  handler_name: string;
  state: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  args?: unknown;
  result?: unknown;
  error?: string;
  created_at?: string;
  started_at?: string;
  ended_at?: string;
};

export type WharfLog = { content: string; offset: number; next_offset: number; size: number; truncated: boolean; exists: boolean };

export const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

export function wharfConfigured(env: Env): boolean {
  return !!(env.WHARF_ROUTER && env.ROUTER_TOKEN);
}

async function call(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  if (!wharfConfigured(env)) throw new Error('wharf-router is not configured on this shim (WHARF_ROUTER binding + ROUTER_TOKEN secret)');
  return env.WHARF_ROUTER!.fetch(`https://router${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.ROUTER_TOKEN}`, 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
  });
}

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) {
    const b = body as { message?: string; error?: string } | null;
    throw new Error(`wharf ${res.status}: ${b?.message ?? b?.error ?? text.slice(0, 200)}`);
  }
  return body as T;
}

export async function runAsync(env: Env, project: string, handler: string, args: unknown): Promise<string> {
  const r = await json<{ job_id: string }>(await call(env, '/run-async', { method: 'POST', body: JSON.stringify({ project_id: project, handler, args }) }));
  return r.job_id;
}

export async function getJob(env: Env, id: string): Promise<WharfJob> {
  return json<WharfJob>(await call(env, `/jobs/${encodeURIComponent(id)}`));
}

export async function getJobLog(env: Env, id: string, opts: { offset?: number; tail?: number } = {}): Promise<WharfLog> {
  const qs = new URLSearchParams();
  if (opts.tail != null) qs.set('tail', String(opts.tail));
  else if (opts.offset != null) qs.set('offset', String(opts.offset));
  return json<WharfLog>(await call(env, `/jobs/${encodeURIComponent(id)}/log${qs.size ? '?' + qs : ''}`));
}

export async function cancelJob(env: Env, id: string): Promise<void> {
  const res = await call(env, `/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  if (!res.ok && res.status !== 409) await json(res);
}

// Submit and wait for a short job (accounts / auth / library). Script
// handlers are async-only on wharf, so even a 1-second handler is a job;
// polling from here keeps the shim's routes synchronous for the UI.
export async function runAndWait<T>(env: Env, project: string, handler: string, args: unknown, timeoutMs = 30_000): Promise<T> {
  const id = await runAsync(env, project, handler, args);
  const deadline = Date.now() + timeoutMs;
  let delay = 700;
  for (;;) {
    await new Promise((r) => setTimeout(r, delay));
    const job = await getJob(env, id);
    if (TERMINAL.has(job.state)) {
      if (job.state !== 'succeeded') {
        // Handlers print the traceback on stderr; surface the tail of it.
        let detail = job.error ?? job.state;
        try {
          const log = await getJobLog(env, id, { tail: 600 });
          const last = log.content.trim().split('\n').filter((l) => l.startsWith('ERR:') || /ERROR/.test(l)).pop();
          if (last) detail = last.replace(/^ERR:\s*/, '');
        } catch { /* keep job.error */ }
        throw new Error(`${handler} ${job.state}: ${detail}`);
      }
      const result = job.result as T & { ok?: boolean; error?: string };
      if (result && result.ok === false) throw new Error(result.error ?? `${handler} reported failure`);
      return result;
    }
    if (Date.now() > deadline) throw new Error(`${handler} is taking too long (job ${id} still ${job.state})`);
    delay = Math.min(delay * 1.4, 3000);
  }
}
