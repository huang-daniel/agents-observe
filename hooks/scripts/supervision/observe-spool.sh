#!/usr/bin/env bash
# Durable event spool primitives. Entries are JSON files named by a stable id.
# A writer first atomically renames into pending; the one collector moves an
# entry pending -> processing -> removed (or failed) as it commits it.

[ -n "${OBSERVE_SPOOL_SH_LOADED:-}" ] && return 0
OBSERVE_SPOOL_SH_LOADED=1

# Schema 1 is the original fully-normalized envelope. Schema 2 lets the
# collector normalize a raw hook payload. Keep both writers because an already
# running pre-schema-2 collector can only consume the envelope representation.
OBSERVE_SPOOL_SCHEMA_ENVELOPE=1
OBSERVE_SPOOL_SCHEMA_RAW_HOOK=2

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
  printf '{"eventId":"%s","timestamp":%s,"spoolSchemaVersion":%s,"envelope":' "$event_id" "$(( $(observe_now_epoch) * 1000 ))" "$OBSERVE_SPOOL_SCHEMA_ENVELOPE" > "$tmp" || {
    rm -f "$tmp"
    return 1
  }
  cat >> "$tmp" || { rm -f "$tmp"; return 1; }
  printf '}\n' >> "$tmp" || { rm -f "$tmp"; return 1; }
  # ln fails with EEXIST when target is already there, unlike `mv -n`, which
  # exits 0 even when it silently skips an existing destination.
  ln "$tmp" "$target" 2>/dev/null
  local linked=$?
  rm -f "$tmp"
  [ "$linked" -eq 0 ] || return 1
  printf '%s\n' "$event_id"
}

# Write a raw hook payload for the collector to normalize. Keeping this work in
# the long-lived collector removes a Node process from the hot hook path while
# retaining the exact agent-specific envelope builders used by observe_cli.
observe_spool_write_hook() { # [event-id]
  local event_id=${1:-} agent_class notification_events notification_events_json project_slug max_image_data tmp target
  observe_spool_ensure || return $?
  [ -n "$event_id" ] || event_id=$(observe_spool_event_id)
  case "$event_id" in *[!A-Za-z0-9._-]*|'') return 2 ;; esac

  # These values are configuration, not hook input. Agent class is deliberately
  # restricted to the registry's known values before it becomes JSON.
  agent_class=${AGENTS_OBSERVE_AGENT_CLASS:-claude-code}
  case "$agent_class" in claude-code|codex|default) ;; *) agent_class=default ;; esac
  project_slug=${AGENTS_OBSERVE_PROJECT_SLUG-}
  max_image_data=${AGENTS_OBSERVE_MAX_IMAGE_DATA_CHARS:-50000}
  case "$max_image_data" in ''|*[!0-9-]*) max_image_data=50000 ;; esac

  target="$OBSERVE_SPOOL/pending/$event_id.json"
  tmp="$OBSERVE_SPOOL/pending/.$event_id.${BASHPID:-$$}.tmp"
  [ ! -e "$target" ] || return 1
  # Hook configuration is encoded as strings; the collector parses the two
  # list/number settings exactly as getConfig does. Escape the user-configured
  # string values so they cannot corrupt the durable JSON record. Notification
  # events must preserve getConfig's three states: unset (JSON null, falls
  # back to the agent-lib default), explicitly empty (JSON "", opts out of
  # all notifications), and an explicit list.
  if [ -n "${AGENTS_OBSERVE_NOTIFICATION_ON_EVENTS+set}" ]; then
    notification_events=$AGENTS_OBSERVE_NOTIFICATION_ON_EVENTS
    notification_events=${notification_events//\\/\\\\}
    notification_events=${notification_events//\"/\\\"}
    notification_events=${notification_events//$'\n'/\\n}
    notification_events_json="\"$notification_events\""
  else
    notification_events_json=null
  fi
  project_slug=${project_slug//\\/\\\\}
  project_slug=${project_slug//\"/\\\"}
  project_slug=${project_slug//$'\n'/\\n}
  printf '{"eventId":"%s","timestamp":%s,"spoolSchemaVersion":%s,"rawHook":{"agentClass":"%s","projectSlug":"%s","notificationOnEvents":%s,"maxImageDataChars":"%s","payload":' \
    "$event_id" "$(( $(observe_now_epoch) * 1000 ))" "$OBSERVE_SPOOL_SCHEMA_RAW_HOOK" "$agent_class" "$project_slug" "$notification_events_json" "$max_image_data" > "$tmp" || return 1
  cat >> "$tmp" || { rm -f "$tmp"; return 1; }
  printf '}}\n' >> "$tmp" || { rm -f "$tmp"; return 1; }
  ln "$tmp" "$target" 2>/dev/null
  local linked=$?
  rm -f "$tmp"
  [ "$linked" -eq 0 ] || return 1
  printf '%s\n' "$event_id"
}

# Atomic same-filesystem state transition. Consumers recover processing entries
# after a crash by returning them to pending before attempting work again.
observe_spool_move() { # <event-id> <pending|processing|failed> <processing|pending|failed>
  local event_id=${1:-} from=${2:-} to=${3:-}
  case "$from:$to" in pending:processing|processing:pending|processing:failed) ;; *) return 2 ;; esac
  mv "$OBSERVE_SPOOL/$from/$event_id.json" "$OBSERVE_SPOOL/$to/$event_id.json"
}
