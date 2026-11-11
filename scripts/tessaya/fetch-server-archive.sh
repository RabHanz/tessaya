#!/usr/bin/env bash
#
# Download a server archive built by the "Tessaya server archive" workflow and check its sha256, so a
# deploy needs no local build.
#
#   scripts/tessaya/fetch-server-archive.sh <version> [dir]     e.g. 0.1.5-tessaya.1  (dir defaults to .)
#
# Prints the archive path.
set -euo pipefail
. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lib/tessaya-env.sh" 2> /dev/null || true
version="${1:?usage: fetch-server-archive.sh <version> [dir]}"
dir="${2:-.}"
repo="${TESSAYA_REPO:-${BATON_REPO:-RabHanz/tessaya}}"
name="t3-$version-linux-x64.tar.gz"
mkdir -p "$dir"
gh release download "server-$version" -R "$repo" --dir "$dir" --clobber -p "$name" -p "$name.sha256"
(cd "$dir" && sha256sum -c "$name.sha256" >&2)
echo "$dir/$name"
