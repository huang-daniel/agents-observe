#!/usr/bin/env bash
# Shared helpers for the collector supervisor commands. This is deliberately a
# small calling-side layer: lock ownership and health remain in the PR1 kernel.

[ -n "${OBSERVE_LIFECYCLE_SH_LOADED:-}" ] && return 0
OBSERVE_LIFECYCLE_SH_LOADED=1

SUPERVISION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hooks/scripts/supervision/lib/observe-heartbeat.sh
. "$SUPERVISION_DIR/lib/observe-heartbeat.sh"

# The ledger is diagnostic evidence, not a lock. A single append is best effort
# so a full diagnostic filesystem can never prevent a safe lifecycle action.
observe_lifecycle_log() { # <action> <outcome> [detail]
  local action=${1:-unknown} outcome=${2:-unknown} detail=${3:-}
  observe_runtime_ensure || return 0
  detail=$(printf '%s' "$detail" | tr '\r\n\t' '   ')
  printf 'at=%s\taction=%s\toutcome=%s\tarm-pid=%s\tdetail=%s\n' \
    "$(observe_now_epoch)" "$action" "$outcome" "${BASHPID:-$$}" "$detail" \
    >> "$OBSERVE_LIFECYCLE_LOG" 2>/dev/null || true
}

observe_lifecycle_deadline() { # [seconds]
  printf '%s\n' "$(( $(observe_now_epoch) + ${1:-$OBSERVE_START_TIMEOUT} + 1 ))"
}

# Wait for the start lock rather than racing a peer. The bounded wait is an
# explicit policy: on timeout, the caller fails rather than creating a second
# collector. A dead start-lock holder is reclaimed by the primitive itself.
observe_lifecycle_acquire_start_lock() {
  local deadline
  deadline=$(observe_lifecycle_deadline)
  while :; do
    observe_start_lock_try_acquire && return 0
    [ "$(observe_now_epoch)" -ge "$deadline" ] && return 1
    sleep "$OBSERVE_START_POLL"
  done
}

observe_lifecycle_release_start_lock() {
  observe_start_lock_release || true
}

observe_spawn_collector() { # prints spawned PID
  local entrypoint data_dir db_path client_dist_path
  [ -d "$OBSERVE_ROOT/app/server" ] || return 1

  # The hook runs this shell arm directly, bypassing config.mjs's
  # getServerEnv(). Keep the local server's state beside the supervision
  # runtime and retain the local-mode loopback default.
  data_dir="$OBSERVE_DATA_ROOT/data"
  db_path=${AGENTS_OBSERVE_DB_PATH:-"$data_dir/observe.db"}
  client_dist_path=${AGENTS_OBSERVE_CLIENT_DIST_PATH:-"$OBSERVE_ROOT/app/client/dist"}
  mkdir -p "$data_dir" || return 1

  (
    cd "$OBSERVE_ROOT/app/server" || exit 1
    export AGENTS_OBSERVE_LOCAL_DATA_ROOT="${AGENTS_OBSERVE_LOCAL_DATA_ROOT:-$OBSERVE_DATA_ROOT}"
    export AGENTS_OBSERVE_DB_PATH="$db_path"
    export AGENTS_OBSERVE_CLIENT_DIST_PATH="$client_dist_path"
    export AGENTS_OBSERVE_BIND_HOST="${AGENTS_OBSERVE_BIND_HOST:-127.0.0.1}"
    if [ -n "$OBSERVE_COLLECTOR_ENTRYPOINT" ]; then
      entrypoint=$OBSERVE_COLLECTOR_ENTRYPOINT
      [ -x "$entrypoint" ] || {
        printf 'observe-lifecycle: collector entrypoint is not executable: %s\n' "$entrypoint" >&2
        exit 1
      }
      nohup "$entrypoint" src/index.ts "$OBSERVE_ENTRYPOINT_MARKER" \
        </dev/null >/dev/null 2>&1 &
    else
      command -v node > /dev/null 2>&1 || {
        printf 'observe-lifecycle: node is unavailable\n' >&2
        exit 1
      }
      # Invoke Node directly rather than the tsx CLI: tsx can fork a wrapper,
      # while this PID must be the one that claims the collector lock.
      nohup node --import tsx src/index.ts "$OBSERVE_ENTRYPOINT_MARKER" \
        </dev/null >/dev/null 2>&1 &
    fi
    printf '%s\n' "$!"
  )
}

# Confirm a specific child, not merely any healthy successor that happened to
# appear during a race. The predicate below remains the one canonical health
# decision: this only binds its healthy result to the PID we launched.
observe_wait_for_spawned_collector() { # <pid>
  local spawned=${1:-} deadline
  observe_is_pid "$spawned" || return 1
  deadline=$(observe_lifecycle_deadline)
  while :; do
    if observe_collector_healthy && observe_collector_lock_snapshot >/dev/null; then
      [ "$OBSERVE_LOCK_PID" = "$spawned" ] && return 0
    fi
    [ "$(observe_now_epoch)" -ge "$deadline" ] && return 1
    sleep "$OBSERVE_START_POLL"
  done
}

observe_wait_for_collector_release() {
  local deadline
  deadline=$(observe_lifecycle_deadline)
  while :; do
    [ ! -d "$OBSERVE_LOCK" ] && [ ! -e "$OBSERVE_HEARTBEAT" ] && return 0
    [ "$(observe_now_epoch)" -ge "$deadline" ] && return 1
    sleep "$OBSERVE_START_POLL"
  done
}
