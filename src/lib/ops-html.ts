// Internal ops dashboard — self-contained inline HTML (same pattern as
// admin-html.ts). Served at /ops behind Cloudflare Access (src/ops/access.ts).
// CF Access injects its session cookie + JWT assertion on every request to the
// Access-protected paths (/ops AND /api/ops), so the fetch below is already
// authenticated — no client-side login logic needed.

export const OPS_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>ABS Shim · ops</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root{
      --bg:#151310;--bg2:#1b1813;--card:#221d15;--border:#3a3122;
      --fg:#f0e9dc;--muted:#b09a73;--accent:#cda24a;--accent2:#f3d99b;--ok:#6bbf59;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
    }
    *{box-sizing:border-box}
    body{margin:0;padding:1.6rem;background:
      radial-gradient(1000px 500px at 85% -10%,rgba(205,162,74,.14),transparent 60%),
      linear-gradient(160deg,var(--bg2),var(--bg) 60%);color:var(--fg);min-height:100vh;max-width:1000px;margin:0 auto}
    h1{font-size:1.5rem;margin:0 0 .2rem;background:linear-gradient(90deg,var(--accent2),var(--accent));-webkit-background-clip:text;background-clip:text;color:transparent;display:inline-block}
    .muted{color:var(--muted);font-size:.9rem}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.8rem;margin:1.2rem 0}
    .stat{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1rem 1.1rem}
    .stat .n{font-size:1.9rem;font-weight:700;color:var(--accent2);line-height:1}
    .stat .l{color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;margin-top:.35rem}
    h2{font-size:1.05rem;margin:1.8rem 0 .6rem;color:var(--accent2)}
    .card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:.4rem .9rem}
    table{width:100%;border-collapse:collapse;font-size:.9rem}
    th,td{text-align:left;padding:.5rem .4rem;border-bottom:1px solid var(--border)}
    th{color:var(--muted);font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.05em}
    tr:last-child td{border-bottom:0}
    .pill{display:inline-block;background:rgba(205,162,74,.15);color:var(--accent2);border:1px solid var(--border);border-radius:999px;padding:.12rem .6rem;font-size:.8rem;margin:0 .3rem .3rem 0}
    code{background:rgba(125,125,125,.18);padding:.1em .35em;border-radius:4px;font-size:.85em}
    .err{background:rgba(180,70,8,.15);border:1px solid #b54708;color:#f5a524;padding:.8rem 1rem;border-radius:10px;margin:1rem 0;display:none}
    .foot{margin-top:2rem;color:var(--muted);font-size:.82rem}
  </style>
</head>
<body>
  <h1>ABS Shim · ops</h1>
  <div class="muted" id="subtitle">internal dashboard · loading…</div>

  <div id="error" class="err"></div>

  <div class="grid" id="stats"></div>

  <h2>Storage / servers added</h2>
  <div class="card"><table id="folders"><thead><tr><th>Library</th><th>Provider</th><th>Config</th></tr></thead><tbody></tbody></table></div>

  <h2>Providers in use</h2>
  <div class="card" style="padding:.9rem"><div id="providers"></div></div>

  <h2>Users</h2>
  <div class="card"><table id="users"><thead><tr><th>Username</th><th>Type</th><th>Created</th><th>Last seen</th></tr></thead><tbody></tbody></table></div>

  <div class="foot">Read-only · gated by Cloudflare Access · ABS Shim <span id="ver"></span></div>

  <script>
    const fmtBytes = (b) => { if(!b) return '0 B'; const u=['B','KB','MB','GB','TB']; let i=0; while(b>=1024&&i<u.length-1){b/=1024;i++} return b.toFixed(i?1:0)+' '+u[i]; };
    const fmtHours = (s) => (s/3600).toFixed(1)+' h';
    const fmtDate = (ms) => ms ? new Date(ms).toLocaleDateString() : '—';
    const esc = (s) => String(s==null?'':s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

    async function load() {
      let data;
      try {
        const r = await fetch('/api/ops/stats', { credentials: 'include' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        data = await r.json();
      } catch (e) {
        const el = document.getElementById('error');
        el.style.display = 'block';
        el.textContent = 'Failed to load stats: ' + e.message + '. (Are /ops AND /api/ops both covered by the Cloudflare Access application?)';
        return;
      }
      document.getElementById('subtitle').textContent = 'internal dashboard · generated ' + new Date(data.generatedAt).toLocaleString();
      document.getElementById('ver').textContent = 'v' + data.version;

      const t = data.totals;
      document.getElementById('stats').innerHTML = [
        ['Users', t.users], ['Libraries', t.libraries], ['Items', t.items],
        ['Storage', fmtBytes(t.storageBytes)], ['Audio', fmtHours(t.durationSeconds)],
      ].map(([l,n]) => '<div class="stat"><div class="n">'+esc(n)+'</div><div class="l">'+l+'</div></div>').join('');

      document.querySelector('#folders tbody').innerHTML = (data.folders||[]).map(f =>
        '<tr><td>'+esc(f.libraryName)+'</td><td><span class="pill">'+esc(f.provider)+'</span></td><td><code>'+esc(JSON.stringify(f.config))+'</code></td></tr>'
      ).join('') || '<tr><td colspan="3" class="muted">No storage backends added.</td></tr>';

      const provs = [
        ...(data.foldersByProvider||[]).map(p => p.provider+' ×'+p.n),
        ...(data.oauthByProvider||[]).map(p => p.provider+' oauth ×'+p.n),
      ];
      document.getElementById('providers').innerHTML = provs.length
        ? provs.map(p => '<span class="pill">'+esc(p)+'</span>').join('')
        : '<span class="muted">None</span>';

      document.querySelector('#users tbody').innerHTML = (data.users||[]).map(u =>
        '<tr><td>'+esc(u.username)+'</td><td><span class="pill">'+esc(u.type)+'</span></td><td>'+fmtDate(u.created_at)+'</td><td>'+fmtDate(u.last_seen)+'</td></tr>'
      ).join('') || '<tr><td colspan="4" class="muted">No users.</td></tr>';
    }
    load();
  </script>
</body>
</html>`;
