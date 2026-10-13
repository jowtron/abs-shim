#!/usr/bin/env bash
# Install (or update) podcast-transcribe on a wharf node. One idempotent
# command per node, run from this directory:
#
#   cd ~/Claude_Code/ABS_shim/wharf-project/podcast-transcribe
#   sudo ./install.sh mac        # the Mac node, locally (needs sudo)
#   ./install.sh stereo-au       # over SSH as core@100.121.86.110 (no local sudo)
#
#   mac        wharfd under launchd as _wharf, root /opt/wharf, models in
#              /opt/wharf/share/whisper (wharf repo: deploy/README-MACOS.md)
#   stereo-au  wharfd under systemd as wharf, root /srv/wharf, models in
#              /usr/local/share/whisper; a live lab PBX and the kiosk share
#              the box, so this RELOADS wharfd's projects and never restarts it,
#              and touches nothing outside the project directory
#
# Each target, printing each step:
#   1. rsync this directory to <root>/projects/podcast-transcribe/, leaving the
#      node's own files alone (.env, data/, scratch/, logs/)
#   2. mac only: data/models/ggml-base.en.bin (the Mac's default model; the
#      node's shared directory only has large-v3-turbo), sha256-checked,
#      skipped when present, else from $MODEL_SRC/ or Hugging Face.
#      stereo-au's tiny.en and base.en are the node's own
#   3. chown -R to the daemon's user, 0750
#   4. .env from .env.example when there is none (0600, the daemon's user),
#      with WHISPER_MODEL_DIR set for the node; an existing .env is never
#      touched
#   5. wharf reload-projects, handler register, handler approve --hash
#      <64-hex content hash>, reload-projects, then the handler list and
#      the project as the daemon sees them
#
# wharf CLI calls run as _wharf on the Mac (under plain sudo the CLI writes
# root-owned files the daemon can't read) and via sudo on stereo-au, as that
# node's other projects (audible) do. The handler is stdlib-only: no venv.
# A job already running keeps the handler copy it started with.
#
# Development: ./install.sh --dest DIR does steps 1, 2 and 4 into DIR as the
# current user (Mac paths), to run the handler by hand. Touches no node.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ=podcast-transcribe
HANDLER=analyse_episode
TARGET="" DEST="" TEST=0
STEREO=core@100.121.86.110

while [ $# -gt 0 ]; do
	case "$1" in
		mac|stereo-au) TARGET="$1"; shift;;
		--dest) DEST="$2"; TEST=1; TARGET=mac; shift 2;;
		-h|--help) sed -n '2,38p' "$0"; exit 0;;
		*) echo "unknown argument: $1 (try --help)" >&2; exit 2;;
	esac
done
[ -n "$TARGET" ] || { echo "usage: sudo ./install.sh mac | ./install.sh stereo-au   (--help for more)" >&2; exit 2; }

