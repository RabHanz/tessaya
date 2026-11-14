#!/usr/bin/env bash
# Copy ~/.t3/baton to ~/.t3/tessaya. Never deletes, never overwrites a file that is already there,
# so it is safe to run again. Readers take the newer of the two copies (packages/tessaya-shared stateDir).
#
#   state-migrate.sh            copy everything except live-queue/
#   state-migrate.sh --queue    also copy live-queue/. Only once the server and the live agent
#                               (baton-live-acp.mjs) on this box are both the build that knows the new path,
#                               otherwise one side writes where the other does not look.
set -euo pipefail
old="$HOME/.t3/baton"; new="$HOME/.t3/tessaya"
[ -d "$old" ] || { echo "nothing to migrate: $old does not exist"; exit 0; }
mkdir -p "$new"
for e in "$old"/* "$old"/.[!.]*; do
  [ -e "$e" ] || continue
  [ "$(basename "$e")" = live-queue ] && [ "${1:-}" != --queue ] && { echo "skip live-queue (use --queue)"; continue; }
  cp -a --no-clobber "$e" "$new"/
done
echo "copied $old -> $new (old left in place)"
