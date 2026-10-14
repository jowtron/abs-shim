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
//
// Rhapsode (2026-10-14): a rhapsode recited Homer, and the word means
// "song-stitcher"; the page's centrepiece is an example book stitched from
// three files, its chapters spaced by the real length of the Odyssey's 24
// books. The icon is Joseph's own (web/icon-512.png); og.png is a 1200x630
// render of the same look. Keep the claims true: "any Audiobookshelf app
// should work" is the API promise; only Pholia, ShelfPlayer and the web app
// are named as tested.
export const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Rhapsode · Private audiobook and podcast server</title>
  <meta name="description" content="A private audiobook and podcast server. Your books stay in your own cloud storage, and it works with any Audiobookshelf app.">
  <meta property="og:title" content="Rhapsode">
  <meta property="og:description" content="A private audiobook and podcast server. Your books stay in your own cloud storage, and it works with any Audiobookshelf app.">
  <meta property="og:image" content="https://rhapsode.jderrick.app/og.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:url" content="https://rhapsode.jderrick.app/">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Rhapsode">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="Rhapsode">
  <meta name="twitter:description" content="A private audiobook and podcast server. Your books stay in your own cloud storage, and it works with any Audiobookshelf app.">
  <meta name="twitter:image" content="https://rhapsode.jderrick.app/og.png">
  <meta name="theme-color" content="#1b1118">
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="apple-touch-icon" href="/ios_icon.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Commissioner:wght@300..700&family=GFS+Didot&family=IBM+Plex+Mono:wght@400;500&display=swap">
  <style>
    /* One left-aligned reading column on a wine-dark ground; the stitched book is the only wide element. */
    :root {
      --ground: #1b1118;
      --raised: #241822;
      --ink: #efe6d8;
      --muted: #ae9ba6;
      --bronze: #d6a458;
      --rule: #3a2935;
      --track: #33232f;
      --on-bronze: #1b1118;
      --display: "GFS Didot", "Didot", "Bodoni 72", Georgia, serif;
      --body: "Commissioner", system-ui, -apple-system, "Segoe UI", sans-serif;
      --mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
      color-scheme: dark;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --ground: #f3eef1; --raised: #eae2e7; --ink: #25161f; --muted: #6b5763;
        --bronze: #8a5a1c; --rule: #d8cbd3; --track: #ddd0d8; --on-bronze: #fbf6ee;
        color-scheme: light;
      }
    }

    * { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body {
      margin: 0;
      background: var(--ground);
      color: var(--ink);
      font-family: var(--body);
      font-size: 1.0625rem;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    a { color: inherit; }
    a:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--bronze); outline-offset: 3px; border-radius: 3px; }

    .page { max-width: 1040px; margin: 0 auto; padding-inline: clamp(16px, 5vw, 48px); padding-block: 1.5rem 3rem; }
    .column { max-width: 40rem; }

    .top { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; padding-bottom: 1rem; border-bottom: 1px solid var(--rule); }
    .wordmark { display: inline-flex; align-items: center; gap: 0.6rem; font-family: var(--display); font-size: 1.35rem; text-decoration: none; }
    .wordmark img { width: 30px; height: 30px; border-radius: 22%; }
    .top nav { display: flex; gap: 1.25rem; font-size: 0.95rem; }
    .top nav a { color: var(--muted); text-decoration: none; }
    .top nav a:hover { color: var(--ink); }

    .hero { padding-block: clamp(2.5rem, 8vw, 5rem) 0; display: grid; gap: 1.25rem; }
    .eyebrow { margin: 0; font-size: 0.78rem; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: var(--bronze); }
    .name { display: flex; align-items: center; flex-wrap: wrap; gap: 0.75rem clamp(1rem, 3vw, 1.75rem); }
    .name img { width: clamp(72px, 13vw, 124px); height: auto; aspect-ratio: 1; border-radius: 22%; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35); }
    h1 { margin: 0; font-family: var(--display); font-weight: 400; font-size: clamp(3.5rem, 13vw, 8rem); line-height: 0.9; letter-spacing: -0.01em; }
    .etym { margin: 0; font-family: var(--mono); font-size: 0.85rem; color: var(--muted); }
    .etym .greek { font-family: var(--display); font-size: 1.15rem; color: var(--ink); }
    .lede { margin: 0; font-size: clamp(1.15rem, 2.6vw, 1.4rem); line-height: 1.45; font-weight: 300; max-width: 34ch; text-wrap: balance; }
    .cta { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 0.5rem; }
    .btn { display: inline-flex; align-items: center; font-weight: 600; font-size: 1rem; text-decoration: none; padding: 0.75rem 1.35rem; border-radius: 4px; border: 1px solid var(--bronze); }
    .btn-primary { background: var(--bronze); color: var(--on-bronze); }
    .btn-ghost { color: var(--ink); border-color: var(--rule); }
    .btn-ghost:hover { border-color: var(--muted); }

    .loom { margin: clamp(2.5rem, 7vw, 4rem) 0 0; padding: clamp(16px, 3vw, 28px); background: var(--raised); border: 1px solid var(--rule); border-radius: 6px; display: grid; gap: 1rem; }
    .loom-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 0.5rem 1.5rem; }
    .book-title { font-family: var(--display); font-size: 1.6rem; line-height: 1.1; }
    .book-title small { font-family: var(--body); font-size: 0.9rem; color: var(--muted); margin-left: 0.5rem; }
    .book-meta { display: flex; align-items: center; gap: 0.75rem; font-family: var(--mono); font-size: 0.8rem; color: var(--muted); font-variant-numeric: tabular-nums; }
    .chip { font-family: var(--body); font-size: 0.7rem; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; border: 1px solid var(--rule); border-radius: 999px; padding: 0.15rem 0.55rem; }

    .ticks { position: relative; height: 1.6rem; }
    .tick { position: absolute; bottom: 0; height: 100%; border-left: 1px solid var(--rule); padding-left: 3px; font-family: var(--display); font-size: 0.95rem; line-height: 1; color: var(--muted); white-space: nowrap; }
    .tick.is-current { color: var(--bronze); border-left-color: var(--bronze); }

    .track { position: relative; height: 46px; display: flex; gap: 4px; cursor: pointer; touch-action: none; }
    .seg { position: relative; background: var(--track); border-radius: 3px; overflow: hidden; }
    .played { position: absolute; inset: 0 auto 0 0; width: 0; background: color-mix(in srgb, var(--bronze) 22%, transparent); pointer-events: none; }
    .thread { position: absolute; left: 0; right: 0; top: 50%; height: 2px; margin-top: -1px; pointer-events: none;
      background-image: linear-gradient(90deg, var(--bronze) 55%, transparent 55%); background-size: 13px 2px; background-repeat: repeat-x; opacity: 0.55; }
    .chline { position: absolute; top: 0; bottom: 0; width: 1px; background: color-mix(in srgb, var(--ink) 14%, transparent); pointer-events: none; }
    .seam { position: absolute; top: -5px; bottom: -5px; width: 16px; margin-left: -8px; pointer-events: none; color: var(--bronze); }
    .seam svg { width: 100%; height: 100%; display: block; }
    .playhead { position: absolute; top: -9px; bottom: -9px; left: var(--p, 0%); width: 2px; margin-left: -1px; background: var(--ink); pointer-events: none; }
    .playhead::before { content: ""; position: absolute; top: -4px; left: -4px; width: 10px; height: 10px; border-radius: 50%; background: var(--ink); }

    .files { display: flex; gap: 4px; font-family: var(--mono); font-size: 0.75rem; color: var(--muted); font-variant-numeric: tabular-nums; }
    .files div { min-width: 0; overflow-wrap: anywhere; line-height: 1.35; }

    .readout { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 1rem; padding-top: 0.75rem; border-top: 1px solid var(--rule); font-variant-numeric: tabular-nums; }
    .readout .letter { font-family: var(--display); font-size: 2rem; line-height: 1; color: var(--bronze); min-width: 1.2ch; }
    .readout .chapter { font-weight: 600; }
    .readout .time, .readout .file { font-family: var(--mono); font-size: 0.85rem; color: var(--muted); }
    .loom figcaption { font-size: 0.92rem; color: var(--muted); max-width: 62ch; }

    section.block { padding-block: clamp(3rem, 8vw, 5rem) 0; }
    h2 { margin: 0 0 1.25rem; font-family: var(--display); font-weight: 400; font-size: clamp(1.9rem, 5vw, 2.6rem); line-height: 1.1; text-wrap: balance; }
    .epigraph { margin: 0 0 1.75rem; padding-left: 1.25rem; border-left: 2px solid var(--bronze); }
    .epigraph .gr { margin: 0; font-family: var(--display); font-size: clamp(1.35rem, 3.6vw, 1.75rem); line-height: 1.3; }
    .epigraph .en { margin: 0.35rem 0 0; font-style: italic; color: var(--muted); }
    .epigraph .cite { margin: 0.35rem 0 0; font-family: var(--mono); font-size: 0.75rem; color: var(--muted); }
    .prose p { margin: 0 0 1rem; }

    .groups { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2.25rem 3rem; }
    .group h3 { margin: 0 0 0.6rem; font-family: var(--display); font-weight: 400; font-size: 1.45rem; }
    .group ul { list-style: none; margin: 0; padding: 0; }
    .group li { padding-block: 0.6rem; border-top: 1px solid var(--rule); color: var(--muted); font-size: 0.98rem; }
    .group li strong { color: var(--ink); font-weight: 600; }

    footer { margin-top: clamp(3rem, 8vw, 5rem); padding-top: 1.25rem; border-top: 1px solid var(--rule); display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.75rem 2rem; font-size: 0.88rem; color: var(--muted); }
    footer nav { display: flex; flex-wrap: wrap; gap: 1.25rem; }
    footer a { text-decoration: none; }
    footer a:hover { color: var(--ink); }

    @media (max-width: 640px) {
      .groups { grid-template-columns: minmax(0, 1fr); }
      .tick { font-size: 0; }
      .tick.is-current { font-size: 0.95rem; }
    }
  </style>
