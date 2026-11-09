#!/usr/bin/env bash
# Self-check: `tessaya --resume` never starts a second copy of a conversation.
# Run: bash scripts/tessaya/tessaya-resume.test.sh
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/tessaya"
work="$(mktemp -d)"
ok() { echo "ok   $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }

# A fake herdr: records every call; "server" marks the space running.
mkdir -p "$work/bin" "$work/home/.claude/sessions" "$work/proj"
cat > "$work/bin/herdr" <<'H'
#!/usr/bin/env bash
echo "$*" >> "$HERDR_LOG"
case "$*" in
  *" server") touch "$HERDR_UP" ;;
  "session list") [[ -f "$HERDR_UP" ]] && echo "fab-proj running" ;;
  *"workspace list") echo '"workspace_id":"w1"' ;;
  *"pane list") echo '"pane_id":"w1:p1"' ;;
esac
exit 0
H
chmod +x "$work/bin/herdr"
export TESSAYA_NO_SYSTEMD=1 PATH="$work/bin:$PATH" HOME="$work/home" HERDR_LOG="$work/log" HERDR_UP="$work/up" XDG_RUNTIME_DIR="$work"
run() { : > "$HERDR_LOG"; bash "$script" --resume "$1" "$work/proj" > "$work/out" < /dev/null; }
# A stand-in for a Claude process inside Herdr pane w1:p9 of fab-proj.
HERDR_SESSION=fab-proj HERDR_PANE_ID=w1:p9 sleep 120 &
holder=$!
trap 'kill "$holder" 2> /dev/null; rm -rf "$work"' EXIT

# 1. Not running anywhere: resumed in a new pane.
touch "$HERDR_UP"
run aaaa-1
grep -q "pane run w1:p1 claude --resume aaaa-1" "$HERDR_LOG" || fail "a stopped session is resumed"
ok "a stopped session is resumed in a pane"

# 2. A live process holds it: no pane is run.
printf '{"pid":%s,"sessionId":"bbbb-2","kind":"interactive"}' "$holder" > "$HOME/.claude/sessions/$holder.json"
run bbbb-2
grep -q "pane run" "$HERDR_LOG" && fail "a running session got a second copy"
grep -q "running in fab-proj pane w1:p9" "$work/out" || fail "a running session is reported where it runs: $(cat "$work/out")"
ok "a running session is not started twice, and says where it runs"

# 3. The space is down and its saved layout resumes it: the server's restore is the only copy.
rm -f "$HERDR_UP"
mkdir -p "$HOME/.config/herdr/sessions/fab-proj"
echo '{"agent_session": {"kind": "id", "value": "cccc-3"}}' > "$HOME/.config/herdr/sessions/fab-proj/session.json"
rm -f "$HOME/.claude/sessions/$holder.json"
printf '{"pid":%s,"sessionId":"cccc-3","kind":"interactive"}' "$holder" > "$work/later.json"
( sleep 1; mv "$work/later.json" "$HOME/.claude/sessions/$holder.json" ) &
run cccc-3
grep -q "proj server" "$HERDR_LOG" || fail "the space's server is started"
grep -q "pane run" "$HERDR_LOG" && fail "a restored session got a second copy"
grep -q "running in fab-proj pane w1:p9" "$work/out" || fail "a restored session is reported as running: $(cat "$work/out")"
ok "a session the restore brings back is not started twice, and is reported as running"

# 4. `tessaya resume <thread>`: from the server's file, on the thread's login; Tessaya's SDK process is never doubled.
touch "$HERDR_UP"
mkdir -p "$work/cfg/sessions"
printf '{"version":1,"threads":[{"threadId":"t-1","title":"Pricing page","sessionId":"dddd-4","cwd":"%s","configDir":"%s","instanceId":"claude-work","model":"m","inTerminal":false,"openedAt":0}]}' \
  "$work/proj" "$work/cfg" > "$work/sessions.json"
export TESSAYA_SESSIONS_FILE="$work/sessions.json"
: > "$HERDR_LOG"
bash "$script" resume pricing > "$work/out" 2>&1 < /dev/null || fail "resume by title words: $(cat "$work/out")"
grep -q "pane run w1:p1 CLAUDE_CONFIG_DIR=$work/cfg claude --resume dddd-4" "$HERDR_LOG" ||
  fail "the pane runs on the thread's login: $(cat "$HERDR_LOG")"
ok "tessaya resume finds the thread in the file and resumes it on its own login"
HERDR_SESSION=fab-proj HERDR_PANE_ID=w1:p9 sleep 120 &
sdk=$!
printf '{"pid":%s,"sessionId":"dddd-4","kind":"interactive","entrypoint":"sdk-ts"}' "$sdk" > "$work/cfg/sessions/$sdk.json"
: > "$HERDR_LOG"
bash "$script" resume t-1 > "$work/out" 2>&1 < /dev/null && fail "a session Tessaya hosts was resumed a second time"
grep -q "pane run" "$HERDR_LOG" && fail "a session Tessaya hosts got a pane"
grep -q "Tessaya is hosting this session" "$work/out" || fail "says why: $(cat "$work/out")"
bash "$script" resume t-1 --force > "$work/out" 2>&1 < /dev/null || true
kill -0 "$sdk" 2> /dev/null && fail "--force stops Tessaya's process"
grep -q "pane run w1:p1 CLAUDE_CONFIG_DIR=$work/cfg claude --resume dddd-4" "$HERDR_LOG" || fail "--force then resumes it"
ok "a session Tessaya hosts is refused, and --force stops that process first"
