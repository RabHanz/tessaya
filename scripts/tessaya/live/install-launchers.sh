#!/usr/bin/env bash
# Installs the live-session launchers into ~/.local/bin (LIVE-ACCOUNT), so every new Claude session gets its own
# config dir however it starts:
#   tessaya-claude   the wrapper (the server's respawn and `tessaya` call it by this name)
#   tessaya          this checkout's scripts/tessaya/tessaya; the box's own `roots=` line is kept
#   baton            the old name: a link to tessaya
#   claude           with --claude: a link to tessaya-claude ahead of nvm's claude, for terminals and `cswap run`
# Re-run after pulling. Safe to repeat; a replaced tessaya or baton file is kept as <name>.bak-<date>.
set -euo pipefail

here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
bin="${TESSAYA_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$bin"

install -m 755 "$here/tessaya-claude" "$bin/tessaya-claude"
echo "installed $bin/tessaya-claude"

new="$(mktemp)"
cp "$here/../tessaya" "$new"
# The box's own roots= line lives in whichever file it was installed as, tessaya or (before the rename) baton.
prev="$bin/tessaya"
[[ -f "$prev" || -L "$bin/baton" || ! -f "$bin/baton" ]] || prev="$bin/baton"
if [[ -f "$prev" ]]; then
  roots="$(grep -m1 '^roots=' "$prev" || true)"
  [[ -z "$roots" ]] || sed -i "s|^roots=.*|$(printf '%s' "$roots" | sed 's/[&|]/\\&/g')|" "$new"
fi
for old in "$bin/tessaya" "$bin/baton"; do
  [[ -f "$old" && ! -L "$old" ]] && ! cmp -s "$new" "$old" && cp "$old" "$old.bak-$(date +%Y%m%d)"
done
install -m 755 "$new" "$bin/tessaya"
rm -f "$new"
ln -sfn tessaya "$bin/baton"
echo "installed $bin/tessaya (baton links to it)"

if [[ "${1:-}" == "--claude" ]]; then
  if [[ -e "$bin/claude" && ! -L "$bin/claude" ]]; then
    echo "$bin/claude is a real file; left as it is" >&2
  else
    ln -sfn "$bin/tessaya-claude" "$bin/claude"
    echo "linked $bin/claude -> tessaya-claude (it finds the real claude by skipping itself)"
  fi
fi
