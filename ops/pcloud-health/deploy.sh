#!/bin/bash
# Install (or update) the hourly pCloud token check on the nodes in nodes.conf.
#
#   ops/pcloud-health/deploy.sh [--key-file FILE] [node ...]
#
# --key-file holds the shim's NODE_HEALTH_KEY secret, written to each node's
# /etc/pcloud-health.env (root, 600). Without it a node keeps the key it
# already has, so only the first install or a key rotation needs it. The key
# travels inside the tar on ssh's stdin, never in argv or on the terminal.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
report_url=${REPORT_URL:-https://abs-shim.jderrick.app/api/node-health}

key_file=""
if [[ "${1:-}" == "--key-file" ]]; then key_file=$2; shift 2; fi
want=("$@")

tmp=$(mktemp -d); chmod 700 "$tmp"; trap 'rm -rf "$tmp"' EXIT

# Runs as root on the node, from the unpacked tar.
cat > "$tmp/install.sh" <<'EOF'
set -euo pipefail
d=$1
if ! grep -q '^REPORT_KEY=' "$d/pcloud-health.env"; then
  grep '^REPORT_KEY=' /etc/pcloud-health.env >> "$d/pcloud-health.env" 2>/dev/null \
    || { echo "no REPORT_KEY on this node yet: deploy with --key-file" >&2; exit 1; }
fi
install -m 755 -o root -g root "$d/pcloud-health.py" /usr/local/bin/pcloud-health
install -m 600 -o root -g root "$d/pcloud-health.env" /etc/pcloud-health.env
install -m 644 -o root -g root "$d/pcloud-health.service" "$d/pcloud-health.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pcloud-health.timer >/dev/null
systemctl start pcloud-health.service || true    # oneshot: returns when the first check is done
journalctl -u pcloud-health.service -n 3 --no-pager -o cat
systemctl list-timers pcloud-health.timer --no-pager | sed -n 2p
EOF

found=0
while read -r name target rclone conf uses; do
  [[ -z "$name" || "$name" == \#* ]] && continue
  if ((${#want[@]})) && [[ ! " ${want[*]} " == *" $name "* ]]; then continue; fi
  found=1
  echo "== $name ($target)"
  stage="$tmp/$name"; mkdir -m 700 "$stage"
  cp "$here/pcloud-health.py" "$here/pcloud-health.service" "$here/pcloud-health.timer" "$tmp/install.sh" "$stage/"
  {
    echo "NODE=$name"
    echo "USES=$uses"
    echo "RCLONE=$rclone"
    echo "RCLONE_CONFIG=$conf"
    echo "REPORT_URL=$report_url"
    [[ -n "$key_file" ]] && echo "REPORT_KEY=$(tr -d '\n' < "$key_file")"
  } > "$stage/pcloud-health.env"
  sudo=""; [[ "$target" == root@* ]] || sudo="sudo -n"
  COPYFILE_DISABLE=1 tar -C "$stage" -cf - . | ssh -o ConnectTimeout=10 "$target" \
    "set -e; d=\$(mktemp -d); trap 'rm -rf \"\$d\"' EXIT; tar -C \"\$d\" -xf - 2>/dev/null; $sudo bash \"\$d/install.sh\" \"\$d\""
done < "$here/nodes.conf"
((found)) || { echo "no matching node in nodes.conf" >&2; exit 1; }
