// Minimal admin UI. Single self-contained HTML file with vanilla JS — no
// build step, no framework. Served at /admin and /admin/ by the Worker
// (registered before the Nuxt SPA fallback so its not_found_handling doesn't
// swallow the route).
//
// Why not put this in the Nuxt UI: the bundled ABS web client doesn't have
// the concept of "shim storage settings", and I don't want to maintain a
// fork of it. A separate, ugly-but-honest admin surface keeps the two
// concerns isolated.
//
// Auth: relies on the `accessToken` cookie set by /login. Pages that haven't
// logged in get bounced to /login.

export const ADMIN_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>ABS_shim · admin</title>
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
    body { margin: 0; padding: 1.5rem; background: var(--bg); color: var(--fg); max-width: 900px; }
    h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
    h2 { font-size: 1.1rem; margin: 1.5rem 0 0.5rem; }
    .muted { color: var(--muted); font-size: 0.9rem; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
    .row { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; }
    button, .btn {
      background: var(--accent); color: white; border: 0; padding: 0.5rem 1rem;
      border-radius: 6px; cursor: pointer; font-size: 0.95rem; text-decoration: none;
      display: inline-block;
    }
    button.secondary, .btn.secondary { background: transparent; color: var(--fg); border: 1px solid var(--border); }
    button.danger, .btn.danger { background: transparent; color: var(--warn); border: 1px solid var(--warn); }
    button:hover, .btn:hover { opacity: 0.9; }
    input, select { background: var(--card); color: var(--fg); border: 1px solid var(--border); padding: 0.4rem 0.6rem; border-radius: 4px; font-size: 0.95rem; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--border); }
    .ok { color: var(--ok); }
    .warn { color: var(--warn); }
    pre { background: var(--bg); padding: 0.5rem; border-radius: 4px; overflow-x: auto; font-size: 0.85rem; border: 1px solid var(--border); }
    code { background: rgba(125,125,125,0.15); padding: 0.1em 0.3em; border-radius: 3px; }
    .upload-area { margin-top: 0.5rem; padding: 0.6rem; background: var(--bg); border: 1px dashed var(--border); border-radius: 6px; display: none; }
    .upload-area.open { display: block; }
    .upload-row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-bottom: 0.5rem; }
    .upload-row input[type=text] { flex: 1; min-width: 160px; }
    .upload-item { padding: 0.4rem 0.5rem; background: var(--card); border: 1px solid var(--border); border-radius: 4px; margin: 0.25rem 0; font-size: 0.85rem; }
    .upload-item .name { font-weight: 500; word-break: break-all; }
    .upload-item .progress-bar { display: block; height: 4px; background: var(--border); border-radius: 2px; margin-top: 0.3rem; overflow: hidden; }
    .upload-item .progress-bar > span { display: block; height: 100%; background: var(--accent); width: 0%; transition: width 0.15s; }
    .upload-item.ok { border-color: var(--ok); }
    .upload-item.ok .progress-bar > span { background: var(--ok); }
    .upload-item.err { border-color: var(--warn); }
    .upload-item .status { color: var(--muted); margin-left: 0.5rem; }
    .upload-item.ok .status { color: var(--ok); }
    .upload-item.err .status { color: var(--warn); }
    .books-list { margin-top: 0.5rem; padding: 0.5rem; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; }
    .book-row { display: flex; gap: 0.5rem; align-items: center; padding: 0.35rem 0.5rem; background: var(--card); border: 1px solid var(--border); border-radius: 4px; margin: 0.25rem 0; font-size: 0.85rem; flex-wrap: wrap; }
    .book-row .title { font-weight: 500; flex: 1; min-width: 200px; word-break: break-word; }
    .book-row .meta { color: var(--muted); font-size: 0.8rem; }
    .book-row .no-chapters { color: var(--warn); }
    .book-row button { font-size: 0.75rem; padding: 0.2rem 0.55rem; flex-shrink: 0; }
  </style>
</head>
<body>
  <div class="row" style="justify-content: space-between; align-items: flex-start">
    <h1>ABS_shim · admin</h1>
    <button id="signout" class="secondary" style="display:none">Sign out</button>
  </div>
  <p class="muted">
    Storage backends + library scans.
    <a href="/audiobookshelf" style="color: var(--accent)">Open ABS web UI</a>
    &nbsp;·&nbsp;
    <a href="https://pholia.jderrick.app" target="_blank" rel="noopener" style="color: var(--accent)">Open Pholia ↗</a>
  </p>

  <div id="error-banner" class="card" style="display:none; border-color: var(--warn); color: var(--warn)"></div>

  <div id="login-card" class="card" style="display:none">
    <h2>Sign in</h2>
    <p class="muted">Cookie session expired or missing. Sign in to continue.</p>
    <form id="login-form" class="row">
      <input id="login-username" placeholder="username" autocomplete="username" required />
      <input id="login-password" placeholder="password" type="password" autocomplete="current-password" required />
      <button type="submit">Sign in</button>
    </form>
  </div>

  <div id="connections-card" class="card">
    <h2>Cloud connections</h2>
    <div id="connections-body" class="muted">Loading…</div>
    <div id="connect-actions" class="row" style="margin-top: 1rem; display:none">
      <a class="btn" id="connect-pcloud" href="/api/admin/storage/pcloud/start">Connect pCloud</a>
      <span class="muted">More providers coming.</span>
    </div>
    <details id="pcloud-setup" class="muted" style="margin-top: 1rem; display:none">
      <summary style="cursor: pointer; color: var(--accent)">pCloud OAuth not configured — setup instructions (only needed for private pCloud folders)</summary>
      <div style="margin-top: 0.75rem; line-height: 1.5">
        <p><strong>You don't need this if you're already using a pCloud <em>public folder</em> URL</strong> (a <code>filedn.com</code> link). The OAuth flow below is only required to attach a <em>private</em> pCloud folder where files aren't publicly listable.</p>
        <p>To enable pCloud OAuth, you need an OAuth app's <code>client_id</code> and <code>client_secret</code> stored as Cloudflare Worker secrets.</p>
        <p><strong>Step 1 — Get an OAuth app from pCloud.</strong> Their "New App" button under My Applications is currently disabled (rate-limited due to abuse), so you have to request one manually. Email <a href="mailto:support@pcloud.com" style="color: var(--accent)">support@pcloud.com</a>; here's a template that has worked, just replace <code>&lt;your-handle&gt;</code>:</p>
        <pre style="white-space: pre-wrap; user-select: all">Subject: OAuth app request (manual — &quot;New App&quot; is unavailable)

