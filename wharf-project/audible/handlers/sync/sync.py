#!/usr/bin/env python3
"""sync — back up Audible titles into a Rhapsode library's own storage.

stdin:  {"account": "t-3f2a…", "asins": ["B0..", ...] | "all", "force": false, "quality": "best",
         "path_prefix": "Audible/mum",
         "deliver": {"url": "https://rhapsode…/api/audible-node/staged", "sync": "as_…", "token": "…"}}
stdout: {"ok": true, "done": [{asin, title, path, bytes}], "failed": [{asin, title, error}], "skipped": [asin...]}

`account` is the node's name for the account (Rhapsode maps each library's
own names to these), `path_prefix` the library's folder for it.

Per title, sequentially (~1 GB of scratch at a time):
  1. audible-cli download: aaxc (with voucher), else aax, 1215px
     cover, flat chapter JSON, into data/dl/<account>/<asin>/
  2. ffmpeg: decrypt (aaxc key/iv from the voucher, or the account's
     activation bytes for aax) and remux — no re-encode — to a fast-start
     m4b with the library's tags, chapters written as an ffmetadata file
     (so they land as a Nero chpl atom, which the shim's prober reads),
     and the cover attached
  3. rclone copyto → r2:abs-shim-audible-staging/<account>/<asin>/<Title>.m4b
  4. POST it to deliver.url; Rhapsode copies it into the library's own
     storage with the library's own credentials, registers it and deletes
     the staged copy (ABS_shim src/lib/audible-delivery.ts). Until
     2026-10-15 this step was a pCloud pull with the instance owner's rclone
     token, which put every library's books in his pCloud.
  5. record in data/synced/<account>.json, delete the working dir

Progress goes to stderr (the shim tails the job log); the result JSON is
the last line on stdout. Titles already in synced.json are skipped unless
force=true. A 20 h book is ~600 MB: about a minute to download as AAXC
on stereo-au, ten as AAX; the R2 upload (stereo-au's ~14 Mbit/s up) is
then the slow step.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# wharf copies an approved handler to state/registered/<project>/<name>/,
# so locate the shared lib from the working dir (the project dir), not __file__.
sys.path.insert(0, os.path.join(os.getcwd(), "handlers", "_lib"))
sys.path.insert(0, "/srv/wharf/projects/audible/handlers/_lib")
import audiblelib as L  # noqa: E402

L.ensure_venv()

DOWNLOAD_TIMEOUT = 3 * 3600
AUDIO_EXTS = (".aaxc", ".aax")


def ffmeta_escape(s):
    return str(s).replace("\\", "\\\\").replace("=", "\\=").replace(";", "\\;").replace("#", "\\#").replace("\n", " ")


def chapters_from_json(path):
    """audible-cli flat chapter JSON → [(start_ms, end_ms, title)]."""
    d = L.load_json(path, {}) if path else {}
    info = ((d.get("content_metadata") or {}).get("chapter_info")) or d.get("chapter_info") or {}
    chaps = info.get("chapters") or []
    out = []
    for c in chaps:
        s = int(c.get("start_offset_ms") or 0)
        e = s + int(c.get("length_ms") or 0)
        if e > s:
            out.append((s, e, c.get("title") or f"Chapter {len(out) + 1}"))
    return out


def write_ffmeta(path, item, chapters):
    lines = [";FFMETADATA1"]
    tags = {
        "title": item.get("title"),
        "album": item.get("title"),
        "artist": ", ".join(item.get("authors") or []),
        "album_artist": ", ".join(item.get("authors") or []),
        "composer": ", ".join(item.get("narrators") or []),
        "date": (item.get("release_date") or "")[:4],
        "comment": f"Audible {item.get('asin')}",
        "genre": "Audiobook",
    }
    if item.get("series"):
        tags["grouping"] = item["series"] + (f", Book {item['series_sequence']}" if item.get("series_sequence") else "")
        tags["series"] = item["series"]
        if item.get("series_sequence"):
            tags["series-part"] = str(item["series_sequence"])
    if item.get("subtitle"):
        tags["subtitle"] = item["subtitle"]
    for k, v in tags.items():
        if v:
            lines.append(f"{k}={ffmeta_escape(v)}")
    for s, e, t in chapters:
        lines += ["", "[CHAPTER]", "TIMEBASE=1/1000", f"START={s}", f"END={e}", f"title={ffmeta_escape(t)}"]
    Path(path).write_text("\n".join(lines) + "\n", encoding="utf-8")


PROGRESS_RE = re.compile(r"(\d{1,3})%\|[^|]*\|\s*([\d.]+\s*[KMGT]?i?B?)/([\d.]+\s*[KMGT]?i?B?)(?:\s*\[([^\]]*)\])?")


def run_download(cmd, timeout):
    """Run audible-cli's download with its progress bar on, and turn the
    bar's redraws (\r-separated on stderr) into one log line every ~10 s or
    5 %: "  42% · 252 MB / 600 MB · 8.7MB/s, 00:40 left". Returns
    (returncode, tail_of_output)."""
    p = subprocess.Popen(cmd, cwd=str(L.PROJECT), env=L.env(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    tail, buf, last_t, last_pct = [], "", 0.0, -100
    deadline = time.time() + timeout
    while True:
        ch = p.stdout.read(1)
        if ch == "":
            break
        if ch in "\r\n":
            line, buf = buf.strip(), ""
            if not line:
                continue
            m = PROGRESS_RE.search(line)
            if m:
                pct = int(m.group(1))
                now = time.time()
                if pct >= last_pct + 5 or now - last_t >= 10 or pct == 100:
                    extra = (m.group(4) or "").strip()
                    rate = extra.split(",")[-1].strip() if "," in extra else extra
                    eta = extra.split("<")[1].split(",")[0] if "<" in extra else ""
                    L.log(f"  {pct:3d}% · {m.group(2).strip()} / {m.group(3).strip()}" + (f" · {rate}" if rate else "") + (f", {eta} left" if eta else ""))
                    last_t, last_pct = now, pct
            else:
                tail.append(line)
                tail = tail[-30:]
        else:
            buf += ch
        if time.time() > deadline:
            p.kill()
            raise subprocess.TimeoutExpired(cmd, timeout)
    p.wait()
    return p.returncode, "\n".join(tail)


# --stats-one-line prints "123 MiB / 797 MiB, 15%, 1.2 MiB/s, ETA 8m" (no "Transferred:" label).
RCLONE_STATS_RE = re.compile(r"([\d.]+\s*[KMGT]?i?B?)\s*/\s*([\d.]+\s*[KMGT]?i?B?),\s*(\d+)%,\s*([\d.]+\s*[KMGT]?i?B/s),\s*ETA\s*(\S+)")


def run_rclone(args, timeout, label):
    """rclone with --stats on stderr, turned into a log line every ~15 s."""
    cmd = ["rclone", *args, "--stats", "15s", "--stats-one-line", "--stats-log-level", "NOTICE", "--log-level", "NOTICE"]
    p = subprocess.Popen(cmd, cwd=str(L.PROJECT), env=L.env(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    tail, deadline = [], time.time() + timeout
    for line in p.stdout:
        line = line.rstrip()
        m = RCLONE_STATS_RE.search(line)
        if m:
            L.log(f"  {label} {m.group(3):>3}% · {m.group(1).strip()} / {m.group(2).strip()} · {m.group(4)}, ETA {m.group(5)}")
        elif line:
            tail.append(line)
            tail = tail[-20:]
        if time.time() > deadline:
            p.kill()
            raise subprocess.TimeoutExpired(cmd, timeout)
    p.wait()
    return p.returncode, "\n".join(tail)


def rclone_has_remote(name):
    try:
        return f"[{name}]" in Path(L.RCLONE_CONF).read_text().splitlines()
    except OSError:
        return False


STAGING_BUCKET = "abs-shim-audible-staging"
# Cloudflare in front of the shim refuses Python-urllib's own User-Agent.
UA = "rhapsode-audible-node/1"


class DeliveryRefused(RuntimeError):
    """Rhapsode answered 4xx: retrying the same notice won't help."""
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code


