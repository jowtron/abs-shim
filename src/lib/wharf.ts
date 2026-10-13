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

// A failed router/wharf call. `code` is the envelope's error code (the
// router puts it in `error` and `error_code`, wharf in `error_code`), so a
// caller can tell "the island is asleep" (island_unreachable) from a real
// failure without parsing the message.
export class WharfError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) {
    const b = body as { message?: string; error?: string; error_code?: string } | null;
    const msg = b?.message ?? b?.error ?? text.slice(0, 200);
    throw new WharfError(`wharf ${res.status}: ${msg}`, res.status, String(b?.error_code ?? (b?.message ? b?.error : '') ?? ''));
  }
  return body as T;
}

// wharf (v0.2.23+) shows a job's `label` on its dashboard. It is strict at
// submit time: control characters or more than 200 runes is a 400
// invalid_field (jobs.ValidateLabel), so clean it the same way its lenient
// CleanLabel does: controls to spaces, whitespace collapsed, a lone UTF-16
// surrogate to U+FFFD (it would reach Go as one), and past the limit cut at
// a code point with an ellipsis. It is logged and listed: never put a
// secret in one.
export const LABEL_MAX = 200;
export function cleanLabel(s: string): string {
  const t = s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cps = Array.from(t);
  return cps.length > LABEL_MAX ? cps.slice(0, LABEL_MAX - 1).join('').trimEnd() + '\u2026' : t;
}

// `label` (optional): see cleanLabel. Older nodes ignore the field. Should a
// node refuse it anyway, the job is submitted again without one: a label is
// display only and must never stop the work (or burn an analysis attempt).
export async function runAsync(env: Env, project: string, handler: string, args: unknown, opts: { label?: string } = {}): Promise<string> {
  const label = opts.label ? cleanLabel(opts.label) : '';
  const submit = async (withLabel: boolean) => json<{ job_id: string }>(await call(env, '/run-async', {
    method: 'POST', body: JSON.stringify({ project_id: project, handler, args, ...(withLabel ? { label } : {}) }),
  }));
  try {
    return (await submit(!!label)).job_id;
  } catch (err) {
    if (label && err instanceof WharfError && err.status === 400 && (err.code === 'invalid_field' || /label/i.test(err.message))) {
      return (await submit(false)).job_id;
    }
    throw err;
  }
}

export async function getJob(env: Env, id: string): Promise<WharfJob> {
  return json<WharfJob>(await call(env, `/jobs/${encodeURIComponent(id)}`));
}

// A project's jobs on its home island, newest first (the router's GET /jobs;
// ids come back namespaced). One page per call: pass `next_cursor` back as
// `afterId`. Each job carries its args and result, so keep `limit` small for
// a handler whose results are large.
export async function listJobs(env: Env, project: string, opts: { limit?: number; afterId?: string; state?: string } = {}): Promise<{ jobs: WharfJob[]; next_cursor?: string }> {
  const qs = new URLSearchParams({ project_id: project });
  if (opts.limit) qs.set('limit', String(opts.limit));
  if (opts.afterId) qs.set('after_id', opts.afterId);
  if (opts.state) qs.set('state', opts.state);
  return json<{ jobs: WharfJob[]; next_cursor?: string }>(await call(env, `/jobs?${qs}`));
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
