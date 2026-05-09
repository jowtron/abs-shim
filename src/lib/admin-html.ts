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
  </style>
</head>
<body>
  <h1>ABS_shim · admin</h1>
  <p class="muted">
    Storage backends + library scans.
    <a href="/" style="color: var(--accent)">Open ABS web UI</a>
    &nbsp;·&nbsp;
    <a href="https://pholia.pages.dev" target="_blank" rel="noopener" style="color: var(--accent)">Open Pholia ↗</a>
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
}

function hideLoginForm() {
  document.getElementById('login-card').style.display = 'none';
  document.getElementById('connections-card').style.display = '';
  document.getElementById('libraries-card').style.display = '';
}

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

  let html = '';
  for (const lib of libraries) {
    const folders = foldersByLib[lib.id] || [];
    html += '<div style="margin-bottom: 1.5rem; padding-bottom: 1rem; border-bottom: 1px solid var(--border);">';
    html += '<strong>' + escapeHtml(lib.name) + '</strong> ';
    html += '<span class="muted">· ' + escapeHtml(lib.id) + '</span><br>';

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

    html += '<div class="row" style="flex-wrap: wrap; gap: 0.5rem;">';
    html += '<button data-scan="' + escapeHtml(lib.id) + '">Scan now</button>';
    html += '<button class="secondary" data-add-path="' + escapeHtml(lib.id) + '">Add book by path</button>';
    html += '<span class="muted" style="width:100%; margin-top:0.5rem">Add another storage backend:</span>';
    html += '<button class="secondary" data-attach-s3="' + escapeHtml(lib.id) + '">S3-compat (R2 / B2 / S3 / Wasabi)</button>';
    html += '<button class="secondary" data-attach-webdav="' + escapeHtml(lib.id) + '">WebDAV (NAS)</button>';
    if (status.profiles.some((p) => p.provider === 'pcloud')) {
      html += '<button class="secondary" data-attach-pcloud="' + escapeHtml(lib.id) + '">pCloud (OAuth)</button>';
    }
    html += '</div></div>';
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

refresh();
</script>
</body>
</html>`;
