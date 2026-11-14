#!/usr/bin/env bash
#
# The assistant's hands, measured (D144, issue #52).
#
#   scripts/tessaya/computer-use-harness.sh dry
#       Replays recorded tool traces through Baton's real tool server and gate with a host that moves
#       no pointer and takes no screenshot. Safe at any time, on any machine.
#
#   LAB_AWAY=<ISO time he said he was away> scripts/tessaya/computer-use-harness.sh real <out-dir>
#       The six tasks, three runs each, on this Windows desktop, with the pointer moving. Only when he
#       is away and has been told. Writes results.json and notes.jsonl to <out-dir>.
set -euo pipefail
. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lib/tessaya-env.sh" 2> /dev/null || true
cd "$(git rev-parse --show-toplevel)/apps/desktop"
case "${1:-}" in
  dry)
    vp test run src/tessaya/agent/agentHarness.test.ts src/tessaya/screen/smoke/agentTasks.test.ts
    ;;
  real)
    out="$(realpath -m "${2:?out dir}")"
    : "${LAB_AWAY:?set LAB_AWAY to the time he said he was away, as an ISO time}"
    case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ;; *) echo "The real run needs the Windows desktop." >&2; exit 2 ;; esac
    mkdir -p "$out" node_modules/.cache/baton-smoke
    esbuild="$(ls -d ../../node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild | tail -1)"
    "$esbuild" src/tessaya/screen/smoke/agentLab.ts --bundle --platform=node --format=cjs \
      --external:electron --external:onnxruntime-node --log-level=warning \
      --outfile=node_modules/.cache/baton-smoke/agentLab.cjs
    BATON_LAB=1 LAB_OUT="$out" "$(node -p 'require("electron")')" node_modules/.cache/baton-smoke/agentLab.cjs
    ;;
  *)
    echo "usage: computer-use-harness.sh dry | real <out-dir>" >&2
    exit 2
    ;;
esac
