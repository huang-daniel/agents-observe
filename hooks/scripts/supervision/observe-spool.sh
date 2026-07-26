#!/usr/bin/env bash
# Durable event spool primitives. Entries are JSON files named by a stable id.
# A writer first atomically renames into pending; the one collector moves an
# entry pending -> processing -> removed (or failed) as it commits it.

[ -n "${OBSERVE_SPOOL_SH_LOADED:-}" ] && return 0
OBSERVE_SPOOL_SH_LOADED=1

SUPERVISION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hooks/scripts/supervision/lib/observe-env.sh
. "$SUPERVISION_DIR/lib/observe-env.sh"

observe_spool_ensure() {
  observe_runtime_ensure || return 2
  mkdir -p "$OBSERVE_SPOOL/pending" "$OBSERVE_SPOOL/processing" "$OBSERVE_SPOOL/failed" 2>/dev/null || return 2
}

observe_spool_event_id() {
  if [ -r /proc/sys/kernel/random/uuid ]; then
    tr -d '\n' < /proc/sys/kernel/random/uuid
  else
    printf '%s-%s-%s\n' "$(observe_now_epoch)" "${BASHPID:-$$}" "$RANDOM"
  fi
}

# Wrap stdin as an event envelope and print its stable event id. The temporary
# file is renamed only after the whole JSON document is durable enough to read.
observe_spool_write() { # [event-id]
  local event_id=${1:-} tmp target
  observe_spool_ensure || return $?
  [ -n "$event_id" ] || event_id=$(observe_spool_event_id)
  case "$event_id" in *[!A-Za-z0-9._-]*|'') return 2 ;; esac
  target="$OBSERVE_SPOOL/pending/$event_id.json"
  tmp="$OBSERVE_SPOOL/pending/.$event_id.${BASHPID:-$$}.tmp"
  [ ! -e "$target" ] || return 1
  printf '{"eventId":"%s","timestamp":%s,"envelope":' "$event_id" "$(( $(observe_now_epoch) * 1000 ))" > "$tmp" || {
    rm -f "$tmp"
    return 1
  }
  cat >> "$tmp" || { rm -f "$tmp"; return 1; }
  printf '}\n' >> "$tmp" || { rm -f "$tmp"; return 1; }
  mv -n "$tmp" "$target" 2>/dev/null || { rm -f "$tmp"; return 1; }
  printf '%s\n' "$event_id"
}

# Atomic same-filesystem state transition. Consumers recover processing entries
# after a crash by returning them to pending before attempting work again.
observe_spool_move() { # <event-id> <pending|processing|failed> <processing|pending|failed>
  local event_id=${1:-} from=${2:-} to=${3:-}
  case "$from:$to" in pending:processing|processing:pending|processing:failed) ;; *) return 2 ;; esac
  mv "$OBSERVE_SPOOL/$from/$event_id.json" "$OBSERVE_SPOOL/$to/$event_id.json"
}
