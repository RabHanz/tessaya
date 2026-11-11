#!/usr/bin/env bash
#
# Move Baton to a newer upstream T3 Code: bump the pin, re-apply the patch series, run the gates,
# and open the pull request. Mechanical by design; the one thing it hands a human is a patch that
# no longer applies.
#
#   scripts/tessaya/upstream-sync.sh [--to <upstream-ref>] [--report-only] [--no-gates]
#                                  [--no-pr] [--branch <name>] [--base <ref>]
#
#   --to        the upstream commit to move to (default upstream/main)
#   --base      where the sync branch starts (default origin/main)
#
# What it does, in order:
#   1. fetch; report upstream's commits and which of them touch a path the series patches
#   2. branch, `patches.sh rebase <to>`: upstream paths become <to>'s, the series re-applies --3way
#   3. regenerate pnpm-lock.yaml (REGENERATED: never patched, re-resolved from upstream's)
#   4. commit it as one squashed import on the base: no upstream commit becomes an ancestor of main
#   5. `gates.sh --install --build`
#   6. push and open the PR with the report as the body
#
# Exit codes: 0 done or nothing to do, 1 refused, 2 a patch needs a human, 3 gates failed.
# The tree is left on the sync branch in cases 2 and 3 so the fix starts from it.

set -euo pipefail
. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lib/tessaya-env.sh" 2> /dev/null || true
cd "$(git rev-parse --show-toplevel)"
export LC_ALL=C

to="upstream/main" base="origin/main" branch="" report_only=0 gates=1 open_pr=1
while [ $# -gt 0 ]; do
  case "$1" in
    --to) shift; to="${1:?}" ;;
    --base) shift; base="${1:?}" ;;
    --branch) shift; branch="${1:?}" ;;
    --report-only) report_only=1 ;;
    --no-gates) gates=0 ;;
    --no-pr) open_pr=0 ;;
    *) echo "upstream-sync: unknown argument '$1'" >&2; exit 1 ;;
  esac
  shift
done

[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "upstream-sync: the working tree is dirty" >&2; exit 1; }

echo "==> Fetching"
git fetch --quiet origin main
git fetch --quiet upstream main
target="$(git rev-parse --verify "$to^{commit}")"
pin="$(git show "$base:vendor-patches/t3code/PIN" | tr -d '[:space:]')"
ahead="$(git rev-list --count "$pin..$target")"
behind_days=$(( ($(git log -1 --format=%ct "$target") - $(git log -1 --format=%ct "$pin")) / 86400 ))

report="${BATON_SYNC_REPORT:-$(mktemp)}"
patched="$(git show "$base:vendor-patches/t3code/series" | grep -vE '^\s*(#|$)' |
  while read -r p; do git show "$base:vendor-patches/t3code/$p" | sed -n 's|^diff --git a/\(.*\) b/.*$|\1|p'; done | sort -u)"
upstream_changed="$(git diff --no-renames --name-only "$pin" "$target" | grep -v '^\.repos/' | sort -u || true)"
touched="$(comm -12 <(printf '%s\n' "$patched") <(printf '%s\n' "$upstream_changed") || true)"

effect_of() { git show "$1:pnpm-workspace.yaml" 2> /dev/null | sed -n 's/^  effect: *//p' | sed -n 1p; }
effect_from="$(effect_of "$pin")" effect_to="$(effect_of "$target")"
{
  printf '## Upstream sync\n\n| | |\n| --- | --- |\n'
  printf '| Pin now | `%s` (%s) |\n' "$(git rev-parse --short "$pin")" "$(git log -1 --format=%cs "$pin")"
  printf '| Moving to | `%s` (%s) |\n' "$(git rev-parse --short "$target")" "$(git log -1 --format=%cs "$target")"
  printf '| Upstream commits | %s (%s days of upstream) |\n' "$ahead" "$behind_days"
  printf '| Patched paths upstream also changed | %s |\n\n' "$(printf '%s' "$touched" | grep -c . || true)"
  # Tessaya's own code is written against upstream's Effect; a new Effect version is the usual reason it breaks.
  if [ "$effect_from" != "$effect_to" ]; then
    printf '**Upstream moves Effect from %s to %s.** Expect Tessaya code (apps/*/src/baton, packages/baton-*) to need\n' "$effect_from" "$effect_to"
    printf 'changes for its new APIs and diagnostics: a red typecheck or lint in those paths is that, not a conflict.\n\n'
  fi
  if [ -n "$touched" ]; then printf '%s\n' "$touched" | sed 's/^/- `/; s/$/`/'; printf '\n'; fi
  printf '### Upstream commits (newest 60)\n\n'
  git log --no-merges --pretty='- `%h` %s' "$pin..$target" | sed -n "1,60p"
  printf '\n'
} > "$report"