</head>
<body>
<div class="page">
  <header class="top">
    <a class="wordmark" href="/"><img src="/icon-192.png" alt="" width="30" height="30">Rhapsode</a>
    <nav aria-label="Main">
      <a href="https://pholia.jderrick.app">Pholia</a>
      <a href="/admin">Sign in</a>
    </nav>
  </header>

  <main>
    <section class="hero">
      <p class="eyebrow">Private audiobook server · Invite only</p>
      <div class="name">
        <img src="/icon-512.png" alt="Rhapsode icon: headphones around a cloud holding three books" width="124" height="124">
        <h1>Rhapsode</h1>
      </div>
      <p class="etym"><span class="greek">ῥαψῳδός</span> &nbsp;rhapsōidós, “song-stitcher”</p>
      <p class="lede">A private server for your audiobooks and podcasts. The books stay in your own cloud storage, and it works with any Audiobookshelf app.</p>
      <div class="cta">
        <a class="btn btn-primary" href="/signup">Request access</a>
        <a class="btn btn-ghost" href="https://pholia.jderrick.app">Open Pholia</a>
      </div>
    </section>

    <figure class="loom" id="loom">
      <div class="loom-head">
        <div class="book-title">The Odyssey <small>Homer</small></div>
        <div class="book-meta"><span>3 files · 24 chapters · 12:09:29</span><span class="chip">Example</span></div>
      </div>
      <div class="ticks" id="ticks" aria-hidden="true"></div>
      <div class="track" id="track" tabindex="0" role="slider" aria-label="Position in the example book" aria-valuemin="0" aria-valuemax="43769" aria-valuenow="0">
        <div class="thread"></div>
        <div class="playhead"></div>
      </div>
      <div class="files" id="files"></div>
      <div class="readout">
        <span class="letter" id="r-letter">α</span>
        <span class="chapter" id="r-chapter">Book 1</span>
        <span class="time" id="r-time">0:00:00 / 12:09:29</span>
        <span class="file" id="r-file">playing part1.mp3</span>
      </div>
      <figcaption>A release that came as three mp3 files becomes one book. Its 24 books, which the Greeks called rhapsodies, become chapters, and the player crosses from one file to the next without a gap. Tap the bar to move through it.</figcaption>
    </figure>

    <section class="block column">
      <h2>Why the name</h2>
      <div class="epigraph">
        <p class="gr" lang="grc">Ἄνδρα μοι ἔννεπε, Μοῦσα, πολύτροπον</p>
        <p class="en">Tell me, O Muse, of the man of many devices</p>
        <p class="cite">Odyssey 1.1 · translated by A. T. Murray, 1919</p>
      </div>
      <div class="prose">
        <p>A rhapsode recited Homer from memory, one book at a time, to whoever came to listen. The word means “one who stitches songs together”, and the books of the Iliad and the Odyssey are still called rhapsodies.</p>
        <p>This one does the same work with your files. It stitches them into books with chapters, covers and series, and recites them to any app that speaks Audiobookshelf.</p>
      </div>
    </section>

    <section class="block">
      <h2>What it does</h2>
      <div class="groups">
        <div class="group">
          <h3>Listen anywhere</h3>
          <ul>
            <li><strong>Works with any Audiobookshelf app.</strong> It speaks the same API, and is tested with Pholia, ShelfPlayer and the Audiobookshelf web app.</li>
            <li>Your place is saved as you listen and picks up on any device.</li>
            <li>Everyone in the library keeps their own progress and their own podcasts.</li>
          </ul>
        </div>
        <div class="group">
          <h3>Your storage</h3>
          <ul>
            <li><strong>pCloud, any S3-compatible bucket, a NAS over WebDAV, or a public link.</strong> Several in one library.</li>
            <li>Reads chapters, covers and series straight from m4b, mp3 and Opus files.</li>
            <li>Nothing is converted, moved or rewritten.</li>
          </ul>
        </div>
        <div class="group">
          <h3>Podcasts</h3>
          <ul>
            <li><strong>Subscribe by search, feed address or OPML.</strong> Feeds are checked every hour.</li>
            <li>Chapters and transcripts from the feed, and a notification in Pholia when a show you follow has a new episode.</li>
            <li>Archives episodes to pCloud, and finds the ads a host stitches in so Pholia can skip them.</li>
          </ul>
        </div>
        <div class="group">
          <h3>Nothing to run</h3>
          <ul>
            <li><strong>One Cloudflare Worker, with D1 and R2.</strong></li>
            <li>No container to patch, update or keep online.</li>
            <li>It began as a fallback for a home server that kept going down.</li>
          </ul>
        </div>
      </div>
    </section>
  </main>

  <footer>
    <span>Rhapsode speaks the Audiobookshelf API. It is not made by or affiliated with the Audiobookshelf project.</span>
    <nav aria-label="Footer">
      <a href="https://pholia.jderrick.app">Pholia</a>
      <a href="/audiobookshelf">Web player</a>
      <a href="/admin">Sign in</a>
    </nav>
  </footer>
