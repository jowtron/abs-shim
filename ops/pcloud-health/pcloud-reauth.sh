#!/bin/bash
# One command to re-authorise rclone's pCloud remote on every node that uses it.
#
#   ops/pcloud-health/pcloud-reauth.sh [node ...]
#
# Use it when pCloud answers 2095 "Revoked 'access_token' provided" (the
# token never expires on its own; 2095 means the authorization was withdrawn).
# It opens pCloud's sign-in in the browser (`rclone authorize pcloud`), then
# on each node in nodes.conf:
#   - replaces only the `token =` line of the [pcloud] section of its
#     rclone.conf, in place, so owner, mode and `hostname =` are kept
#     (the old file is kept as rclone.conf.bak-reauth);
#   - checks the new token with `rclone about pcloud:` as the config's owner;
#   - runs the node's pcloud-health check, so the shim marks it OK again.
# The token reaches the nodes on ssh's stdin. It is never printed, never in
# argv, and the local copy is deleted on exit. This Mac's own rclone config
# is not touched.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
want=("$@")
command -v rclone >/dev/null || { echo "rclone isn't installed on this Mac (brew install rclone)" >&2; exit 1; }

tmp=$(mktemp -d); chmod 700 "$tmp"; trap 'rm -rf "$tmp"' EXIT

echo "Opening pCloud's sign-in in your browser. Sign in and allow rclone."
(umask 077; rclone authorize pcloud > "$tmp/authorize.out")

# rclone prints the token between "--->" and "<---End paste".
python3 - "$tmp/authorize.out" "$tmp/token.json" <<'EOF'
import json, re, sys
m = re.search(r"--->\s*(\{.*?\})\s*<---", open(sys.argv[1]).read(), re.S)
if not m:
    sys.exit("rclone authorize didn't print a token (cancelled in the browser?)")
raw = m.group(1).strip()
if not json.loads(raw).get("access_token"):
    sys.exit("the token rclone printed has no access_token")
with open(sys.argv[2], "w") as f:
    f.write(raw)
EOF

# Runs as root on each node: argv = rclone config, rclone binary; stdin = token JSON.
remote_py=$(base64 <<'EOF' | tr -d '\n'
import json, os, pwd, re, subprocess, sys
conf, rclone = sys.argv[1], sys.argv[2]
raw = sys.stdin.read().strip()
json.loads(raw)
with open(conf) as f:
    lines = f.read().split("\n")
section, header, at = None, None, None
for i, line in enumerate(lines):
    s = line.strip()
    if s.startswith("[") and s.endswith("]"):
        section = s[1:-1]
        if section == "pcloud":
            header = i
    elif section == "pcloud" and re.match(r"token\s*=", s):
        at = i
if header is None:
    sys.exit(f"  no [pcloud] section in {conf}")
if at is None:
    lines.insert(header + 1, "token = " + raw)
else:
    lines[at] = "token = " + raw
st = os.stat(conf)
bak = conf + ".bak-reauth"
with open(conf) as src, open(bak, "w") as dst:
    dst.write(src.read())
os.chown(bak, st.st_uid, st.st_gid)
os.chmod(bak, 0o600)
# Rewritten in place: same inode, so owner, mode and SELinux label stay.
with open(conf, "r+") as f:
    f.seek(0)
    f.write("\n".join(lines))
    f.truncate()
user = pwd.getpwuid(st.st_uid).pw_name
p = subprocess.run(["runuser", "-u", user, "--", rclone, "--config", conf, "about", "pcloud:"],
                   capture_output=True, text=True, timeout=120)
if p.returncode != 0:
    tail = (p.stderr or p.stdout).strip().splitlines()
    say = next((l for l in tail if " ERROR " in l), tail[-1] if tail else f"exit {p.returncode}")
    sys.exit("  token written, but rclone about FAILED: " + say)
facts = [" ".join(l.split()) for l in p.stdout.splitlines() if l.startswith(("Used:", "Free:"))]
print("  token installed; rclone about OK: " + ", ".join(facts))
if os.path.exists("/etc/systemd/system/pcloud-health.service"):
    subprocess.run(["systemctl", "start", "--no-block", "pcloud-health.service"])
    print("  health check started; the shim will mark this node OK")
EOF
)

ok=() failed=()
while read -r name target rclone conf _uses; do
  [[ -z "$name" || "$name" == \#* ]] && continue
  if ((${#want[@]})) && [[ ! " ${want[*]} " == *" $name "* ]]; then continue; fi
  echo "== $name"
  sudo=""; [[ "$target" == root@* ]] || sudo="sudo -n"
  if ssh -o ConnectTimeout=10 "$target" \
      "$sudo python3 -c \"import base64; exec(base64.b64decode('$remote_py'))\" '$conf' '$rclone'" < "$tmp/token.json"; then
    ok+=("$name")
  else
    failed+=("$name")
  fi
done < "$here/nodes.conf"

echo
echo "Updated: ${ok[*]:-none}"
if ((${#failed[@]})); then
  echo "FAILED:  ${failed[*]} (re-run with just those names once they're reachable)"
  exit 1
fi
