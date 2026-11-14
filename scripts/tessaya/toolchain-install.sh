#!/usr/bin/env bash
# Install the Node and pnpm this tree's package.json names, user-local, checksum-verified.
#   scripts/tessaya/toolchain-install.sh            into $BATON_TOOLCHAIN_DIR or the default
# Node comes from nodejs.org with SHASUMS256.txt checked; pnpm is installed into that Node.
set -euo pipefail
# Settings are renamed TESSAYA_*; the old BATON_* names still work. Drop them once no unit or workflow sets them.
BATON_TOOLCHAIN_DIR="${TESSAYA_TOOLCHAIN_DIR:-${BATON_TOOLCHAIN_DIR:-}}"
. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lib/tessaya-env.sh" 2> /dev/null || true
cd "$(git rev-parse --show-toplevel)"

dir="${BATON_TOOLCHAIN_DIR:-}"
[ -n "$dir" ] || dir="$HOME/dev/toolchain"
mkdir -p "$dir"

node_ver="$(node -p 'require("./package.json").engines.node')"
pnpm_ver="$(node -p 'require("./package.json").packageManager.replace(/^pnpm@/, "")')"
[[ "$node_ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "engines.node is a range ($node_ver); nothing to pin"; exit 0; }

name="node-v$node_ver-linux-x64"
if [ ! -x "$dir/$name/bin/node" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  base="https://nodejs.org/dist/v$node_ver"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  curl -fsSL "$base/$name.tar.xz" -o "$tmp/$name.tar.xz"
  (cd "$tmp" && grep " $name.tar.xz\$" SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$tmp/$name.tar.xz" -C "$dir"
fi
export PATH="$dir/$name/bin:$PATH"
[ "$(pnpm -v 2> /dev/null || true)" = "$pnpm_ver" ] || npm install -g --silent "pnpm@$pnpm_ver"
echo "node $(node -v), pnpm $(pnpm -v) in $dir/$name"
