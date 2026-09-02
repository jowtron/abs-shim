#!/usr/bin/env python3
"""Resize AudioBookBay catalogue covers locally and push them to the shim.

Workers can't resize images, and Cloudflare's transformation service costs
money past 5,000 a month, so this runs on a Mac (or any box with Pillow):

  1. asks the shim for posts whose cover isn't cached yet
     (GET /api/admin/abb/catalog/covers/pending — the shim tracks what is
     done: cover_r2 set = cached, cover_error set = gave up, else pending)
  2. downloads each cover from its image host
  3. fits it inside --max px (never upscales) and saves a webp at --quality
  4. PUTs the webp to /api/admin/abb/catalog/covers/<id>; the shim stores it
     in R2 and serves it at /public/abb-cover/<id>.webp

Preview quality without uploading:

  python3 scripts/abb-covers.py --server https://abs-shim.jderrick.app \
      --user root --sample 12 --quality 30,45,60 --out ./cover-samples

One pass (re-runnable; only pending covers are fetched):

  python3 scripts/abb-covers.py --server https://abs-shim.jderrick.app \
      --user root --quality 30 --upload

Background runner (what "ABB Covers.command" launches): keeps going,
sleeping --every minutes between passes, and simply retries after any
network hiccup — closing the lid pauses the process, reopening resumes it:

  python3 scripts/abb-covers.py --server https://abs-shim.jderrick.app \
      --user root --quality 30 --loop

Credentials: --pass, the ABS_SHIM_PASS env var, or the macOS Keychain
(--keychain, default in --loop mode: asked once, stored under the service
name "abs-shim-covers", read back on every start). The 30-day shim token
is re-minted automatically on a 401. Needs Pillow (pip3 install Pillow).
"""
import argparse
import getpass
import io
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    sys.exit("Pillow is required: pip3 install Pillow")

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
KEYCHAIN_SERVICE = "abs-shim-covers"


class Unauthorized(Exception):
    pass


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


# ─── shim API ────────────────────────────────────────────────────────────────

def api(server, token, path, method="GET", body=None, content_type="application/json"):
    req = urllib.request.Request(server + path, method=method)
    req.add_header("Authorization", "Bearer " + token)
    if body is not None:
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        req.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(req, body, timeout=60) as r:
            data = r.read()
            return json.loads(data) if data else None
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise Unauthorized() from e
        raise


def login(server, user, password):
    req = urllib.request.Request(server + "/login", method="POST", data=json.dumps({"username": user, "password": password}).encode())
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)["user"]["token"]


# ─── macOS Keychain ─────────────────────────────────────────────────────────

def keychain_get(user):
    try:
        out = subprocess.run(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", user, "-w"],
                             capture_output=True, text=True, check=True)
        return out.stdout.rstrip("\n")
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def keychain_set(user, password):
    subprocess.run(["security", "add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", user, "-w", password],
                   check=True, capture_output=True)


class Session:
    """Token holder that re-logs-in on 401."""

    def __init__(self, server, user, password):
        self.server, self.user, self.password = server, user, password
        self.token = login(server, user, password)

    def call(self, path, method="GET", body=None, content_type="application/json"):
        try:
            return api(self.server, self.token, path, method, body, content_type)
        except Unauthorized:
            log("token rejected — logging in again")
            self.token = login(self.server, self.user, self.password)
            return api(self.server, self.token, path, method, body, content_type)


# ─── images ─────────────────────────────────────────────────────────────────