def post_deliver(deliver, payload, timeout=60):
    """POST a notice to Rhapsode; retries a dropped connection or a 5xx."""
    body = json.dumps({"sync": deliver["sync"], **payload}).encode()
    req = urllib.request.Request(deliver["url"], data=body, method="POST", headers={
        "Content-Type": "application/json", "Authorization": f"Bearer {deliver['token']}", "User-Agent": UA,
    })
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:300]
            if 400 <= e.code < 500:
                raise DeliveryRefused(e.code, f"Rhapsode refused it ({e.code}): {detail}") from e
            last = f"HTTP {e.code}: {detail}"
        except Exception as e:  # noqa: BLE001 — network: retry
            last = str(e)
        if attempt < 4:
            time.sleep(5 * 2 ** attempt)
    raise RuntimeError(f"couldn't reach Rhapsode: {last}")


def stage_and_deliver(deliver, account, asin, item, out, folder):
    """Stage the m4b in R2 (fast from anywhere) and hand it to Rhapsode,
    which has the library's own storage credentials; the slow box→pCloud
    leg (37 KB/s from stereo-au, 2026-09-03) never happens."""
    key = f"{account}/{asin}/{out.name}"
    size = out.stat().st_size
    L.log(f"[{asin}] staging in R2…")
    rc, tail = run_rclone(["copyto", str(out), f"r2:{STAGING_BUCKET}/{key}", "--s3-upload-concurrency", "4", "--s3-chunk-size", "16M", "--retries", "5"], 3 * 3600, "R2")
    if rc != 0:
        raise RuntimeError(f"R2 upload failed: {tail[-300:]}")
    return post_deliver(deliver, {"asin": asin, "title": item.get("title"), "folder": folder, "file": out.name, "key": key, "bytes": size})


