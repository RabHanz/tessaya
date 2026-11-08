#!/usr/bin/env bash
#
# Baton's edits to upstream T3 Code, kept as a named patch series over a pinned upstream commit.
#
# The tree at the repo root IS the vendor tree: upstream's files at the pin, plus this series,
# plus files Baton adds. Upstream stays at the root rather than under vendor/ because its release
# chain, workspace globs and root configs all assume the root; moving it would itself need patches
# (D76). What makes it a vendor tree is the rule `verify` enforces: no upstream path differs from
# the pin except through a patch in the series.
#
#   vendor-patches/t3code/PIN          upstream commit the tree is built on
#   vendor-patches/t3code/series       patch names, applied in order
#   vendor-patches/t3code/REGENERATED  upstream paths changed by regeneration, not by patch
#   vendor-patches/t3code/NNNN-*.patch one concern each; every edited upstream path in exactly one
#
# Usage:
#   patches.sh verify [<commit>]          <commit> (default HEAD) == PIN + series on upstream paths
#   patches.sh refresh [--assign <patch> <path>...]...
#                                         rewrite every patch from the working tree; new upstream
#                                         edits must be assigned to a patch once (repeatable)
#   patches.sh rebase <upstream-commit>   move the working tree to a new pin and re-apply the
#                                         series with --3way (exit 2 = conflicts left in the tree)
#   patches.sh files [<patch>]            upstream paths a patch, or the whole series, touches
#
# Exit codes: 0 ok, 1 refused or drift found, 2 rebase left conflicts for a human.

set -euo pipefail
. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lib/tessaya-env.sh" 2> /dev/null || true

export LC_ALL=C
cd "$(git rev-parse --show-toplevel)"
dir="${BATON_PATCH_DIR:-vendor-patches/t3code}"

die() { echo "patches: $*" >&2; exit 1; }
[ -f "$dir/PIN" ] || die "no $dir/PIN"
pin="$(tr -d '[:space:]' < "$dir/PIN")"
series() { grep -vE '^\s*(#|$)' "$dir/series" || true; }
regenerated() { [ -f "$dir/REGENERATED" ] && grep -vE '^\s*(#|$)' "$dir/REGENERATED" || true; }
patch_paths() { sed -n 's|^diff --git a/\(.*\) b/.*$|\1|p' "$1"; }
# Blob ids on stdin, fetched from the pin's remote in one request rather than one lazy fetch per
# file. The flags are git's own lazy fetch's; without noop negotiation a batch fails its connectivity check.
fetch_blobs() {
  git -c fetch.negotiationAlgorithm=noop fetch --quiet --no-tags --no-write-fetch-head \
    --recurse-submodules=no --filter=blob:none --stdin t3code-pin 2> /dev/null || true
}

# main carries no upstream history (upstream enters as squashed imports), so a fresh clone may not
# have the pin. Fetch it blobless from upstream through a remote that exists only for this run and,
# being a promisor, also serves any pin blob a later step reads.
upstream_url="${TESSAYA_UPSTREAM_URL:-https://github.com/pingdotgg/t3code.git}"
have_pin=1
git cat-file -e "$pin^{commit}" 2> /dev/null || have_pin=0
n="${GIT_CONFIG_COUNT:-0}"
export "GIT_CONFIG_KEY_$n=remote.t3code-pin.url" "GIT_CONFIG_VALUE_$n=$upstream_url" \
  "GIT_CONFIG_KEY_$((n + 1))=remote.t3code-pin.promisor" "GIT_CONFIG_VALUE_$((n + 1))=true" \
  "GIT_CONFIG_KEY_$((n + 2))=remote.t3code-pin.partialclonefilter" "GIT_CONFIG_VALUE_$((n + 2))=blob:none" \
  GIT_CONFIG_COUNT=$((n + 3))
if [ "$have_pin" -eq 0 ]; then
  echo "patches: fetching PIN $pin from $upstream_url" >&2
  git fetch --quiet --no-tags --filter=blob:none t3code-pin "$pin" ||
    die "PIN $pin is not a commit here and could not be fetched from $upstream_url"
  # The blobs the series patches.
  git ls-tree -r "$pin" -- $(while read -r p; do patch_paths "$dir/$p"; done < <(series)) |
    awk '$2 == "blob" { print $3 }' | fetch_blobs
fi

# The pin's index with the whole series applied, as a tree id. Never touches the working tree.
series_tree() {
  local idx
  idx="$(mktemp)"
  GIT_INDEX_FILE="$idx" git read-tree "$pin"
  local p
  while read -r p; do
    GIT_INDEX_FILE="$idx" git apply --cached --whitespace=nowarn "$dir/$p" \
      || { rm -f "$idx"; die "$p no longer applies to PIN $pin"; }
  done < <(series)
  GIT_INDEX_FILE="$idx" git write-tree
  rm -f "$idx"
}

cmd_verify() {
  local target="${1:-HEAD}" expected drift pin_paths
  expected="$(series_tree)"
  pin_paths="$(mktemp)"
  git ls-tree -r --name-only "$pin" | sort > "$pin_paths"
  # Paths that differ between PIN+series and the target, limited to paths upstream owns.
  # Everything else that differs is a file Baton added, which needs no patch.
  drift="$(git diff-tree -r --no-renames --name-only "$expected" "$target^{tree}" | sort |
    comm -12 - "$pin_paths" | comm -23 - <(regenerated | sort) || true)"
  rm -f "$pin_paths"
  if [ -n "$drift" ]; then
    echo "patches: these upstream paths differ from PIN + series. Edit them through a patch:" >&2
    echo "         scripts/tessaya/patches.sh refresh [--assign <patch> <path>]" >&2
    printf '  %s\n' $drift >&2
    exit 1
  fi
  echo "patches: ok — $(git rev-parse --short "$target") is upstream $(git rev-parse --short "$pin") + $(series | wc -l | tr -d ' ') patches"
}

