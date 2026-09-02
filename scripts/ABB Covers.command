#!/bin/bash
# Double-click to start the AudioBookBay cover runner in a Terminal window.
# It asks for the shim password once (kept in the macOS Keychain), then
# loops forever: every 15 minutes it asks the shim which catalogue covers
# still need caching, resizes them to 500px webp at quality 30, and uploads
# them. Closing the lid just pauses it; Ctrl-C or closing the window stops it.
#
# Edit SHIM_USER below if your shim username isn't "root".
SHIM_URL="https://abs-shim.jderrick.app"
SHIM_USER="jderrick"

cd "$(dirname "$0")" || exit 1
if ! python3 -c "import PIL" 2>/dev/null; then
  echo "Installing Pillow (image library)…"
  python3 -m pip install --user Pillow || { echo "pip install failed"; read -r -p "Press return to close"; exit 1; }
fi
# Don't let the Mac idle-sleep mid-pass; lid close still sleeps it (and that's fine).
exec caffeinate -i python3 abb-covers.py --server "$SHIM_URL" --user "$SHIM_USER" --quality 30 --loop
