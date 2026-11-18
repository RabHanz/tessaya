#!/usr/bin/env bash
#
# The topology gate (evals/tessaya-room/README.md, "Topology gate"): her turns on one server's brain while she sits on
# another server's hub, as the room loop runs them with R1_BRAIN_URL and R1_HUB_URL apart.
#
#   scripts/tessaya/room-topology.sh <t3 binary of the build> <topologyGate.mjs from r1voice bundle> [userdata dir]
#
# Starts the build twice on empty scratch homes (a brain and a hub, nothing of his but the brain's model key), links the
# brain to the hub as his servers are linked, puts a pretend Tessel on the hub, and runs the loop's own bridge between
# them. Device writes are real, on the pretend Tessel. Exit 0 when every case passes.
set -euo pipefail
t3="${1:?usage: room-topology.sh <t3 binary> <topologyGate.mjs> [userdata dir]}"
gate="${2:?usage: room-topology.sh <t3 binary> <topologyGate.mjs> [userdata dir]}"
from="${3:-$HOME/.t3/userdata}"
work="$(mktemp -d "${TMPDIR:-/tmp}/room-topology.XXXXXX")"
pids=()
cleanup() {
  # Wait for each server to exit, or it recreates userdata/ after the rm below.
  for p in "${pids[@]}"; do { kill "$p" && wait "$p"; } 2> /dev/null || true; done
  rm -rf -- "$work"
}
trap cleanup EXIT
free_port() { node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
# One pretend Tessel both servers know (as his servers share her record): a fresh id and key, no MQTT login of its own.
node -e "const c=require('crypto');console.log(JSON.stringify({deviceId:'r1-topogate',deviceKey:c.randomBytes(24).toString('hex'),mqttUrl:null,mqttUser:null,mqttPass:null}))" > "$work/device.json"
for side in brain hub; do
  mkdir -p "$work/$side/userdata/secrets"
  chmod 700 "$work/$side/userdata/secrets"
  install -m 600 "$work/device.json" "$work/$side/userdata/secrets/r1-device.bin"
  echo '{"linkedEnvironmentsEnabled":true}' > "$work/$side/userdata/settings.json"
done
# The brain answers with his model key, as the room suite's does; nothing else of his is copied.
[ -f "$from/secrets/dictation-cleanup-anthropic.bin" ] \
  && install -m 600 "$from/secrets/dictation-cleanup-anthropic.bin" "$work/brain/userdata/secrets/"
node -e "const f=require('fs');const d=JSON.parse(f.readFileSync(process.argv[1],'utf8'));f.writeFileSync(process.argv[2],JSON.stringify({linkedEnvironmentsEnabled:true,dictationCleanupCredentials:d.dictationCleanupCredentials,dictationCleanup:d.dictationCleanup}))" \
  "$from/settings.json" "$work/brain/userdata/settings.json"
declare -A port
for side in brain hub; do
  port[$side]="$(free_port)"
  TESSAYA_VOICE_POOL=lean "$t3" serve --base-dir "$work/$side" --port "${port[$side]}" --host 127.0.0.1 > "$work/$side.log" 2>&1 &
  pids+=("$!")
done
for side in brain hub; do
  code=""
  for _ in $(seq 1 60); do
    code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${port[$side]}/api/devices/r1/v1/chat/completions" -d '{}' || true)"
    [ "$code" = 401 ] && break
    sleep 2
  done
  [ "$code" = 401 ] || { echo "room-topology: the $side build did not come up (http ${code:-none})" >&2; tail -20 "$work/$side.log" >&2; exit 1; }
done
# The brain links to the hub's server as his are linked (approval-required): device acts take that peer route.
pairing="$("$t3" pair --base-dir "$work/hub" 2>&1 | sed -n 's/^.*Token: *//p' | head -1 || true)"
[ -n "$pairing" ] || { echo "room-topology: no pairing code from the hub" >&2; "$t3" pair --base-dir "$work/hub" 2>&1 | tail -5 >&2; exit 1; }
"$t3" environment link "http://127.0.0.1:${port[hub]}" --pairing-code "$pairing" --base-dir "$work/brain" > "$work/link.log" 2>&1 \
  || { echo "room-topology: the brain could not link to the hub" >&2; tail -5 "$work/link.log" >&2; exit 1; }
node "$gate" --brain "http://127.0.0.1:${port[brain]}" --hub "http://127.0.0.1:${port[hub]}" \
  --brain-bus-key-file "$work/brain/userdata/secrets/r1-bus.bin" --hub-bus-key-file "$work/hub/userdata/secrets/r1-bus.bin" \
  --device-file "$work/device.json" --brain-db "$work/brain/userdata/baton.sqlite" --hub-db "$work/hub/userdata/baton.sqlite" --out "${ROOM_TOPOLOGY_OUT:-$work/results}"