def activation_bytes(account):
    r = L.run(["audible", "-P", account, "activation-bytes"], timeout=120)
    if r.returncode != 0:
        raise RuntimeError(f"activation-bytes failed: {(r.stderr or r.stdout).strip()[-300:]}")
    ab = [ln.strip() for ln in r.stdout.splitlines() if ln.strip()][-1]
    if len(ab) != 8:
        raise RuntimeError(f"unexpected activation bytes output: {ab!r}")
    return ab


def download_cmd(account, asin, fmt, quality, work):
    return ["audible", "-P", account, "download", "--asin", asin, fmt, "--cover", "--cover-size", "1215",
            "--chapter", "--chapter-type", "flat", "-q", quality, "-o", str(work), "-y",
            "--filename-mode", "asin_ascii", "--timeout", "120"]


def sync_one(account, item, deliver, path_prefix, quality):
    asin = item["asin"]
    work = L.DL_DIR / account / asin
    work.mkdir(parents=True, exist_ok=True)
    # A previous attempt's download (killed mid-upload, say) is reused
    # rather than fetched again; only the finished m4b is rebuilt.
    audio = [p for p in work.iterdir() if p.suffix.lower() in AUDIO_EXTS]
    for old_m4b in work.glob("*.m4b"):
        old_m4b.unlink()
    if audio:
        L.log(f"[{asin}] reusing downloaded {audio[0].name}")
        rc, out_tail = 0, ""
    else:
        L.log(f"[{asin}] downloading “{item.get('title')}”…")
        # AAXC first, AAX only when no .aaxc came back (a title not offered
        # as AAXC, or one whose licence is plain MP3, as podcasts' are).
        # Audible's AAX server gives ~12 Mbit/s per connection from any box
        # (2026-10-15: 9.2 Mbit/s over 109 titles on stereo-au, 11.9 on a
        # 1 Gbit/s VPS) while its AAXC CDN gave 70 on stereo-au and 134 on
        # the VPS, so audible-cli's --aax-fallback (AAX first) cost ~6 min a
        # title. audible-cli has no AAXC-then-AAX flag, hence two runs.
        # A download lands under its final name only when complete (.tmp /
        # .resume until then), so an .aaxc here is a whole file.
        rc, out_tail = run_download(download_cmd(account, asin, "--aaxc", quality, work), DOWNLOAD_TIMEOUT)
        if not any(p.suffix.lower() == ".aaxc" for p in work.iterdir()):
            for p in work.iterdir():
                if p.suffix.lower() in (".mp3", ".voucher"):
                    p.unlink()
            why = (out_tail.strip().splitlines() or [f"exit {rc}"])[-1][-200:]
            L.log(f"[{asin}] no AAXC ({why}); trying AAX…")
            rc, out_tail = run_download(download_cmd(account, asin, "--aax", quality, work), DOWNLOAD_TIMEOUT)
        audio = [p for p in work.iterdir() if p.suffix.lower() in AUDIO_EXTS]
    if rc != 0 and not audio:
        raise RuntimeError(f"download failed: {out_tail[-400:]}")
    if not audio:
        raise RuntimeError("download produced no audio file: " + out_tail[-300:])
    src = audio[0]
    size_mb = src.stat().st_size / 1024 / 1024
    L.log(f"[{asin}] got {src.name} ({size_mb:.0f} MB); decrypting…")

    dec = []
    if src.suffix.lower() == ".aaxc":
        vouchers = list(work.glob("*.voucher"))
        if not vouchers:
            raise RuntimeError("aaxc without a voucher file")
        v = L.load_json(vouchers[0], {})
        lic = ((v.get("content_license") or {}).get("license_response")) or {}
        if not lic.get("key") or not lic.get("iv"):
            raise RuntimeError("voucher has no key/iv")
        dec = ["-audible_key", lic["key"], "-audible_iv", lic["iv"]]
    else:
        dec = ["-activation_bytes", activation_bytes(account)]

    chap_json = next(iter(work.glob("*chapters.json")), None)
    chapters = chapters_from_json(chap_json)
    ffmeta = work / "meta.txt"
    write_ffmeta(ffmeta, item, chapters)
    cover = next(iter(sorted(work.glob("*.jpg"))), None)

    title = L.safe_name(item.get("title") or asin)
    author = L.safe_name(", ".join(item.get("authors") or []) or "Unknown Author", 60)
    folder = L.safe_name(f"{title} - {author}", 150)
    out = work / f"{title}.m4b"
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *dec, "-i", str(src), "-i", str(ffmeta)]
    if cover:
        cmd += ["-i", str(cover)]
    cmd += ["-map_metadata", "1", "-map_chapters", "1", "-map", "0:a"]
    if cover:
        cmd += ["-map", "2:v", "-c:v", "copy", "-disposition:v:0", "attached_pic"]
    cmd += ["-c:a", "copy", "-movflags", "+faststart", "-f", "mp4", str(out)]
    r = L.run(cmd, timeout=1800)
    if r.returncode != 0 or not out.exists():
        raise RuntimeError(f"ffmpeg failed: {(r.stderr or '').strip()[-400:]}")
    L.log(f"[{asin}] m4b ready ({out.stat().st_size / 1024 / 1024:.0f} MB, {len(chapters)} chapters); uploading…")

    # Audible backups sit apart from everything else in the library:
    # <root>/Audible/<account>/<Title - Author>/<Title>.m4b (Joseph's ask,
    # 2026-09-02); Rhapsode builds that path from `folder` and the file name.
    r = stage_and_deliver(deliver, account, asin, item, out, folder)
    # Rhapsode may add the ASIN to the folder name when another title of the
    # library already has "Title - Author".
    rel = r.get("relPath") or f"{path_prefix}/{folder}/{out.name}"
    rec = {"path": rel, "bytes": out.stat().st_size, "at": int(time.time() * 1000), "chapters": len(chapters), "delivery": r.get("id")}
    synced_path = L.SYNCED_DIR / f"{account}.json"
    synced = L.load_json(synced_path, {})
    synced[asin] = rec
    L.save_json(synced_path, synced)
    shutil.rmtree(work, ignore_errors=True)
    # Not "done →": the old /admin scanned the library on that line, and the
    # book isn't in the library until Rhapsode's copy lands.
    L.log(f"[{asin}] handed to Rhapsode → {rel}")
    return rec


