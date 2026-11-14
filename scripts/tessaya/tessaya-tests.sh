#!/usr/bin/env bash
#
# Every Tessaya test file, workspace by workspace. baton-ci runs only the test files a PR changes, so
# a Tessaya test that a later change on main made stale is never run again; the nightly runs this to
# catch it (GEN-22). Browser tests and upstream's own tests are upstream's suites' job.
#
#   scripts/tessaya/tessaya-tests.sh
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

failed=()
for ws in packages/tessaya-contracts packages/tessaya-shared packages/tessaya-voice packages/client-runtime \
  apps/server apps/desktop apps/web; do
  files="$(git ls-files "$ws" | grep -E '\.test\.tsx?$' | grep -vE '\.browser\.test\.' |
    grep -E '(baton|Baton|Tessaya|Phone|Intent|WorkSession|Fleet)' | sed "s|^$ws/||" || true)"
  [ -n "$files" ] || continue
  echo "== $ws: $(printf '%s\n' "$files" | wc -l | tr -d ' ') test files"
  # shellcheck disable=SC2086 # one argument per file
  (cd "$ws" && vp test run $files) || failed+=("$ws")
done
if [ "${#failed[@]}" -gt 0 ]; then
  echo "tessaya-tests: failures in ${failed[*]}" >&2
  exit 1
fi
echo "tessaya-tests: all passed"