cmd_refresh() {
  declare -A owner=()
  local p f
  while read -r p; do
    while read -r f; do owner["$f"]="$p"; done < <(patch_paths "$dir/$p")
  done < <(series)
  # --assign <patch> <path>... ; repeatable: --assign A a1 a2 --assign B b1
  local target=""
  while [ $# -gt 0 ]; do
    if [ "$1" = "--assign" ]; then
      target="${2:?--assign needs a patch name}"
      series | grep -qxF "$target" || die "$target is not in $dir/series"
      shift 2
    else
      [ -n "$target" ] || die "unexpected argument $1"
      owner["$1"]="$target"
      shift
    fi
  done

  # Upstream paths the working tree changes (added files are Baton's own and are excluded).
  local changed unassigned=()
  changed="$(git diff --no-renames --name-only --diff-filter=MDT "$pin" -- . | comm -23 - <(regenerated | sort) || true)"
  for f in $changed; do [ -n "${owner[$f]:-}" ] || unassigned+=("$f"); done
  if [ "${#unassigned[@]}" -gt 0 ]; then
    echo "patches: upstream paths edited but in no patch. Assign each once:" >&2
    printf '  scripts/tessaya/patches.sh refresh --assign <NNNN-name.patch> %s\n' "${unassigned[@]}" >&2
    exit 1
  fi

  while read -r p; do
    local paths=() header tmp
    for f in $changed; do [ "${owner[$f]}" = "$p" ] && paths+=("$f"); done
    if [ "${#paths[@]}" -eq 0 ]; then
      echo "patches: $p is now empty; upstream took it or the edit was reverted. Drop it from series." >&2
      continue
    fi
    # Keep the patch's description: everything above its first diff.
    header="$(sed '/^diff --git /,$d' "$dir/$p" 2> /dev/null || true)"
    tmp="$(mktemp)"
    { [ -n "$header" ] && printf '%s\n\n' "$header"
      git diff --full-index --binary --no-renames "$pin" -- "${paths[@]}"; } > "$tmp"
    mv "$tmp" "$dir/$p"
  done < <(series)
  echo "patches: refreshed $(series | wc -l | tr -d ' ') patches against $(git rev-parse --short "$pin")"
}

cmd_rebase() {
  local new
  new="$(git rev-parse --verify "${1:?rebase needs an upstream commit}^{commit}")"
  [ -z "$(git status --porcelain --untracked-files=no)" ] || die "the working tree is dirty"
  [ "$new" != "$pin" ] || { echo "patches: already on $new"; return 0; }

  # A path Baton added that upstream now adds too cannot be decided mechanically.
  local collide
  collide="$(comm -12 \
    <(git diff --no-renames --name-only --diff-filter=A "$pin" HEAD | sort) \
    <(git diff --no-renames --name-only --diff-filter=A "$pin" "$new" | sort) || true)"
  if [ -n "$collide" ]; then
    echo "patches: upstream now adds paths Tessaya also added. Rename or drop Tessaya's first:" >&2
    printf '  %s\n' $collide >&2
    exit 1
  fi

  echo "==> Upstream paths to $(git rev-parse --short "$new")"
  # The clone is blobless: the changed files, before checkout fetches them one by one (about
  # 10,000 took 20 minutes in the 25b53299b7 import).
  git diff --no-renames --raw --no-abbrev "$pin" "$new" | awk '$2 != "160000" && $4 !~ /^0+$/ { print $4 }' | fetch_blobs
  git checkout -q "$new" -- .
  git diff --no-renames --name-only --diff-filter=D "$pin" "$new" | xargs -r -d '\n' git rm -q --ignore-unmatch --

  echo "==> Re-applying the series"
  local p failed=()
  while read -r p; do
    if git apply --index --3way --whitespace=nowarn "$dir/$p" 2> "$dir/.$p.log"; then
      echo "  ok        $p"
      rm -f "$dir/.$p.log"
    else
      echo "  CONFLICT  $p  (see $dir/.$p.log)"
      failed+=("$p")
    fi
  done < <(series)

  printf '%s\n' "$new" > "$dir/PIN"
  git add "$dir/PIN"
  pin="$new"
  if [ "${#failed[@]}" -gt 0 ]; then
    echo "patches: ${#failed[@]} patch(es) need a human: ${failed[*]}" >&2
    echo "         fix the markers, then: scripts/tessaya/patches.sh refresh && scripts/tessaya/patches.sh verify" >&2
    exit 2
  fi
  cmd_refresh > /dev/null
  git add "$dir"
  echo "patches: series applies to $(git rev-parse --short "$new"); patches refreshed"
}

cmd_files() {
  if [ -n "${1:-}" ]; then patch_paths "$dir/$1"; else
    local p
    while read -r p; do patch_paths "$dir/$p"; done < <(series)
  fi
}

case "${1:-}" in
  verify) shift; cmd_verify "$@" ;;
  refresh) shift; cmd_refresh "$@" ;;
  rebase) shift; cmd_rebase "$@" ;;
  files) shift; cmd_files "$@" ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 1 ;;
esac