args = L.read_args()
account = L.check_account(args.get("account"))
if account not in L.accounts():
    L.fail(f"unknown account '{account}'")
deliver = args.get("deliver") or {}
if not all(isinstance(deliver.get(k), str) and deliver.get(k) for k in ("url", "sync", "token")):
    L.fail("deliver {url, sync, token} required (this handler only hands books to Rhapsode)")
path_prefix = str(args.get("path_prefix") or "").strip("/ ")
if not path_prefix:
    L.fail("path_prefix required")
if not rclone_has_remote("r2"):
    L.fail("no r2 remote in data/rclone.conf (books are staged there)")
quality = args.get("quality") or "best"
force = bool(args.get("force"))
# Titles Rhapsode accepted earlier but couldn't copy into storage: synced
# here, not there, so they go again.
redo = {a for a in (args.get("redo") or []) if isinstance(a, str)}
lib = L.load_json(L.LIBRARY_DIR / f"{account}.json", {})
by_asin = {i["asin"]: i for i in lib.get("items", []) if i.get("asin")}
if not by_asin:
    L.fail("no cached library for this account — fetch the library first")
want = args.get("asins")
asins = list(by_asin) if want == "all" or want is None else [a for a in want if isinstance(a, str)]
synced = L.load_json(L.SYNCED_DIR / f"{account}.json", {})