if [ "$ahead" -eq 0 ]; then echo "Nothing to sync: the pin is upstream's tip."; exit 0; fi
cat "$report"
[ "$report_only" -eq 0 ] || exit 0

branch="${branch:-baton/upstream-sync-$(date -u +%Y%m%d)-$(git rev-parse --short "$target")}"
echo "==> $branch from $base"
git checkout --quiet -B "$branch" "$base"

set +e
bash scripts/tessaya/patches.sh rebase "$target"
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  printf '\n### Result\n\nThe series stopped (exit %s). See the CONFLICT lines above.\n' "$rc" >> "$report"
  exit "$rc"
fi

# OURS files keep Tessaya's text whole, so upstream's change to them is dropped: it goes in the report (and the PR body)
# for a person to read, never silently.
ours_changed="$( (grep -vE '^\s*(#|$)' vendor-patches/t3code/OURS 2> /dev/null || true) | while read -r f; do
  git diff --quiet "$pin" "$target" -- "$f" || echo "$f"; done)"
if [ -n "$ours_changed" ]; then
  { printf '\n### Upstream changes not taken (OURS: Tessaya keeps its own file)\n\nRead these: a contact, icon or policy change may need doing in Tessaya'"'"'s own text.\n\n```diff\n'
    git diff "$pin" "$target" -- $ours_changed | head -200
    printf '```\n'
  } >> "$report"
fi

echo "==> Regenerating pnpm-lock.yaml"
# A new pin can name a new Node or pnpm; install it first (idempotent, checksum-verified).
bash scripts/tessaya/toolchain-install.sh > /dev/null
# shellcheck source=toolchain.sh
source scripts/tessaya/toolchain.sh
nice -n 10 pnpm install --lockfile-only --silent
git add -A

tree="$(git write-tree)"
commit="$(git commit-tree "$tree" -p "$(git rev-parse HEAD)" \
  -m "chore(upstream): import T3 Code $(git rev-parse --short "$target") ($ahead commits)" \
  -m "Upstream https://github.com/pingdotgg/t3code at $target (MIT, Copyright T3 Tools Inc.). Pin $(git rev-parse --short "$pin") -> $(git rev-parse --short "$target"); patch series re-applied by scripts/tessaya/patches.sh rebase.")"
git reset --quiet --hard "$commit"
bash scripts/tessaya/patches.sh verify

if [ "$gates" -eq 1 ]; then
  set +e
  bash scripts/tessaya/gates.sh --install --build 2>&1 | tee "${report%.md}.gates.log"
  rc="${PIPESTATUS[0]}"
  set -e
  if [ "$rc" -ne 0 ]; then
    { printf '\n### Result\n\nGates failed at **%s**. Log: `%s`\n' \
        "$(grep '^==> ' "${report%.md}.gates.log" | tail -1 | sed 's/^==> //')" "${report%.md}.gates.log"
      [ "$effect_from" = "$effect_to" ] || printf '\nUpstream moved Effect %s -> %s in this range (see above).\n' "$effect_from" "$effect_to"
      printf '\n```\n'; grep -E 'error|FAIL|✗|×' "${report%.md}.gates.log" | head -30 || true; printf '```\n'
    } >> "$report"
    exit 3
  fi
  printf '\n### Result\n\nSeries applied, lockfile regenerated, gates passed (typecheck, lint, tests, build).\n' >> "$report"
fi

git push --quiet -u origin "$branch"
bash scripts/tessaya/disable-upstream-workflows.sh || echo "warn: could not check upstream workflows"
if [ "$open_pr" -eq 1 ]; then
  gh pr create --base main --head "$branch" \
    --title "chore(upstream): import T3 Code $(git rev-parse --short "$target") ($ahead commits)" --body-file "$report"
fi