Hi,

I'd like to register an OAuth application against my pCloud account. The "New App" button under My Applications returns "Temporary unavailable, please contact support team", so I'm requesting one manually as your support team has previously suggested for cases like this.

App details:

  App name: abs-shim-&lt;your-handle&gt;
  Folder access: All Folders
  Write access: Yes
  Description: Personal serverless audiobook server hosted on Cloudflare Workers. The app reads audiobook files from my own pCloud account so the official Audiobookshelf mobile and web clients can stream them. Strictly personal use, single account, no third-party redistribution.

API methods I plan to call:

  - listfolder    — to enumerate audiobooks for the library scanner
  - getfilelink   — to mint short-lived stream URLs for clients
  - createuploadlink — to mint scoped upload links so users can add audiobooks via a browser without exposing the OAuth token to client-side JavaScript

The reason I'm requesting write access despite not invoking uploadfile or deletefile directly: createuploadlink (https://docs.pcloud.com/methods/upload_links/createuploadlink.html) requires write permission, and it's the cleanest way to keep the OAuth secret server-side while still supporting browser uploads. All upload links will be created with sensible expire / maxfiles / maxspace caps.

Two small follow-up questions while you're setting this up:

  1. Does createuploadlink require any OAuth scope beyond standard write permission?
  2. Are pCloud upload-link pages (https://my.pcloud.com/#page=puplink&amp;code=...) embeddable in an iframe, or do they send X-Frame-Options: deny? Affects whether I embed the upload step inside my admin UI or open a popup.

Either way, ready to proceed with whatever credentials you can provision.

Thanks,
&lt;your-name&gt;</pre>
        <p>They typically reply within ~1 business day with your <code>client_id</code> and <code>client_secret</code>.</p>
        <p><strong>Step 2 — Store them as Worker secrets.</strong> From the project directory on your machine:</p>
        <pre style="user-select: all">npx wrangler secret put PCLOUD_CLIENT_ID
npx wrangler secret put PCLOUD_CLIENT_SECRET</pre>
        <p>Each command prompts for the value — paste it in, hit return.</p>
        <p><strong>Step 3 — Reload this page.</strong> The "Connect pCloud" button will appear in place of these instructions.</p>
      </div>
    </details>
  </div>

  <div id="libraries-card" class="card">
    <h2>Libraries</h2>
    <div id="libraries-body" class="muted">Loading…</div>
  </div>

  <div id="cover-cache-card" class="card">
    <h2>Cover cache</h2>
    <p class="muted">Covers are probed from the m4b on first request and stored in R2 so subsequent loads (from any CF POP) are fast. Click below to pre-fetch every library item's cover now.</p>
    <div class="row">
      <button id="warm-covers" class="secondary">Warm cover cache</button>
      <span id="warm-status" class="muted"></span>
    </div>
  </div>

  <div id="household-card" class="card" style="display:none">
    <h2>Library members</h2>
    <p class="muted">Everyone here shares the same libraries but keeps their own progress, bookmarks, and finished books.</p>
    <div id="members-body" class="muted">Loading…</div>
    <div id="invite-actions" class="row" style="margin-top:1rem; display:none">
      <button id="create-invite" class="secondary">Invite someone…</button>
      <span id="invite-status" class="muted"></span>
    </div>
    <div id="invites-body"></div>
  </div>

  <div id="members-card" class="card" style="display:none">
    <h2>Members &amp; signups</h2>
    <p class="muted">Instance owner only. Approve people who requested an account; each approval gets its own isolated library.</p>
    <div class="row" style="margin: 0.75rem 0">
      <label for="signup-mode" style="font-size:0.9rem">New signups:</label>
      <select id="signup-mode">
        <option value="approval">Open (require approval)</option>
        <option value="closed">Closed</option>
      </select>
      <span id="signup-mode-status" class="muted"></span>
    </div>
    <h2 style="font-size:1rem">Pending approvals</h2>
    <div id="pending-body" class="muted">Loading…</div>
  </div>

  <div id="scan-card" class="card" style="display:none">
    <h2>Last scan</h2>
    <pre id="scan-output"></pre>
  </div>

<script>
async function api(path, opts) {
  const res = await fetch(path, { credentials: 'include', ...opts });
  if (res.status === 401) {
    showLoginForm();
    throw new UnauthorizedError();
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('HTTP ' + res.status + ' ' + text);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

class UnauthorizedError extends Error { constructor() { super('Unauthorized'); this.name = 'UnauthorizedError'; } }

function showLoginForm() {
  document.getElementById('login-card').style.display = 'block';
  document.getElementById('connections-card').style.display = 'none';
  document.getElementById('libraries-card').style.display = 'none';
  document.getElementById('cover-cache-card').style.display = 'none';
  document.getElementById('members-card').style.display = 'none';
  document.getElementById('household-card').style.display = 'none';
  document.getElementById('signout').style.display = 'none';
}

function hideLoginForm() {
  document.getElementById('login-card').style.display = 'none';
  document.getElementById('connections-card').style.display = '';
  document.getElementById('libraries-card').style.display = '';
  document.getElementById('cover-cache-card').style.display = '';
  document.getElementById('signout').style.display = '';
}

document.getElementById('signout').addEventListener('click', async () => {
  try { await fetch('/logout', { method: 'POST', credentials: 'include' }); } catch (e) {}
  showLoginForm();
});

document.getElementById('warm-covers').addEventListener('click', async (e) => {
  const btn = e.target;
  const status = document.getElementById('warm-status');
  btn.disabled = true;
  status.textContent = 'Probing…';
  try {
    const result = await api('/api/admin/covers/warm', { method: 'POST' });
    status.textContent = result.warmed + ' warmed, ' + result.skipped + ' already cached, ' + result.failed + ' failed (of ' + result.totalItems + ' items).';
  } catch (err) {
    showError('Warm failed: ' + err.message);
    status.textContent = '';
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  try {
    const res = await fetch('/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error('Login failed: HTTP ' + res.status);
    hideLoginForm();
    document.getElementById('login-password').value = '';
    refresh();
  } catch (err) {
    showError(err.message);
  }
});

function showError(msg) {
  const el = document.getElementById('error-banner');
  el.textContent = msg;
  el.style.display = 'block';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function describeFolder(f) {
  const c = f.config || {};
  if (f.provider === 'public_url') return 'base: ' + escapeHtml(f.legacyBaseUrl || c.baseUrl || '');
  if (f.provider === 'pcloud_oauth') return 'root: ' + escapeHtml(c.rootPath || '/') + ' · profile: ' + escapeHtml(f.profileId || '(missing)');
  if (f.provider === 's3') return escapeHtml(c.endpoint || '') + ' / ' + escapeHtml(c.bucket || '') + (c.prefix ? ' / ' + escapeHtml(c.prefix) : '');
  if (f.provider === 'webdav') return escapeHtml(c.baseUrl || '') + (c.rootPath ? ' / ' + escapeHtml(c.rootPath) : '') + ' (user: ' + escapeHtml(c.username || '?') + ')';
  return '';
}

// Friendly scan-report formatter. The most common "error" — listing not
// supported — gets a one-line explanation instead of a stack trace.
function formatScanReport(report) {
  const lines = [];
  lines.push('Added: ' + report.added);
  lines.push('Skipped: ' + report.skipped);
  lines.push('Duration: ' + report.durationMs + ' ms');
  if (report.errors && report.errors.length) {
    lines.push('');
    lines.push('Errors:');
    for (const err of report.errors) {
      if (err.reason && err.reason.indexOf('listing not supported') >= 0) {
        lines.push('  ✗ Auto-scan unavailable for this storage backend.');
        lines.push('    The current folder uses filedn (public-URL) storage,');
        lines.push('    which has no folder-listing API — pCloud OAuth, S3,');
        lines.push('    and WebDAV do.');
        lines.push('');
        lines.push('    To add a single book on a public-URL folder, use the');
        lines.push('    "Add book by path" button next to "Scan now" (scroll up');
        lines.push('    to the library card if it just hid behind this output).');
      } else {
        lines.push('  ✗ ' + (err.relPath || '(folder)') + ': ' + err.reason);
      }
    }
  }
  return lines.join('\n');
}

async function refresh() {
  let status, libs;
  try {
    [status, libs] = await Promise.all([
      api('/api/admin/storage/status'),
      api('/api/libraries'),
    ]);
  } catch (e) {
    if (e instanceof UnauthorizedError) return; // login form is now visible
    showError('Failed to load admin status: ' + e.message);
    return;
  }
  hideLoginForm();
  renderConnections(status);
  renderConnectActions(status);
  renderLibraries(status, libs.libraries || []);
  renderHousehold(status);
  renderMembers(status);

  // If we landed here from a successful OAuth callback, surface the freshly
  // created profile so the user can attach it without remembering its id.
  const params = new URLSearchParams(location.search);
  const profileId = params.get('profile_id');
  if (profileId) {
    const note = document.createElement('p');
    note.className = 'ok';
    note.textContent = '✓ pCloud connected. Pick a library below and attach this connection.';
    document.getElementById('connections-card').appendChild(note);
    window.__freshProfileId = profileId;
  }
}

function renderConnectActions(status) {
  const ready = status.secrets && status.secrets.pcloudConfigured;
  document.getElementById('connect-actions').style.display = ready ? '' : 'none';
  document.getElementById('pcloud-setup').style.display = ready ? 'none' : '';
}

function renderConnections(status) {
  const body = document.getElementById('connections-body');
  if (!status.profiles.length) {
    body.innerHTML = '<p class="muted">No cloud connections yet. Click below to connect pCloud.</p>';
    return;
  }
  let html = '<table><thead><tr><th>Provider</th><th>Account</th><th>API host</th><th>Connected</th><th></th></tr></thead><tbody>';
  for (const p of status.profiles) {
    html += '<tr>';
    html += '<td>' + escapeHtml(p.provider) + '</td>';
    html += '<td>' + escapeHtml(p.account_label || '—') + '</td>';
    html += '<td><code>' + escapeHtml(p.api_host || '') + '</code></td>';
    html += '<td>' + new Date(p.created_at).toLocaleString() + '</td>';
    html += '<td><button class="danger" data-disconnect="' + escapeHtml(p.id) + '">Disconnect</button></td>';
    html += '</tr>';
  }
  html += '</tbody></table>';
  body.innerHTML = html;
  body.querySelectorAll('[data-disconnect]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Disconnect this account? Libraries using it will stop working until reconnected.')) return;
      await api('/api/admin/storage/pcloud/disconnect/' + btn.dataset.disconnect, { method: 'POST' });
      refresh();
    });
  });
}

function renderHousehold(status) {
  const card = document.getElementById('household-card');
  card.style.display = '';
  const isOwner = status.role === 'owner';
  window.__myUserId = status.userId;

  // Member roster.
  api('/api/admin/members').then((data) => {
    const members = (data && data.members) || [];
    let html = '<table><thead><tr><th>Member</th><th>Role</th><th></th></tr></thead><tbody>';
    for (const m of members) {
      const you = m.userId === status.userId ? ' <span class="muted">(you)</span>' : '';
      html += '<tr><td>' + escapeHtml(m.username) + you
        + (m.email ? ' <span class="muted">&middot; ' + escapeHtml(m.email) + '</span>' : '') + '</td>';
      html += '<td>' + escapeHtml(m.role) + '</td>';
      html += '<td>';
      if (isOwner && m.role !== 'owner' && m.userId !== status.userId) {
        html += '<button class="danger" data-remove-member="' + escapeHtml(m.userId) + '" style="font-size:0.78rem;padding:0.2rem 0.55rem">Remove</button>';
      }
      html += '</td></tr>';
    }
    html += '</tbody></table>';
    const body = document.getElementById('members-body');
    body.innerHTML = html;
    body.querySelectorAll('[data-remove-member]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this member? They lose access to the shared library.')) return;
        try { await api('/api/admin/members/' + btn.dataset.removeMember, { method: 'DELETE' }); renderHousehold(status); }
        catch (err) { showError('Remove failed: ' + err.message); }
      });
    });
  }).catch((e) => { if (!(e instanceof UnauthorizedError)) document.getElementById('members-body').innerHTML = '<p class="warn">' + escapeHtml(e.message) + '</p>'; });

  // Owner-only: invite controls + open invites.
  document.getElementById('invite-actions').style.display = isOwner ? '' : 'none';
  document.getElementById('invites-body').innerHTML = '';
  if (!isOwner) return;

  const createBtn = document.getElementById('create-invite');
  if (!createBtn.dataset.wired) {
    createBtn.dataset.wired = '1';
    createBtn.addEventListener('click', async () => {
      const note = document.getElementById('invite-status');
      note.textContent = 'Creating…';
      try {
        const inv = await api('/api/admin/invites', { method: 'POST' });
        note.textContent = '';
        await navigator.clipboard.writeText(inv.url).catch(() => {});
        prompt('Share this single-use invite link (copied to clipboard):', inv.url);
        renderHousehold(status);
      } catch (err) { note.textContent = ''; showError('Could not create invite: ' + err.message); }
    });
  }

  api('/api/admin/invites').then((data) => {
    const invites = (data && data.invites) || [];
    const ib = document.getElementById('invites-body');
    if (!invites.length) { ib.innerHTML = '<p class="muted" style="margin-top:0.75rem">No open invites.</p>'; return; }
    let html = '<p class="muted" style="margin-top:1rem">Open invites:</p><table><tbody>';
    for (const i of invites) {
      const exp = i.expiresAt ? new Date(i.expiresAt).toLocaleDateString() : 'never';
      html += '<tr><td><code>' + escapeHtml(i.code.slice(0, 10)) + '…</code></td>'
        + '<td class="muted">expires ' + exp + '</td>'
        + '<td><button class="secondary" data-copy-invite="' + escapeHtml(i.code) + '" style="font-size:0.78rem;padding:0.2rem 0.55rem">Copy link</button> '
        + '<button class="danger" data-revoke-invite="' + escapeHtml(i.code) + '" style="font-size:0.78rem;padding:0.2rem 0.55rem">Revoke</button></td></tr>';
    }
    html += '</tbody></table>';
    ib.innerHTML = html;
    ib.querySelectorAll('[data-copy-invite]').forEach((btn) => btn.addEventListener('click', () => {
      const url = location.origin + '/signup?invite=' + btn.dataset.copyInvite;
      navigator.clipboard.writeText(url).catch(() => {});
      prompt('Invite link (copied):', url);
    }));
    ib.querySelectorAll('[data-revoke-invite]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!confirm('Revoke this invite link?')) return;
      try { await api('/api/admin/invites/' + btn.dataset.revokeInvite, { method: 'DELETE' }); renderHousehold(status); }
      catch (err) { showError('Revoke failed: ' + err.message); }
    }));
  }).catch(() => {});
}

