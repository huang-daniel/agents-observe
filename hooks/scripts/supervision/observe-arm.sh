#!/usr/bin/env bash
# Attach to, start, or restart one collector for one data root.
set -u

SUPERVISION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hooks/scripts/supervision/observe-lifecycle.sh
. "$SUPERVISION_DIR/observe-lifecycle.sh"

usage() {
  printf 'Usage: observe-arm.sh <attach|start|restart>\n' >&2
}

report_attached() {
  observe_collector_lock_snapshot >/dev/null || return 1
  observe_lifecycle_log attach attached "pid=$OBSERVE_LOCK_PID instance=$OBSERVE_LOCK_INSTANCE_ID"
  printf 'collector: attached pid=%s instance=%s\n' "$OBSERVE_LOCK_PID" "$OBSERVE_LOCK_INSTANCE_ID"
}

attach() {
  local rc
  if observe_collector_healthy; then
    report_attached
    return 0
  else
    rc=$?
  fi
  observe_lifecycle_log attach unavailable "status=$OBSERVE_HEALTH_STATUS reason=$OBSERVE_HEALTH_REASON"
  printf 'collector: %s%s\n' "$OBSERVE_HEALTH_STATUS" \
    "${OBSERVE_HEALTH_REASON:+ reason=$OBSERVE_HEALTH_REASON}" >&2
  return "$rc"
}

start() {
  local spawned rc
  if observe_collector_healthy; then
    report_attached
    return 0
  else
    rc=$?
  fi
  [ "$rc" -eq 2 ] && return 2

  if ! observe_lifecycle_acquire_start_lock; then
    observe_lifecycle_log start start-lock-timeout
    printf 'collector: start in progress timed out waiting for start lock\n' >&2
    return 1
  fi
  trap 'observe_lifecycle_release_start_lock' EXIT
  trap 'observe_lifecycle_release_start_lock; exit 1' HUP INT TERM

  # A peer may have completed while this invocation waited for its start lock.
  if observe_collector_healthy; then
    report_attached
    return 0
  else
    rc=$?
  fi
  [ "$rc" -eq 2 ] && return 2

  if [ -d "$OBSERVE_LOCK" ]; then
    if observe_collector_lock_is_abandoned; then
      observe_collector_lock_reclaim || {
        observe_lifecycle_log start reclaim-failed
        printf 'collector: could not reclaim abandoned lock\n' >&2
        return 1
      }
      observe_lifecycle_log start reclaimed-abandoned-lock
    else
      observe_lifecycle_log start live-or-unsafe-owner "status=$OBSERVE_HEALTH_STATUS reason=$OBSERVE_HEALTH_REASON"
      printf 'collector: live or unsafe owner remains; use restart only for an identity-matched owner\n' >&2
      return 1
    fi
  fi

  spawned=$(observe_spawn_collector) || {
    observe_lifecycle_log start spawn-failed
    return 1
  }
  observe_lifecycle_log start spawned "pid=$spawned"
  if observe_wait_for_spawned_collector "$spawned"; then
    observe_collector_lock_snapshot >/dev/null
    observe_lifecycle_log start started "pid=$OBSERVE_LOCK_PID instance=$OBSERVE_LOCK_INSTANCE_ID"
    printf 'collector: started pid=%s instance=%s\n' "$OBSERVE_LOCK_PID" "$OBSERVE_LOCK_INSTANCE_ID"
    return 0
  fi

  observe_lifecycle_log start confirmation-timeout "pid=$spawned"
  printf 'collector: failed to confirm spawned collector pid=%s healthy\n' "$spawned" >&2
  return 1
}

restart() {
  if [ -d "$OBSERVE_LOCK" ]; then
    if observe_process_matches_lock; then
      observe_collector_lock_snapshot >/dev/null
      observe_lifecycle_log restart signalling "pid=$OBSERVE_LOCK_PID"
      observe_signal_locked_process TERM || return 1
      if ! observe_wait_for_collector_release; then
        observe_lifecycle_log restart shutdown-timeout
        printf 'collector: timed out waiting for owner to release lock\n' >&2
        return 1
      fi
      observe_lifecycle_log restart stopped
    elif observe_collector_lock_is_abandoned; then
      observe_lifecycle_log restart no-live-owner
    else
      observe_lifecycle_log restart unsafe-owner
      printf 'collector: unsafe owner; refusing to signal\n' >&2
      return 2
    fi
  fi
  start
}

case "${1:-}" in
  attach | start | restart) action=$1 ;;
  *) usage; exit 2 ;;
esac

observe_env_init || exit 2
observe_runtime_ensure || exit 2
"$action"
