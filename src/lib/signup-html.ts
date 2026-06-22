// Public self-serve signup form. Single self-contained HTML file with vanilla
// JS — served at /signup. Posts to /api/signup/register (see src/routes/
// signup.ts). Approval-gated: a successful submit creates a *pending* account
// the instance owner must approve before it can sign in.
//
// renderSignupHtml(siteKey) injects a Cloudflare Turnstile widget when a site
// key is configured; with no key the form still works (server-side enforcement
// is likewise skipped until TURNSTILE_SECRET is set).

export function renderSignupHtml(siteKey?: string): string {
  const widget = siteKey
    ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
      <div class="cf-turnstile" data-sitekey="${siteKey}" data-theme="auto" style="margin-top:1rem"></div>`
    : '';
  return SIGNUP_HTML.replace('<!--TURNSTILE-->', widget);
}

const SIGNUP_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Request an account · ABS_shim</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root {
      color-scheme: light dark;
      --bg: #fafafa; --fg: #111; --muted: #666; --border: #ddd; --card: #fff;
      --accent: #0a66c2; --warn: #b54708; --ok: #15803d;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #0f0f10; --fg: #f5f5f5; --muted: #9aa0a6; --border: #2a2a2c; --card: #18181a; --accent: #58a6ff; --warn: #f5a524; --ok: #4ade80; }
    }
    body { margin: 0; padding: 1.5rem; background: var(--bg); color: var(--fg); display: flex; justify-content: center; }
    .wrap { width: 100%; max-width: 420px; }
    h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
    .muted { color: var(--muted); font-size: 0.9rem; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1.25rem; margin-top: 1rem; }
    label { display: block; font-size: 0.85rem; margin: 0.75rem 0 0.25rem; }
    input { width: 100%; box-sizing: border-box; background: var(--bg); color: var(--fg); border: 1px solid var(--border); padding: 0.55rem 0.7rem; border-radius: 6px; font-size: 1rem; }
    button { width: 100%; margin-top: 1rem; background: var(--accent); color: #fff; border: 0; padding: 0.65rem 1rem; border-radius: 6px; cursor: pointer; font-size: 1rem; }
    button:disabled { opacity: 0.6; cursor: default; }
    .hint { font-size: 0.78rem; color: var(--muted); margin-top: 0.2rem; }
    .banner { display: none; padding: 0.7rem 0.9rem; border-radius: 6px; margin-top: 1rem; font-size: 0.9rem; }
    .banner.err { display: block; border: 1px solid var(--warn); color: var(--warn); }
    .banner.ok { display: block; border: 1px solid var(--ok); color: var(--ok); }
    a { color: var(--accent); }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Request an account</h1>
    <p class="muted">New accounts are reviewed before they're activated. Once approved, you can sign in from any audiobook client.</p>

    <div id="invite-note" class="banner" style="display:none"></div>
    <div id="banner" class="banner"></div>

    <form id="signup-form" class="card">
      <label for="username">Username</label>
      <input id="username" autocomplete="username" autocapitalize="none" spellcheck="false" required />

      <label for="email">Email <span class="muted">(optional)</span></label>
      <input id="email" type="email" autocomplete="email" autocapitalize="none" spellcheck="false" />

      <label for="password">Password</label>
      <input id="password" type="password" autocomplete="new-password" required />
      <div class="hint">At least 10 characters, and not the same as your username.</div>

      <!--TURNSTILE-->

      <button id="submit" type="submit">Request account</button>
    </form>

    <p class="muted" style="margin-top:1rem">Already approved? <a href="/account">Sign in</a></p>
  </div>

<script>
  const form = document.getElementById('signup-form');
  const banner = document.getElementById('banner');
  const submit = document.getElementById('submit');

  // An ?invite= code (from a "join my library" link) means no approval wait —
  // the account activates immediately and joins that household.
  const inviteCode = new URLSearchParams(location.search).get('invite') || '';
  if (inviteCode) {
    const n = document.getElementById('invite-note');
    n.className = 'banner ok';
    n.textContent = "You've been invited to join a shared library. Create your account below — no approval needed.";
  }

  function show(kind, msg) {
    banner.className = 'banner ' + kind;
    banner.textContent = msg;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value.trim();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    if (password.length < 10) { show('err', 'Password must be at least 10 characters.'); return; }
    if (password.toLowerCase() === username.toLowerCase()) { show('err', 'Password must not match the username.'); return; }

    // Turnstile injects a hidden input named cf-turnstile-response into the form.
    const tokenEl = form.querySelector('[name="cf-turnstile-response"]');
    const turnstileToken = tokenEl ? tokenEl.value : undefined;

    submit.disabled = true;
    banner.className = 'banner';
    try {
      const res = await fetch('/api/signup/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password, turnstileToken, inviteCode }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        form.style.display = 'none';
        document.getElementById('invite-note').style.display = 'none';
        show('ok', data.message || 'Your account has been submitted and is awaiting approval.');
        if (data.status === 'active') {
          banner.innerHTML += ' <a href="/account" style="color:inherit;font-weight:600">Sign in &rarr;</a>';
        }
      } else {
        show('err', data.error || ('Request failed (HTTP ' + res.status + ')'));
        submit.disabled = false;
        if (window.turnstile) try { window.turnstile.reset(); } catch (e) {}
      }
    } catch (err) {
      show('err', 'Network error: ' + err.message);
      submit.disabled = false;
      if (window.turnstile) try { window.turnstile.reset(); } catch (e) {}
    }
  });
</script>
</body>
</html>`;
