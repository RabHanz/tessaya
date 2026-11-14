#!/usr/bin/env bash
#
# Real run of the screen companion (D84) on Linux, headless: Xvfb + a compositor (so the
# transparent overlay is transparent), the desktop's own screen modules bundled into a small
# Electron app, his signed-in `claude` answering, xdotool as the hands.
#
#   scripts/tessaya/screen-smoke.sh <out-dir> [look,teach,drive]
#
# Needs: Xvfb, xvfb-run, xdotool and xcompmgr on PATH (a user-local `dpkg -x` of the debs is
# enough: set BATON_SMOKE_XBIN to its usr/bin), and `pnpm install` done. Frames, the approval
# boxes' text and results.json land in <out-dir>.
set -euo pipefail
# Settings are renamed TESSAYA_*; the old BATON_* names still work. Drop them once no unit or workflow sets them.
BATON_SMOKE_XBIN="${TESSAYA_SMOKE_XBIN:-${BATON_SMOKE_XBIN:-}}"
. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lib/tessaya-env.sh" 2> /dev/null || true
cd "$(git rev-parse --show-toplevel)/apps/desktop"
out="$(realpath -m "${1:?out dir}")"
only="${2:-look,teach,drive}"
mkdir -p "$out" node_modules/.cache/baton-smoke
if [ -n "${BATON_SMOKE_XBIN:-}" ]; then
  export PATH="$BATON_SMOKE_XBIN:$PATH"
  export LD_LIBRARY_PATH="$BATON_SMOKE_XBIN/../lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
fi
esbuild="$(ls -d ../../node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild | tail -1)"
"$esbuild" src/baton/screen/smoke/screenSmoke.ts --bundle --platform=node --format=cjs \
  --external:electron --external:onnxruntime-node --log-level=warning \
  --outfile=node_modules/.cache/baton-smoke/smoke.cjs
electron="$(node -p 'require("electron")')"
BATON_SMOKE_OUT="$out" BATON_SMOKE_ONLY="$only" xvfb-run -a -s "-screen 0 1600x1000x24" \
  bash -c 'xcompmgr -n & sleep 1; "$0" --no-sandbox --disable-gpu node_modules/.cache/baton-smoke/smoke.cjs' "$electron"
