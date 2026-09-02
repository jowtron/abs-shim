#!/usr/bin/env python3
"""Resize AudioBookBay catalogue covers locally and push them to the shim.

Workers can't resize images, and Cloudflare's transformation service costs
money past 5,000 a month, so this runs on a Mac (or any box with Pillow):

  1. asks the shim for posts whose cover isn't cached yet
     (GET /api/admin/abb/catalog/covers/pending)
  2. downloads each cover from its image host
  3. fits it inside --max px and saves a small webp at --quality
  4. PUTs the webp to /api/admin/abb/catalog/covers/<id>; the shim stores it
     in R2 and serves it at /public/abb-cover/<id>.webp

Try quality first without uploading:

  python3 scripts/abb-covers.py --server https://abs-shim.jderrick.app \
      --user root --sample 12 --quality 30,45,60 --out ./cover-samples

then run for real (re-runnable; only pending covers are fetched):

  python3 scripts/abb-covers.py --server https://abs-shim.jderrick.app \
      --user root --quality 40 --upload

Password: --pass, or the ABS_SHIM_PASS env var, or an interactive prompt.
Needs Pillow (pip3 install Pillow). Dead/unreadable covers are reported back
with .../covers/<id>/error so they aren't retried every run.
"""
import argparse
import getpass
import io
import json
import os
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


def api(server, token, path, method="GET", body=None, content_type="application/json"):
    req = urllib.request.Request(server + path, method=method)
    req.add_header("Authorization", "Bearer " + token)
    if body is not None:
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        req.add_header("Content-Type", content_type)
    with urllib.request.urlopen(req, body, timeout=60) as r:
        data = r.read()
        return json.loads(data) if data else None


def login(server, user, password):
    req = urllib.request.Request(server + "/login", method="POST", data=json.dumps({"username": user, "password": password}).encode())
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)["user"]["token"]


def fetch_image(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://audiobookbay.lu/"})
    with urllib.request.urlopen(req, timeout=20) as r:
        if r.status != 200:
            raise RuntimeError(f"HTTP {r.status}")
        data = r.read(8 * 1024 * 1024)
    return data


def to_webp(data, max_px, quality):
    im = Image.open(io.BytesIO(data))
    im.load()
    if im.mode not in ("RGB", "L"):
        im = im.convert("RGB")
    if im.width > max_px or im.height > max_px:
        im.thumbnail((max_px, max_px), Image.LANCZOS)
    out = io.BytesIO()
    im.save(out, "WEBP", quality=quality, method=6)
    return out.getvalue(), im.size


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--server", required=True, help="shim origin, e.g. https://abs-shim.jderrick.app")
    ap.add_argument("--user", required=True)
    ap.add_argument("--pass", dest="password", default=os.environ.get("ABS_SHIM_PASS"))
    ap.add_argument("--quality", default="40", help="webp quality 1-100; comma-separated list in --sample mode")
    ap.add_argument("--max", type=int, default=500, help="fit inside this many px (default 500)")
    ap.add_argument("--limit", type=int, default=100000, help="stop after this many covers")
    ap.add_argument("--batch", type=int, default=200, help="pending covers fetched per round")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--sample", type=int, metavar="N", help="write N covers locally at each --quality and stop (no upload)")
    ap.add_argument("--out", default="./cover-samples", help="--sample output directory")
    ap.add_argument("--upload", action="store_true", help="actually PUT the webps to the shim")
    args = ap.parse_args()

    if not args.sample and not args.upload:
        ap.error("pass --upload, or --sample N to preview quality first")
    password = args.password or getpass.getpass("shim password: ")
    server = args.server.rstrip("/")
    token = login(server, args.user, password)
    qualities = [int(q) for q in str(args.quality).split(",")]

    if args.sample:
        os.makedirs(args.out, exist_ok=True)
        pending = api(server, token, f"/api/admin/abb/catalog/covers/pending?limit={args.sample}")["pending"]
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
        return

    quality = qualities[0]
    done = failed = 0
    t0 = time.time()
    while done + failed < args.limit:
        st = api(server, token, f"/api/admin/abb/catalog/covers/pending?limit={min(args.batch, args.limit - done - failed)}")
        pending = st["pending"]
        if not pending:
            break
        print(f"[{st['cached']}/{st['withCover']} cached, {st['failed']} failed] processing {len(pending)}…")

        def work(p):
            try:
                data = fetch_image(p["url"])
                webp, _dims = to_webp(data, args.max, quality)
                api(server, token, f"/api/admin/abb/catalog/covers/{p['id']}", "PUT", webp, "image/webp")
                return True, len(webp)
            except Exception as e:  # noqa: BLE001
                msg = str(e)[:180]
                try:
                    api(server, token, f"/api/admin/abb/catalog/covers/{p['id']}/error", "POST", {"error": msg})
                except Exception:  # noqa: BLE001
                    pass
                return False, msg

        with ThreadPoolExecutor(max_workers=args.workers) as ex:
            for p, (ok, info) in zip(pending, ex.map(work, pending)):
                if ok:
                    done += 1
                else:
                    failed += 1
                    print(f"  {p['id']} failed: {info}")
        print(f"  ok {done}, failed {failed}, {time.time() - t0:.0f}s")
    print(f"Finished: {done} cached, {failed} failed.")


if __name__ == "__main__":
    main()
