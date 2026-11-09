#!/usr/bin/env bash
# Installs the live-session launchers into ~/.local/bin (LIVE-ACCOUNT), so every new Claude session gets its own
# config dir however it starts:
#   tessaya-claude   the wrapper (the server's respawn and `baton` call it by this name)
#   baton            this checkout's scripts/tessaya/tessaya; the box's own `roots=` line is kept
#   claude           with --claude: a link to tessaya-claude ahead of nvm's claude, for terminals and `cswap run`
# Re-run after pulling. Safe to repeat; the previous baton is kept as baton.bak-<date>.
set -euo pipefail

here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
bin="${TESSAYA_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$bin"

install -m 755 "$here/tessaya-claude" "$bin/tessaya-claude"
echo "installed $bin/tessaya-claude"

new="$(mktemp)"
cp "$here/../tessaya" "$new"
if [[ -f "$bin/baton" ]]; then
  roots="$(grep -m1 '^roots=' "$bin/baton" || true)"
  [[ -z "$roots" ]] || sed -i "s|^roots=.*|$(printf '%s' "$roots" | sed 's/[&|]/\\&/g')|" "$new"
  cmp -s "$new" "$bin/baton" || cp "$bin/baton" "$bin/baton.bak-$(date +%Y%m%d)"
fi
install -m 755 "$new" "$bin/baton"
rm -f "$new"
echo "installed $bin/baton"

if [[ "${1:-}" == "--claude" ]]; then
  if [[ -e "$bin/claude" && ! -L "$bin/claude" ]]; then
    echo "$bin/claude is a real file; left as it is" >&2
  else
    ln -sfn "$bin/tessaya-claude" "$bin/claude"
    echo "linked $bin/claude -> tessaya-claude (it finds the real claude by skipping itself)"
  fi
fi
