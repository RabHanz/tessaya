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
# Stand-ins run as "claude" and their descriptors carry the real start time, the way Claude writes them.
claude_like() { HERDR_SESSION=fab-proj HERDR_PANE_ID=w1:p9 bash -c 'exec -a claude sleep 120' & }
start_of() { local s; s="$(cat "/proc/$1/stat")"; cut -d' ' -f20 <<< "${s##*) }"; }
claude_like
holder=$!
sleep 0.2
trap 'kill "$holder" "${sdk:-}" "${stranger:-}" 2> /dev/null; rm -rf "$work"' EXIT

# 1. Not running anywhere: resumed in a new pane.
touch "$HERDR_UP"
run aaaa-1
grep -q "pane run w1:p1 claude --resume aaaa-1" "$HERDR_LOG" || fail "a stopped session is resumed"
ok "a stopped session is resumed in a pane"

# 2. A live process holds it: no pane is run.
printf '{"pid":%s,"sessionId":"bbbb-2","kind":"interactive","procStart":"%s"}' "$holder" "$(start_of "$holder")" > "$HOME/.claude/sessions/$holder.json"
run bbbb-2
grep -q "pane run" "$HERDR_LOG" && fail "a running session got a second copy"
grep -q "running in fab-proj pane w1:p9" "$work/out" || fail "a running session is reported where it runs: $(cat "$work/out")"
ok "a running session is not started twice, and says where it runs"

# 3. The space is down and its saved layout resumes it: the server's restore is the only copy.
rm -f "$HERDR_UP"
mkdir -p "$HOME/.config/herdr/sessions/fab-proj"
echo '{"agent_session": {"kind": "id", "value": "cccc-3"}}' > "$HOME/.config/herdr/sessions/fab-proj/session.json"
rm -f "$HOME/.claude/sessions/$holder.json"
printf '{"pid":%s,"sessionId":"cccc-3","kind":"interactive","procStart":"%s"}' "$holder" "$(start_of "$holder")" > "$work/later.json"
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
claude_like
sdk=$!
sleep 0.2
printf '{"pid":%s,"sessionId":"dddd-4","kind":"interactive","entrypoint":"sdk-ts","procStart":"%s"}' "$sdk" "$(start_of "$sdk")" > "$work/cfg/sessions/$sdk.json"
: > "$HERDR_LOG"
bash "$script" resume t-1 > "$work/out" 2>&1 < /dev/null && fail "a session Tessaya hosts was resumed a second time"
grep -q "pane run" "$HERDR_LOG" && fail "a session Tessaya hosts got a pane"
grep -q "Tessaya is hosting this session" "$work/out" || fail "says why: $(cat "$work/out")"
ok "a session Tessaya hosts is refused without --force"

# 5. --force with the server up: the request is the server's to act on; nothing is killed from here.
( for _ in $(seq 1 300); do f="$(ls "$work"/tessaya-requests/open-*.json 2> /dev/null | head -1 || true)"; [[ -n "$f" ]] && { cp "$f" "$work/taken.json"; rm -f "$f"; exit 0; }; sleep 0.1; done ) &
: > "$HERDR_LOG"
bash "$script" resume t-1 --force > "$work/out" 2>&1 < /dev/null || fail "--force with the server up: $(cat "$work/out")"
kill -0 "$sdk" 2> /dev/null || fail "the server's process is not killed from outside: $(cat "$work/out")"
grep -q '"threadId":"t-1"' "$work/taken.json" || fail "the server is asked for this thread"
grep -q "pane run" "$HERDR_LOG" && fail "the server opens the pane, not the CLI"
ok "--force with the server up asks the server to stop the turn and open it"

# 6. --force with no server: the request goes unanswered, so the verified process is stopped, then resumed.
bash "$script" resume t-1 --force > "$work/out" 2>&1 < /dev/null || true
kill -0 "$sdk" 2> /dev/null && fail "--force with no server stops the outlived process"
grep -q "pane run w1:p1 CLAUDE_CONFIG_DIR=$work/cfg claude --resume dddd-4" "$HERDR_LOG" || fail "--force then resumes it"
ok "--force with no server stops the outlived process, then resumes it"

# 7. A pid reused by another process is never taken for the session's holder, nor signalled.
sleep 120 &
stranger=$!
printf '{"pid":%s,"sessionId":"eeee-7","kind":"interactive","procStart":"1"}' "$stranger" > "$HOME/.claude/sessions/$stranger.json"
: > "$HERDR_LOG"
bash "$script" --resume eeee-7 "$work/proj" > "$work/out" 2>&1 < /dev/null || true
kill -0 "$stranger" 2> /dev/null || fail "a stranger with a reused pid is left alone"
grep -q "pane run w1:p1 claude --resume eeee-7" "$HERDR_LOG" || fail "a stale descriptor does not block the resume: $(cat "$HERDR_LOG")"
ok "a reused pid is neither the holder nor signalled"
