#!/usr/bin/env bash
# Deploy the abbcrawl project to a wharf node.
#
#   ./wharf-project/abbcrawl/deploy.sh core@100.111.229.12    # stereo-nz (FCOS, sudo)
#   ./wharf-project/abbcrawl/deploy.sh root@100.65.13.50      # wharf-syd-1 (Debian, root)
#
# Copies project.toml + both service scripts (the cover runner is the shim
# repo's scripts/abb-covers.py — copied, never forked), builds the venv that
# Pillow needs, and reloads wharfd. It does NOT write .env: the shim password
# goes on separately so it never passes through a repo file. See README.md.
#
# Re-runnable: a plain copy plus `reload-projects`, which restarts the
# services with the new scripts.
#
# Files are staged in the login user's home first because /srv/wharf/projects
# is wharf:wharf 0750 — an unprivileged scp straight into it fails, and on
# Fedora CoreOS (stereo-nz) the login user is `core`, not root.
set -euo pipefail
HOST="${1:?usage: deploy.sh user@host}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DIR=/srv/wharf/projects/abbcrawl
STAGE=/tmp/abbcrawl-deploy

# root needs no sudo; anyone else does (and has it — both nodes' login users
# are in wheel/sudo).
SUDO='sudo'
[[ "${HOST%%@*}" == root ]] && SUDO=''

ssh "$HOST" "rm -rf $STAGE && mkdir -p $STAGE"
scp -q "$HERE/project.toml" "$HOST:$STAGE/"
scp -q "$HERE/handlers/abb-detail-crawler.py" "$REPO/scripts/abb-covers.py" "$HOST:$STAGE/"

ssh "$HOST" "set -e
  $SUDO mkdir -p $DIR/handlers
  $SUDO cp $STAGE/project.toml $DIR/project.toml
  $SUDO cp $STAGE/abb-detail-crawler.py $STAGE/abb-covers.py $DIR/handlers/
  rm -rf $STAGE
  # Pillow is the only third-party dep (the covers service); everything the
  # detail crawler uses is stdlib, so it runs on the system python3.
  $SUDO test -x $DIR/venv/bin/python3 || $SUDO python3 -m venv $DIR/venv
  $SUDO $DIR/venv/bin/pip install -q --upgrade pip Pillow
  $SUDO chown -R wharf:wharf $DIR
  $SUDO /srv/wharf/bin/wharf reload-projects"
echo "deployed to $HOST — services start once $DIR/.env exists (see README.md)"