</div>

<script>
(function () {
  // The Odyssey's 24 books, spaced by their length in lines; three files of a 12:09:29 recording.
  var lines = [444, 434, 497, 847, 493, 331, 347, 586, 566, 574, 640, 453, 440, 533, 557, 481, 606, 428, 604, 394, 434, 501, 372, 548];
  var letters = 'αβγδεζηθικλμνξοπρστυφχψω'.split('');
  var files = [{ name: 'part1.mp3', sec: 14497 }, { name: 'part2.mp3', sec: 14292 }, { name: 'part3.mp3', sec: 14980 }];
  var total = files.reduce(function (a, f) { return a + f.sec; }, 0);
  var totalLines = lines.reduce(function (a, n) { return a + n; }, 0);

  var starts = [], acc = 0;
  lines.forEach(function (n) { starts.push(acc / totalLines); acc += n; });
  var fileStarts = [], fa = 0;
  files.forEach(function (f) { fileStarts.push(fa / total); fa += f.sec; });

  var loom = document.getElementById('loom');
  var ticks = document.getElementById('ticks');
  var track = document.getElementById('track');
  var filesRow = document.getElementById('files');
  var thread = track.querySelector('.thread');

  function hms(s) {
    s = Math.round(s);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return h + ':' + String(m).padStart(2, '0') + ':' + String(x).padStart(2, '0');
  }

  starts.forEach(function (p, i) {
    var t = document.createElement('span');
    t.className = 'tick';
    t.style.left = (p * 100) + '%';
    t.textContent = letters[i];
    ticks.appendChild(t);
  });
  var tickEls = ticks.children;

  files.forEach(function (f) {
    var seg = document.createElement('div');
    seg.className = 'seg';
    seg.style.flex = f.sec + ' 1 0';
    var played = document.createElement('div');
    played.className = 'played';
    seg.appendChild(played);
    track.insertBefore(seg, thread);
    var lab = document.createElement('div');
    lab.style.flex = f.sec + ' 1 0';
    lab.innerHTML = f.name + '<br>' + hms(f.sec);
    filesRow.appendChild(lab);
  });
  var segs = track.querySelectorAll('.seg');
  starts.slice(1).forEach(function (p) {
    var l = document.createElement('div');
    l.className = 'chline';
    l.style.left = (p * 100) + '%';
    track.appendChild(l);
  });
  fileStarts.slice(1).forEach(function (p) {
    var s = document.createElement('div');
    s.className = 'seam';
    s.style.left = (p * 100) + '%';
    s.innerHTML = '<svg viewBox="0 0 16 56" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">' +
      '<path d="M3 6 L13 16 M13 6 L3 16"/><path d="M3 23 L13 33 M13 23 L3 33"/><path d="M3 40 L13 50 M13 40 L3 50"/></svg>';
    track.appendChild(s);
  });

  var pos = 0.31, last = -1;
  function render() {
    loom.style.setProperty('--p', (pos * 100) + '%');
    segs.forEach(function (seg, i) {
      var a = fileStarts[i], b = i + 1 < fileStarts.length ? fileStarts[i + 1] : 1;
      var w = Math.max(0, Math.min(1, (pos - a) / (b - a)));
      seg.firstChild.style.width = (w * 100) + '%';
    });
    var ch = 0;
    for (var i = 0; i < starts.length; i++) if (starts[i] <= pos) ch = i;
    var fi = 0;
    for (var j = 0; j < fileStarts.length; j++) if (fileStarts[j] <= pos) fi = j;
    if (ch !== last) {
      if (last >= 0) tickEls[last].classList.remove('is-current');
      tickEls[ch].classList.add('is-current');
      document.getElementById('r-letter').textContent = letters[ch];
      document.getElementById('r-chapter').textContent = 'Book ' + (ch + 1);
      last = ch;
    }
    document.getElementById('r-time').textContent = hms(pos * total) + ' / ' + hms(total);
    document.getElementById('r-file').textContent = 'playing ' + files[fi].name;
    track.setAttribute('aria-valuenow', String(Math.round(pos * total)));
    track.setAttribute('aria-valuetext', 'Book ' + (ch + 1) + ', ' + hms(pos * total));
  }

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var SWEEP_MS = 60000, prev = null;
  function frame(ts) {
    if (prev !== null) pos = (pos + (ts - prev) / SWEEP_MS) % 1;
    prev = ts;
    render();
    requestAnimationFrame(frame);
  }

  function seekFrom(e) {
    var r = track.getBoundingClientRect();
    pos = Math.max(0, Math.min(0.9999, (e.clientX - r.left) / r.width));
    render();
  }
  var dragging = false;
  track.addEventListener('pointerdown', function (e) { dragging = true; try { track.setPointerCapture(e.pointerId); } catch (err) {} seekFrom(e); });
  track.addEventListener('pointermove', function (e) { if (dragging) seekFrom(e); });
  track.addEventListener('pointerup', function () { dragging = false; });
  track.addEventListener('pointercancel', function () { dragging = false; });
  track.addEventListener('keydown', function (e) {
    var ch = last;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') ch = Math.min(starts.length - 1, ch + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') ch = Math.max(0, ch - 1);
    else if (e.key === 'Home') ch = 0;
    else if (e.key === 'End') ch = starts.length - 1;
    else return;
    e.preventDefault();
    pos = starts[ch] + 0.0005;
    render();
  });

  render();
  if (!reduce) requestAnimationFrame(frame);
})();
</script>
</body>
</html>`;
