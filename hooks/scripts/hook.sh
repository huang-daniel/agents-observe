#!/bin/bash
# Fast hook wrapper — durably spool first, then leave delivery to the collector.
# Hooks block until this command exits, so the collector arm runs in the
# background only when its canonical lock/heartbeat health predicate is false.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
input=$(cat)
[ -n "${input//[[:space:]]/}" ] || exit 0

# shellcheck source=hooks/scripts/supervision/observe-spool.sh
. "$SCRIPT_DIR/supervision/observe-spool.sh"
# shellcheck source=hooks/scripts/supervision/lib/observe-heartbeat.sh
. "$SCRIPT_DIR/supervision/lib/observe-heartbeat.sh"
observe_env_init || exit 0

# A failed spool write must not discard the event: retain the established
# direct CLI delivery as the last-resort compatibility path.
if ! printf '%s' "$input" | observe_spool_write_hook > /dev/null 2>&1; then
  printf '%s' "$input" | node "$SCRIPT_DIR/observe_cli.mjs" hook > /dev/null 2>&1 &
  exit 0
fi

if ! observe_collector_healthy >/dev/null 2>&1; then
  "$SCRIPT_DIR/supervision/observe-arm.sh" start > /dev/null 2>&1 &
fi
exit 0
