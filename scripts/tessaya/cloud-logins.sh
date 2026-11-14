#!/usr/bin/env bash
# Writes ~/.t3/baton/cloud-logins.json: per cloud account, whether its claude.ai login is alive and how
# how many days of login it has left. Run daily by tessaya-cloud-logins.timer (was baton-cloud-logins) (scripts/tessaya/systemd).
#
# A cloud account is a folder under $BATON_CLOUD_DIR (default ~/.claude-cloud); its name is the
# account's name here and in the report, so no address is ever written. One call per account
# (`claude auth status`) is enough to refresh a token that needs it. These logins are cloud-only:
# Tessaya and T3 never use them as a provider, and this script only checks and reports.
#
# {"checkedAt": <epoch seconds>, "accounts": [{"account", "state": ok|renew-soon|expired|not-logged-in,
#   "loginExpiresInDays", "accessTokenExpiresInHours"}]}  renew-soon is under 5 days of login left.
# Settings are renamed TESSAYA_*; the old BATON_* names still work. Drop them once no unit or workflow sets them.
BATON_CLOUD_DIR="${TESSAYA_CLOUD_DIR:-${BATON_CLOUD_DIR:-}}"
BATON_CLOUD_LOGINS_FILE="${TESSAYA_CLOUD_LOGINS_FILE:-${BATON_CLOUD_LOGINS_FILE:-}}"
BATON_CLOUD_RENEW_DAYS="${TESSAYA_CLOUD_RENEW_DAYS:-${BATON_CLOUD_RENEW_DAYS:-}}"
BATON_NOW="${TESSAYA_NOW:-${BATON_NOW:-}}"
BATON_STATE="${TESSAYA_STATE:-${BATON_STATE:-}}"
set -uo pipefail
. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lib/tessaya-env.sh" 2> /dev/null || true
root="${BATON_CLOUD_DIR:-$HOME/.claude-cloud}"
out="${BATON_CLOUD_LOGINS_FILE:-${BATON_STATE:-$HOME/.t3/baton}/cloud-logins.json}"
renew_days="${BATON_CLOUD_RENEW_DAYS:-5}"
mkdir -p "$(dirname "$out")"
now="${BATON_NOW:-$(date +%s)}"
rows=()
for dir in "$root"/*/; do
  [ -d "$dir" ] || continue
  acct=$(basename "$dir")
  if [ ! -f "$dir/.credentials.json" ]; then
    rows+=("{\"account\":\"$acct\",\"state\":\"not-logged-in\"}")
    continue
  fi
  status=$(env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR="$dir" timeout 60 claude auth status 2> /dev/null)
  logged_in=$(echo "$status" | python3 -c "import sys,json; print(json.load(sys.stdin).get('loggedIn',False))" 2> /dev/null || echo False)
  # The ACCESS token lives hours and is refreshed by any use; the LOGIN lasts until the refresh token expires.
  read -r access_exp refresh_exp <<< "$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); o=d.get('claudeAiOauth',d); print(int(o.get('expiresAt',0))//1000, int(o.get('refreshTokenExpiresAt',0))//1000)" "$dir/.credentials.json" 2> /dev/null || echo "0 0")"
  state=ok
  [ "$logged_in" = "True" ] || state=expired
  fields="\"account\":\"$acct\""
  if [ "$refresh_exp" -gt 0 ]; then
    days=$(((refresh_exp - now) / 86400))
    [ "$state" = ok ] && [ "$days" -lt "$renew_days" ] && state=renew-soon
    fields="$fields,\"state\":\"$state\",\"loginExpiresInDays\":$days"
  else
    fields="$fields,\"state\":\"$state\""
  fi
  [ "$access_exp" -gt 0 ] && fields="$fields,\"accessTokenExpiresInHours\":$(((access_exp - now) / 3600))"
  # One line a day, to learn whether use extends the refresh token. Times only: no token, no address.
  echo "$now $acct $state access=$access_exp refresh=$refresh_exp" >> "$(dirname "$out")/cloud-logins.history"
  rows+=("{$fields}")
done
printf '{"checkedAt":%s,"accounts":[%s]}\n' "$now" "$(
  IFS=,
  echo "${rows[*]}"
)" > "$out"
