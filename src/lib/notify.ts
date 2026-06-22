import type { Env } from '../types';

// External notification / verification helpers for the public signup flow.

// Verify a Cloudflare Turnstile token server-side.
//   - Returns true when Turnstile is NOT configured, so the feature degrades to
//     "off" until the secret is set (lets us ship before the dashboard widget
//     exists, then tighten by setting TURNSTILE_SECRET).
//   - When configured, returns true only for a token that passes siteverify.
export async function verifyTurnstile(
  env: Env,
  token: string | undefined,
  remoteIp?: string,
): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true; // not enforced until configured
  if (!token) return false;
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  if (remoteIp) form.append('remoteip', remoteIp);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

// Best-effort Pushover push to the instance owner. No-op when not configured.
// Pass the returned promise to ctx.waitUntil so it never blocks or fails the
// request it's reporting on.
export async function sendPushover(
  env: Env,
  opts: { title: string; message: string; url?: string; urlTitle?: string; priority?: number },
): Promise<void> {
  if (!env.PUSHOVER_TOKEN || !env.PUSHOVER_USER_KEY) return;
  const form = new FormData();
  form.append('token', env.PUSHOVER_TOKEN);
  form.append('user', env.PUSHOVER_USER_KEY);
  form.append('title', opts.title);
  form.append('message', opts.message);
  if (opts.url) form.append('url', opts.url);
  if (opts.urlTitle) form.append('url_title', opts.urlTitle);
  if (opts.priority != null) form.append('priority', String(opts.priority));
  try {
    await fetch('https://api.pushover.net/1/messages.json', { method: 'POST', body: form });
  } catch {
    /* best-effort: a missed notification must not fail signup */
  }
}
