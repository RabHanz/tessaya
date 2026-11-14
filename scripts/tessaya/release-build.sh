#!/usr/bin/env bash
#
# Build the Linux CLI archive a box runs, the way upstream builds its release.
#
#   scripts/tessaya/release-build.sh <version>      e.g. 0.1.5-tessaya.1
#
# Writes release-cli/t3-<version>-linux-x64.tar.gz and smoke-tests it. The package.json version
# bump is release-time only and is put back afterwards, so the tree stays PIN + series.
set -euo pipefail
. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lib/tessaya-env.sh" 2> /dev/null || true
cd "$(git rev-parse --show-toplevel)"
version="${1:?usage: release-build.sh <version>}"
out="${BATON_RELEASE_DIR:-release-cli}"
[ -z "${TMPDIR:-}" ] || mkdir -p "$TMPDIR"
# shellcheck source=toolchain.sh
source scripts/tessaya/toolchain.sh
export PATH="$PWD/node_modules/.bin:$PATH" # build-exe spawns `vp pack` by name

# The SEA step needs Node >= 25.7; a tree still on Node 24 borrows the newest toolchain Node for it.
sea_node="node"
if [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 26 ]; then
  sea_node="$(ls -d "$baton_toolchain_dir"/node-v2[6-9]*-linux-x64/bin/node 2> /dev/null | sort -V | tail -1)"
  [ -x "$sea_node" ] || { echo "release-build: no Node >= 26 in $baton_toolchain_dir for the SEA step" >&2; exit 1; }
fi

# Reuse the installed release's Rust resource monitor rather than needing cargo here; CI passes
# BATON_RESOURCE_MONITOR_DIR (laid out like dist/resource-monitor) from a fresh cargo build.
monitor="${BATON_RESOURCE_MONITOR_DIR:-}"
if [ -z "$monitor" ]; then
  active="$(node -p 'require(process.env.HOME + "/.t3/runtime/service-state.json").activeVersion')"
  monitor="$HOME/.t3/runtime/versions/$active/resource-monitor"
fi
[ -d "$monitor" ] || { echo "release-build: no resource monitor at $monitor" >&2; exit 1; }

restore() { git diff --name-only -- '*package.json' apps/server/src/home/R1VoiceBundle.ts | xargs -r git checkout -q --; }
trap restore EXIT

# Memory recall's model (MEM-13): fetched and checked against its pinned sha256, then copied beside the executable.
node scripts/tessaya/fetch-memory-model.mjs
node scripts/update-release-package-versions.ts "$version"
# The R1 voice bundle, pinned into this build (R1Loop fetches it on the first R1's pairing). CI passes the recogniser.
if [ -n "${BATON_R1_RECOGNIZER:-}" ]; then
  bash scripts/tessaya/build-r1-voice.sh "$version" "$BATON_R1_RECOGNIZER" "$out"
fi
nice -n 10 pnpm exec vp run --filter t3 build
PATH="$(dirname "$sea_node"):$PATH" nice -n 10 node apps/server/scripts/cli.ts build-exe
nice -n 10 node scripts/build-cli-archive.ts --platform linux --arch x64 --version "$version" \
  --resource-monitor-dir "$monitor" --output-dir "$out"
# A public archive carries no private persona layer (apps/server/src/tessaya/PersonaLayers.ts); internal builds skip this.
[ "${TESSAYA_INTERNAL:-}" = "1" ] || node scripts/tessaya/check-no-private-layer.mjs apps/server/dist
node scripts/smoke-cli-archive.ts --archive "$out/t3-$version-linux-x64.tar.gz" --expect-version "$version"
ls -la "$out/t3-$version-linux-x64.tar.gz"
