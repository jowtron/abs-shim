// The password-reset page, served at /reset (src/routes/password-reset.ts has
// the API, src/lib/password-reset.ts the rules). Two modes in one page:
//   /reset            "Forgot password?": username or email → an emailed link
//                     (?u= pre-fills it; /admin and Pholia pass what was typed)
//   /reset#t=<secret> a link: choose a new password. The secret is in the
//                     fragment so it never reaches a server log; the page
//                     POSTs it and strips it from the address bar.
// Same look as the signup page; Turnstile on the request form only.

export function renderResetHtml(siteKey?: string): string {
  const widget = siteKey
    ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
      <div class="cf-turnstile" data-sitekey="${siteKey}" data-theme="auto" style="margin-top:1rem"></div>`
    : '';
  return RESET_HTML.replace('<!--TURNSTILE-->', widget);
}

const RESET_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Reset your password · Rhapsode</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
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
    body { margin: 0; padding: 1.5rem 1rem; background: var(--bg); color: var(--fg); display: flex; justify-content: center; }
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
    .hidden { display: none; }
    a { color: var(--accent); }
  </style>
</head>
<body>
  <div class="wrap">
    <h1 id="title">Forgot your password?</h1>
    <p id="lead" class="muted">Enter your username or the email address on your account, and we'll email you a link to choose a new password.</p>

    <div id="banner" class="banner"></div>

    <form id="request-form" class="card">
      <label for="login">Username or email</label>
      <input id="login" autocomplete="username" autocapitalize="none" spellcheck="false" required />
      <!--TURNSTILE-->
      <button id="request-submit" type="submit">Email me a link</button>
    </form>

    <form id="reset-form" class="card hidden">
      <input id="reset-username" autocomplete="username" class="hidden" readonly />
      <label for="new-password">New password</label>
      <input id="new-password" type="password" autocomplete="new-password" required />
      <div class="hint">At least 10 characters, and not the same as your username.</div>
      <label for="confirm-password">New password again</label>
      <input id="confirm-password" type="password" autocomplete="new-password" required />
      <button id="reset-submit" type="submit">Set new password</button>
    </form>

    <p id="footer" class="muted" style="margin-top:1rem">No email on your account? Ask the person who runs this server for a reset link. <a href="/account">Back to sign in</a></p>
  </div>

<script>
  const banner = document.getElementById('banner');
  function show(kind, msg) { banner.className = 'banner ' + kind; banner.textContent = msg; }
  function clear() { banner.className = 'banner'; banner.textContent = ''; }

  const token = new URLSearchParams(location.hash.slice(1)).get('t') || '';
  const requestForm = document.getElementById('request-form');
  const resetForm = document.getElementById('reset-form');

  if (token) {
    // Keep the secret out of the address bar, history and any screenshot.
    history.replaceState(null, '', location.pathname);
    requestForm.classList.add('hidden');
    document.getElementById('title').textContent = 'Choose a new password';
    document.getElementById('lead').textContent = 'Checking your link…';
    document.getElementById('footer').innerHTML = '<a href="/account">Back to sign in</a>';
    fetch('/api/password-reset/check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
    }).then((r) => r.json()).then((d) => {
      if (!d.valid) {
        document.getElementById('lead').textContent = '';
        show('err', d.error || 'This link has expired or has already been used.');
        document.getElementById('footer').innerHTML = '<a href="/reset">Ask for a new link</a> · <a href="/account">Back to sign in</a>';
        return;
      }
      document.getElementById('lead').textContent = 'For the account ' + d.username + '. Every device signed in to it will be signed out and its passkeys removed, so you’ll sign in again with the new password.';
      document.getElementById('reset-username').value = d.username;
      resetForm.classList.remove('hidden');
      document.getElementById('new-password').focus();
    }).catch((e) => { show('err', 'Network error: ' + e.message); });
  } else {
    const u = new URLSearchParams(location.search).get('u');
    if (u) document.getElementById('login').value = u;
  }

  requestForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('request-submit');
    const login = document.getElementById('login').value.trim();
    const tokenEl = requestForm.querySelector('[name="cf-turnstile-response"]');
    const turnstileToken = tokenEl ? tokenEl.value : undefined;
    btn.disabled = true; clear();
    try {
      const res = await fetch('/api/password-reset/request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login, turnstileToken }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        requestForm.classList.add('hidden');
        show('ok', d.message || 'If that account has an email address, a link is on its way.');
        return;
      }
      show('err', d.error || ('Request failed (HTTP ' + res.status + ')'));
    } catch (err) {
      show('err', 'Network error: ' + err.message);
    }
    btn.disabled = false;
    if (window.turnstile) try { window.turnstile.reset(); } catch (e) {}
  });

  resetForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('reset-submit');
    const password = document.getElementById('new-password').value;
    const again = document.getElementById('confirm-password').value;
    const username = document.getElementById('reset-username').value;
    if (password !== again) { show('err', 'The two passwords don’t match.'); return; }
    if (password.length < 10) { show('err', 'Password must be at least 10 characters.'); return; }
    if (password.toLowerCase() === username.toLowerCase()) { show('err', 'Password must not match the username.'); return; }
    btn.disabled = true; clear();
    try {
      const res = await fetch('/api/password-reset/complete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        resetForm.classList.add('hidden');
        document.getElementById('lead').textContent = '';
        show('ok', 'Your password has been changed. Sign in with it in Pholia or any audiobook app.');
        document.getElementById('footer').innerHTML = '<a href="/account">Sign in here</a>';
        return;
      }
      show('err', d.error || ('Request failed (HTTP ' + res.status + ')'));
      if (res.status === 410) {
        resetForm.classList.add('hidden');
        document.getElementById('footer').innerHTML = '<a href="/reset">Ask for a new link</a> · <a href="/account">Back to sign in</a>';
        return;
      }
    } catch (err) {
      show('err', 'Network error: ' + err.message);
    }
    btn.disabled = false;
  });
</script>
</body>
</html>`;