# Check Rhapsode will take the books before downloading anything: a title
# costs ~13 minutes of download before it gets to hand anything over.
if any(force or a not in synced or a in redo for a in asins):
    try:
        post_deliver(deliver, {"ping": True}, timeout=30)
    except RuntimeError as e:
        L.fail(f"Rhapsode delivery check: {e}")
    L.log("Rhapsode delivery OK")

done, failed, skipped = [], [], []
stopped = None
L.log(f"sync: {len(asins)} title(s) → {path_prefix}")
for n, asin in enumerate(asins, 1):
    item = by_asin.get(asin)
    if not item:
        failed.append({"asin": asin, "title": None, "error": "not in this account's library"})
        continue
    if asin in synced and not force and asin not in redo:
        skipped.append(asin)
        continue
    if item.get("content_type") == "Podcast":
        failed.append({"asin": asin, "title": item.get("title"), "error": "podcast parents aren't downloadable as one file"})
        continue
    L.log(f"({n}/{len(asins)})")
    try:
        rec = sync_one(account, item, deliver, path_prefix, quality)
        done.append({"asin": asin, "title": item.get("title"), **rec})
    except subprocess.TimeoutExpired:
        failed.append({"asin": asin, "title": item.get("title"), "error": "timed out"})
        L.log(f"[{asin}] timed out")
    except DeliveryRefused as e:
        # A refused sync token refuses every later title too.
        failed.append({"asin": asin, "title": item.get("title"), "error": str(e)[:400]})
        L.log(f"[{asin}] FAILED: {e}")
        if e.code == 401:
            stopped = str(e)
            L.log(f"stopping: {len(asins) - n} title(s) not attempted")
            break
    except Exception as e:  # noqa: BLE001
        failed.append({"asin": asin, "title": item.get("title"), "error": str(e)[:400]})
        L.log(f"[{asin}] FAILED: {e}")
L.log(f"finished: {len(done)} handed over, {len(failed)} failed, {len(skipped)} already there")
L.emit({"ok": True, "account": account, "done": done, "failed": failed, "skipped": skipped, "stopped": stopped})
