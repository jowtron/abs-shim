#!/usr/bin/env python3
"""sync — back up Audible titles into the pCloud audiobook library.

stdin:  {"account": "joseph", "asins": ["B0..", ...] | "all",
         "dest_root": "Public Folder/audiobooks", "force": false, "quality": "best"}
stdout: {"ok": true, "done": [{asin, title, path, bytes}], "failed": [{asin, title, error}], "skipped": [asin...]}

Per title, sequentially (one slot, ~1 GB of scratch at a time):
  1. audible-cli download: aaxc (with voucher) or aax fallback, 1215px
     cover, flat chapter JSON, into data/dl/<account>/<asin>/
  2. ffmpeg: decrypt (aaxc key/iv from the voucher, or the account's
     activation bytes for aax) and remux — no re-encode — to a fast-start
     m4b with the library's tags, chapters written as an ffmetadata file
     (so they land as a Nero chpl atom, which the shim's prober reads),
     and the cover attached
  3. rclone copyto → pcloud:<dest_root>/Audible/<account>/<Title - Author>/<Title>.m4b
  4. record in data/synced/<account>.json, delete the working dir

Progress goes to stderr (the shim tails the job log); the result JSON is
the last line on stdout. Titles already in synced.json are skipped unless
force=true. Audible's own download step is where time goes: a 20 h book
is ~600 MB and Audible throttles, so budget minutes per title.
"""
import json
import os
import shutil
import subprocess
import sys
import time
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


def activation_bytes(account):
    r = L.run(["audible", "-P", account, "activation-bytes"], timeout=120)
    if r.returncode != 0:
        raise RuntimeError(f"activation-bytes failed: {(r.stderr or r.stdout).strip()[-300:]}")
    ab = [ln.strip() for ln in r.stdout.splitlines() if ln.strip()][-1]
    if len(ab) != 8:
        raise RuntimeError(f"unexpected activation bytes output: {ab!r}")
    return ab


def sync_one(account, item, dest_root, quality):
    asin = item["asin"]
    work = L.DL_DIR / account / asin
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    L.log(f"[{asin}] downloading “{item.get('title')}”…")
    cmd = ["audible", "-P", account, "download", "--asin", asin, "--aax-fallback", "--cover", "--cover-size", "1215",
           "--chapter", "--chapter-type", "flat", "-q", quality, "-o", str(work), "-y", "--no-progress",
           "--filename-mode", "asin_ascii", "--timeout", "120"]
    r = L.run(cmd, timeout=DOWNLOAD_TIMEOUT)
    audio = [p for p in work.iterdir() if p.suffix.lower() in AUDIO_EXTS]
    if r.returncode != 0 and not audio:
        raise RuntimeError(f"download failed: {(r.stderr or r.stdout).strip()[-400:]}")
    if not audio:
        raise RuntimeError("download produced no audio file: " + (r.stdout or "").strip()[-300:])
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

    # Keep Audible backups apart from everything else in the library:
    # <root>/Audible/<account>/<Title - Author>/<Title>.m4b (Joseph's ask,
    # 2026-09-02). The scanner walks subfolders, so the nesting is free.
    dest = f"pcloud:{dest_root.strip('/')}/Audible/{account}/{folder}/{out.name}"
    r = L.run(["rclone", "copyto", str(out), dest, "--retries", "5", "--low-level-retries", "20", "--stats", "0"], timeout=3 * 3600)
    if r.returncode != 0:
        raise RuntimeError(f"rclone upload failed: {(r.stderr or '').strip()[-300:]}")
    rel = f"Audible/{account}/{folder}/{out.name}"
    rec = {"path": rel, "bytes": out.stat().st_size, "at": int(time.time() * 1000), "chapters": len(chapters)}
    synced_path = L.SYNCED_DIR / f"{account}.json"
    synced = L.load_json(synced_path, {})
    synced[asin] = rec
    L.save_json(synced_path, synced)
    shutil.rmtree(work, ignore_errors=True)
    L.log(f"[{asin}] done → {rel}")
    return rec


args = L.read_args()
account = L.check_account(args.get("account"))
if account not in L.accounts():
    L.fail(f"unknown account '{account}'")
dest_root = str(args.get("dest_root") or "").strip("/ ")
if not dest_root:
    L.fail("dest_root required (pCloud path of the audiobook library, e.g. 'Public Folder/audiobooks')")
quality = args.get("quality") or "best"
force = bool(args.get("force"))
lib = L.load_json(L.LIBRARY_DIR / f"{account}.json", {})
by_asin = {i["asin"]: i for i in lib.get("items", []) if i.get("asin")}
if not by_asin:
    L.fail("no cached library for this account — fetch the library first")
want = args.get("asins")
asins = list(by_asin) if want == "all" or want is None else [a for a in want if isinstance(a, str)]
synced = L.load_json(L.SYNCED_DIR / f"{account}.json", {})

done, failed, skipped = [], [], []
L.log(f"sync {account}: {len(asins)} title(s) → pcloud:{dest_root}")
for n, asin in enumerate(asins, 1):
    item = by_asin.get(asin)
    if not item:
        failed.append({"asin": asin, "title": None, "error": "not in this account's library"})
        continue
    if asin in synced and not force:
        skipped.append(asin)
        continue
    if item.get("content_type") == "Podcast":
        failed.append({"asin": asin, "title": item.get("title"), "error": "podcast parents aren't downloadable as one file"})
        continue
    L.log(f"({n}/{len(asins)})")
    try:
        rec = sync_one(account, item, dest_root, quality)
        done.append({"asin": asin, "title": item.get("title"), **rec})
    except subprocess.TimeoutExpired:
        failed.append({"asin": asin, "title": item.get("title"), "error": "timed out"})
        L.log(f"[{asin}] timed out")
    except Exception as e:  # noqa: BLE001
        failed.append({"asin": asin, "title": item.get("title"), "error": str(e)[:400]})
        L.log(f"[{asin}] FAILED: {e}")
L.log(f"finished: {len(done)} synced, {len(failed)} failed, {len(skipped)} already there")
L.emit({"ok": True, "account": account, "done": done, "failed": failed, "skipped": skipped})