def fetch_image(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://audiobookbay.lu/"})
    with urllib.request.urlopen(req, timeout=20) as r:
        if r.status != 200:
            raise RuntimeError(f"HTTP {r.status}")
        data = r.read(8 * 1024 * 1024)
    if len(data) < 100:
        raise RuntimeError("empty response")
    return data


def to_webp(data, max_px, quality):
    im = Image.open(io.BytesIO(data))
    im.load()
    if im.mode not in ("RGB", "L"):
        im = im.convert("RGB")
    if im.width > max_px or im.height > max_px:   # downscale only, never upscale
        im.thumbnail((max_px, max_px), Image.LANCZOS)
    out = io.BytesIO()
    im.save(out, "WEBP", quality=quality, method=6)
    return out.getvalue(), im.size


# ─── passes ─────────────────────────────────────────────────────────────────

def sample(sess, args, qualities):
    os.makedirs(args.out, exist_ok=True)
    pending = sess.call(f"/api/admin/abb/catalog/covers/pending?limit={args.sample}")["pending"]
    for p in pending:
        try:
            data = fetch_image(p["url"])
        except Exception as e:  # noqa: BLE001
            print(f"{p['id']}: download failed ({e})")
            continue
        ext = os.path.splitext(p["url"].split("?")[0])[1] or ".img"
        with open(os.path.join(args.out, f"{p['id']}-original{ext}"), "wb") as f:
            f.write(data)
        sizes = [f"orig {len(data) // 1024} KB"]
        for q in qualities:
            webp, dims = to_webp(data, args.max, q)
            with open(os.path.join(args.out, f"{p['id']}-q{q}.webp"), "wb") as f:
                f.write(webp)
            sizes.append(f"q{q} {len(webp) // 1024} KB {dims[0]}x{dims[1]}")
        print(f"{p['id']}: {' | '.join(sizes)}  — {p['title'][:60]}")
    print(f"\nSamples in {args.out}. Re-run with --quality <pick> --upload when happy.")


def one_pass(sess, args, quality, limit):
    """Process pending covers until none are left (or `limit`). Returns (done, failed)."""
    done = failed = 0
    t0 = time.time()
    while done + failed < limit:
        st = sess.call(f"/api/admin/abb/catalog/covers/pending?limit={min(args.batch, limit - done - failed)}")
        pending = st["pending"]
        if not pending:
            break
        log(f"[{st['cached']}/{st['withCover']} cached, {st['failed']} failed] processing {len(pending)}…")

        def work(p):
            try:
                data = fetch_image(p["url"])
                webp, _dims = to_webp(data, args.max, quality)
                sess.call(f"/api/admin/abb/catalog/covers/{p['id']}", "PUT", webp, "image/webp")
                return True, len(webp)
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                # Could be our network (lid just opened) rather than the cover: leave it pending.
                return None, str(e)[:180]
            except Exception as e:  # noqa: BLE001
                msg = str(e)[:180]
                try:
                    sess.call(f"/api/admin/abb/catalog/covers/{p['id']}/error", "POST", {"error": msg})
                except Exception:  # noqa: BLE001
                    pass
                return False, msg

        skipped = 0
        with ThreadPoolExecutor(max_workers=args.workers) as ex:
            for p, (ok, info) in zip(pending, ex.map(work, pending)):
                if ok:
                    done += 1
                elif ok is None:
                    skipped += 1
                else:
                    failed += 1
                    log(f"  {p['id']} failed: {info}")
        log(f"  ok {done}, failed {failed}, {time.time() - t0:.0f}s")
        if skipped == len(pending):
            # Everything hit the network — don't spin, let the caller sleep.
            raise ConnectionError("network unavailable")
    return done, failed


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--server", required=True, help="shim origin, e.g. https://abs-shim.jderrick.app")
    ap.add_argument("--user", required=True)
    ap.add_argument("--pass", dest="password", default=os.environ.get("ABS_SHIM_PASS"))
    ap.add_argument("--keychain", action="store_true", help="store/read the password in the macOS Keychain (default with --loop)")
    ap.add_argument("--quality", default="30", help="webp quality 1-100; comma-separated list in --sample mode")
    ap.add_argument("--max", type=int, default=500, help="fit inside this many px (default 500); smaller images are left as is")
    ap.add_argument("--limit", type=int, default=100000, help="stop a pass after this many covers")
    ap.add_argument("--batch", type=int, default=200, help="pending covers fetched per round")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--sample", type=int, metavar="N", help="write N covers locally at each --quality and stop (no upload)")
    ap.add_argument("--out", default="./cover-samples", help="--sample output directory")
    ap.add_argument("--upload", action="store_true", help="one pass: PUT the webps to the shim")
    ap.add_argument("--loop", action="store_true", help="keep running: a pass, then sleep --every minutes, forever")
    ap.add_argument("--every", type=float, default=15, help="minutes between passes in --loop mode")
    args = ap.parse_args()

    if not (args.sample or args.upload or args.loop):
        ap.error("pass --upload, --loop, or --sample N to preview quality first")
    server = args.server.rstrip("/")
    qualities = [int(q) for q in str(args.quality).split(",")]

    use_keychain = args.keychain or (args.loop and not args.password)
    password = args.password
    if not password and use_keychain:
        password = keychain_get(args.user)
    if not password:
        password = getpass.getpass(f"shim password for {args.user}: ")
        if use_keychain:
            keychain_set(args.user, password)
            log("password stored in the Keychain (service abs-shim-covers)")

    # First login: retry until the network is there (the runner may start before Wi-Fi).
    while True:
        try:
            sess = Session(server, args.user, password)
            break
        except urllib.error.HTTPError as e:
            sys.exit(f"login failed: HTTP {e.code} — wrong password? (delete it with: security delete-generic-password -s {KEYCHAIN_SERVICE})")
        except (urllib.error.URLError, OSError) as e:
            if not args.loop:
                sys.exit(f"cannot reach {server}: {e}")
            log(f"cannot reach {server} ({e}); retrying in 60s")
            time.sleep(60)

    if args.sample:
        sample(sess, args, qualities)
        return

    quality = qualities[0]
    if not args.loop:
        done, failed = one_pass(sess, args, quality, args.limit)
        print(f"Finished: {done} cached, {failed} failed.")
        return

    log(f"runner started — quality {quality}, max {args.max}px, pass every {args.every:g} min. Ctrl-C to stop.")
    while True:
        try:
            done, failed = one_pass(sess, args, quality, args.limit)
            if done or failed:
                log(f"pass done: {done} cached, {failed} failed")
            else:
                log("nothing pending")
        except (ConnectionError, urllib.error.URLError, OSError) as e:
            log(f"network trouble ({e}); will try again")
        except Exception as e:  # noqa: BLE001
            log(f"pass error: {e}; will try again")
        # time.sleep is wall-clock: a closed lid just stretches this sleep.
        time.sleep(args.every * 60)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nstopped")
