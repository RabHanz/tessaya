#!/bin/bash
# Bundles cleanup-lab.ts into one file for the laptop: bundle-cleanup.sh <outfile.mjs>
set -e
cd "$(dirname "$0")/../../.."
esbuild="$(ls -d node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild | tail -1)"
node "$esbuild" scripts/tessaya/voice-lab/cleanup-lab.ts --bundle --platform=node --format=esm \
  --target=node22 --alias:@t3tools/tessaya-shared/dictationCleanup=./packages/tessaya-shared/src/dictationCleanup.ts \
  --log-level=warning --outfile="$1"
