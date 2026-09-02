#!/usr/bin/env bash
# Deploy one of this repo's wharf projects to a node.
#
#   ./wharf-project/deploy.sh abbcrawl  core@100.111.229.12   # stereo-nz (FCOS, sudo)
#   ./wharf-project/deploy.sh abbcrawl  root@100.65.13.50     # wharf-syd-1 (Debian, root)
#   ./wharf-project/deploy.sh abbcovers root@100.65.13.50
#
# abbcrawl  = ABB detail-page crawler (stdlib only, tiny).
# abbcovers = cover resizer (Pillow venv, hundreds of MB peak). Check the
#   box has room before deploying it — wharfd runs everything in one cgroup:
#       ssh <host> systemctl show wharfd -p MemoryMax -p MemoryCurrent
#   stereo-nz's cap is 128 MB and both projects together OOM-killed wharfd
#   there 75 times in an hour (2026-09-03), restarting netprobe and
#   cfpbx-stereo's ESL forwarder each time. syd's cap is 448 MB and fits both.
#
# Copies project.toml + handlers (abbcovers takes the shim repo's
# scripts/abb-covers.py — copied, never forked) and reloads wharfd. It does
# NOT write .env: the shim password goes on separately so it never passes
# through a repo file. See abbcrawl/README.md.
#
# Files are staged in the login user's home first because /srv/wharf/projects
# is wharf:wharf 0750 — an unprivileged scp straight into it fails, and on
# Fedora CoreOS (stereo-nz) the login user is `core`, not root.
set -euo pipefail
PROJ="${1:?usage: deploy.sh <abbcrawl|abbcovers> user@host}"
HOST="${2:?usage: deploy.sh <abbcrawl|abbcovers> user@host}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
SRC="$HERE/$PROJ"
[[ -f "$SRC/project.toml" ]] || { echo "ERROR: no such project: $PROJ" >&2; exit 1; }
DIR=/srv/wharf/projects/$PROJ
STAGE=/tmp/$PROJ-deploy

SUDO='sudo'
[[ "${HOST%%@*}" == root ]] && SUDO=''

ssh "$HOST" "rm -rf $STAGE && mkdir -p $STAGE"
scp -q "$SRC/project.toml" "$HOST:$STAGE/"
if [[ "$PROJ" == abbcovers ]]; then
  scp -q "$REPO/scripts/abb-covers.py" "$HOST:$STAGE/"
else
  scp -q "$SRC"/handlers/*.py "$HOST:$STAGE/"
fi

ssh "$HOST" "set -e
  $SUDO mkdir -p $DIR/handlers
  $SUDO cp $STAGE/project.toml $DIR/project.toml
  $SUDO cp $STAGE/*.py $DIR/handlers/
  rm -rf $STAGE"

# Only the cover runner needs a venv (Pillow); the crawler is stdlib.
if [[ "$PROJ" == abbcovers ]]; then
  ssh "$HOST" "set -e
    $SUDO test -x $DIR/venv/bin/python3 || $SUDO python3 -m venv $DIR/venv
    $SUDO $DIR/venv/bin/pip install -q --upgrade pip Pillow"
fi

ssh "$HOST" "$SUDO chown -R wharf:wharf $DIR; $SUDO /srv/wharf/bin/wharf reload-projects"
echo "deployed $PROJ to $HOST — services start once $DIR/.env exists"
