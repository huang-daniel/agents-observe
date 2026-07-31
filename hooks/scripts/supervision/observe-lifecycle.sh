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

# How long a start attempt waits for confirmation. A docker start may have to
# pull an image before the collector exists at all, which is a different order
# of magnitude from forking a local process.
observe_start_timeout_for() { # <runtime>
  case "${1:-local}" in
    docker) printf '%s\n' "$OBSERVE_DOCKER_START_TIMEOUT" ;;
    *) printf '%s\n' "$OBSERVE_START_TIMEOUT" ;;
  esac
}

# How long to wait for a signalled collector to release its lock and heartbeat.
# `docker stop` gives the container its own grace period before killing it, so
# the host has to outwait that rather than the local process's shutdown.
observe_shutdown_timeout_for() { # <runtime>
  case "${1:-local}" in
    docker) printf '%s\n' "$(( OBSERVE_DOCKER_STOP_TIMEOUT + OBSERVE_START_TIMEOUT ))" ;;
    *) printf '%s\n' "$OBSERVE_START_TIMEOUT" ;;
  esac
}

# A fresh instance id for a collector run the supervisor is about to start.
# Only the docker path needs one: a local collector is identified by the PID we
# forked, while a container has to be told which run it is before it starts, so
# the host can recognise it afterwards.
observe_new_instance_id() {
  if [ -r /proc/sys/kernel/random/uuid ]; then
    tr -d '\n' < /proc/sys/kernel/random/uuid
    printf '\n'
  else
    printf '%s-%s-%s\n' "$(observe_now_epoch)" "${BASHPID:-$$}" "$RANDOM"
  fi
}

# Wait for the start lock rather than racing a peer. The bounded wait is an
# explicit policy: on timeout, the caller fails rather than creating a second
# collector. A dead start-lock holder is reclaimed by the primitive itself.
#
# A waiter also watches for the outcome it actually wants. The winner keeps the
# start lock until it has *confirmed* its collector, which for docker can be
# minutes after the collector became healthy; peers wait a small fraction of
# that. Polling only the lock made every one of them fail a start that had in
# fact already succeeded — a herd of failures around one success. Watching
# health costs nothing extra (the peer is already polling) and cannot create a
# second collector: it only ever returns without starting anything.
#
# Returns: 0 acquired the lock, 2 a peer's collector became healthy, 1 timed out.
observe_lifecycle_acquire_start_lock() {
  local deadline
  deadline=$(observe_lifecycle_deadline)
  while :; do
    observe_start_lock_try_acquire && return 0
    observe_collector_healthy && return 2
    [ "$(observe_now_epoch)" -ge "$deadline" ] && return 1
    sleep "$OBSERVE_START_POLL"
  done
}

observe_lifecycle_release_start_lock() {
  observe_start_lock_release || true
}

# Start one collector in whichever runtime this host supports, and print the
# token that identifies the run so the caller can bind its confirmation to the
# thing it actually started rather than to any healthy successor that shows up
# during a race. The token is a PID for a local collector and an instance id for
# a containerized one — see observe_wait_for_spawned_collector.
observe_spawn_collector() { # prints the spawned owner token
  case "$(observe_resolved_runtime)" in
    docker) observe_spawn_collector_docker ;;
    *) observe_spawn_collector_local ;;
  esac
}

# Hand the container start to the Node CLI rather than re-implementing image
# pulls, version checks, port fallback and bind mounts in bash. That keeps one
# implementation of "run the container" (hooks/scripts/lib/docker.mjs) while
# supervision keeps its single decision point here.
#
# The instance id is generated *before* the container starts and passed in, so
# the container carries it as a label from birth: that label is what lets the
# host tell this collector run from an earlier one with the same name.
#
# The CLI runs in the *foreground* and its exit status decides the outcome. A
# detached start proves only that a request was launched, so a failed docker
# start — or a container that came up as something other than this instance —
# used to be recorded as a spawn and then spent the whole confirmation window
# waiting for it. Nothing user-facing waits on this: hook.sh already backgrounds
# the arm, and the CLI's own health wait is bounded well inside the docker start
# timeout this caller allows.
observe_spawn_collector_docker() { # prints the instance id
  local cli token output
  cli="$OBSERVE_ROOT/hooks/scripts/observe_cli.mjs"
  [ -f "$cli" ] || return 1
  command -v node > /dev/null 2>&1 || return 1
  command -v docker > /dev/null 2>&1 || return 1

  token=$(observe_new_instance_id)
  [ -n "$token" ] || return 1

  if output=$(AGENTS_OBSERVE_INSTANCE_ID=$token \
    AGENTS_OBSERVE_DATA_ROOT=$OBSERVE_DATA_ROOT \
    node "$cli" start < /dev/null 2>&1); then
    printf '%s\n' "$token"
    return 0
  fi
  observe_lifecycle_log start docker-start-failed \
    "instance=$token detail=$(printf '%s' "$output" | tail -n 3)"
  return 1
}

observe_spawn_collector_local() { # prints spawned PID
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

# Confirm the collector we started, not merely any healthy successor that
# happened to appear during a race. The predicate below remains the one
# canonical health decision: this only binds its healthy result to the run we
# launched — by PID for a local collector, by instance id for a container, whose
# PID lives in a namespace this host cannot read.
observe_wait_for_spawned_collector() { # <token> [runtime]
  local spawned=${1:-} runtime=${2:-local} deadline
  [ -n "$spawned" ] || return 1
  [ "$runtime" = docker ] || observe_is_pid "$spawned" || return 1
  deadline=$(observe_lifecycle_deadline "$(observe_start_timeout_for "$runtime")")
  while :; do
    if observe_collector_healthy && observe_collector_lock_snapshot >/dev/null; then
      if [ "$runtime" = docker ]; then
        # Either the run we asked for, or the container we manage: docker allows
        # one live container per name, so a healthy collector running as *that*
        # container is this data root's collector however it got started. A peer
        # supervisor winning the race is a success, not a duplicate.
        [ "$OBSERVE_LOCK_INSTANCE_ID" = "$spawned" ] && return 0
        [ -n "$OBSERVE_LOCK_CONTAINER" ] &&
          [ "$OBSERVE_LOCK_CONTAINER" = "$OBSERVE_DOCKER_CONTAINER" ] && return 0
      else
        [ "$OBSERVE_LOCK_PID" = "$spawned" ] && return 0
      fi
    fi
    [ "$(observe_now_epoch)" -ge "$deadline" ] && return 1
    sleep "$OBSERVE_START_POLL"
  done
}

observe_wait_for_collector_release() { # [seconds]
  local deadline
  deadline=$(observe_lifecycle_deadline "${1:-$OBSERVE_START_TIMEOUT}")
  while :; do
    [ ! -d "$OBSERVE_LOCK" ] && [ ! -e "$OBSERVE_HEARTBEAT" ] && return 0
    [ "$(observe_now_epoch)" -ge "$deadline" ] && return 1
    sleep "$OBSERVE_START_POLL"
  done
}