function renderMembers(status) {
  const card = document.getElementById('members-card');
  if (!status.isInstanceOwner) { card.style.display = 'none'; return; }
  card.style.display = '';

  // Signup mode selector.
  const sel = document.getElementById('signup-mode');
  if (status.signupMode) sel.value = status.signupMode;
  if (!sel.dataset.wired) {
    sel.dataset.wired = '1';
    sel.addEventListener('change', async () => {
      const note = document.getElementById('signup-mode-status');
      note.textContent = 'Saving…';
      try {
        await api('/api/admin/signup/mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: sel.value }),
        });
        note.textContent = '✓ saved';
        setTimeout(() => { note.textContent = ''; }, 1500);
      } catch (err) {
        note.textContent = '';
        showError('Could not change signup mode: ' + err.message);
      }
    });
  }

  loadPending();
}

async function loadPending() {
  const body = document.getElementById('pending-body');
  let data;
  try {
    data = await api('/api/admin/signup/pending');
  } catch (e) {
    if (e instanceof UnauthorizedError) return;
    body.innerHTML = '<p class="warn">Failed to load pending signups: ' + escapeHtml(e.message) + '</p>';
    return;
  }
  const pending = data.pending || [];
  if (!pending.length) {
    body.innerHTML = '<p class="muted">No accounts awaiting approval.</p>';
    return;
  }
  let html = '<table><thead><tr><th>Username</th><th>Email</th><th>Requested</th><th></th></tr></thead><tbody>';
  for (const p of pending) {
    html += '<tr>';
    html += '<td>' + escapeHtml(p.username) + '</td>';
    html += '<td>' + escapeHtml(p.email || '—') + '</td>';
    html += '<td>' + new Date(p.created_at).toLocaleString() + '</td>';
    html += '<td style="white-space:nowrap">'
      + '<button data-approve="' + escapeHtml(p.id) + '" style="font-size:0.8rem; padding:0.2rem 0.6rem">Approve</button> '
      + '<button class="danger" data-reject="' + escapeHtml(p.id) + '" style="font-size:0.8rem; padding:0.2rem 0.6rem">Reject</button>'
      + '</td>';
    html += '</tr>';
  }
  html += '</tbody></table>';
  body.innerHTML = html;

  body.querySelectorAll('[data-approve]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api('/api/admin/users/' + btn.dataset.approve + '/approve', { method: 'POST' });
        loadPending();
      } catch (err) {
        btn.disabled = false;
        showError('Approve failed: ' + err.message);
      }
    });
  });
  body.querySelectorAll('[data-reject]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Reject and delete this signup request?')) return;
      btn.disabled = true;
      try {
        await api('/api/admin/users/' + btn.dataset.reject + '/reject', { method: 'POST' });
        loadPending();
      } catch (err) {
        btn.disabled = false;
        showError('Reject failed: ' + err.message);
      }
    });
  });
}

