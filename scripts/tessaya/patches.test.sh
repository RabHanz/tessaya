#!/usr/bin/env bash
# Self-check for patches.sh on a throwaway repository: verify, refresh, a clean rebase, drift,
# a collision, a conflicting rebase, and one an OURS file settles. Run: bash scripts/tessaya/patches.test.sh
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/patches.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"
git init -q -b main .
git config user.email t@t && git config user.name t
ok() { echo "ok   $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }

# upstream A: two files, one to be deleted later
printf 'one\ntwo\nthree\nfour\nfive\n' > up.txt
printf 'gone\n' > old.txt
printf 'lock-a\n' > lock.txt
git add . && git commit -qm A && A="$(git rev-parse HEAD)"

# Baton: edit up.txt line 2, add a file, set up the series
sed -i 's/^two$/two-baton/' up.txt
printf 'ours\n' > baton.txt
printf 'lock-baton\n' > lock.txt
mkdir -p vendor-patches/t3code
echo "$A" > vendor-patches/t3code/PIN
echo 0001-edit.patch > vendor-patches/t3code/series
echo lock.txt > vendor-patches/t3code/REGENERATED
printf 'Subject: edit\n' > vendor-patches/t3code/0001-edit.patch
cp "$script" ./patches.sh
bash patches.sh refresh > /dev/null 2>&1 && fail "refresh accepted an unassigned edit"
bash patches.sh refresh --assign 0001-edit.patch up.txt > /dev/null
grep -q '^Subject: edit$' vendor-patches/t3code/0001-edit.patch || fail "header lost"
git add . && git commit -qm baton
bash patches.sh verify > /dev/null || fail "verify on a consistent tree"
ok "refresh + verify"

# drift: an upstream file edited without a patch
printf 'gone, edited\n' > old.txt && git commit -qam drift
bash patches.sh verify > /dev/null 2>&1 && fail "verify missed drift"
git reset -q --hard HEAD~1
ok "verify catches an edit outside the series"

# upstream B: changes line 5, deletes old.txt; the series must still apply
git checkout -q -b up "$A"
sed -i 's/^five$/five-upstream/' up.txt && git rm -q old.txt && git commit -qam B
B="$(git rev-parse HEAD)"
git checkout -q main
bash patches.sh rebase "$B" > /dev/null
grep -q two-baton up.txt && grep -q five-upstream up.txt || fail "rebase lost a side"
[ ! -e old.txt ] || fail "upstream deletion not taken"
[ "$(cat baton.txt)" = ours ] || fail "baton file touched"
[ "$(cat vendor-patches/t3code/PIN)" = "$B" ] || fail "PIN not moved"
git commit -qam "sync B"
bash patches.sh verify > /dev/null || fail "verify after rebase"
ok "clean rebase keeps both sides and moves the pin"

# collision: upstream adds a path Baton already added
git checkout -q up && printf 'theirs\n' > baton.txt && git add baton.txt && git commit -qm C && C="$(git rev-parse HEAD)"
git checkout -q main
bash patches.sh rebase "$C" > /dev/null 2>&1 && fail "rebase ignored a collision"
ok "rebase refuses a path both sides add"

# conflict: upstream rewrites Baton's line
git checkout -q up && git rm -q baton.txt && sed -i 's/^two$/two-upstream/' up.txt && git commit -qam D && D="$(git rev-parse HEAD)"
git checkout -q main
set +e; bash patches.sh rebase "$D" > /dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 2 ] || fail "conflicting rebase exit $rc, want 2"
grep -q '^<<<<<<<' up.txt || fail "no conflict markers left"
ok "conflicting rebase exits 2 with markers"

# OURS: the same conflict in a file Tessaya replaces whole keeps Tessaya's file, and the sync goes on
git checkout -q -f main && git clean -qfd
echo up.txt > vendor-patches/t3code/OURS && git add vendor-patches/t3code/OURS && git commit -qm ours
bash patches.sh rebase "$D" > /dev/null || fail "OURS conflict still needs a human"
grep -q two-baton up.txt && ! grep -q '^<<<<<<<' up.txt || fail "OURS file not kept"
[ "$(cat vendor-patches/t3code/PIN)" = "$D" ] || fail "PIN not moved past an OURS conflict"
git commit -qam "sync D" && bash patches.sh verify > /dev/null || fail "verify after an OURS rebase"
ok "an OURS conflict keeps Tessaya's file"