step() { echo "==> $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

# --no-owner/--no-group: the receiving rsync runs as root, which would
# otherwise stamp the Mac user's uid on every file until the chown below.
RSYNC_EXCLUDES=(--no-owner --no-group --exclude '/.env' --exclude '/data/' --exclude '/scratch/' --exclude '/logs/'
	--exclude '/db.sqlite' --exclude '__pycache__/' --exclude '.DS_Store')

# .env.example with this node's model directory filled in.
render_env() { sed "s|^WHISPER_MODEL_DIR=.*|WHISPER_MODEL_DIR=$1|" "$HERE/.env.example"; }

hash_of() { # reads `wharf handler list --json` on stdin
	python3 -c 'import json, sys
print(next(h["hash"] for h in json.load(sys.stdin)["handlers"] if h["name"] == sys.argv[1]))' "$HANDLER"
}

# ─── mac ────────────────────────────────────────────────────────────────────
if [ "$TARGET" = mac ]; then
	ROOT=/opt/wharf WUSER=_wharf MODEL_DIR=/opt/wharf/share/whisper
	export PATH="/opt/homebrew/bin:$PATH"   # python3 for hash_of
	if [ "$TEST" = 0 ]; then
		DEST="$ROOT/projects/$PROJ"
		[ "$(id -u)" = 0 ] || die "the mac target needs sudo: sudo ./install.sh mac"
		id "$WUSER" >/dev/null 2>&1 || die "no $WUSER account: the wharf node isn't installed (wharf repo: deploy/README-MACOS.md)"
		[ -x "$ROOT/bin/wharf" ] || die "no $ROOT/bin/wharf"
		WHARF() { sudo -u "$WUSER" "$ROOT/bin/wharf" "$@"; }
	else
		step "test install into $DEST as $(id -un): no chown, no wharf CLI"
	fi

	step "project files -> $DEST"
	mkdir -p "$DEST/data/models"
	rsync -a --delete --itemize-changes "${RSYNC_EXCLUDES[@]}" "$HERE/" "$DEST/" | sed 's/^/    /'

	step "model data/models/ggml-base.en.bin"
	# sha256 and size from Hugging Face (x-linked-etag / x-linked-size), checked 2026-10-13.
	name=ggml-base.en.bin
	sha=a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002
	bytes=147964211
	dst="$DEST/data/models/$name"
	if [ -f "$dst" ] && [ "$(stat -f %z "$dst")" = "$bytes" ]; then
		echo "    present, unchanged"
	else
		tmp="$dst.part"
		if [ -n "${MODEL_SRC:-}" ] && [ -f "$MODEL_SRC/$name" ]; then
			echo "    copying from $MODEL_SRC"
			cp -c "$MODEL_SRC/$name" "$tmp" 2>/dev/null || cp "$MODEL_SRC/$name" "$tmp"
		else
			echo "    downloading from Hugging Face (148 MB)"
			curl -fsSL --retry 3 -o "$tmp" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$name"
		fi
		got=$(shasum -a 256 "$tmp" | cut -d' ' -f1)
		[ "$got" = "$sha" ] || { rm -f "$tmp"; die "$name sha256 $got, expected $sha"; }
		mv "$tmp" "$dst"
		echo "    installed (sha256 ok)"
	fi

	if [ "$TEST" = 0 ]; then
		step "ownership $WUSER:$WUSER"
		chown -R "$WUSER:$WUSER" "$DEST"
		chmod 0750 "$DEST"
	fi

	step ".env"
	if [ -f "$DEST/.env" ]; then
		keys=$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=.' "$DEST/.env" | cut -d= -f1 | tr '\n' ' ' || true)
		echo "    kept the existing .env (keys set: ${keys:-none})"
	else
		( umask 077; render_env "$MODEL_DIR" > "$DEST/.env" )
		[ "$TEST" = 1 ] || chown "$WUSER:$WUSER" "$DEST/.env"
		echo "    created from .env.example: WHISPER_MODEL_DIR=$MODEL_DIR, no OPENROUTER_API_KEY yet (LLM step reports skipped)"
	fi

	if [ "$TEST" = 0 ]; then
		step "register + approve $PROJ/$HANDLER (as $WUSER)"
		WHARF reload-projects
		WHARF handler register "$PROJ" "$DEST/handlers/$HANDLER"
		hash=$(WHARF handler list --json "$PROJ" | hash_of)
		[[ "$hash" =~ ^[0-9a-f]{64}$ ]] || die "could not read the content hash of $PROJ/$HANDLER"
		WHARF handler approve --hash "$hash" "$PROJ/$HANDLER"   # a no-op when already approved
		WHARF reload-projects
		step "as the daemon sees it"
		WHARF handler list "$PROJ"
		WHARF project show "$PROJ" || die "wharfd did not load $PROJ; see $ROOT/logs/wharfd.log"
	fi
	step "done: $PROJ on mac at $DEST"
	exit 0
fi

# ─── stereo-au (over SSH) ───────────────────────────────────────────────────
ROOT=/srv/wharf WUSER=wharf MODEL_DIR=/usr/local/share/whisper
DEST="$ROOT/projects/$PROJ"
SSH=(ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no -o BatchMode=yes "$STEREO")
R() { "${SSH[@]}" "$@"; }

step "preflight on $STEREO"
R "set -e
	sudo -n true
	id $WUSER >/dev/null
	sudo test -x $ROOT/bin/wharf
	sudo test -d $ROOT/projects
	for t in whisper-cli ffmpeg ffprobe python3; do command -v \$t >/dev/null || { echo \"missing \$t\"; exit 1; }; done
	for m in tiny.en base.en; do test -f $MODEL_DIR/ggml-\$m.bin || { echo \"missing $MODEL_DIR/ggml-\$m.bin\"; exit 1; }; done
	echo \"    wharfd \$(systemctl is-active wharfd), models: \$(ls $MODEL_DIR | tr '\n' ' ')\"" || die "preflight failed"

step "project files -> $STEREO:$DEST"
R "sudo mkdir -p $DEST"
rsync -a --delete --itemize-changes "${RSYNC_EXCLUDES[@]}" \
	-e "ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no -o BatchMode=yes" --rsync-path="sudo rsync" \
	"$HERE/" "$STEREO:$DEST/" | sed 's/^/    /'

step "ownership $WUSER:$WUSER"
R "sudo chown -R $WUSER:$WUSER $DEST && sudo chmod 0750 $DEST"

step ".env"
render_env "$MODEL_DIR" | R "if sudo test -f $DEST/.env; then
		echo \"    kept the existing .env (keys set: \$(sudo grep -E '^[A-Za-z_][A-Za-z0-9_]*=.' $DEST/.env | cut -d= -f1 | tr '\n' ' '))\"
	else
		sudo install -m 0600 -o $WUSER -g $WUSER /dev/null $DEST/.env
		sudo -u $WUSER tee $DEST/.env >/dev/null
		echo '    created from .env.example: WHISPER_MODEL_DIR=$MODEL_DIR, no OPENROUTER_API_KEY yet (LLM step reports skipped)'
	fi"

step "register + approve $PROJ/$HANDLER (reload only, never a restart)"
R "set -e
	W='sudo $ROOT/bin/wharf'
	\$W reload-projects
	\$W handler register $PROJ $DEST/handlers/$HANDLER
	hash=\$(\$W handler list --json $PROJ | python3 -c 'import json, sys
print(next(h[\"hash\"] for h in json.load(sys.stdin)[\"handlers\"] if h[\"name\"] == \"$HANDLER\"))')
	echo \"\$hash\" | grep -Eq '^[0-9a-f]{64}\$' || { echo 'could not read the content hash'; exit 1; }
	\$W handler approve --hash \"\$hash\" $PROJ/$HANDLER
	\$W reload-projects
	echo '==> as the daemon sees it'
	\$W handler list $PROJ
	\$W project show $PROJ"
step "done: $PROJ on stereo-au at $DEST"
