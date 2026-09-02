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
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <!-- Installable as a home-screen web app from both /account and /admin (they
       serve this same HTML). iOS uses apple-touch-icon + the apple-* metas;
       Android/Chrome use the linked manifest. Icon files live in web/. -->
  <link rel="icon" href="/favicon.ico" sizes="any" />
  <link rel="icon" type="image/png" sizes="32x32" href="/icon-32.png" />
  <link rel="icon" type="image/png" sizes="16x16" href="/icon-16.png" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <link rel="manifest" href="/manifest.json" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-title" content="ABS Shim" />
  <meta name="application-name" content="ABS Shim" />
  <meta name="apple-mobile-web-app-status-bar-style" content="default" />
  <meta name="theme-color" media="(prefers-color-scheme: light)" content="#fafafa" />
  <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0f0f10" />
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
    .upload-item .row-btn { float: right; padding: 0.1rem 0.5rem; font-size: 0.75rem; margin-left: 0.5rem; }
    .spinner { display: inline-block; width: 0.8em; height: 0.8em; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 0.7s linear infinite; vertical-align: -0.1em; margin-right: 0.4em; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .abb-cover { width: 44px; height: 44px; object-fit: cover; border-radius: 4px; background: var(--border); display: block; }
    /* Search field with an inline × clear button (hidden while empty). */
    .search-wrap { position: relative; flex: 1; min-width: 160px; display: flex; }
    .search-wrap input[type=text] { flex: 1; min-width: 0; padding-right: 1.9rem; }
    .search-clear { position: absolute; right: 0.15rem; top: 50%; transform: translateY(-50%); width: 1.6rem; height: 1.6rem; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--muted); font-size: 1.1rem; line-height: 1; cursor: pointer; display: none; }
    .search-clear:hover { background: rgba(125,125,125,0.2); color: inherit; }
    .search-wrap.has-value .search-clear { display: block; }
    .abb-progress-row td { padding: 0 0 0.5rem 0; }
    #abb-results td { vertical-align: middle; }
    #abb-results .abb-title { font-weight: 500; }
    #abb-results .abb-sub { color: var(--muted); font-size: 0.8rem; }
    #abb-results .abb-title { cursor: pointer; }
    #abb-results .abb-ext { color: var(--muted); font-size: 0.8rem; margin-left: 0.4rem; text-decoration: none; }
    .abb-details-row td { padding: 0 0.5rem 0.6rem 0.5rem; }
    .abb-browse-row { margin-top: 0.4rem; }
    .abb-browse-row select { flex: 1; min-width: 8rem; }
    .abb-cached { color: var(--muted); font-size: 0.75rem; margin-left: 0.4rem; }
    .abb-more { margin: 0.5rem 0; }
    #abb-catalog-listings span { display: inline-block; margin: 0 0.5rem 0.15rem 0; white-space: nowrap; }
    .abb-details { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 0.6rem 0.75rem; font-size: 0.85rem; line-height: 1.45; }
    .abb-details .meta { color: var(--muted); margin-bottom: 0.4rem; }
    .abb-details p { margin: 0 0 0.5rem 0; }
    .abb-details p:last-child { margin-bottom: 0; }
    .abb-modal { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 50; padding: 1rem; }
    .abb-modal-box { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; width: min(640px, 100%); max-height: 90vh; display: flex; flex-direction: column; }
    .abb-modal-box h3 { margin: 0 0 0.25rem 0; font-size: 1rem; overflow-wrap: anywhere; }
    .abb-pick-list { overflow-y: auto; flex: 1; min-height: 0; border: 1px solid var(--border); border-radius: 6px; padding: 0.25rem 0.5rem; font-size: 0.85rem; }
    .abb-pick-group { margin: 0.35rem 0; }
    .abb-pick-dir { display: block; font-weight: 600; padding: 0.2rem 0; overflow-wrap: anywhere; }
    .abb-pick-file { display: block; padding: 0.15rem 0 0.15rem 1.4rem; overflow-wrap: anywhere; }
    .abb-pick-file input, .abb-pick-dir input { margin-right: 0.3rem; }
    /* Mobile: cards scroll sideways instead of overflowing the viewport. */
    .card { min-width: 0; overflow-x: auto; }
    code { overflow-wrap: anywhere; }
    input, select { max-width: 100%; box-sizing: border-box; }
    .upload-row input[type=text], .upload-row input[type=password] { min-width: 0; }
    @media (max-width: 600px) {
      body { padding: 0.75rem; }
      .card { padding: 0.75rem; }
      th, td { padding: 0.35rem 0.4rem; font-size: 0.85rem; }
    }
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
    <a id="open-pholia" href="https://pholia.jderrick.app" target="_blank" rel="noopener" style="color: var(--accent)">Open Pholia ↗</a>
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

  <div id="abb-card" class="card" style="display:none">
    <h2>AudioBookBay → Real-Debrid</h2>
    <p class="muted" style="margin-top:0">Search AudioBookBay, send a release to Real-Debrid, and have pCloud fetch the finished files straight into a library. Multi-file releases are added one file at a time so nothing arrives as a rar.</p>
    <details id="abb-settings">
      <summary>Accounts</summary>
      <div class="upload-row" style="margin-top:0.5rem">
        <input type="text" id="abb-user" placeholder="AudioBookBay username" autocomplete="off" />
        <input type="password" id="abb-pass" placeholder="AudioBookBay password" autocomplete="new-password" />
      </div>
      <div class="upload-row">
        <input type="password" id="abb-rd" placeholder="Real-Debrid API token (real-debrid.com/apitoken)" autocomplete="new-password" />
        <button id="abb-save">Save</button>
        <button class="secondary" id="abb-test">Test</button>
      </div>
      <div id="abb-settings-status" class="muted" style="font-size:0.85rem"></div>
    </details>
    <div class="upload-row" style="margin-top:0.75rem">
      <span class="search-wrap">
        <input type="text" id="abb-q" placeholder="Search AudioBookBay… (title, author)" />
        <button type="button" class="search-clear" id="abb-clear" aria-label="Clear search" title="Clear">×</button>
      </span>
      <select id="abb-target"></select>
      <button id="abb-search">Search</button>
    </div>
    <div class="upload-row abb-browse-row" id="abb-browse-row" style="display:none">
      <select id="abb-cat" title="Category"><option value="">Latest (all categories)</option></select>
      <select id="abb-lang" title="Language"><option value="">Any language</option></select>
      <select id="abb-fmt" title="Format"><option value="">Any format</option></select>
      <button class="secondary" id="abb-browse">Browse</button>
    </div>
    <div id="abb-active" style="display:none; margin:0.5rem 0 0.75rem">
      <div style="font-weight:600; margin-bottom:0.25rem">In progress</div>
      <div id="abb-rd-progress" class="upload-list"></div>
    </div>
    <div id="abb-results"></div>
    <details id="abb-rd" style="margin-top:0.75rem">
      <summary>On Real-Debrid <span id="abb-rd-count" class="muted"></span></summary>
      <p class="muted" style="margin:0.4rem 0">Grabs run in this browser tab. If a tab was closed mid-grab the torrents are still here — <b>Finish</b> collects a completed one into the library, <b>Watch</b> resumes waiting for one that's still downloading, <b>Delete</b> removes it from Real-Debrid.</p>
      <div id="abb-rd-list" class="muted">Not loaded.</div>
      <button class="secondary" id="abb-rd-refresh" style="margin-top:0.4rem">Refresh</button>
    </details>
    <details id="abb-catalog" style="margin-top:0.5rem">
      <summary>Catalogue <span id="abb-catalog-count" class="muted"></span></summary>
      <p class="muted" style="margin:0.4rem 0">A local copy of AudioBookBay's listings, built up by a cron tick every 5 minutes (~50 page fetches each). Search answers from it first and adds live results; a cached release goes straight to Real-Debrid without touching AudioBookBay. Each listing on ABB stops at 500 pages, so the backfill reaches roughly a year back in busy categories and everything from now on.</p>
      <div id="abb-catalog-status" class="muted">Not loaded.</div>
      <div id="abb-catalog-listings" class="muted" style="font-size:0.8rem; margin-top:0.4rem"></div>
      <div class="upload-row" style="margin-top:0.5rem; flex-wrap:wrap">
        <button class="secondary" id="abb-catalog-refresh">Refresh</button>
        <button class="secondary" data-catalog="run">Run a tick now</button>
        <button class="secondary" data-catalog="pause">Pause</button>
        <button class="secondary" data-catalog="resume" style="display:none">Resume</button>
        <button class="secondary" data-catalog="retry-errors">Retry errors</button>
        <button class="secondary" data-catalog="restart-backfill" data-confirm="Re-walk every listing from page 1? Cached posts are kept and refreshed.">Restart backfill</button>
        <button class="secondary" data-catalog="clear-backoff" style="display:none">Clear backoff</button>
        <button class="secondary" data-catalog="send-report" title="Sends the check-in push now, as a test">Send report now</button>
        <label class="muted" style="font-size:0.85rem; white-space:nowrap">Fetches per tick <input type="number" id="abb-budget" min="1" max="30" style="width:4.5rem"></label>
      </div>
    </details>
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

  <div id="all-users-card" class="card" style="display:none">
    <h2>All users</h2>
    <p class="muted">Every account across all libraries (instance owner only). Each approved signup gets its own isolated library; "Servers" are the storage backends attached to that library. Lock an account to block its sign-in without deleting anything.</p>
    <div id="all-users-body" class="muted">Loading…</div>
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
  document.getElementById('abb-card').style.display = 'none';
  document.getElementById('connections-card').style.display = 'none';
  document.getElementById('libraries-card').style.display = 'none';
  document.getElementById('cover-cache-card').style.display = 'none';
  document.getElementById('members-card').style.display = 'none';
  document.getElementById('all-users-card').style.display = 'none';
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

