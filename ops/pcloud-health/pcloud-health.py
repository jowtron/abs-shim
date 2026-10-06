#!/usr/bin/env python3
"""pcloud-health: is this box's rclone pCloud token still accepted?

Installed as /usr/local/bin/pcloud-health and run hourly by
pcloud-health.timer, as the user that owns the rclone config. Runs
`rclone about pcloud:` and posts the outcome to the shim
(POST /api/node-health). The shim decides what the output means and sends
the Pushover; this box holds no Pushover keys. Settings come from
/etc/pcloud-health.env, written by deploy.sh.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request


def main():
    try:
        node, rclone, conf, url, key = (os.environ[k] for k in ("NODE", "RCLONE", "RCLONE_CONFIG", "REPORT_URL", "REPORT_KEY"))
    except KeyError as e:
        print(f"{e.args[0]} missing from /etc/pcloud-health.env", file=sys.stderr)
        return 2
    try:
        p = subprocess.run([rclone, "--config", conf, "about", "pcloud:"], capture_output=True, text=True, timeout=120)
        ok, code, out = p.returncode == 0, p.returncode, (p.stdout + p.stderr).strip()
    except subprocess.TimeoutExpired:
        ok, code, out = False, -1, "rclone about timed out after 120 s"
    except OSError as e:
        ok, code, out = False, -1, f"could not run rclone: {e}"
    lines = out.splitlines()
    say = next((l for l in lines if " ERROR " in l), lines[-1] if lines else "")
    print(("ok" if ok else "FAILED") + (": " + say if say else ""))

    body = {"node": node, "ok": ok, "exitCode": code, "uses": os.environ.get("USES", "")}
    if not ok:
        body["output"] = out[-2000:]
    # A User-Agent of our own: Cloudflare's bot rules 403 Python's default
    # on the shim's domain.
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {key}",
        "User-Agent": f"pcloud-health/1 ({node})",
    })
    err = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                print("reported:", r.read().decode()[:200])
                return 0
        except Exception as e:  # noqa: BLE001: any failure to report is retried, then logged
            err = e
            time.sleep(10 * (attempt + 1))
    print(f"could not report to the shim: {err}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
