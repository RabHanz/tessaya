#!/usr/bin/env bash
# Copies the Character Studio's characters into the app, so an art change there reaches the desktop mascot, the island
# face and the phone companion. Run after the studio changes, then commit apps/web/public/companion (every server serves it; the desktop build ships it).
#   scripts/tessaya/sync-companion-art.sh <character-studio folder>
set -euo pipefail
src="${1:?usage: sync-companion-art.sh <character-studio folder>}"
out="$(cd "$(dirname "$0")/../.." && pwd)/apps/web/public/companion"
mkdir -p "$out/hands"
for f in rig.js bodies.js props.js speech.js; do cp "$src/$f" "$out/$f"; done
rm -f "$out"/hands/*.png
cp "$src"/hands/*.png "$out/hands/"
echo "synced $(ls "$out" "$out/hands" | grep -c .) files into $out"