function renderLibraries(status, libraries) {
  const body = document.getElementById('libraries-body');
  if (!libraries.length) {
    body.innerHTML = '<p class="muted">No libraries configured.</p>';
    return;
  }
  // Group folders by library so a library can have many.
  const foldersByLib = {};
  for (const f of status.folders) {
    (foldersByLib[f.libraryId] = foldersByLib[f.libraryId] || []).push(f);
  }

  const stats = status.stats || {};
  let html = '';
  for (const lib of libraries) {
    const folders = foldersByLib[lib.id] || [];
    const s = stats[lib.id] || { bookCount: 0, missingCount: 0, totalDurationSeconds: 0, totalSizeBytes: 0 };
    html += '<div style="margin-bottom: 1.5rem; padding-bottom: 1rem; border-bottom: 1px solid var(--border);">';
    html += '<strong>' + escapeHtml(lib.name) + '</strong> ';
    html += '<span class="muted">· ' + escapeHtml(lib.id) + '</span><br>';
    html += '<span class="muted" style="font-size:0.85rem;">' + s.bookCount + ' book' + (s.bookCount === 1 ? '' : 's');
    if (s.totalDurationSeconds > 0) {
      html += ' · ' + formatDuration(s.totalDurationSeconds);
    }
    if (s.totalSizeBytes > 0) {
      html += ' · ' + formatBytes(s.totalSizeBytes);
    }
    if (s.missingCount > 0) {
      html += ' · <span class="warn">' + s.missingCount + ' missing</span>';
    }
    html += '</span><br>';

    if (!folders.length) {
      html += '<p class="muted" style="margin: 0.5rem 0;">No storage backends connected yet.</p>';
    } else {
      html += '<div style="margin: 0.5rem 0;">';
      for (const f of folders) {
        html += '<div style="display:flex; gap:0.5rem; align-items:center; padding:0.4rem 0.5rem; margin:0.25rem 0; background:var(--bg); border:1px solid var(--border); border-radius:4px; flex-wrap:wrap;">';
        html += '<code style="flex-shrink:0">' + escapeHtml(f.provider) + '</code>';
        // min-width:0 lets flex children shrink below their content width;
        // word-break makes long URLs wrap inside the card on mobile rather
        // than spilling out the side.
        html += '<span class="muted" style="flex:1; min-width:0; font-size: 0.85rem; word-break: break-all;">' + describeFolder(f) + '</span>';
        html += '<button class="danger" data-remove-folder="' + escapeHtml(f.id) + '" style="font-size:0.8rem; padding:0.2rem 0.6rem; flex-shrink:0">Remove</button>';
        html += '</div>';
      }
      html += '</div>';
    }

    const pcloudFolder = folders.find((f) => f.provider === 'pcloud_oauth');

    // Primary actions row.
    html += '<div class="row" style="flex-wrap: wrap; gap: 0.5rem;">';
    html += '<button data-scan="' + escapeHtml(lib.id) + '">Scan now</button>';
    html += '<button class="secondary" data-add-path="' + escapeHtml(lib.id) + '">Add book by path</button>';
    if (pcloudFolder) {
      html += '<button class="secondary" data-upload-toggle="' + escapeHtml(lib.id) + '">Upload audiobook…</button>';
    }
    html += '<button class="secondary" data-show-books="' + escapeHtml(lib.id) + '">Show books (' + s.bookCount + ')</button>';
    html += '<button class="secondary" data-reprobe-missing="' + escapeHtml(lib.id) + '">Re-probe books missing chapters</button>';
    html += '<button class="secondary" data-reprobe-all="' + escapeHtml(lib.id) + '">Re-probe all</button>';
    html += '</div>';

    // Hidden book list — populated lazily on first "Show books" click.
    html += '<div id="books-list-' + escapeHtml(lib.id) + '" class="books-list" style="display:none">Loading…</div>';

    // Inline upload widget — placed directly under the row that contains the
    // toggle button so it visually belongs to "Upload audiobook…", not to the
    // attach-backend row below.
    if (pcloudFolder) {
      html += '<div class="upload-area" id="upload-area-' + escapeHtml(lib.id) + '" data-folder="' + escapeHtml(pcloudFolder.id) + '">';
      html += '<div class="upload-row">';
      html += '<input type="file" multiple accept=".m4b,.m4a,.aac,.zip,.rar" data-upload-files="' + escapeHtml(lib.id) + '" />';
      html += '<input type="text" placeholder="Optional subfolder, e.g. The Hobbit/" data-upload-subfolder="' + escapeHtml(lib.id) + '" />';
      html += '<button data-upload-go="' + escapeHtml(lib.id) + '">Upload</button>';
      html += '</div>';
      html += '<div class="upload-list" id="upload-list-' + escapeHtml(lib.id) + '"></div>';
      html += '</div>';
    }

    // Secondary actions: attach another backend.
    html += '<div class="row" style="flex-wrap: wrap; gap: 0.5rem; margin-top: 0.5rem;">';
    html += '<span class="muted" style="width:100%">Add another storage backend:</span>';
    html += '<button class="secondary" data-attach-s3="' + escapeHtml(lib.id) + '">S3-compat (R2 / B2 / S3 / Wasabi)</button>';
    html += '<button class="secondary" data-attach-webdav="' + escapeHtml(lib.id) + '">WebDAV (NAS)</button>';
    if (status.profiles.some((p) => p.provider === 'pcloud')) {
      html += '<button class="secondary" data-attach-pcloud="' + escapeHtml(lib.id) + '">pCloud (OAuth)</button>';
    }
    html += '</div>';

    html += '</div>';
  }
  body.innerHTML = html;

  body.querySelectorAll('[data-remove-folder]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this storage backend? Books that live on it must be deleted or migrated first — the request fails if any items still reference it.')) return;
      try {
        await api('/api/admin/storage/folder/' + btn.dataset.removeFolder, { method: 'DELETE' });
        refresh();
      } catch (e) {
        showError('Remove failed: ' + e.message);
      }
    });
  });

  body.querySelectorAll('[data-scan]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'Scanning…';
      try {
        const report = await api('/api/admin/libraries/' + btn.dataset.scan + '/scan', { method: 'POST' });
        document.getElementById('scan-card').style.display = 'block';
        document.getElementById('scan-output').textContent = formatScanReport(report);
      } catch (e) {
        showError('Scan failed: ' + e.message);
      } finally {
        btn.disabled = false; btn.textContent = 'Scan now';
        refresh();
      }
    });
  });

  body.querySelectorAll('[data-add-path]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const libId = btn.dataset.addPath;
      const relPath = prompt('Relative path inside the library folder.\n\nExample: "The Singularity Trap/The Singularity Trap (Unabridged).m4b"', '');
      if (!relPath) return;
      btn.disabled = true; btn.textContent = 'Adding…';
      try {
        const result = await api('/api/admin/books/add-by-path', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ libraryId: libId, relPath: relPath.trim() }),
        });
        document.getElementById('scan-card').style.display = 'block';
        document.getElementById('scan-output').textContent = JSON.stringify(result, null, 2);
      } catch (e) {
        showError('Add failed: ' + e.message);
      } finally {
        btn.disabled = false; btn.textContent = 'Add book by path';
        refresh();
      }
    });
  });

  body.querySelectorAll('[data-attach-s3]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const libId = btn.dataset.attachS3;
      const endpoint = prompt('S3 endpoint URL.\n\nExamples:\n  Cloudflare R2: https://<accountid>.r2.cloudflarestorage.com\n  AWS S3:        https://s3.us-east-1.amazonaws.com\n  Backblaze B2:  https://s3.us-west-002.backblazeb2.com\n  Wasabi:        https://s3.us-east-1.wasabisys.com');
      if (!endpoint) return;
      const bucket = prompt('Bucket name (e.g. abs-shim-books):');
      if (!bucket) return;
      const region = prompt('Region (R2 = "auto", AWS = "us-east-1" etc.):', 'auto');
      if (region == null) return;
      const prefix = prompt('Path prefix inside the bucket (optional, e.g. "audiobooks/"):', '') || '';
      const accessKeyId = prompt('Access Key ID:');
      if (!accessKeyId) return;
      const secretAccessKey = prompt('Secret Access Key:');
      if (!secretAccessKey) return;
      try {
        await api('/api/admin/storage/folder/s3', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ libraryId: libId, endpoint, bucket, region, prefix, accessKeyId, secretAccessKey }),
        });
        refresh();
      } catch (e) {
        showError('Attach failed: ' + e.message);
      }
    });
  });

  body.querySelectorAll('[data-attach-webdav]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const libId = btn.dataset.attachWebdav;
      const baseUrl = prompt('WebDAV server URL.\n\nExamples:\n  Synology DSM:    https://<dns-name>:5006/\n  Nextcloud:       https://nc.example.com/remote.php/dav/files/<user>/\n  TrueNAS:         https://nas.example.com/dav/\n\nMust be reachable from the public internet (Cloudflare Tunnel recommended).');
      if (!baseUrl) return;
      const username = prompt('Username:');
      if (!username) return;
      const password = prompt('Password (or app-specific token):');
      if (!password) return;
      const rootPath = prompt('Subfolder inside the WebDAV root (optional, e.g. "Audiobooks/"):', '') || '';
      try {
        await api('/api/admin/storage/folder/webdav', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ libraryId: libId, baseUrl, username, password, rootPath }),
        });
        refresh();
      } catch (e) {
        showError('Attach failed: ' + e.message);
      }
    });
  });

  body.querySelectorAll('[data-show-books]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const libId = btn.dataset.showBooks;
      const list = document.getElementById('books-list-' + libId);
      if (!list) return;
      // Toggle: hide if already shown.
      if (list.style.display !== 'none' && list.dataset.loaded === '1') {
        list.style.display = 'none';
        return;
      }
      list.style.display = 'block';
      list.textContent = 'Loading…';
      try {
        const data = await api('/api/admin/libraries/' + libId + '/items');
        renderBooksList(list, data.items || []);
        list.dataset.loaded = '1';
      } catch (e) {
        list.textContent = 'Failed to load books: ' + e.message;
      }
    });
  });

  body.querySelectorAll('[data-reprobe-missing]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const libId = btn.dataset.reprobeMissing;
      btn.disabled = true; btn.textContent = 'Re-probing…';
      try {
        const r = await api('/api/admin/libraries/' + libId + '/reprobe?onlyMissingChapters=1', { method: 'POST' });
        document.getElementById('scan-card').style.display = 'block';
        document.getElementById('scan-output').textContent = JSON.stringify(r, null, 2);
        // If the books list is open, refresh it to show new chapter counts.
        const list = document.getElementById('books-list-' + libId);
        if (list && list.dataset.loaded === '1') {
          const data = await api('/api/admin/libraries/' + libId + '/items');
          renderBooksList(list, data.items || []);
        }
      } catch (e) {
        showError('Re-probe failed: ' + e.message);
      } finally {
        btn.disabled = false; btn.textContent = 'Re-probe books missing chapters';
      }
    });
  });

  body.querySelectorAll('[data-reprobe-all]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const libId = btn.dataset.reprobeAll;
      if (!confirm('Re-probe every book in this library? This re-reads each m4b\'s moov atom — for a 100-book library that\'s ~500 MB of pCloud bandwidth and several minutes of wall time.')) return;
      btn.disabled = true; btn.textContent = 'Re-probing…';
      try {
        const r = await api('/api/admin/libraries/' + libId + '/reprobe', { method: 'POST' });
        document.getElementById('scan-card').style.display = 'block';
        document.getElementById('scan-output').textContent = JSON.stringify(r, null, 2);
        const list = document.getElementById('books-list-' + libId);
        if (list && list.dataset.loaded === '1') {
          const data = await api('/api/admin/libraries/' + libId + '/items');
          renderBooksList(list, data.items || []);
        }
      } catch (e) {
        showError('Re-probe failed: ' + e.message);
      } finally {
        btn.disabled = false; btn.textContent = 'Re-probe all';
      }
    });
  });

  body.querySelectorAll('[data-upload-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const area = document.getElementById('upload-area-' + btn.dataset.uploadToggle);
      if (area) area.classList.toggle('open');
    });
  });

  body.querySelectorAll('[data-upload-go]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const libId = btn.dataset.uploadGo;
      const area = document.getElementById('upload-area-' + libId);
      const folderId = area && area.dataset.folder;
      const fileInput = document.querySelector('[data-upload-files="' + libId + '"]');
      const subfolderInput = document.querySelector('[data-upload-subfolder="' + libId + '"]');
      if (!folderId || !fileInput || !fileInput.files || !fileInput.files.length) {
        showError('Pick at least one file to upload.');
        return;
      }
      const subfolder = (subfolderInput && subfolderInput.value || '').trim().replace(/^\/+|\/+$/g, '');
      const listEl = document.getElementById('upload-list-' + libId);
      btn.disabled = true;
      try {
        for (const file of fileInput.files) {
          await uploadFile(folderId, file, subfolder, listEl);
        }
        const done = document.createElement('div');
        done.className = 'muted';
        done.style.cssText = 'margin-top:0.5rem; font-size:0.85rem';
        done.textContent = 'Batch finished. Reload the page to refresh library counts.';
        listEl.appendChild(done);
      } finally {
        btn.disabled = false;
        fileInput.value = '';
        // Deliberately no refresh() here — refresh re-renders the libraries
        // pane and wipes this upload-list (and any error rows) before the
        // user can read them. Manual reload picks up new counts.
      }
    });
  });

  body.querySelectorAll('[data-attach-pcloud]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const libId = btn.dataset.attachPcloud;
      const profiles = status.profiles.filter((p) => p.provider === 'pcloud');
      const profileId = window.__freshProfileId
        || (profiles.length === 1 ? profiles[0].id
            : prompt('pCloud profile id:', profiles[0].id));
      if (!profileId) return;
      const rootPath = prompt('Root path inside pCloud (e.g. /Audiobooks):', '/Audiobooks');
      if (!rootPath) return;
      try {
        await api('/api/admin/storage/folder/pcloud', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ libraryId: libId, profileId, rootPath }),
        });
        refresh();
      } catch (e) {
        showError('Attach failed: ' + e.message);
      }
    });
  });
}

