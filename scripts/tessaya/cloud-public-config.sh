#!/usr/bin/env bash
#
# Print the three public T3 Connect config values that a fork build does not
# carry, read out of an installed official release.
#
# Why this exists
# ---------------
# `hasCloudPublicConfig` (apps/server/src/cloud/publicConfig.ts) is the gate on
# the whole T3 Connect startup path: with it false, the server never reconciles
# the desired cloud link, so no managed tunnel is provisioned and the
# environment is unreachable from t3.codes. It is true only when a relay URL, a
# Clerk publishable key and a Clerk CLI OAuth client id are present — and in the
# official release those arrive as build-time defines injected by upstream's CI
# (`__T3CODE_BUILD_*__`), which a fork build has no way to reproduce.
#
# All three are *public* identifiers: they ship in plain text inside every
# published `t3` binary, the Clerk key is a publishable key by Clerk's own
# naming, and the relay URL is a public hostname. They are still not committed
# to this repository, for two reasons: they are upstream's cloud, not ours, and
# a fork that may be open-sourced should not carry another project's
# environment as source. So they are read at deploy time from whichever release
# is installed on the machine, and handed to the fork's unit as environment.
#
# Deliberately NOT printed: the relay client's OTLP tracing triple, which
# includes an Axiom *ingest* token. That one is a credential, it is upstream's,
# and a fork has no business writing into their telemetry dataset. Leaving it
# unset disables relay-client tracing, which is the correct default for a fork.
#
# Usage:
#   scripts/tessaya/cloud-public-config.sh [/path/to/official/t3] [--systemd]
#
# With no path, the newest non-Tessaya version under $T3CODE_HOME/runtime/versions
# is used. `--systemd` prints `Environment=` lines for a unit drop-in instead of
# bare KEY=value pairs.

set -euo pipefail

binary=""
systemd=0
for argument in "$@"; do
  case "$argument" in
    --systemd) systemd=1 ;;
    *) binary="$argument" ;;
  esac
done

if [ -z "$binary" ]; then
  home="${T3CODE_HOME:-$HOME/.t3}"
  # Newest by version sort, skipping anything this fork installed: a fork build
  # is exactly the thing that lacks these values.
  for candidate in $(ls -1 "$home/runtime/versions" 2>/dev/null | grep -vE 'tessaya|fabric|baton' | sort -Vr); do
    if [ -x "$home/runtime/versions/$candidate/t3" ]; then
      binary="$home/runtime/versions/$candidate/t3"
      break
    fi
  done
fi

if [ -z "$binary" ] || [ ! -r "$binary" ]; then
  echo "cloud-public-config: no official t3 release found to read from." >&2
  echo "Install one (curl -fsSL https://t3.codes/install.sh | sh) or pass its path." >&2
  exit 1
fi

# The bundle keeps the substituted literals on one line each, in the form
#   const buildTimeRelayUrl = normalizeSecureRelayUrl("https://relay.t3.codes") ?? "";
#   const buildTimeClerkPublishableKey = readBuildTimeValue("pk_live_…");
#   const buildTimeClerkCliOAuthClientId = readBuildTimeValue("…");
# so each value is the first quoted string after its own constant's name.
read_value() {
  grep -aoE "const $1 = [a-zA-Z]+\(\"[^\"]+\"\)" "$binary" |
    head -1 |
    sed -E 's/.*"([^"]+)".*/\1/'
}

relay_url="$(read_value buildTimeRelayUrl || true)"
publishable_key="$(read_value buildTimeClerkPublishableKey || true)"
client_id="$(read_value buildTimeClerkCliOAuthClientId || true)"

if [ -z "$relay_url" ] || [ -z "$publishable_key" ] || [ -z "$client_id" ]; then
  echo "cloud-public-config: could not read all three values from $binary." >&2
  echo "Upstream may have changed how publicConfig.ts is bundled; read it and update this script." >&2
  exit 1
fi

prefix=""
if [ "$systemd" -eq 1 ]; then
  prefix="Environment="
  cat <<'HEADER'
# T3 Connect public config, read out of the installed official release by
# scripts/tessaya/cloud-public-config.sh. Without these a fork build skips the
# cloud link reconcile entirely and the environment is unreachable from
# t3.codes. Regenerate rather than edit.
[Service]
HEADER
fi

printf '%sT3CODE_RELAY_URL=%s\n' "$prefix" "$relay_url"
printf '%sT3CODE_CLERK_PUBLISHABLE_KEY=%s\n' "$prefix" "$publishable_key"
printf '%sT3CODE_CLERK_CLI_OAUTH_CLIENT_ID=%s\n' "$prefix" "$client_id"
