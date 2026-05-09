#!/usr/bin/env bash
# Fetch the latest Pholia (alternative ABS web client) into web/pholia/
# at deploy time, so we don't vendor its source into our repo.
#
# Pholia is a static HTML/JS PWA at github.com/jowtron/pholia, normally
# deployed to Cloudflare Pages. We co-host it under /pholia/ on the shim
# so users can pick between the bundled ABS web UI and Pholia without
# managing two deployments. Run automatically as part of `npm run deploy`.

set -euo pipefail

REPO="${PHOLIA_REPO:-https://github.com/jowtron/pholia}"
REF="${PHOLIA_REF:-main}"
DEST="web/pholia"

cd "$(dirname "$0")/.."

# Honor an opt-out so devs can build without internet / without auth.
if [[ "${SKIP_PHOLIA:-0}" == "1" ]]; then
  echo "fetch-pholia: SKIP_PHOLIA=1 set, skipping."
  exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "fetch-pholia: cloning ${REPO}@${REF}..."
git clone --depth 1 --branch "$REF" --quiet "$REPO" "$TMP/pholia"

# Pholia's CI injects a build hash into #build-version (the SW-update probe
# reads it). Mirror that here so update-detection still works when served
# from the shim.
HASH=$(git -C "$TMP/pholia" rev-parse --short HEAD)
if grep -q 'id="build-version"' "$TMP/pholia/index.html" 2>/dev/null; then
  # The placeholder in the source is `dev`; replace with our hash so
  # Pholia's update-detection probe sees a real version string.
  sed -i.bak -E "s|(id=\"build-version\"[^>]*>)[^<]*|\1$HASH|g" "$TMP/pholia/index.html"
  rm -f "$TMP/pholia/index.html.bak"
fi

# Ship only the runtime files. Drop git/CI/desktop/server scaffolding so the
# Worker bundle stays small. Add to this list if Pholia adds more dirs we
# DO want (e.g. a new top-level asset directory).
RUNTIME_FILES=(
  index.html style.css api.js app.js player.js sw.js
  account.js manifest.json favicon.ico _headers
  icons isub schema docs
)

rm -rf "$DEST"
mkdir -p "$DEST"
for entry in "${RUNTIME_FILES[@]}"; do
  if [[ -e "$TMP/pholia/$entry" ]]; then
    cp -R "$TMP/pholia/$entry" "$DEST/"
  fi
done

echo "fetch-pholia: $DEST/ populated at $HASH ($(du -sh "$DEST" | cut -f1))"