// ─── Upload pipeline ────────────────────────────────────────────────────────

// Top-level dispatch: single audio file uploads as-is; .zip / .rar are
// extracted in the browser and each contained audio file is uploaded.
async function uploadFile(folderId, file, subfolder, listEl) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'zip' || ext === 'rar') {
    const row = appendUploadRow(listEl, file.name, 'Reading archive…');
    let entries;
    try {
      entries = await extractAudioEntries(file, (status) => row.setStatus(status));
    } catch (e) {
      row.fail('Read failed: ' + e.message);
      return;
    }
    if (!entries.length) {
      row.fail('No audio files inside archive');
      return;
    }
    row.complete(entries.length + ' audio file(s) found');
    // entry.file here is a CompressedFile wrapper, not a real Blob. Extract
    // each one just before its upload starts so we hold the decompressed
    // bytes in memory for the minimum time possible.
    for (const entry of entries) {
      const relPath = joinPath(subfolder, entry.relPath);
      const subRow = appendUploadRow(listEl, '↳ ' + entry.relPath, 'Extracting…');
      let realFile;
      try {
        realFile = await entry.file.extract();
      } catch (e) {
        subRow.fail('Extract failed: ' + e.message);
        continue;
      }
      await chunkedUploadOne(folderId, realFile, relPath, subRow);
    }
  } else if (ext === 'm4b' || ext === 'm4a' || ext === 'aac') {
    const relPath = joinPath(subfolder, file.name);
    const row = appendUploadRow(listEl, file.name, 'Queued');
    await chunkedUploadOne(folderId, file, relPath, row);
  } else {
    appendUploadRow(listEl, file.name, '').fail('Unsupported file type: .' + ext);
  }
}

