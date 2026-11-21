#!/usr/bin/env bash
# ci/kaggle.sh GROUP: baton-ci inside a Kaggle CPU kernel (root, internet, no credential). VentureOS's
# scripts/ci/kaggle-repo/route.sh packs one head, runs one kernel per group and posts the `kaggle-ci` status.
# CI never runs on our machines, and this repo is private (Director, 21-22 Nov). Keep in step with baton-ci.yml.
#   checks  verify job, typecheck gate, lint
#   tests   every test Tessaya added since the upstream pin (no history in the pack, so main's rule for every head)
#   server  the release build starts
set -euo pipefail
G="${1:?group}"
cd "$(dirname "$0")/.."
export DEBIAN_FRONTEND=noninteractive CI=1
node_v="$(sed -nE 's/.*"node": "([0-9.]+)".*/\1/p' package.json | head -1)"
curl -fsSL --retry 5 "https://nodejs.org/dist/v$node_v/node-v$node_v-linux-x64.tar.xz" | tar -xJ -C /opt
export PATH="/opt/node-v$node_v-linux-x64/bin:$PWD/node_modules/.bin:$PATH"
corepack enable
pnpm install --frozen-lockfile > /tmp/install.log 2>&1 || { tail -40 /tmp/install.log; exit 1; }

case "$G" in
  checks)
    node scripts/tessaya/check-notices.mjs
    node --test scripts/tessaya/check-notices.test.mjs scripts/tessaya/check-no-private-layer.test.mjs
    node --test scripts/tessaya/status-file.test.mjs scripts/tessaya/cloud-logins.test.mjs scripts/tessaya/live/answer-review.test.mjs scripts/tessaya/live/baton-live-acp.test.mjs
    bash scripts/tessaya/patches.sh verify
    node scripts/tessaya/guard-private.mjs
    bash scripts/tessaya/patches.test.sh
    bash scripts/tessaya/tessaya-resume.test.sh
    node scripts/tessaya/typecheck-gate.mjs
    vp lint --report-unused-disable-directives ;;
  tests)
    pin="$(tr -d '[:space:]' < vendor-patches/t3code/PIN)"
    git fetch -q --no-tags --filter=blob:none https://github.com/pingdotgg/t3code.git "$pin"
    added="$(git diff --no-renames --name-only --diff-filter=A "$pin" HEAD)"
    for ws in apps/server apps/desktop packages/tessaya-shared packages/tessaya-voice packages/tessaya-contracts apps/web; do
      files=$(echo "$added" | grep -E "^$ws/.*\.test\.tsx?$" | grep -vE '\.browser\.test\.' | sed "s|^$ws/||" || true)
      [ -z "$files" ] && continue
      echo "== $ws: $(echo $files | wc -w) test files"
      (cd "$ws" && vp test run $files)
    done ;;
  server)
    command -v cargo > /dev/null || { curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal > /dev/null; . "$HOME/.cargo/env"; }
    cargo build --release --manifest-path native/resource-monitor/Cargo.toml
    mkdir -p /tmp/resource-monitor/linux-x64 && cp native/resource-monitor/target/release/t3-resource-monitor /tmp/resource-monitor/linux-x64/
    BATON_RESOURCE_MONITOR_DIR=/tmp/resource-monitor NODE_ENV=production bash scripts/tessaya/release-build.sh 0.0.0-tessaya.0 ;;
  *) echo "unknown group $G"; exit 2 ;;
esac
