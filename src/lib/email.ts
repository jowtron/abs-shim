import type { Env } from '../types';

// Outgoing email through Cloudflare Email Sending (the `EMAIL` send_email
// binding in wrangler.toml), copied in spirit from cf-pbx's voicemail mailer:
// best-effort, never throws, and logs only the failure, never the address.
// Used for password-reset links and the notices that follow a change.

export function emailConfigured(env: Env): boolean {
  return !!env.EMAIL && !!env.EMAIL_FROM?.trim();
}

export function escHtml(v: unknown): string {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// A plain, single-column message: a heading, paragraphs, an optional button,
// and a muted footer. Same words in the text part, for clients that want it.
export function simpleEmail(m: {
  heading: string;
  paragraphs: string[];
  button?: { label: string; url: string };
  footer?: string;
}): { html: string; text: string } {
  const html = `<div style="font:15px/1.5 -apple-system,system-ui,'Segoe UI',sans-serif;color:#111;max-width:34rem">
  <h2 style="margin:0 0 .75rem;font-size:18px">${escHtml(m.heading)}</h2>
  ${m.paragraphs.map((p) => `<p style="margin:0 0 .75rem">${escHtml(p)}</p>`).join('\n  ')}
  ${m.button ? `<p style="margin:1.25rem 0"><a href="${escHtml(m.button.url)}" style="display:inline-block;background:#0a66c2;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">${escHtml(m.button.label)}</a></p>
  <p style="margin:0 0 .75rem;color:#666;font-size:13px">Or open this link: <a href="${escHtml(m.button.url)}" style="color:#0a66c2;word-break:break-all">${escHtml(m.button.url)}</a></p>` : ''}
  ${m.footer ? `<p style="color:#888;font-size:12px;margin-top:1.5rem">${escHtml(m.footer)}</p>` : ''}
</div>`;
  const text = [
    m.heading, '',
    ...m.paragraphs.flatMap((p) => [p, '']),
    ...(m.button ? [`${m.button.label}: ${m.button.url}`, ''] : []),
    ...(m.footer ? [m.footer] : []),
  ].join('\n');
  return { html, text };
}

// True only when Cloudflare accepted the message.
export async function sendEmail(
  env: Env,
  m: { to: string; subject: string; html: string; text: string },
): Promise<boolean> {
  const from = env.EMAIL_FROM?.trim();
  const to = m.to.trim();
  if (!env.EMAIL || !from || !to) return false;
  try {
    await env.EMAIL.send({
      to,
      from: { email: from, name: env.EMAIL_FROM_NAME?.trim() || 'Audiobook server' },
      subject: m.subject,
      html: m.html,
      text: m.text,
    });
    return true;
  } catch (e) {
    const code = (e as { code?: string })?.code;
    console.log('[email] send failed', code ? `${code} ${(e as Error).message}` : (e instanceof Error ? e.message : String(e)));
    return false;
  }
}
