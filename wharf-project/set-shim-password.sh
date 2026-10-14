#!/usr/bin/env bash
# Put the owner's NEW shim password on the catalogue nodes, after jderrick's
# password was changed or reset (the abbcrawl + abbcovers services sign in
# with it; see "Passwords" in CLAUDE.md).
#
#   ./wharf-project/set-shim-password.sh
#
# Asks for the password without echoing it, checks it against the live
# /login first (a typo never reaches a node), then on each node rewrites the
# password lines of both projects' .env, reloads wharfd and stops the two
# services so wharfd restarts them (restart = "always"): they read the
# password once, at start, so a .env edit alone changes nothing. The password
# goes over ssh on stdin, never on a command line or into a file here.
set -euo pipefail

SHIM_URL=https://rhapsode.jderrick.app
SHIM_USER=jderrick
NODES=(root@100.65.13.50 core@100.111.229.12)   # wharf-syd-1, stereo-nz

read -r -s -p "New password for $SHIM_USER: " PW; echo
[[ -n "$PW" ]] || { echo "Nothing entered." >&2; exit 1; }

code=$(printf '%s' "$PW" | python3 -c '
import json, sys, urllib.request, urllib.error
pw = sys.stdin.read()
req = urllib.request.Request(sys.argv[1] + "/login", method="POST",
    data=json.dumps({"username": sys.argv[2], "password": pw}).encode(),
    headers={"Content-Type": "application/json", "User-Agent": "set-shim-password"})
try:
    with urllib.request.urlopen(req, timeout=30) as r: print(r.status)
except urllib.error.HTTPError as e: print(e.code)
' "$SHIM_URL" "$SHIM_USER")
[[ "$code" == 200 ]] || { echo "The shim refused that password (HTTP $code). Nothing changed." >&2; exit 1; }
echo "Password accepted by $SHIM_URL."

# Runs on the node as root: rewrites only the password lines, keeping the
# files' owner (wharf) and mode (600) because they are written in place.
REMOTE_PY='
import sys
pw = sys.stdin.read()
for path in ("/srv/wharf/projects/abbcrawl/.env", "/srv/wharf/projects/abbcovers/.env"):
    lines = open(path).read().splitlines()
    n = 0
    for i, line in enumerate(lines):
        if line.split("=", 1)[0] in ("SHIM_PASS", "ABS_SHIM_PASS"):
            lines[i] = line.split("=", 1)[0] + "=" + pw
            n += 1
    if not n:
        sys.exit(path + ": no password line found")
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")
    print("  " + path + ": " + str(n) + " line(s)")
'

for host in "${NODES[@]}"; do
  echo "$host"
  sudo=sudo; [[ "${host%%@*}" == root ]] && sudo=
  printf '%s' "$PW" | ssh -o ConnectTimeout=10 "$host" "$sudo python3 -c '$REMOTE_PY'"
  # [s]/[r] keep pkill from matching this ssh command's own shell.
  ssh -o ConnectTimeout=10 "$host" "$sudo /srv/wharf/bin/wharf reload-projects >/dev/null
    $sudo pkill -f 'handlers/abb-detail-crawle[r].py' || true
    $sudo pkill -f 'handlers/abb-cover[s].py' || true
    sleep 8
    ps -eo lstart,args | grep -E 'abb-(detail-crawle[r]|cover[s]).py' | sed 's/^/  running since /'"
done
unset PW
echo "Done. The nodes' dots in /admin's catalogue card should go green within a few minutes."