function joinPath(subfolder, name) {
  const sf = (subfolder || '').replace(/^\/+|\/+$/g, '');
  return sf ? sf + '/' + name : name;
}

// Per-file chunked upload to pCloud via the Worker proxy. Each chunk is sized
// by the server (init response); browser slices the Blob accordingly.
async function chunkedUploadOne(folderId, blob, relPath, row) {
  try {
    row.setStatus('Initialising…');
    const init = await api('/api/admin/storage/folder/' + folderId + '/upload/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relPath }),
    });
    const uploadId = init.uploadId;
    const chunkSize = init.chunkSize || (8 * 1024 * 1024);
    let offset = 0;
    while (offset < blob.size) {
      const end = Math.min(offset + chunkSize, blob.size);
      const chunk = blob.slice(offset, end);
      const qs = new URLSearchParams({ uploadId: String(uploadId), offset: String(offset) });
      const res = await fetch(
        '/api/admin/storage/folder/' + folderId + '/upload/chunk?' + qs.toString(),
        { method: 'POST', credentials: 'include', body: chunk },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error('Chunk failed at offset ' + offset + ': HTTP ' + res.status + ' ' + text);
      }
      offset = end;
      row.setProgress(offset, blob.size);
    }
    row.setStatus('Saving…');
    const saved = await api('/api/admin/storage/folder/' + folderId + '/upload/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId, relPath, registerAsBook: true }),
    });
    if (saved.itemId) {
      row.complete('Saved & registered (' + saved.itemId + ')');
    } else if (saved.registerError) {
      row.complete('Saved to pCloud but NOT registered: ' + saved.registerError);
    } else {
      row.complete('Saved');
    }
  } catch (e) {
    row.fail(e.message || String(e));
  }
}

