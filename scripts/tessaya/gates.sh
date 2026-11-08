#!/usr/bin/env bash
#
# The gates a Baton tree passes before it merges or deploys. Local on purpose: upstream's CI runs
# on Blacksmith runners this repository does not have, so its jobs queue forever here.
#
#   scripts/tessaya/gates.sh [--install] [--build] [--skip-tests]
#
#   --install     pnpm install --frozen-lockfile first (after a sync or a fresh clone)
#   --build       also build the server bundle and web client the release is cut from
#
# Order: patch series (cheapest, catches an unrecorded upstream edit) → typecheck → lint → tests of
# every package Baton adds to or patches → build. Stops at the first failure.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

install=0 build=0 tests=1
for a in "$@"; do
  case "$a" in
    --install) install=1 ;;
    --build) build=1 ;;
    --skip-tests) tests=0 ;;
    *) echo "gates: unknown argument $a" >&2; exit 1 ;;
  esac
done

export TMPDIR="${TMPDIR:-$HOME/tmp}"
mkdir -p "$TMPDIR"
# shellcheck source=toolchain.sh
source scripts/tessaya/toolchain.sh

step() { printf '\n==> %s\n' "$*"; }
# The box's one-heavy-job-at-a-time lock. Set only by a caller that does not already hold it.
heavy_lock="${BATON_HEAVY_LOCK:-}"
started="$(date +%s)"

step "patch series"
bash scripts/tessaya/patches.sh verify
bash scripts/tessaya/patches.test.sh

if [ "$install" -eq 1 ]; then
  step "install"
  nice -n 10 pnpm install --frozen-lockfile
fi

step "typecheck"
nice -n 10 pnpm -s typecheck

step "lint"
nice -n 10 pnpm -s lint

if [ "$tests" -eq 1 ]; then
  # Every package the series patches or Baton adds code to. Not the whole monorepo: marketing,
  # mobile's native checks and the reference repos are upstream's and untouched.
  for pkg in packages/baton-contracts packages/baton-shared packages/client-runtime packages/baton-voice \
    apps/web apps/desktop apps/server; do
    step "test $pkg"
    extra=()
    # Upstream's libsecret helper test compiles native code; a box without pkg-config cannot run it.
    if [ "$pkg" = apps/desktop ] && ! command -v pkg-config > /dev/null; then
      extra=(--exclude scripts/browser-secret-native.test.mjs)
      echo "(no pkg-config: skipping scripts/browser-secret-native.test.mjs)"
    fi
    # Upstream's browser tests carry 15 s timeouts that a loaded box misses; a retry tells a
    # flake from a failure without hiding a test that fails every time. Chromium also drops its
    # connection at load 20+, so the suite runs one file at a time under the box's heavy-work lock.
    lock=()
    if [ "$pkg" = apps/web ]; then
      extra+=(--retry 2 --maxWorkers 1)
      [ -n "$heavy_lock" ] && lock=(flock -w 3600 "$heavy_lock")
    fi
    if [ "$pkg" != apps/web ]; then
      (cd "$pkg" && nice -n 10 "${lock[@]}" pnpm -s test "${extra[@]}")
      continue
    fi
    # --retry reruns a failed test, not a file Chromium failed to import under load; such files get one rerun of
    # their own, so a file that fails twice still fails the gate.
    web_log="$(mktemp)"
    if ! (cd "$pkg" && nice -n 10 "${lock[@]}" pnpm -s test "${extra[@]}") 2>&1 | tee "$web_log"; then
      mapfile -t again < <(sed -n 's/\x1b\[[0-9;]*m//g; s/^ *FAIL  *|browser ([a-z]*)| \(src\/[^ ]*\.test\.tsx\{0,1\}\).*/\1/p' "$web_log" | sort -u)
      [ "${#again[@]}" -gt 0 ] && [ "${#again[@]}" -le 10 ] || { echo "gates: apps/web failed"; exit 1; }
      echo "gates: rerunning ${#again[@]} failed web file(s) once: ${again[*]}"
      (cd "$pkg" && nice -n 10 "${lock[@]}" pnpm -s test --maxWorkers 1 "${again[@]}")
    fi
    rm -f "$web_log"
  done
fi

if [ "$build" -eq 1 ]; then
  step "build"
  nice -n 10 pnpm exec vp run --filter t3 build
fi

printf '\ngates: passed in %ss\n' "$(($(date +%s) - started))"
