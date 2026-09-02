#!/usr/bin/env python3
"""
abb-detail-crawler — fetch AudioBookBay detail pages for the ABS_shim
catalogue from this node's own IP, and post the HTML back to the shim.

Runs as a wharf [[services]] entry (long-lived, supervised, restart=always),
not as a job: a per-minute schedule would mint a job row and a log file for
what is really one slow continuous loop.

Why a node at all: the shim's cron crawler shares Cloudflare's egress with
every other Worker and with the shim's own live ABB search, so its budget is
~1 detail page a minute. The backlog is ~10k posts. A box with its own IP can
run the same work in parallel; two of them clear it in about a day.

Division of labour, so nothing is fetched twice:
  - the shim leases each batch (`claim`) with an expiry, so two nodes never
    hold the same post, and a node that dies just lets its lease lapse;
  - nodes take the OLDEST pending posts, the cron takes the newest;
  - all parsing happens in the Worker — this script never looks inside the
    HTML, so an ABB markup fix ships with the shim and not with the fleet.

Politeness is the whole design constraint. ABB firewalls an IP that bursts
(≈50 pages in 3 min got the dev Mac dropped at TCP level, 2026-09-02), so
this paces one page every PACE_SECONDS, and on consecutive failures it hands
its lease back and sleeps for an exponentially growing spell rather than
hammering a site that is already unhappy.

Config (project .env):
  SHIM_URL       https://abs-shim.jderrick.app
  SHIM_USER      shim account (must be the tenant owner — the routes are owner-only)
  SHIM_PASS      its password
  NODE_NAME      label shown in /admin (default: hostname)
  PACE_SECONDS   seconds between ABB fetches (default 8 → ~7/min)
  BATCH          posts per claim (default 10, shim caps at 25)
  IDLE_SLEEP     seconds to wait when the backlog is empty (default 600)
"""
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request

ABB_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
# The shim's domain is behind Cloudflare bot rules that 403 "Python-urllib"
# before the Worker ever sees the request (2026-09-02, abb-covers.py).
SHIM_UA = "abb-detail-crawler/1.0"

SHIM_URL = os.environ.get("SHIM_URL", "").rstrip("/")
SHIM_USER = os.environ.get("SHIM_USER", "")
SHIM_PASS = os.environ.get("SHIM_PASS", "")
NODE = os.environ.get("NODE_NAME") or socket.gethostname()
PACE = float(os.environ.get("PACE_SECONDS", "8"))
BATCH = int(os.environ.get("BATCH", "10"))
IDLE_SLEEP = float(os.environ.get("IDLE_SLEEP", "600"))

# Consecutive ABB failures before we assume it's us, not a slow page. Same
# threshold the Worker crawler uses (two timeouts on a slow patch was a false
# alarm once already), and the same 30 min → doubling → 6 h shape.
FAILS_TO_BACK_OFF = 3
BACKOFF_BASE = 30 * 60
BACKOFF_MAX = 6 * 3600


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


class Unauthorized(Exception):
    pass


class Session:
    """Shim API client; re-logs-in when the 30-day token is rejected."""

    def __init__(self):
        self.token = self._login()

    def _login(self):
        req = urllib.request.Request(
            SHIM_URL + "/login", method="POST",
            data=json.dumps({"username": SHIM_USER, "password": SHIM_PASS}).encode())
        req.add_header("Content-Type", "application/json")
        req.add_header("User-Agent", SHIM_UA)
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)["user"]["token"]

    def _once(self, path, body):
        req = urllib.request.Request(SHIM_URL + path, method="POST",
                                     data=json.dumps(body).encode())
        req.add_header("Authorization", "Bearer " + self.token)
        req.add_header("Content-Type", "application/json")
        req.add_header("User-Agent", SHIM_UA)
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                data = r.read()
                return json.loads(data) if data else None
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise Unauthorized() from e
            raise

    def post(self, path, body):
        try:
            return self._once(path, body)
        except Unauthorized:
            log("shim token rejected — logging in again")
            self.token = self._login()
            return self._once(path, body)


def fetch_page(url):
    """(status, html) or raises. 20s, same bound the Worker crawler uses."""
    req = urllib.request.Request(url, headers={"User-Agent": ABB_UA})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        # A 404 is a real answer (deleted post) — record it, don't retry it.
        return e.code, ""


def main():
    if not (SHIM_URL and SHIM_USER and SHIM_PASS):
        sys.exit("SHIM_URL, SHIM_USER and SHIM_PASS must be set in the project .env")
    log(f"node={NODE} shim={SHIM_URL} pace={PACE}s batch={BATCH}")
    sess = Session()
    fails = 0
    backoff_level = 0

    while True:
        try:
            claim = sess.post("/api/admin/abb/catalog/details/claim", {"node": NODE, "limit": BATCH})
        except Exception as e:  # network blip on the shim side; try again shortly
            log(f"claim failed: {e}")
            time.sleep(60)
            continue

        items = (claim or {}).get("items") or []
        if not items:
            log(f"nothing pending — sleeping {int(IDLE_SLEEP)}s")
            time.sleep(IDLE_SLEEP)
            continue

        for i, item in enumerate(items):
            time.sleep(PACE)
            url = item["url"]
            try:
                status, html = fetch_page(url)
                body = {"node": NODE, "url": url, "status": status}
                if html:
                    body["html"] = html
                res = sess.post("/api/admin/abb/catalog/details/submit", body) or {}
                if status == 200:
                    fails = 0
                    backoff_level = 0
                log(f"{status} {'hash' if res.get('hash') else res.get('error') or 'no-hash'} {item['title'][:60]}")
                # 403/429/503 are ABB pushing back, not a bad page.
                if status in (403, 429, 503):
                    fails += 1
            except Exception as e:
                fails += 1
                log(f"fetch failed ({fails}): {e} — {url}")
                try:
                    sess.post("/api/admin/abb/catalog/details/submit",
                              {"node": NODE, "url": url, "error": str(e)[:200]})
                except Exception:
                    pass

            if fails >= FAILS_TO_BACK_OFF:
                # Hand the rest of the batch back so the other node (or the
                # cron) can take it while we sit out, then sleep it off.
                for rest in items[i + 1:]:
                    try:
                        sess.post("/api/admin/abb/catalog/details/submit",
                                  {"node": NODE, "url": rest["url"], "release": True})
                    except Exception:
                        pass
                nap = min(BACKOFF_BASE * (2 ** backoff_level), BACKOFF_MAX)
                backoff_level += 1
                log(f"{fails} consecutive failures — released {len(items) - i - 1} claims, backing off {int(nap / 60)} min")
                time.sleep(nap)
                fails = 0
                break


if __name__ == "__main__":
    main()
