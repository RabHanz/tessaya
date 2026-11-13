#!/usr/bin/env bash
#
# The room's tool suite against a build, before it is deployed (evals/tessaya-room/README.md, "Live suite"):
#
#   scripts/tessaya/room-suite.sh <t3 binary of the build> [userdata dir, default ~/.t3/userdata] [live.ts flags: --laptop, --case <id>]
#
# Starts the build on a scratch copy of what the room needs from the userdata (Home Assistant's address and token,
# the R1's device key without its MQTT login, the brain's key): his house is read live, its writes and his phone asks
# are dry runs, his R1 and his live database are never touched. Exit 0 when every case passes or does not apply.
set -euo pipefail
t3="${1:?usage: room-suite.sh <t3 binary> [userdata dir] [--laptop] [--case <id>]...}"
from="${2:-$HOME/.t3/userdata}"
here="$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)"
[ -f "$from/secrets/r1-device.bin" ] || { echo "room-suite: no R1 set up in $from" >&2; exit 1; }
home="$(mktemp -d "${TMPDIR:-/tmp}/room-suite.XXXXXX")"
pid=""
cleanup() {
  # Wait for the server to exit, or it recreates userdata/ after the rm below.
  [ -n "$pid" ] && { kill "$pid" && wait "$pid"; } 2> /dev/null || true
  rm -rf -- "$home"
}
trap cleanup EXIT
mkdir -p "$home/userdata/secrets"
chmod 700 "$home/userdata/secrets"
# A consistent copy of the live database, never opened for writing.
node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync(process.argv[1],{readOnly:true}).exec(\"VACUUM INTO '\"+process.argv[2]+\"'\")" \
  "$from/baton.sqlite" "$home/userdata/baton.sqlite.copy"
mv "$home/userdata/baton.sqlite.copy" "$home/userdata/baton.sqlite"
# The copy's own device list and relay offset would reach his devices; only the house settings stay.
node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync(process.argv[1]).exec(\"DELETE FROM fabric_settings WHERE key NOT LIKE 'home.%'\")" \
  "$home/userdata/baton.sqlite"
for s in home-assistant-token dictation-cleanup-anthropic; do
  [ -f "$from/secrets/$s.bin" ] && install -m 600 "$from/secrets/$s.bin" "$home/userdata/secrets/"
done
node -e "const f=require('fs');const d=JSON.parse(f.readFileSync(process.argv[1],'utf8'));f.writeFileSync(process.argv[2],JSON.stringify({deviceKey:d.deviceKey,mqttUrl:null,mqttUser:null,mqttPass:null,deviceId:null}),{mode:0o600})" \
  "$from/secrets/r1-device.bin" "$home/userdata/secrets/r1-device.bin"
# Only the brain's key settings: provider accounts would reach his real account homes.
node -e "const f=require('fs');const d=JSON.parse(f.readFileSync(process.argv[1],'utf8'));f.writeFileSync(process.argv[2],JSON.stringify({dictationCleanupCredentials:d.dictationCleanupCredentials,dictationCleanup:d.dictationCleanup}))" \
  "$from/settings.json" "$home/userdata/settings.json"
port="$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
TESSAYA_VOICE_POOL=lean "$t3" serve --base-dir "$home" --port "$port" --host 127.0.0.1 > "$home/server.log" 2>&1 &
pid=$!
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$port/api/devices/r1/v1/chat/completions" -d '{}' || true)"
  [ "$code" = 401 ] && break
  sleep 2
done
[ "${code:-}" = 401 ] || { echo "room-suite: the build did not come up (http ${code:-none})" >&2; tail -20 "$home/server.log" >&2; exit 1; }
node "$here/evals/tessaya-room/live.ts" --server "http://127.0.0.1:$port" \
  --key-file "$home/userdata/secrets/r1-device.bin" --out "${ROOM_SUITE_OUT:-$home/results}" "${@:3}"