// Per-upload-row helper: renders a <div> with file name, progress bar, status
// and returns an object exposing setProgress / setStatus / complete / fail.
function appendUploadRow(listEl, name, initialStatus) {
  const el = document.createElement('div');
  el.className = 'upload-item';
  el.innerHTML =
    '<span class="name"></span><span class="status"></span>' +
    '<div class="progress-bar"><span></span></div>';
  el.querySelector('.name').textContent = name;
  el.querySelector('.status').textContent = initialStatus ? ' · ' + initialStatus : '';
  listEl.appendChild(el);
  const bar = el.querySelector('.progress-bar > span');
  const status = el.querySelector('.status');
  return {
    setProgress(uploaded, total) {
      const pct = total ? Math.round((uploaded / total) * 100) : 0;
      bar.style.width = pct + '%';
      status.textContent = ' · ' + pct + '% (' + formatBytes(uploaded) + ' / ' + formatBytes(total) + ')';
    },
    setStatus(text) { status.textContent = ' · ' + text; },
    complete(text) {
      el.classList.add('ok');
      bar.style.width = '100%';
      status.textContent = ' · ' + (text || 'Done');
    },
    fail(text) {
      el.classList.add('err');
      status.textContent = ' · ' + (text || 'Failed');
    },
  };
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

// Render the books-list panel. Each row is title/author + chapter count +
// duration + per-book actions (re-probe, remove).
function renderBooksList(container, items) {
  if (!items.length) {
    container.innerHTML = '<p class="muted">No books in this library yet.</p>';
    return;
  }
  let html = '';
  for (const it of items) {
    const chapCls = it.chapter_count === 0 ? ' no-chapters' : '';
    html += '<div class="book-row" data-item-id="' + escapeHtml(it.id) + '">';
    html += '<span class="title">' + escapeHtml(it.title || it.rel_path || '(untitled)');
    if (it.author_name) html += ' <span class="meta">· ' + escapeHtml(it.author_name) + '</span>';
    if (it.series_name) html += ' <span class="meta">· ' + escapeHtml(it.series_name) + '</span>';
    html += '</span>';
    html += '<span class="meta' + chapCls + '">' + it.chapter_count + ' chapters</span>';
    html += '<span class="meta">' + formatDuration(it.duration_seconds) + '</span>';
    html += '<span class="meta">' + formatBytes(it.size_bytes) + '</span>';
    html += '<button class="secondary" data-reprobe-item="' + escapeHtml(it.id) + '">Re-probe</button>';
    html += '<button class="danger" data-remove-item="' + escapeHtml(it.id) + '">Remove</button>';
    html += '</div>';
  }
  container.innerHTML = html;

  container.querySelectorAll('[data-reprobe-item]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = '…';
      try {
        const r = await api('/api/admin/items/' + btn.dataset.reprobeItem + '/reprobe', { method: 'POST' });
        // Update the row inline so user sees the new chapter count immediately.
        const row = btn.closest('.book-row');
        const counterSpans = row.querySelectorAll('.meta');
        counterSpans[counterSpans.length === 4 ? 1 : 0].textContent = r.chapters + ' chapters';
        counterSpans[counterSpans.length === 4 ? 1 : 0].className = 'meta' + (r.chapters === 0 ? ' no-chapters' : '');
      } catch (e) {
        showError('Re-probe failed: ' + e.message);
      } finally {
        btn.disabled = false; btn.textContent = 'Re-probe';
      }
    });
  });

  container.querySelectorAll('[data-remove-item]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('.book-row');
      const title = row.querySelector('.title').textContent.trim().split(' · ')[0];
      if (!confirm('Remove "' + title + '" from the library?\\n\\nThe underlying file on pCloud/S3/etc. is NOT deleted — only the D1 entry. Re-uploading or running a scan will bring it back.')) return;
      btn.disabled = true; btn.textContent = '…';
      try {
        await api('/api/admin/items/' + btn.dataset.removeItem, { method: 'DELETE' });
        row.remove();
      } catch (e) {
        showError('Remove failed: ' + e.message);
        btn.disabled = false; btn.textContent = 'Remove';
      }
    });
  });
}

