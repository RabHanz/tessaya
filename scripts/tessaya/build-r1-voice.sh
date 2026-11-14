#!/usr/bin/env bash
#
# Build the R1 voice loop bundle a server fetches when its first R1 pairs (apps/server/src/home/R1Loop.ts): Node, the
# loop (packages/tessaya-voice/src/room), its own recogniser, Pocket TTS and the small models that live in git. The large
# models are pinned in R1VoiceInstall.ts and fetched by the server itself.
#
#   scripts/tessaya/build-r1-voice.sh <version> <tessaya-recognizer binary> [out dir]
#
# Writes <out>/r1-voice-<version>-linux-x64.tar.gz and pins it in apps/server/src/home/R1VoiceBundle.ts, so the server
# built next carries its address, size and sha256. release-build.sh puts that file back afterwards.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
version="${1:?usage: build-r1-voice.sh <version> <recognizer binary> [out dir]}"
recognizer="${2:?usage: build-r1-voice.sh <version> <recognizer binary> [out dir]}"
out="${3:-release-cli}"
repo="${GITHUB_REPOSITORY:-RabHanz/tessaya}"

NODE_VERSION=24.22.3
NODE_SHA256=4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb
POCKET=pocket-tts-3.3.0-x86_64-unknown-linux-gnu
POCKET_SHA256=9abff0aa138a804e44052952d8c3bdaae247fb267ca8f4b83fe178897d1a0559

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
root="$stage/r1-voice"
mkdir -p "$root/node/bin" "$root/app/node_modules" "$root/bin" "$root/models/pocket/english" "$out"

fetch() { # url sha256 file
  curl -fsSL --retry 3 -o "$3" "$1"
  echo "$2  $3" | sha256sum -c --quiet -
}

fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" "$NODE_SHA256" "$stage/node.tar.xz"
tar -xJf "$stage/node.tar.xz" -C "$stage" "node-v$NODE_VERSION-linux-x64/bin/node" "node-v$NODE_VERSION-linux-x64/LICENSE"
mv "$stage/node-v$NODE_VERSION-linux-x64/bin/node" "$root/node/bin/node"
mv "$stage/node-v$NODE_VERSION-linux-x64/LICENSE" "$root/node/LICENSE"

fetch "https://github.com/kyutai-labs/pocket-tts/releases/download/v4.0.1/$POCKET.tar.gz" "$POCKET_SHA256" "$stage/pocket.tar.gz"
tar -xzf "$stage/pocket.tar.gz" -C "$stage"
mv "$stage/$POCKET/pocket-tts" "$stage/$POCKET/LICENSE" "$root/models/pocket/"
# Pocket's own config (apps/desktop/src/baton/voice/pocketConfigs.ts) with its weights beside it; Pocket runs there.
node -e '
  const [from, to] = process.argv.slice(1);
  import(from).then((m) => require("node:fs").writeFileSync(to, m.POCKET_CONFIG_FULL.replaceAll("{dir}", ".")));
' "$PWD/apps/desktop/src/baton/voice/pocketConfigs.ts" "$root/models/pocket/english/config.yaml"

install -m 755 "$recognizer" "$root/bin/tessaya-recognizer"
cp native/baton-dictation/models/{silero_vad,melspectrogram,embedding_model,tessaya,alfred,freya}.onnx native/baton-dictation/models/LICENSE "$root/models/"

scripts/node_modules/.bin/esbuild packages/tessaya-voice/src/room/main.ts packages/tessaya-voice/src/room/replay.ts \
  --bundle --platform=node --format=esm --target=node24 --outdir="$root/app" --out-extension:.js=.mjs \
  --external:onnxruntime-node --log-level=warning \
  --banner:js="import { createRequire as __r1Require } from 'node:module'; const require = __r1Require(import.meta.url);"
# onnxruntime-node for this platform only (the package carries every OS's binaries).
ort="$(readlink -f packages/tessaya-voice/node_modules/onnxruntime-node)"
mkdir -p "$root/app/node_modules/onnxruntime-node/bin/napi-v6/linux"
cp -r "$ort/package.json" "$ort/dist" "$root/app/node_modules/onnxruntime-node/"
cp -r "$ort/bin/napi-v6/linux/x64" "$root/app/node_modules/onnxruntime-node/bin/napi-v6/linux/"
cp -rL "$(readlink -f "$ort/../onnxruntime-common")" "$root/app/node_modules/onnxruntime-common"
cp packages/tessaya-voice/LICENSE "$root/app/LICENSE"
# Attribution travels with the bundle (Parakeet and Pocket are CC BY 4.0).
cp docs/baton/THIRD_PARTY_NOTICES.md "$root/NOTICE.md"

"$root/node/bin/node" -e 'require(process.argv[1] + "/app/node_modules/onnxruntime-node")' "$root"

bundle="r1-voice-$version-linux-x64.tar.gz"
tar -czf "$out/$bundle" -C "$root" .
sha="$(sha256sum "$out/$bundle" | cut -d' ' -f1)"
size="$(stat -c %s "$out/$bundle")"
echo "$sha  $bundle" > "$out/$bundle.sha256"
cat > apps/server/src/home/R1VoiceBundle.ts << EOF
/** Written by scripts/tessaya/build-r1-voice.sh for a release build; null in every other build. */
export const R1_VOICE_BUNDLE: {
  readonly platform: string;
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
} | null = {
  platform: "linux-x64",
  url: "https://github.com/$repo/releases/download/server-$version/$bundle",
  size: $size,
  sha256: "$sha",
};
EOF
echo "r1-voice bundle: $out/$bundle ($size bytes, sha256 $sha)"
