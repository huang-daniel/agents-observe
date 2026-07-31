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

# A healthy older collector does not advertise schema capabilities. It can
# safely consume the original envelope record, so select that representation
# rather than silently handing it a newer raw-hook entry it would dead-letter.
write_spool_entry() {
  local legacy_envelope
  if [ "$collector_healthy" -eq 0 ] &&
    observe_collector_supports_spool_schema "$OBSERVE_SPOOL_SCHEMA_RAW_HOOK"; then
    printf '%s' "$input" | observe_spool_write_hook
  elif [ "$collector_healthy" -eq 0 ]; then
    # Normalization was what the schema-1 hook writer did before raw spooling.
    # It is intentionally paid only during a mixed-version rollout.
    legacy_envelope=$(printf '%s' "$input" | node "$SCRIPT_DIR/observe_cli.mjs" spool-envelope) || return 1
    printf '%s' "$legacy_envelope" | observe_spool_write
  else
    # No live collector is consuming yet; write the current representation and
    # arm a current collector below.
    printf '%s' "$input" | observe_spool_write_hook
  fi
}

observe_collector_healthy >/dev/null 2>&1
collector_healthy=$?

# A failed spool write must not discard the event: retain the established
# direct CLI delivery as the last-resort compatibility path.
if ! write_spool_entry > /dev/null 2>&1; then
  printf '%s' "$input" | node "$SCRIPT_DIR/observe_cli.mjs" hook > /dev/null 2>&1 &
  exit 0
fi

if [ "$collector_healthy" -ne 0 ]; then
  "$SCRIPT_DIR/supervision/observe-arm.sh" start > /dev/null 2>&1 &
fi
exit 0
