# shellcheck shell=bash
# Source this to put the Node and pnpm the tree declares first on PATH.
#
# package.json `engines.node` (when an exact version) and `packageManager` name the toolchain.
# Exact versions live user-local under $BATON_TOOLCHAIN_DIR (default ~/dev/toolchain), as node-v<ver>-linux-x64/ with pnpm installed into it. A range
# (upstream before 2026-10 said ^24.13.1) keeps whatever node is already on PATH.
# Settings are renamed TESSAYA_*; the old BATON_* names still work. Drop them once no unit or workflow sets them.
BATON_TOOLCHAIN_DIR="${TESSAYA_TOOLCHAIN_DIR:-${BATON_TOOLCHAIN_DIR:-}}"

baton_toolchain_dir="${BATON_TOOLCHAIN_DIR:-}"
if [ -z "$baton_toolchain_dir" ]; then
  for d in "$HOME/dev/toolchain"; do
    [ -d "$d" ] && baton_toolchain_dir="$d" && break
  done
fi

baton_node_want="$(node -p 'require("./package.json").engines?.node ?? ""' 2> /dev/null || true)"
baton_pnpm_want="$(node -p '(require("./package.json").packageManager ?? "").replace(/^pnpm@/, "")' 2> /dev/null || true)"

if [[ "$baton_node_want" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && [ "$(node -v 2> /dev/null)" != "v$baton_node_want" ]; then
  baton_node_bin="$baton_toolchain_dir/node-v$baton_node_want-linux-x64/bin"
  if [ -x "$baton_node_bin/node" ]; then
    export PATH="$baton_node_bin:$PATH"
  else
    echo "toolchain: node $baton_node_want wanted, not in $baton_toolchain_dir. scripts/tessaya/toolchain-install.sh" >&2
    return 1 2> /dev/null || exit 1
  fi
fi

if [ -n "$baton_pnpm_want" ] && [ "$(pnpm -v 2> /dev/null)" != "$baton_pnpm_want" ]; then
  echo "toolchain: pnpm $baton_pnpm_want wanted, have $(pnpm -v 2> /dev/null || echo none). scripts/tessaya/toolchain-install.sh" >&2
  return 1 2> /dev/null || exit 1
fi
echo "toolchain: node $(node -v), pnpm $(pnpm -v)"