// "Open Pholia" — hand the signed-in member straight into Pholia. The shim's
// access token IS the ABS JWT Pholia authenticates with (Pholia talks to this
// shim as its ABS server), so we mint a fresh one via /api/authorize and pass
// it to Pholia in the URL *fragment* — fragments aren't sent to servers or
// included in the Referer header, and Pholia strips it from the address bar on
// arrival. The anchor's plain href stays as a no-JS / not-signed-in fallback.
const PHOLIA_URL = 'https://pholia.jderrick.app';
function b64url(obj) {
  // UTF-8-safe base64url (usernames may be non-ASCII).
  return btoa(unescape(encodeURIComponent(JSON.stringify(obj))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
document.getElementById('open-pholia').addEventListener('click', (e) => {
  e.preventDefault();
  // Open the tab synchronously inside the click gesture so Safari doesn't treat
  // the post-await navigation as a blocked popup.
  const win = window.open('', '_blank');
  fetch('/api/authorize', { method: 'POST', credentials: 'include' })
    .then((res) => { if (!res.ok) throw new Error('not signed in'); return res.json(); })
    .then((data) => {
      const token = data && data.user && (data.user.accessToken || data.user.token);
      if (!token) throw new Error('no token in authorize response');
      const username = (data.user && data.user.username) || '';
      const payload = b64url({ s: location.origin, u: username, t: token });
      const target = PHOLIA_URL + '/#connect=' + payload;
      if (win) win.location = target; else location.href = target;
    })
    .catch(() => {
      // Couldn't mint a token (e.g. cookie expired) — fall back to plain Pholia
      // and let the user sign in there manually.
      if (win) win.location = PHOLIA_URL; else location.href = PHOLIA_URL;
    });
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
  if (!report.added && (!report.errors || !report.errors.length)) {
    lines.push('No changes — every audio file is already in the library.');
    lines.push('');
  }
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
  renderAbb(status, libs.libraries || []);
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
  const usersCard = document.getElementById('all-users-card');
  if (!status.isInstanceOwner) { card.style.display = 'none'; usersCard.style.display = 'none'; return; }
  card.style.display = '';
  usersCard.style.display = '';

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
  loadAllUsers();
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

// Instance-wide roster: every account across all libraries, with the library
// (tenant) it belongs to and the storage backends ("servers") attached there.
// Lock/unlock is a reversible sign-in block — see /api/admin/users/:id/lock.
async function loadAllUsers() {
  const body = document.getElementById('all-users-body');
  let data;
  try {
    data = await api('/api/admin/users');
  } catch (e) {
    if (e instanceof UnauthorizedError) return;
    body.innerHTML = '<p class="warn">Failed to load users: ' + escapeHtml(e.message) + '</p>';
    return;
  }
  const users = data.users || [];
  if (!users.length) { body.innerHTML = '<p class="muted">No users yet.</p>'; return; }

  let html = '<table><thead><tr><th>User</th><th>Library</th><th>Servers</th><th>Books</th><th>Status</th><th></th></tr></thead><tbody>';
  for (const u of users) {
    const you = u.id === data.selfId ? ' <span class="muted">(you)</span>' : '';
    const typeBadge = (u.type === 'root' || u.type === 'admin') ? ' <span class="muted">[' + escapeHtml(u.type) + ']</span>' : '';
    const email = u.email ? '<br><span class="muted" style="font-size:0.8rem">' + escapeHtml(u.email) + '</span>' : '';
    const lastSeen = u.lastSeen ? '<br><span class="muted" style="font-size:0.78rem">seen ' + new Date(u.lastSeen).toLocaleDateString() + '</span>' : '';
    const role = u.role ? ' <span class="muted">· ' + escapeHtml(u.role) + '</span>' : '';
    const lib = u.tenantName ? escapeHtml(u.tenantName) + role : '<span class="muted">none</span>';
    const servers = (u.servers && u.servers.length)
      ? u.servers.map((s) => escapeHtml(s.label)).join('<br>')
      : '<span class="muted">—</span>';
    let status;
    if (u.isLocked) status = '<span class="warn">Locked</span>';
    else if (u.signupStatus === 'pending') status = '<span class="warn">Pending</span>';
    else status = '<span class="ok">Active</span>';

    html += '<tr>';
    html += '<td>' + escapeHtml(u.username) + you + typeBadge + email + lastSeen + '</td>';
    html += '<td>' + lib + '</td>';
    html += '<td style="font-size:0.85rem">' + servers + '</td>';
    html += '<td>' + (u.bookCount || 0) + '</td>';
    html += '<td>' + status + '</td>';
    html += '<td style="white-space:nowrap">';
    if (u.id !== data.selfId) {
      if (u.isLocked) {
        html += '<button class="secondary" data-unlock="' + escapeHtml(u.id) + '" style="font-size:0.78rem;padding:0.2rem 0.55rem">Unlock</button>';
      } else {
        html += '<button class="danger" data-lock="' + escapeHtml(u.id) + '" style="font-size:0.78rem;padding:0.2rem 0.55rem">Lock</button>';
      }
    }
    html += '</td></tr>';
  }
  html += '</tbody></table>';
  body.innerHTML = html;

  body.querySelectorAll('[data-lock]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('Lock this account? They will be unable to sign in or stream until you unlock them. No data is deleted.')) return;
    try { await api('/api/admin/users/' + btn.dataset.lock + '/lock', { method: 'POST' }); loadAllUsers(); }
    catch (e) { if (!(e instanceof UnauthorizedError)) showError('Lock failed: ' + e.message); }
  }));
  body.querySelectorAll('[data-unlock]').forEach((btn) => btn.addEventListener('click', async () => {
    try { await api('/api/admin/users/' + btn.dataset.unlock + '/unlock', { method: 'POST' }); loadAllUsers(); }
    catch (e) { if (!(e instanceof UnauthorizedError)) showError('Unlock failed: ' + e.message); }
  }));
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
    // Per-book progress rows for the re-probe buttons (same rows as uploads).
    html += '<div id="reprobe-list-' + escapeHtml(lib.id) + '" class="upload-list"></div>';

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
      html += '<div class="upload-row">';
      html += '<input type="text" placeholder="…or paste a direct download URL (.m4b / .m4a / .aac / .zip)" data-fetch-url="' + escapeHtml(lib.id) + '" />';
      html += '<input type="text" placeholder="Save as (optional file name)" data-fetch-name="' + escapeHtml(lib.id) + '" style="max-width:220px" />';
      html += '<button data-fetch-go="' + escapeHtml(lib.id) + '">Fetch to pCloud</button>';
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
        // Re-render FIRST, then attach the summary beside the fresh button —
        // refresh() rebuilds this section and would wipe an earlier insert.
        // Always shown, even for "no changes": the Last-scan card lives at
        // the bottom of the page and clicking Scan gave no visible feedback.
        await refresh();
        const summary = (report.added > 0 ? 'Added ' + report.added + ' book(s)' : 'No changes')
          + ' — ' + report.skipped + ' already in library'
          + (report.errors && report.errors.length ? ', ' + report.errors.length + ' error(s) — see "Last scan" at the bottom' : '')
          + ' · ' + (report.durationMs / 1000).toFixed(1) + 's';
        const fresh = document.querySelector('[data-scan="' + btn.dataset.scan + '"]');
        if (fresh) {
          const note = document.createElement('span');
          note.className = 'muted';
          note.style.marginLeft = '0.6em';
          note.textContent = summary;
          fresh.insertAdjacentElement('afterend', note);
        }
      } catch (e) {
        showError('Scan failed: ' + e.message);
        btn.disabled = false; btn.textContent = 'Scan now';
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
    btn.addEventListener('click', () => runReprobe(btn.dataset.reprobeMissing, btn, true, 'Re-probe books missing chapters'));
  });

  body.querySelectorAll('[data-reprobe-all]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!confirm('Re-probe every book in this library? This re-reads each m4b\'s moov atom — for a 100-book library that\'s ~500 MB of pCloud bandwidth and several minutes of wall time.')) return;
      runReprobe(btn.dataset.reprobeAll, btn, false, 'Re-probe all');
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

  body.querySelectorAll('[data-fetch-go]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const libId = btn.dataset.fetchGo;
      const area = document.getElementById('upload-area-' + libId);
      const folderId = area && area.dataset.folder;
      const urlInput = document.querySelector('[data-fetch-url="' + libId + '"]');
      const nameInput = document.querySelector('[data-fetch-name="' + libId + '"]');
      const subfolderInput = document.querySelector('[data-upload-subfolder="' + libId + '"]');
      const url = (urlInput && urlInput.value || '').trim();
      if (!folderId || !url) {
        showError('Paste a download URL first.');
        return;
      }
      const subfolder = (subfolderInput && subfolderInput.value || '').trim().replace(/^\/+|\/+$/g, '');
      let name = (nameInput && nameInput.value || '').trim();
      if (!name) name = fileNameFromUrl(url);
      if (!name) {
        showError('Could not work out a file name from that URL — fill in "Save as".');
        return;
      }
      if (!/\.(m4b|m4a|aac|zip)$/i.test(name)) {
        if (!confirm('"' + name + '" is not .m4b/.m4a/.aac/.zip — it will be saved to pCloud but not registered as a book. Continue?')) return;
      }
      const listEl = document.getElementById('upload-list-' + libId);
      btn.disabled = true;
      try {
        await fetchUrlToPcloud(folderId, url, joinPath(subfolder, name), listEl);
        urlInput.value = '';
        nameInput.value = '';
      } finally {
        btn.disabled = false;
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

// ─── AudioBookBay → Real-Debrid ─────────────────────────────────────────────

let abbWired = false;

function renderAbb(status, libraries) {
  const card = document.getElementById('abb-card');
  const target = document.getElementById('abb-target');
  // One option per pCloud folder; the fetch-url flow only works on pcloud_oauth.
  const libName = {};
  for (const lib of libraries) libName[lib.id] = lib.name;
  void libraries;
  const prev = target.value;
  target.innerHTML = '';
  for (const f of status.folders || []) {
    if (f.provider !== 'pcloud_oauth') continue;
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.dataset.libraryId = f.libraryId;
    opt.textContent = (f.libraryName || libName[f.libraryId] || f.libraryId) + ' → pCloud ' + ((f.config && f.config.rootPath) || '/');
    target.appendChild(opt);
  }
  if (prev) target.value = prev;
  card.style.display = target.options.length ? 'block' : 'none';
  if (abbWired) return;
  abbWired = true;

  abbLoadSettings();
  document.getElementById('abb-rd-refresh').addEventListener('click', abbLoadRdList);
  document.getElementById('abb-rd').addEventListener('toggle', (ev) => { if (ev.target.open) abbLoadRdList(); });
  abbLoadRdList();
  document.getElementById('abb-save').addEventListener('click', abbSaveSettings);
  document.getElementById('abb-test').addEventListener('click', abbTestSettings);
  document.getElementById('abb-search').addEventListener('click', abbDoSearch);
  document.getElementById('abb-browse').addEventListener('click', () => abbBrowse(1));
  document.getElementById('abb-cat').addEventListener('change', () => abbBrowse(1));
  abbLoadFacets();
  document.getElementById('abb-catalog-refresh').addEventListener('click', abbLoadCatalog);
  document.getElementById('abb-catalog').addEventListener('toggle', (ev) => { if (ev.target.open) abbLoadCatalog(); });
  for (const b of document.querySelectorAll('#abb-catalog [data-catalog]')) b.addEventListener('click', () => abbCatalogAction(b.dataset.catalog, b));
  document.getElementById('abb-budget').addEventListener('change', (ev) => abbCatalogAction('set-budget', ev.target, Number(ev.target.value)));
  abbLoadCatalog();
  const q = document.getElementById('abb-q');
  const clear = document.getElementById('abb-clear');
  const syncClear = () => q.parentElement.classList.toggle('has-value', q.value.length > 0);
  q.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') abbDoSearch(); });
  q.addEventListener('input', syncClear);
  clear.addEventListener('click', () => {
    q.value = '';
    syncClear();
    document.getElementById('abb-results').innerHTML = '';
    q.focus();
  });
  syncClear();
}

function abbLibraryIdForFolder(folderId) {
  const opt = [...document.getElementById('abb-target').options].find((o) => o.value === folderId);
  return opt ? opt.dataset.libraryId : null;
}

async function abbLoadSettings() {
  const st = document.getElementById('abb-settings-status');
  try {
    const s = await api('/api/admin/abb/settings');
    document.getElementById('abb-user').value = s.abbUsername || '';
    document.getElementById('abb-pass').placeholder = s.abbPasswordSet ? 'AudioBookBay password (saved — leave blank to keep)' : 'AudioBookBay password';
    document.getElementById('abb-rd').placeholder = s.rdTokenSet ? 'Real-Debrid API token (saved — leave blank to keep)' : 'Real-Debrid API token (real-debrid.com/apitoken)';
    if (!s.canEdit) {
      for (const id of ['abb-user', 'abb-pass', 'abb-rd', 'abb-save']) document.getElementById(id).disabled = true;
      st.textContent = 'Only the tenant owner can change these accounts.';
    } else if (s.encryptionConfigured === false) {
      document.getElementById('abb-settings').open = true;
      st.textContent = 'The server has no SETTINGS_KEY secret, so credentials can\'t be stored. Run: openssl rand -base64 32 | npx wrangler secret put SETTINGS_KEY';
    } else if (!s.rdTokenSet) {
      document.getElementById('abb-settings').open = true;
      st.textContent = 'Add a Real-Debrid API token to grab releases. The AudioBookBay login is optional (needed only for member-only pages).';
    } else {
      st.textContent = 'Real-Debrid token saved' + (s.abbUsername ? ', AudioBookBay login saved as ' + s.abbUsername : '') + '.';
    }
  } catch (e) {
    st.textContent = 'Could not load settings: ' + e.message;
  }
}

async function abbSaveSettings() {
  const st = document.getElementById('abb-settings-status');
  const btn = document.getElementById('abb-save');
  btn.disabled = true;
  try {
    await api('/api/admin/abb/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        abbUsername: document.getElementById('abb-user').value,
        abbPassword: document.getElementById('abb-pass').value,
        rdToken: document.getElementById('abb-rd').value,
      }),
    });
    document.getElementById('abb-pass').value = '';
    document.getElementById('abb-rd').value = '';
    st.textContent = 'Saved.';
    await abbLoadSettings();
  } catch (e) {
    st.textContent = 'Save failed: ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function abbTestSettings() {
  const st = document.getElementById('abb-settings-status');
  const btn = document.getElementById('abb-test');
  btn.disabled = true; st.textContent = 'Testing…';
  try {
    const r = await api('/api/admin/abb/settings/test', { method: 'POST' });
    const parts = [];
    parts.push('AudioBookBay: ' + (!r.abb.configured ? 'not configured (anonymous search only)' : r.abb.ok ? 'login OK' : 'FAILED — ' + r.abb.error));
    parts.push('Real-Debrid: ' + (!r.rd.configured ? 'no token' : r.rd.ok ? 'OK as ' + r.rd.username + (r.rd.premiumUntil ? ', premium until ' + new Date(r.rd.premiumUntil).toLocaleDateString() : '') + (r.rd.error ? ' — ' + r.rd.error : '') : 'FAILED — ' + r.rd.error));
    st.textContent = parts.join(' · ');
  } catch (e) {
    st.textContent = 'Test failed: ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function abbDoSearch() {
  const q = document.getElementById('abb-q').value.trim();
  const out = document.getElementById('abb-results');
  const btn = document.getElementById('abb-search');
  if (!q) return;
  btn.disabled = true; out.textContent = 'Searching…';
  try {
    // A pasted magnet link becomes a single pseudo-result; Grab resolves it
    // server-side (title from dn=) and inspects it like any release.
    const r = /^magnet:\?/i.test(q)
      ? { results: [{ title: abbMagnetTitle(q), url: null, magnet: q, cover: null, format: null, bitrate: null, sizeBytes: null, language: '', posted: null }] }
      : await api('/api/admin/abb/search?q=' + encodeURIComponent(q));
    if (!r.results.length) {
      out.innerHTML = '<p class="muted">0 results. (If a known title returns nothing, AudioBookBay\'s page layout may have changed.)</p>';
      return;
    }
    out.innerHTML = '';
    if (r.liveError) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'AudioBookBay didn\'t answer (' + r.liveError + ') — showing the catalogue only.';
      out.appendChild(p);
    }
    abbRenderResults(r.results, out);
  } catch (e) {
    out.textContent = 'Search failed: ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

// Shared by search and browse. Appends to an existing table in "out" when
// there is one (browse's "Load more"), otherwise starts a new one.
function abbRenderResults(results, out) {
  let tb = out.querySelector('table > tbody');
  if (!tb) {
    const table = document.createElement('table');
    tb = document.createElement('tbody');
    table.appendChild(tb);
    out.appendChild(table);
  }
  {
    for (const res of results) {
      const tr = document.createElement('tr');
      const fmt = res.magnet ? 'Magnet link' : [res.format ? res.format.toUpperCase() : null, res.bitrate, res.sizeBytes ? formatBytes(res.sizeBytes) : null, res.language, res.posted ? 'Posted ' + res.posted : null].filter(Boolean).join(' · ');
      tr.innerHTML = '<td style="width:44px"></td><td></td><td style="width:1%; white-space:nowrap"></td>';
      if (res.cover && /^https?:/.test(res.cover)) {
        const img = document.createElement('img');
        img.className = 'abb-cover'; img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
        img.src = res.cover;
        img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
        tr.children[0].appendChild(img);
      }
      tr.children[1].innerHTML = '<span class="abb-title" role="button" title="Show description"></span><a class="abb-ext" target="_blank" rel="noopener" title="Open on AudioBookBay">↗</a><div class="abb-sub"></div>';
      tr.children[1].querySelector('.abb-title').textContent = res.title;
      if (res.infoHash) {
        const c = document.createElement('span');
        c.className = 'abb-cached';
        c.title = 'Magnet is cached — Real-Debrid gets it without a trip to AudioBookBay';
        c.textContent = '⚡ cached';
        tr.children[1].querySelector('.abb-ext').after(c);
      }
      if (res.url) tr.children[1].querySelector('.abb-ext').href = res.url; else tr.children[1].querySelector('.abb-ext').remove();
      tr.children[1].querySelector('.abb-sub').textContent = fmt;
      // Tap the title → blurb + written by / read by, fetched once.
      const drow = document.createElement('tr');
      drow.className = 'abb-details-row';
      drow.style.display = 'none';
      drow.innerHTML = '<td colspan="3"><div class="abb-details"></div></td>';
      if (res.url) tr.children[1].querySelector('.abb-title').addEventListener('click', () => abbToggleDetails(res, drow));
      const b = document.createElement('button');
      b.textContent = 'Grab';
      // Progress renders in a row directly under this result, not at the
      // bottom of the list, so it's obvious which grab is which.
      const prow = document.createElement('tr');
      prow.className = 'abb-progress-row';
      prow.style.display = 'none';
      prow.innerHTML = '<td colspan="3"><div class="upload-list"></div></td>';
      b.addEventListener('click', () => {
        b.disabled = true;
        b.innerHTML = '<span class="spinner"></span>Grabbing…';
        prow.style.display = '';
        abbGrab(res, document.getElementById('abb-target').value, prow.firstChild.firstChild)
          .then((ok) => { b.textContent = ok ? 'Done ✓' : 'Retry'; b.disabled = !!ok; abbLoadRdList(); })
          .catch(() => { b.textContent = 'Retry'; b.disabled = false; });
      });
      tr.children[2].appendChild(b);
      tb.appendChild(tr);
      tb.appendChild(drow);
      tb.appendChild(prow);
    }
  }
}

// ─── Catalogue: browse by category + crawler status ─────────────────────────

let abbBrowsePage = 1;

async function abbLoadFacets() {
  try {
    const f = await api('/api/admin/abb/catalog/categories');
    const row = document.getElementById('abb-browse-row');
    if (!f.total) { row.style.display = 'none'; return; }
    row.style.display = '';
    const fill = (id, items, label) => {
      const sel = document.getElementById(id);
      const prev = sel.value;
      while (sel.options.length > 1) sel.remove(1);
      for (const it of items) {
        const o = document.createElement('option');
        o.value = it.name;
        o.textContent = label(it.name) + ' (' + it.count.toLocaleString() + ')';
        sel.appendChild(o);
      }
      sel.value = prev;
    };
    fill('abb-cat', f.categories, (n) => n);
    fill('abb-lang', f.languages, (n) => n);
    fill('abb-fmt', f.formats, (n) => n.toUpperCase());
    document.getElementById('abb-cat').options[0].textContent = 'Latest (all categories, ' + f.total.toLocaleString() + ')';
  } catch (e) {
    console.warn('catalog facets', e);
  }
}

async function abbBrowse(page) {
  const out = document.getElementById('abb-results');
  const btn = document.getElementById('abb-browse');
  const qs = new URLSearchParams({ page: String(page), limit: '30' });
  const cat = document.getElementById('abb-cat').value;
  const lang = document.getElementById('abb-lang').value;
  const fmt = document.getElementById('abb-fmt').value;
  if (cat) qs.set('cat', cat);
  if (lang) qs.set('language', lang);
  if (fmt) qs.set('format', fmt);
  if (page === 1) out.textContent = 'Loading…';
  const more = out.querySelector('.abb-more');
  if (more) more.remove();
  btn.disabled = true;
  try {
    const r = await api('/api/admin/abb/catalog/browse?' + qs.toString());
    if (page === 1) {
      out.innerHTML = '';
      if (!r.results.length) { out.innerHTML = '<p class="muted">Nothing in the catalogue for that yet — the crawler adds more every few minutes.</p>'; return; }
    }
    abbRenderResults(r.results, out);
    abbBrowsePage = page;
    if (r.hasMore) {
      const b = document.createElement('button');
      b.className = 'secondary abb-more';
      b.textContent = 'Load more';
      b.addEventListener('click', () => abbBrowse(abbBrowsePage + 1));
      out.appendChild(b);
    }
  } catch (e) {
    out.textContent = 'Browse failed: ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

function abbAgo(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 90) return s + 's ago';
  if (s < 5400) return Math.round(s / 60) + 'm ago';
  if (s < 172800) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

async function abbLoadCatalog() {
  const box = document.getElementById('abb-catalog-status');
  const lst = document.getElementById('abb-catalog-listings');
  const count = document.getElementById('abb-catalog-count');
  try {
    const st = await api('/api/admin/abb/catalog/status');
    const c = st.counts, s = st.stats;
    count.textContent = c.total ? '(' + c.total.toLocaleString() + ' posts)' : '';
    const done = st.listings.filter((l) => l.done).length;
    const running = s.tickStartedAt && (!s.lastTick || s.tickStartedAt > s.lastTick);
    const lines = [
      c.total.toLocaleString() + ' posts cached · ' + c.withHash.toLocaleString() + ' with a magnet · ' + c.pending.toLocaleString() + ' awaiting details' + (c.errors ? ' · ' + c.errors + ' detail errors' : ''),
      'Listings: ' + done + '/' + st.listings.length + ' backfilled · ' + s.pagesFetched.toLocaleString() + ' pages fetched over ' + s.ticks + ' ticks',
      (s.paused ? 'PAUSED · ' : '') + (running ? 'Tick running (started ' + abbAgo(s.tickStartedAt) + ')' : 'Last tick ' + abbAgo(s.lastTick) + (s.lastTickMs ? ' (' + Math.round(s.lastTickMs / 1000) + 's)' : '')) + ' · ' + (s.budget || 6) + ' fetches per 2-minute tick',
      s.backoffUntil && s.backoffUntil > Date.now() ? '⚠ BACKING OFF until ' + new Date(s.backoffUntil).toLocaleString() + ' — AudioBookBay stopped answering (episode ' + s.backoffLevel + '). Live search may be affected while the egress IP is blocked.' : null,
      'Check-in push ' + (s.reportSentAt ? 'sent ' + abbAgo(s.reportSentAt) : 'due ' + new Date(st.reportDueAt).toLocaleDateString()),
    ];
    if (s.blockedTicks) lines.push('Backoff episodes so far: ' + s.blockedTicks);
    if (s.zeroParsePages) lines.push('⚠ ' + s.zeroParsePages + ' listing page(s) parsed to 0 posts — AudioBookBay\'s markup may have changed.');
    if (s.lastError) lines.push('Last error (' + abbAgo(s.lastErrorAt) + '): ' + s.lastError);
    box.innerHTML = '';
    for (const t of lines) { if (!t) continue; const d = document.createElement('div'); d.textContent = t; box.appendChild(d); }
    const budget = document.getElementById('abb-budget');
    if (document.activeElement !== budget) budget.value = s.budget || 6;
    document.querySelector('#abb-catalog [data-catalog="clear-backoff"]').style.display = s.backoffUntil && s.backoffUntil > Date.now() ? '' : 'none';
    lst.innerHTML = '';
    for (const l of st.listings) {
      const sp = document.createElement('span');
      sp.textContent = (l.done ? '✓ ' : l.page ? '… ' : '· ') + l.name + (l.page ? ' p' + l.page : '') + (l.error ? ' ⚠' : '');
      if (l.error) sp.title = l.error;
      lst.appendChild(sp);
    }
    document.querySelector('#abb-catalog [data-catalog="pause"]').style.display = s.paused ? 'none' : '';
    document.querySelector('#abb-catalog [data-catalog="resume"]').style.display = s.paused ? '' : 'none';
  } catch (e) {
    box.textContent = 'Couldn\'t load: ' + e.message;
  }
}

async function abbCatalogAction(action, btn, value) {
  if (btn.dataset.confirm && !confirm(btn.dataset.confirm)) return;
  btn.disabled = true;
  try {
    if (action === 'run') await api('/api/admin/abb/catalog/run', { method: 'POST' });
    else await api('/api/admin/abb/catalog/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value != null ? { action, value } : { action }) });
    if (action === 'run') setTimeout(abbLoadCatalog, 3000);
    await abbLoadCatalog();
    if (action === 'run') abbLoadFacets();
  } catch (e) {
    alert('Failed: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

async function abbLoadRdList() {
  const box = document.getElementById('abb-rd-list');
  const count = document.getElementById('abb-rd-count');
  box.textContent = 'Loading…';
  let r;
  try {
    r = await api('/api/admin/abb/torrents');
    if (r.error) throw new Error(r.error);
  } catch (e) {
    box.textContent = 'Couldn\'t list: ' + e.message;
    return;
  }
  // One row per release: the grab flow adds one RD torrent per file, so a
  // multi-file grab is N torrents sharing a hash.
  const all = abbGroupTorrents(r.torrents || []);
  const hidden = abbRdShowAll ? [] : all.filter((g) => abbLooksVideo(g.filename));
  const groups = abbRdShowAll ? all : all.filter((g) => !abbLooksVideo(g.filename));
  count.textContent = all.length ? '(' + groups.length + (hidden.length ? ' + ' + hidden.length + ' video' : '') + ')' : '';
  box.innerHTML = '';
  if (!groups.length) box.appendChild(Object.assign(document.createElement('div'), { className: 'muted', textContent: all.length ? 'Nothing audiobook-looking on Real-Debrid.' : 'Nothing on Real-Debrid.' }));
  if (hidden.length || abbRdShowAll) {
    const t = document.createElement('button');
    t.className = 'secondary'; t.style.margin = '0.3rem 0';
    t.textContent = abbRdShowAll ? 'Hide video torrents' : 'Show ' + hidden.length + ' hidden video torrent' + (hidden.length === 1 ? '' : 's');
    t.addEventListener('click', () => { abbRdShowAll = !abbRdShowAll; abbLoadRdList(); });
    box.appendChild(t);
  }
  if (!groups.length) return;
  const table = document.createElement('table');
  const tb = document.createElement('tbody');
  const folderId = document.getElementById('abb-target').value;
  const listEl = document.getElementById('abb-rd-progress');
  for (const g of groups) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td></td><td style="white-space:nowrap"></td><td style="width:1%; white-space:nowrap"></td>';
    tr.children[0].textContent = g.filename + ' · ' + g.torrents.length + ' torrent' + (g.torrents.length === 1 ? '' : 's') + (g.bytes ? ' · ' + formatBytes(g.bytes) : '');
    tr.children[1].textContent = g.summary;
    const act = (label, fn) => { const b = document.createElement('button'); b.className = 'secondary'; b.textContent = label; b.style.marginLeft = '0.3rem'; b.addEventListener('click', async () => { b.disabled = true; await fn(); abbLoadRdList(); }); tr.children[2].appendChild(b); };
    if (g.live.length) {
      act('Choose files…', () => abbResumeGroup(g, folderId, listEl, true));
      act(g.allDone ? 'Finish' : 'Watch', () => abbResumeGroup(g, folderId, listEl, false));
    }
    act('Delete', () => Promise.all(g.torrents.map((t) => api('/api/admin/abb/torrents/' + encodeURIComponent(t.id), { method: 'DELETE' }).catch(() => {}))));
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  box.appendChild(table);
}

// Real-Debrid accounts fill up with TV/film; hide anything that looks like
// video by name (resolution / codec / source tags, SxxEyy, video extension)
// unless the user asks for everything.
const ABB_VIDEO_RE = /\b(2160p|1080[pi]|720p|480p|4k|uhd|x26[45]|h\.?26[45]|hevc|av1|xvid|divx|blu-?ray|bdrip|brrip|web-?dl|webrip|hdtv|hdrip|dvdrip|remux|hdr(10\+?)?|dolby[\s.]?vision|sdr|s\d{1,2}e\d{1,3}|season\s?\d+|complete series|yify|yts|rarbg|dts(-hd)?|truehd|atmos|ddp?\s?[57]\.1|aac\s?[57]\.1)\b|\.(mkv|mp4|avi|m2ts|ts)$/i;
const ABB_AUDIO_RE = /\b(audiobook|unabridged|abridged|narrated|m4b|mp3)\b/i;
const abbLooksVideo = (name) => ABB_VIDEO_RE.test(name) && !ABB_AUDIO_RE.test(name);
let abbRdShowAll = false;

function abbGroupTorrents(torrents) {
  const byHash = new Map();
  for (const t of torrents) {
    const key = t.hash || t.id;
    if (!byHash.has(key)) byHash.set(key, { hash: t.hash, filename: t.filename, torrents: [], bytes: 0 });
    const g = byHash.get(key);
    g.torrents.push(t);
    g.bytes += t.bytes || 0;
  }
  return [...byHash.values()].map((g) => {
    g.live = g.torrents.filter((t) => !t.error);
    g.allDone = g.live.length > 0 && g.live.every((t) => t.status === 'downloaded');
    const done = g.live.filter((t) => t.status === 'downloaded').length;
    const errs = g.torrents.length - g.live.length;
    const dl = g.live.filter((t) => t.status !== 'downloaded');
    const pct = dl.length ? Math.round(dl.reduce((s, t) => s + (t.progress || 0), 0) / dl.length) : null;
    const seeders = dl.length ? Math.max(...dl.map((t) => t.seeders || 0)) : null;
    g.summary = [done + ' / ' + g.torrents.length + ' ready', pct != null ? 'downloading ' + pct + '%' : null, seeders != null ? seeders + ' seeders' : null, errs ? errs + ' failed' : null].filter(Boolean).join(' · ');
    return g;
  });
}

// Resume a release this tab didn't start. With pick=true, re-offer the file
// picker over the whole torrent (currently selected files pre-ticked):
// unticked files have their RD torrents deleted, newly ticked ones are
// added from the hash. Then the normal tracking loop runs over the result,
// with destinations planned across all chosen files together so the
// shared-prefix collapse behaves like a fresh grab.
async function abbResumeGroup(g, folderId, listEl, pick) {
  if (!folderId) { showError('Pick a target library first.'); return; }
  // Progress lives in the always-visible "In progress" block above the
  // results, not at the bottom of an 80-row account list.
  document.getElementById('abb-active').style.display = '';
  document.getElementById('abb-active').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  const row = appendUploadRow(listEl, g.filename, 'Checking on Real-Debrid…');
  try {
    const infos = [];
    for (const t of g.live) {
      const st = await api('/api/admin/abb/torrents/' + encodeURIComponent(t.id));
      if (st.error && !st.downloads) { appendUploadRow(listEl, '  ↳ RD ' + t.id, '').fail(st.error); continue; }
      infos.push(st);
    }
    if (!infos.length) throw new Error('No usable torrents in this group');
    const allFiles = infos[0].files || [];
    const byFile = new Map();  // fileId → torrent id currently covering it
    for (const st of infos) for (const f of st.selectedFiles || []) byFile.set(f.id, st.id);
    let chosen = allFiles.filter((f) => byFile.has(f.id));
    if (pick) {
      const candidates = allFiles.filter((f) => f.isAudio || f.isArchive).map((f) => ({ ...f, selected: byFile.has(f.id) }));
      if (!candidates.length) throw new Error('Torrent contains no audio files');
      row.setStatus('Choose which files to keep…');
      chosen = await abbPickFiles(g.filename, candidates, true);
      if (!chosen) { row.fail('Cancelled'); return; }
    }
    if (!chosen.length) throw new Error('Nothing selected');
    const want = new Set(chosen.map((f) => f.id));
    // Drop torrents covering only unwanted files; add torrents for wanted
    // files nobody covers.
    const hash = infos[0].hash || g.hash;
    for (const st of infos) {
      const covers = (st.selectedFiles || []).map((f) => f.id);
      if (covers.length && !covers.some((id) => want.has(id))) {
        await api('/api/admin/abb/torrents/' + encodeURIComponent(st.id), { method: 'DELETE' }).catch(() => {});
        covers.forEach((id) => byFile.delete(id));
      }
    }
    const missing = chosen.filter((f) => !byFile.has(f.id));
    if (missing.length) {
      row.setStatus('Adding ' + missing.length + ' torrent(s) to Real-Debrid…');
      const magnet = 'magnet:?xt=urn:btih:' + hash + '&dn=' + encodeURIComponent(g.filename);
      for (const f of missing) {
        try { const a = await abbAddTorrent(magnet, f.id); byFile.set(f.id, a.id); }
        catch (e) { appendUploadRow(listEl, '  ↳ ' + f.path, '').fail('Add failed: ' + e.message); }
      }
    }
    const san = (s) => s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'audiobook';
    const plan = abbPlanDest(san(g.filename), chosen.filter((f) => byFile.has(f.id)));
    // One torrent may cover several files (old-flow first torrent); key the
    // tracking list by torrent and give it the first covered file's dest.
    const byTorrent = new Map();
    for (const p of plan) { const tid = byFile.get(p.id); if (!byTorrent.has(tid)) byTorrent.set(tid, p.dest); }
    const torrents = [...byTorrent].map(([id, dest]) => ({ id, dest }));
    if (!torrents.length) throw new Error('Nothing to track');
    row.setStatus(torrents.length + ' torrent(s) on Real-Debrid — waiting for download');
    await abbTrackTorrents(torrents, folderId, listEl, row);
  } catch (e) {
    row.fail(e.message || String(e));
  }
}

function abbMagnetTitle(magnet) {
  try { return (new URL(magnet).searchParams.get('dn') || '').replace(/\+/g, ' ').trim() || 'Magnet link'; } catch (e) { return 'Magnet link'; }
}

async function abbToggleDetails(res, drow) {
  const box = drow.firstChild.firstChild;
  if (drow.style.display !== 'none') { drow.style.display = 'none'; return; }
  drow.style.display = '';
  if (drow.dataset.loaded) return;
  box.innerHTML = '<span class="spinner"></span>Loading description…';
  try {
    const d = await api('/api/admin/abb/details?url=' + encodeURIComponent(res.url));
    if (d.error) throw new Error(d.error);
    renderAbbDetails(box, d);
    drow.dataset.loaded = '1';
  } catch (e) {
    box.textContent = 'Couldn\'t load details: ' + e.message;
  }
}

function renderAbbDetails(box, d) {
  box.innerHTML = '';
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = [
    d.author ? 'Written by ' + d.author : null,
    d.narrators && d.narrators.length ? 'Read by ' + d.narrators.join(', ') : null,
    d.format, d.bitrate, d.length,
    d.abridged === true ? 'Abridged' : d.abridged === false ? 'Unabridged' : null,
  ].filter(Boolean).join(' · ');
  box.appendChild(meta);
  const paras = (d.description || '').split(/\n\n+/).filter(Boolean);
  if (!paras.length) {
    const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'No description on the listing.'; box.appendChild(p);
  }
  for (const t of paras) { const p = document.createElement('p'); p.textContent = t; box.appendChild(p); }
}

// Resolve → add torrent(s) → poll → pCloud fetch each file → delete torrent.
async function abbGrab(res, folderId, listEl) {
  if (!folderId) { showError('Pick a target library first.'); return false; }
  const row = appendUploadRow(listEl, res.title, res.magnet ? 'Reading magnet…' : 'Resolving on AudioBookBay…');
  try {
    const m = await api('/api/admin/abb/resolve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(res.magnet ? { magnet: res.magnet } : { url: res.url }),
    });
    if (m.error) throw new Error(m.error);
    row.setStatus('Asking Real-Debrid what\'s in it…');
    const peek = await api('/api/admin/abb/torrents', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ magnet: m.magnet, inspect: true }),
    });
    if (peek.error) throw new Error(peek.error);
    const candidates = (peek.files || []).filter((f) => f.isAudio || f.isArchive);
    if (!candidates.length) throw new Error('Torrent contains no audio files');
    let chosen = candidates;
    if (candidates.length > 1) {
      row.setStatus('Choose which files to grab…');
      chosen = await abbPickFiles(peek.name || m.title, candidates);
      if (!chosen) { row.fail('Cancelled'); return false; }
    }
    const plan = abbPlanDest(m.folderName, chosen);
    row.setStatus('Adding ' + plan.length + ' torrent(s) to Real-Debrid…');
    // One torrent per file, two at a time — RD caps active torrents, each
    // add costs ~10 API calls, and four in parallel drew a 429 (2026-09-02).
    // A failed add gets its own Retry, which re-adds just that file and
    // tracks it to the library on its own.
    const torrents = [];
    const retryAdd = (p) => {
      const r = appendUploadRow(listEl, '  ↳ ' + p.dest, '');
      const retry = () => {
        r.setStatus('Adding to Real-Debrid…');
        abbAddTorrent(m.magnet, p.id)
          .then((a) => { removeBtn(); return abbTrackTorrents([{ id: a.id, dest: p.dest }], folderId, listEl, r); })
          .then(() => abbLoadRdList())
          .catch((e) => r.fail('Add failed: ' + e.message));
      };
      let removeBtn = r.addButton('Retry', retry);
      return r;
    };
    for (let i = 0; i < plan.length; i += 2) {
      const batch = plan.slice(i, i + 2);
      const added = await Promise.all(batch.map((p) => abbAddTorrent(m.magnet, p.id).then((a) => ({ ...a, dest: p.dest, plan: p })).catch((e) => ({ error: e.message, dest: p.dest, plan: p }))));
      for (const a of added) {
        if (a.error) retryAdd(a.plan).fail('Add failed: ' + a.error);
        else torrents.push({ id: a.id, dest: a.dest });
      }
      row.setStatus('Added ' + torrents.length + ' / ' + plan.length + ' torrent(s)…');
    }
    if (!torrents.length) throw new Error('Nothing could be added to Real-Debrid');
    row.setStatus(torrents.length + ' torrent(s) on Real-Debrid — waiting for download');
    return await abbTrackTorrents(torrents, folderId, listEl, row);
  } catch (e) {
    row.fail(e.message || String(e));
    return false;
  }
}

// Shared tail of a grab: poll the given RD torrents, hand each finished
// file to pCloud at its planned dest, delete it on RD, scan if needed.
// Also used by the "On Real-Debrid" panel to resume a torrent nobody is
// watching (tab closed mid-grab).
async function abbTrackTorrents(torrents, folderId, listEl, row) {
  try {

    // Poll every torrent on one shared timer so RD's 250 req/min limit holds
    // even for a 40-part set: interval scales with the torrent count.
    // Cancel deletes whatever is still on RD; a torrent whose progress
    // hasn't moved for 20 min (no seeders) is given up on the same way —
    // RD itself would otherwise sit on it indefinitely.
    const interval = Math.max(4000, torrents.length * 600);
    const STALL_MS = 20 * 60 * 1000;
    const pending = new Map(torrents.map((t) => [t.id, { row: appendUploadRow(listEl, '  ↳ ' + t.dest, 'Queued on Real-Debrid'), dest: t.dest, lastProgress: -1, lastChangeAt: Date.now() }]));
    const fetches = [];
    let needsScan = false;
    let cancelled = false;
    const removeCancel = row.addButton('Cancel', () => { cancelled = true; });
    // No automatic torrent deletion anywhere in this flow: Real-Debrid
    // expires old torrents on its own, and auto-deleting on failure destroyed
    // the only way to retry a grab (The Secret, 2026-08-24). Only the explicit
    // Delete button in the On Real-Debrid panel (and deselecting files in the
    // picker) removes torrents. Kept in sync with Pholia's abbTrackTorrents.
    while (pending.size) {
      await new Promise((r) => setTimeout(r, interval));
      if (cancelled) {
        for (const [, p] of pending) p.row.fail('Cancelled');
        pending.clear();
        removeCancel();
        row.fail('Cancelled — torrents left on Real-Debrid (resume from the On Real-Debrid panel)');
        return false;
      }
      for (const [id, p] of [...pending]) {
        let st;
        try { st = await api('/api/admin/abb/torrents/' + encodeURIComponent(id)); }
        catch (e) { p.row.setStatus('Poll error: ' + e.message); continue; }
        if (st.error && !st.downloads) { p.row.fail(st.error); pending.delete(id); continue; }
        if (st.progress !== p.lastProgress) { p.lastProgress = st.progress; p.lastChangeAt = Date.now(); }
        else if (st.status !== 'downloaded' && Date.now() - p.lastChangeAt > STALL_MS) {
          p.row.fail('No progress for 20 min (' + (st.seeders || 0) + ' seeders) — gave up; it is still on Real-Debrid to retry later');
          pending.delete(id); continue;
        }
        if (st.status === 'downloaded' && st.downloads) {
          pending.delete(id);
          p.row.complete('Ready on Real-Debrid');
          // Hand each direct link to pCloud at the planned path; delete the
          // torrent once it lands.
          fetches.push((async () => {
            for (const d of st.downloads) {
              if (!d.isAudio && !d.isArchive) continue;
              if (d.ext === 'rar' || d.ext === '7z') {
                appendUploadRow(listEl, '  ↳ ' + d.filename, '').fail('Real-Debrid produced a ' + d.ext + ' — can\'t extract server-side. Download it and use the browser upload instead.');
                continue;
              }
              const registered = await fetchUrlToPcloud(folderId, d.download, p.dest, listEl);
              if (!registered) needsScan = true;
            }
          })());
        } else {
          const pct = typeof st.progress === 'number' ? st.progress + '%' : '';
          p.row.setStatus(st.status + ' ' + pct + (st.seeders != null ? ' · ' + st.seeders + ' seeders' : '') + (st.speed ? ' · ' + formatBytes(st.speed) + '/s' : ''));
          if (typeof st.progress === 'number') p.row.setProgressPct(st.progress);
        }
      }
    }
    removeCancel();
    await Promise.all(fetches);
    if (!fetches.length) { row.fail('Nothing downloaded'); return false; }
    // /fetch-url/finish only registers single m4b/m4a/aac files. An mp3
    // release is N chapter files that must land before they can be probed
    // as one book, so nothing registers them until a scan runs — do that
    // here rather than making the user find "Scan now". Skipped when every
    // file already registered: a scan racing another grab's /finish is how
    // duplicate items appeared on 2026-08-23 (now also blocked by a unique
    // index, but no point provoking it).
    const libId = abbLibraryIdForFolder(folderId);
    if (libId && needsScan) {
      row.setStatus('Scanning library…');
      try {
        const report = await api('/api/admin/libraries/' + libId + '/scan', { method: 'POST' });
        row.complete('Done — scan added ' + (report.added || 0) + ' new book(s)');
        refresh().catch(() => {});
      } catch (e) {
        row.complete('Done, but the library scan failed: ' + e.message + ' — use "Scan now"');
      }
    } else {
      row.complete('Done');
    }
    return true;
  } catch (e) {
    row.fail(e.message || String(e));
    return false;
  }
}

// Where each chosen torrent file lands on pCloud, relative to the library
// folder. RD paths look like "/Pack Name/Book 28 - The Secret/01.mp3".
//   • The dirs every chosen file shares are collapsed to their deepest one,
//     so picking only "Book 28" out of a 4-book pack lands it as
//     "Book 28 - The Secret/01.mp3", not "Pack Name/Book 28 …/01.mp3".
//   • Sub-folders below that are kept, so a whole pack lands as one folder
//     per book and the scanner sees separate books.
//   • Two m4b/m4a siblings in one dir would be read as one broken
//     "multi-file non-mp3" book, so each gets its own folder named after
//     the file. mp3 siblings stay together — they're chapters of one book.
function abbPlanDest(folderName, files) {
  const san = (s) => s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  const split = files.map((f) => f.path.split('/').filter(Boolean));
  let depth = 0;
  while (split.every((p) => p.length > depth + 1 && p[depth] === split[0][depth])) depth++;
  const top = depth > 0 ? san(split[0][depth - 1]) : san(folderName);
  const rels = split.map((p) => [top, ...p.slice(depth)].map(san));
  const dirOf = (r) => r.slice(0, -1).join('/');
  const m4bLike = (name) => /\.(m4b|m4a|aac)$/i.test(name);
  return files.map((f, i) => {
    const r = rels[i];
    const name = r[r.length - 1];
    const siblings = rels.filter((o, j) => j !== i && dirOf(o) === dirOf(r) && /\.(m4b|m4a|aac|mp3|flac|ogg|opus)$/i.test(o[o.length - 1]));
    const dest = m4bLike(name) && siblings.length
      ? [...r.slice(0, -1), name.replace(/\.[^.]+$/, ''), name].join('/')
      : r.join('/');
    return { id: f.id, dest, bytes: f.bytes };
  });
}

// Modal picker for multi-file releases. Files grouped by directory; a
// directory checkbox toggles its files. Resolves with the chosen files or
// null on cancel.
function abbPickFiles(name, files, useSelectedFlag) {
  const pre = (f) => (useSelectedFlag ? !!f.selected : true);
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'abb-modal';
    overlay.innerHTML =
      '<div class="abb-modal-box">' +
        '<h3></h3><p class="muted" style="margin-top:0">Pick what to grab. Whole folders are one book each; mp3 files in a folder are chapters of that book.</p>' +
        '<div class="abb-pick-list"></div>' +
        '<div class="upload-row" style="justify-content:flex-end; margin:0.75rem 0 0">' +
          '<span class="muted abb-pick-summary" style="margin-right:auto"></span>' +
          '<button class="secondary" data-cancel>Cancel</button><button data-ok>Grab</button>' +
        '</div>' +
      '</div>';
    overlay.querySelector('h3').textContent = name;
    const list = overlay.querySelector('.abb-pick-list');
    const groups = new Map();
    for (const f of files) {
      const parts = f.path.split('/').filter(Boolean);
      const dir = parts.slice(0, -1).join('/') || '/';
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir).push({ f, name: parts[parts.length - 1] });
    }
    const boxes = [];
    for (const [dir, entries] of groups) {
      const g = document.createElement('div');
      g.className = 'abb-pick-group';
      const dl = document.createElement('label');
      dl.className = 'abb-pick-dir';
      const dcb = document.createElement('input'); dcb.type = 'checkbox';
      dcb.checked = entries.every((e) => pre(e.f)); dcb.indeterminate = !dcb.checked && entries.some((e) => pre(e.f));
      dl.appendChild(dcb);
      dl.appendChild(document.createTextNode(' ' + dir + ' (' + entries.length + ' file' + (entries.length === 1 ? '' : 's') + ', ' + formatBytes(entries.reduce((s, e) => s + (e.f.bytes || 0), 0)) + ')'));
      g.appendChild(dl);
      const fileBoxes = [];
      for (const e of entries) {
        const l = document.createElement('label');
        l.className = 'abb-pick-file';
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = pre(e.f); cb._file = e.f;
        l.appendChild(cb);
        l.appendChild(document.createTextNode(' ' + e.name + (e.f.bytes ? ' · ' + formatBytes(e.f.bytes) : '') + (e.f.isArchive ? ' · archive' : '')));
        g.appendChild(l);
        fileBoxes.push(cb); boxes.push(cb);
        cb.addEventListener('change', () => { dcb.checked = fileBoxes.every((b) => b.checked); dcb.indeterminate = !dcb.checked && fileBoxes.some((b) => b.checked); update(); });
      }
      dcb.addEventListener('change', () => { fileBoxes.forEach((b) => { b.checked = dcb.checked; }); dcb.indeterminate = false; update(); });
      list.appendChild(g);
    }
    const ok = overlay.querySelector('[data-ok]');
    const summary = overlay.querySelector('.abb-pick-summary');
    const chosen = () => boxes.filter((b) => b.checked).map((b) => b._file);
    const update = () => {
      const c = chosen();
      ok.disabled = !c.length;
      ok.textContent = 'Grab ' + c.length + ' file' + (c.length === 1 ? '' : 's');
      summary.textContent = c.length ? formatBytes(c.reduce((s, f) => s + (f.bytes || 0), 0)) : 'Nothing selected';
    };
    update();
    const close = (val) => { overlay.remove(); resolve(val); };
    ok.addEventListener('click', () => close(chosen()));
    overlay.querySelector('[data-cancel]').addEventListener('click', () => close(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    document.body.appendChild(overlay);
  });
}

async function abbAddTorrent(magnet, fileId) {
  const body = fileId != null ? { magnet, fileId } : { magnet };
  const r = await api('/api/admin/abb/torrents', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (r.error) throw new Error(r.error);
  return r;
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

// Last path segment of a URL, decoded, with the query string ignored.
// Returns '' for URLs like https://host/download?id=123 so the caller can
// insist on an explicit name.
function fileNameFromUrl(url) {
  try {
    const u = new URL(url);
    const seg = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    return /\.[a-z0-9]{2,4}$/i.test(seg) ? seg : '';
  } catch {
    return '';
  }
}

// Fetch-from-URL: pCloud's servers download the file; we just poll its
// size. Nothing here is stateful on the server — if the tab closes, the
// download still completes and "Add book by path" picks the file up later.
// pCloud gives no progress API for these jobs (see admin routes), so the
// file may stay invisible until it lands in one go; the wait is bounded by
// a generous timeout rather than by anything pCloud tells us.
async function fetchUrlToPcloud(folderId, url, relPath, listEl) {
  const row = appendUploadRow(listEl, relPath, 'Queueing…');
  try {
    // /start can block for a while (pCloud's stat of the target hangs 10-60s
    // while pCloud is busy writing) — tick elapsed time so it doesn't look
    // frozen. Seen: >1 min of silent "Queueing", 2026-08-24. Same in Pholia.
    const t0q = Date.now();
    const qTimer = setInterval(() => row.setStatus(
      'Queueing on pCloud… ' + Math.round((Date.now() - t0q) / 1000) + 's (checking for an existing copy — pCloud can be slow here)'), 3000);
    let started;
    try {
      started = await api('/api/admin/storage/folder/' + folderId + '/fetch-url/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, relPath }),
      });
    } finally {
      clearInterval(qTimer);
    }
    const t0 = Date.now();
    const maxWaitMs = 60 * 60 * 1000;
    let lastSize = 0;
    if (started.alreadyComplete) row.setStatus('Already on pCloud (same size) — registering…');
    if (started.resumed) row.setStatus('pCloud already has a partial copy — resuming…');
    // A single failed poll (pCloud's API does throw transient 5xx / 5000s)
    // must not kill the grab; only give up after several in a row.
    let pollErrors = 0;
    for (; !started.alreadyComplete;) {
      await new Promise((r) => setTimeout(r, 3000));
      const qs = new URLSearchParams({ relPath: started.relPath, lastSize: String(lastSize) });
      if (started.expectedSize) qs.set('expectedSize', String(started.expectedSize));
      let p;
      try {
        p = await api('/api/admin/storage/folder/' + folderId + '/fetch-url/progress?' + qs.toString());
        if (p.error) throw new Error(p.error);
        pollErrors = 0;
      } catch (e) {
        if (++pollErrors >= 6) throw new Error('Progress check kept failing: ' + e.message);
        row.setStatus('Progress check failed (' + pollErrors + '/6): ' + e.message + ' — retrying');
        continue;
      }
      if (p.finished) break;
      const elapsed = Math.round((Date.now() - t0) / 1000);
      if (elapsed * 1000 > maxWaitMs) throw new Error('Gave up after an hour — pCloud never finished the download (is the URL a direct link?)');
      if (p.status === 'pending') {
        row.setStatus('Waiting for pCloud to fetch it… ' + elapsed + 's'
          + (started.expectedSize ? ' (' + formatBytes(started.expectedSize) + ')' : ''));
      } else if (p.size) {
        row.setProgress(p.downloaded, p.size);
      } else {
        row.setStatus('Downloading… ' + formatBytes(p.downloaded) + ' so far');
      }
      lastSize = p.downloaded || 0;
    }
    row.setStatus('Registering…');
    const saved = await api('/api/admin/storage/folder/' + folderId + '/fetch-url/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relPath: started.relPath, registerAsBook: true }),
    });
    if (saved.itemId) {
      row.complete('Saved & registered (' + saved.itemId + ')');
      return true;
    } else if (saved.registerError) {
      row.complete('Saved to pCloud but NOT registered: ' + saved.registerError);
    } else if (/\.zip$/i.test(started.relPath)) {
      row.complete('Saved (' + formatBytes(saved.size || 0) + ') — extracting…');
      await extractZipOnServer(folderId, started.relPath, listEl);
    } else {
      row.complete('Saved' + (saved.size ? ' (' + formatBytes(saved.size) + ')' : ''));
    }
  } catch (e) {
    row.fail(e.message || String(e));
  }
  return false;
}

// Server-side zip extraction (ArchiveExtractDO). One row per file inside
// the archive, created as the job reports them. The job runs in a Durable
// Object, so closing the tab doesn't stop it — reopening and re-running
// the same URL would just show "already exists".
async function extractZipOnServer(folderId, relPath, listEl) {
  const head = appendUploadRow(listEl, '↳ extracting ' + relPath, 'Reading archive…');
  const rows = {};
  try {
    await api('/api/admin/storage/folder/' + folderId + '/extract/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relPath, deleteArchive: true }),
    });
    for (;;) {
      await new Promise((r) => setTimeout(r, 2500));
      const job = await api('/api/admin/storage/folder/' + folderId + '/extract/status?relPath=' + encodeURIComponent(relPath));
      if (job.error && job.status !== 'done' && job.status !== 'error' && !job.entries) throw new Error(job.error);
      for (const e of job.entries || []) {
        if (!rows[e.outRelPath]) rows[e.outRelPath] = appendUploadRow(listEl, '  ↳ ' + e.outRelPath, 'Queued');
        const r = rows[e.outRelPath];
        if (e.status === 'running') r.setProgress(e.uploaded, e.size);
        else if (e.status === 'done') r.complete(e.itemId ? 'Registered (' + e.itemId + ')' : (e.error || 'Extracted'));
        else if (e.status === 'error') r.fail(e.error || 'Failed');
      }
      if (job.status === 'listing') head.setStatus('Reading archive…');
      else if (job.status === 'running') head.setStatus((job.next || 0) + ' / ' + job.entries.length + ' files');
      else if (job.status === 'done') { head.complete(job.entries.length + ' file(s) extracted' + (job.archiveDeleted ? ', archive deleted' : '') + (job.error ? ' — ' + job.error : '')); return; }
      else if (job.status === 'error') { head.fail(job.error || 'Extraction failed'); return; }
    }
  } catch (e) {
    head.fail(e.message || String(e));
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
    setProgressPct(pct) { bar.style.width = Math.max(0, Math.min(100, pct)) + '%'; },
    complete(text) {
      el.classList.add('ok');
      bar.style.width = '100%';
      status.textContent = ' · ' + (text || 'Done');
    },
    fail(text) {
      el.classList.add('err');
      status.textContent = ' · ' + (text || 'Failed');
    },
    // Small inline button (e.g. "Cancel"); returns a function that removes it.
    addButton(label, onClick) {
      const b = document.createElement('button');
      b.className = 'secondary row-btn';
      b.textContent = label;
      b.addEventListener('click', onClick);
      el.appendChild(b);
      return () => b.remove();
    },
  };
}

// Re-probe driven from the browser one book at a time so there's a live
// row per book ("The Secret · 1 chapter · no chapter data in the file")
// instead of one long silent request that dumped JSON at the bottom of the
// page. "Missing chapters" = 0 or 1 chapters: a single-file mp3 scanned
// before CHAP support shows as one whole-file chapter.
async function runReprobe(libId, btn, onlyMissing, label) {
  const list = document.getElementById('reprobe-list-' + libId);
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Re-probing…';
  list.innerHTML = '';
  const head = appendUploadRow(list, label, 'Listing books…');
  let done = 0, withChapters = 0;
  try {
    const data = await api('/api/admin/libraries/' + libId + '/items');
    let items = data.items || [];
    if (onlyMissing) items = items.filter((it) => (it.chapter_count || 0) <= 1);
    if (!items.length) { head.complete('Nothing to do — every book already has chapters'); return; }
    for (const it of items) {
      head.setStatus((done + 1) + ' / ' + items.length + ' — ' + (it.title || it.id));
      head.setProgressPct((done / items.length) * 100);
      const row = appendUploadRow(list, '  ↳ ' + (it.title || it.id), 'Reading tags…');
      try {
        const r = await api('/api/admin/items/' + it.id + '/reprobe', { method: 'POST' });
        if (r.error) throw new Error(r.detail || r.error);
        const parts = [r.chapters + ' chapter' + (r.chapters === 1 ? '' : 's')];
        if (r.chapters <= 1) parts.push('no chapter data in the file (no chpl/CHAP)');
        if (r.series) parts.push('series: ' + r.series);
        if (r.durationSeconds) parts.push(formatDuration(r.durationSeconds));
        if (r.coverRefreshed) parts.push('cover refreshed');
        row.complete(parts.join(' · '));
        if (r.chapters > 1) withChapters++;
      } catch (e) {
        row.fail(e.message || String(e));
      }
      done++;
    }
    head.complete(done + ' book' + (done === 1 ? '' : 's') + ' re-probed · ' + withChapters + ' with chapters');
    const books = document.getElementById('books-list-' + libId);
    if (books && books.dataset.loaded === '1') {
      const fresh = await api('/api/admin/libraries/' + libId + '/items');
      renderBooksList(books, fresh.items || []);
    }
  } catch (e) {
    head.fail(e.message || String(e));
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
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
    html += '<button class="danger" data-delete-item-files="' + escapeHtml(it.id) + '" title="Remove from the library AND delete the audio files from pCloud">Delete + files</button>';
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

  container.querySelectorAll('[data-delete-item-files]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('.book-row');
      const title = row.querySelector('.title').textContent.trim().split(' · ')[0];
      if (!confirm('Delete "' + title + '" from the library AND delete its audio file(s) from pCloud?\n\nThis cannot be undone.')) return;
      btn.disabled = true; btn.textContent = '…';
      try {
        const r = await api('/api/admin/items/' + btn.dataset.deleteItemFiles + '?deleteFiles=1', { method: 'DELETE' });
        if (r && r.error) throw new Error(r.error);
        row.remove();
        if (r && r.reason) showError(r.reason);
      } catch (e) {
        showError('Delete failed: ' + e.message);
        btn.disabled = false; btn.textContent = 'Delete + files';
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