// ─── Archive extraction (lazy-loaded libarchive.js) ─────────────────────────

// libarchive.js spawns a Web Worker that loads WASM. Workers refuse cross-
// origin URLs even when CORS allows them, so we fetch the bundle from
// jsdelivr and wrap it in a Blob URL on our own origin.
//
// Then there's a second wrinkle: v2.x of libarchive.js loads its WASM as a
// separate file via new URL("libarchive.wasm", import.meta.url). Once the
// worker is running from a Blob URL, that resolves to a relative path on our
// origin that doesn't exist — extraction hangs forever at "Opening archive".
// Fix: rewrite the literal "libarchive.wasm" in the worker source to the
// absolute jsdelivr URL before wrapping in a Blob.
let __libarchive = null;
async function loadLibarchive() {
  if (__libarchive) return __libarchive;
  const VER = '2.0.2';
  const baseUrl = 'https://cdn.jsdelivr.net/npm/libarchive.js@' + VER + '/dist/';
  const wasmUrl = baseUrl + 'libarchive.wasm';
  const workerRes = await fetch(baseUrl + 'worker-bundle.js');
  if (!workerRes.ok) throw new Error('Failed to fetch libarchive worker: HTTP ' + workerRes.status);
  let workerSrc = await workerRes.text();
  workerSrc = workerSrc.replace(/"libarchive\.wasm"/g, JSON.stringify(wasmUrl));
  const workerBlob = new Blob([workerSrc], { type: 'application/javascript' });
  const workerUrl = URL.createObjectURL(workerBlob);
  const mod = await import(baseUrl + 'libarchive.js');
  mod.Archive.init({ workerUrl });
  __libarchive = mod;
  return mod;
}

// Open the archive, walk every entry, and return only those with audiobook
// extensions. Returns [{ file: File, relPath: string }]. relPath preserves
// the archive's internal directory structure so multi-disc books keep their
// folder.
async function extractAudioEntries(file, statusCb) {
  statusCb && statusCb('Loading extractor…');
  const { Archive } = await loadLibarchive();
  statusCb && statusCb('Opening archive…');
  const archive = await Archive.open(file);
  statusCb && statusCb('Reading entries…');
  // getFilesArray returns [{file: File, path: string}] where path is the
  // directory (with trailing slash) and file.name is the filename.
  const flat = await archive.getFilesArray();
  const out = [];
  for (const item of flat) {
    const filename = item.file.name;
    if (!/\.(m4b|m4a|aac)$/i.test(filename)) continue;
    const dir = (item.path || '').replace(/^\/+|\/+$/g, '');
    out.push({ file: item.file, relPath: dir ? dir + '/' + filename : filename });
  }
  return out;
}

refresh();
</script>
</body>
</html>`;
