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
#
# A waiter also watches for the outcome it actually wants. The winner keeps the
# start lock until it has *confirmed* its collector, which on a first start
# (dependencies still to install) can be minutes after the collector became
# healthy; peers wait a small fraction of that. Polling only the lock made every
# one of them fail a start that had in fact already succeeded — a herd of
# failures around one success. Watching health costs nothing extra (the peer is
# already polling) and cannot create a second collector: it only ever returns
# without starting anything.
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

# Where a bootstrap install writes its output. Kept beside the lifecycle ledger
# so a failed first start leaves one place to look.
observe_install_log() {
  printf '%s\n' "${OBSERVE_RUNTIME:-}/collector-install.log"
}

# Run one npm install in <dir>, appending everything it says to <log-file>.
#
# `npm ci` first when there is a lockfile: it is the reproducible install and
# the one a shipped checkout should get. It refuses to run when the lockfile is
# missing or out of sync with package.json, and that refusal is not a reason to
# leave the collector unusable — `npm install` is the documented fallback for
# exactly that state.
#
# Bounded by `timeout` where the host has it. Where it does not (stock macOS),
# the install runs unbounded rather than not at all: the start lock is held
# throughout, so a wedged install blocks starts, but a skipped one guarantees
# there is nothing to start.
observe_npm_install() { # <dir> <log-file>
  local dir=${1:-} logfile=${2:-} npm=$OBSERVE_NPM
  [ -d "$dir" ] || return 1
  command -v "$npm" > /dev/null 2>&1 || {
    printf 'observe-lifecycle: npm is unavailable; cannot install %s\n' "$dir" >&2
    return 1
  }

  local -a runner=()
  if command -v timeout > /dev/null 2>&1; then
    runner=(timeout "$OBSERVE_INSTALL_TIMEOUT")
  fi

  if [ -f "$dir/package-lock.json" ]; then
    if (cd "$dir" && "${runner[@]}" "$npm" ci --no-audit --no-fund) \
      < /dev/null >> "$logfile" 2>&1; then
      return 0
    fi
    printf '\n--- npm ci failed in %s; retrying with npm install ---\n' "$dir" >> "$logfile" 2>&1
  fi
  (cd "$dir" && "${runner[@]}" "$npm" install --no-audit --no-fund) \
    < /dev/null >> "$logfile" 2>&1
}

# Make a source-only checkout runnable before the collector is forked.
#
# A Claude plugin marketplace install is a clone of this repository and nothing
# else: no `app/server/node_modules`, no built dashboard. Rather than requiring
# a manual `npm install`, the first start pays for it once, here, with the start
# lock held so concurrent hooks cannot install on top of each other.
#
# The two halves fail differently on purpose. Without server dependencies there
# is no collector at all, so that failure aborts the start with an actionable
# message. The dashboard is only the UI — a collector with no `dist/` still
# captures every event — so a failed client build is a warning, not a dead
# collector.
observe_bootstrap_collector() {
  local logfile server_dir client_dir
  server_dir="$OBSERVE_ROOT/app/server"
  client_dir="$OBSERVE_ROOT/app/client"
  logfile=$(observe_install_log)

  if [ ! -d "$server_dir/node_modules" ]; then
    observe_lifecycle_log install server-deps-started "log=$logfile"
    printf 'collector: installing server dependencies (one-time, first start of a source-only install)\n' >&2
    if ! observe_npm_install "$server_dir" "$logfile"; then
      observe_lifecycle_log install server-deps-failed "log=$logfile"
      printf 'observe-lifecycle: could not install the collector'"'"'s dependencies in %s\n' \
        "$server_dir" >&2
      printf 'observe-lifecycle: see %s, then retry — or run `npm install` in that directory by hand\n' \
        "$logfile" >&2
      return 1
    fi
    observe_lifecycle_log install server-deps-installed "log=$logfile"
  fi

  if [ ! -f "$client_dir/dist/index.html" ] && [ -f "$client_dir/package.json" ]; then
    observe_lifecycle_log install client-build-started "log=$logfile"
    printf 'collector: building the dashboard (one-time, first start of a source-only install)\n' >&2
    if { [ -d "$client_dir/node_modules" ] || observe_npm_install "$client_dir" "$logfile"; } &&
      (cd "$client_dir" && "$OBSERVE_NPM" run build) < /dev/null >> "$logfile" 2>&1; then
      observe_lifecycle_log install client-build-succeeded "log=$logfile"
    else
      observe_lifecycle_log install client-build-failed "log=$logfile"
      printf 'observe-lifecycle: dashboard build failed; events are still captured but the UI will not load (see %s)\n' \
        "$logfile" >&2
    fi
  fi
  return 0
}

# Start one collector as a host process and print its PID, so the caller can
# bind its confirmation to the thing it actually started rather than to any
# healthy successor that shows up during a race — see
# observe_wait_for_spawned_collector.
observe_spawn_collector_local() { # prints spawned PID
  local entrypoint data_dir db_path client_dist_path logfile
  [ -d "$OBSERVE_ROOT/app/server" ] || return 1
  observe_bootstrap_collector || return 1

  # The hook runs this shell arm directly, bypassing config.mjs's
  # getServerEnv(). Keep the local server's state beside the supervision
  # runtime and retain the local-mode loopback default.
  data_dir="$OBSERVE_DATA_ROOT/data"
  db_path=${AGENTS_OBSERVE_DB_PATH:-"$data_dir/observe.db"}
  client_dist_path=${AGENTS_OBSERVE_CLIENT_DIST_PATH:-"$OBSERVE_ROOT/app/client/dist"}
  mkdir -p "$data_dir" || return 1

  # One log per collector run — truncated at each start rather than appended, so
  # it stays the record of the collector that is running now. `observe_cli.mjs
  # logs-server` and `/observe logs` read this file.
  logfile="$OBSERVE_RUNTIME/collector.log"

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
        </dev/null >"$logfile" 2>&1 &
    else
      command -v node > /dev/null 2>&1 || {
        printf 'observe-lifecycle: node is unavailable\n' >&2
        exit 1
      }
      # Invoke Node directly rather than the tsx CLI: tsx can fork a wrapper,
      # while this PID must be the one that claims the collector lock.
      nohup node --import tsx src/index.ts "$OBSERVE_ENTRYPOINT_MARKER" \
        </dev/null >"$logfile" 2>&1 &
    fi
    printf '%s\n' "$!"
  )
}

# Confirm the collector we started, not merely any healthy successor that
# happened to appear during a race. The predicate below remains the one
# canonical health decision: this only binds its healthy result to the PID we
# forked.
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

observe_wait_for_collector_release() { # [seconds]
  local deadline
  deadline=$(observe_lifecycle_deadline "${1:-$OBSERVE_START_TIMEOUT}")
  while :; do
    [ ! -d "$OBSERVE_LOCK" ] && [ ! -e "$OBSERVE_HEARTBEAT" ] && return 0
    [ "$(observe_now_epoch)" -ge "$deadline" ] && return 1
    sleep "$OBSERVE_START_POLL"
  done
}
