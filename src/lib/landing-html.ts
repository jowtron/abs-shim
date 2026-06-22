// Marketing/landing page served at the true site root (`/`).
//
// The bundled ABS Nuxt web client is hard-bound to the `/audiobookshelf/` base
// path (its index.html sets `<base href="/audiobookshelf/">`), so it lives at
// `/audiobookshelf` and `/` is free for this landing page. The outer fetch()
// in index.ts serves this for an exact `/` request BEFORE the prefix-strip, so
// `/audiobookshelf/*` still reaches the Nuxt SPA untouched.
//
// Kept as a single self-contained HTML string (same pattern as ADMIN_HTML) so
// there's no extra asset/route to manage. The portfolio at jderrick.app scrapes
// this <head> for the card title/description/preview image.

export const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ABS Shim — Serverless Audiobookshelf Backend</title>
  <meta name="description" content="A serverless, Cloudflare-native backend that speaks the Audiobookshelf API. Stream your audiobook library from cloud storage to any ABS app — no server to run.">
  <meta property="og:title" content="ABS Shim — Serverless Audiobookshelf Backend">
  <meta property="og:description" content="A serverless, Cloudflare-native backend that speaks the Audiobookshelf API. Stream your audiobook library from cloud storage to any ABS app — no server to run.">
  <meta property="og:image" content="https://abs-shim.jderrick.app/og.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:url" content="https://abs-shim.jderrick.app/">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="ABS Shim">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="ABS Shim — Serverless Audiobookshelf Backend">
  <meta name="twitter:description" content="A serverless, Cloudflare-native backend that speaks the Audiobookshelf API. Bring your own storage; stream to any ABS app.">
  <meta name="twitter:image" content="https://abs-shim.jderrick.app/og.png">
  <meta name="theme-color" content="#1b1813">
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="apple-touch-icon" href="/ios_icon.png">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    :root{--bg:#1b1813;--bg2:#151310;--card:#2a2114;--accent:#cda24a;--accent2:#f3d99b;--ink:#f0e9dc;--muted:#b09a73}
    html{-webkit-text-size-adjust:100%}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;background:
      radial-gradient(1100px 600px at 80% -10%,rgba(205,162,74,.20),transparent 60%),
      linear-gradient(160deg,var(--bg2),var(--bg) 55%,#2a2114);
      color:var(--ink);min-height:100vh;line-height:1.55;-webkit-font-smoothing:antialiased}
    .wrap{max-width:880px;margin:0 auto;padding:clamp(2.5rem,8vw,6rem) 1.5rem 4rem}
    .eyebrow{display:inline-block;font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);
      border:1px solid rgba(56,189,248,.35);border-radius:999px;padding:.35rem .8rem;margin-bottom:1.6rem}
    h1{font-size:clamp(2.6rem,8vw,4.5rem);line-height:1.02;letter-spacing:-.02em;
      background:linear-gradient(90deg,var(--accent2),var(--accent));-webkit-background-clip:text;background-clip:text;color:transparent}
    .tag{font-size:clamp(1.1rem,3.5vw,1.5rem);color:var(--ink);margin-top:1rem;font-weight:500}
    .lede{font-size:1.08rem;color:var(--muted);margin-top:1.2rem;max-width:60ch}
    .cta{display:flex;flex-wrap:wrap;gap:.8rem;margin-top:2.2rem}
    .btn{display:inline-flex;align-items:center;gap:.5rem;font-size:1rem;font-weight:600;text-decoration:none;
      padding:.85rem 1.5rem;border-radius:12px;transition:transform .12s ease,box-shadow .12s ease}
    .btn:active{transform:translateY(1px)}
    .btn-primary{background:linear-gradient(90deg,var(--accent2),var(--accent));color:#1a1408;box-shadow:0 8px 30px rgba(205,162,74,.28)}
    .btn-ghost{background:rgba(255,255,255,.04);color:var(--ink);border:1px solid rgba(255,255,255,.12)}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1rem;margin-top:3.5rem}
    .feat{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:1.3rem}
    .feat h3{font-size:1.05rem;margin-bottom:.4rem;color:var(--accent2)}
    .feat p{font-size:.95rem;color:var(--muted)}
    .foot{margin-top:3.5rem;padding-top:1.6rem;border-top:1px solid rgba(255,255,255,.08);color:var(--muted);font-size:.92rem}
    .foot a{color:var(--accent2);text-decoration:none}
    .foot a:hover{text-decoration:underline}
  </style>
</head>
<body>
  <main class="wrap">
    <span class="eyebrow">Early access</span>
    <h1>ABS Shim</h1>
    <p class="tag">A serverless Audiobookshelf backend.</p>
    <p class="lede">ABS Shim speaks the Audiobookshelf API from a single Cloudflare Worker — point any
      Audiobookshelf app at it and stream your audiobook library straight from cloud storage. No server to
      run, no container to babysit.</p>

    <div class="cta">
      <a class="btn btn-primary" href="/signup">Request early access</a>
      <a class="btn btn-ghost" href="/audiobookshelf">Open the web player →</a>
    </div>

    <div class="grid">
      <div class="feat">
        <h3>Bring your own storage</h3>
        <p>pCloud, S3-compatible (R2 / B2 / Wasabi), WebDAV, or a public link. Multiple backends per library.</p>
      </div>
      <div class="feat">
        <h3>Works with your apps</h3>
        <p>Compatible with ShelfPlayer, the official ABS web client, and <a style="color:var(--accent2);text-decoration:none" href="https://pholia.jderrick.app">Pholia</a>.</p>
      </div>
      <div class="feat">
        <h3>Zero servers</h3>
        <p>Cloudflare Workers, D1, and R2 do the work. Nothing to patch, nothing to keep online.</p>
      </div>
    </div>

    <div class="foot">
      Looking for a player? <a href="https://pholia.jderrick.app">Pholia</a> is the recommended Audiobookshelf
      client — fast, offline-first, installable. &nbsp;·&nbsp; <a href="/admin">Server admin</a>
    </div>
  </main>
</body>
</html>`;
