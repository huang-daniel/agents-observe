#!/usr/bin/env bash
# Gracefully stop only the identity-matched collector that owns this data root.
set -u

SUPERVISION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hooks/scripts/supervision/observe-lifecycle.sh
. "$SUPERVISION_DIR/observe-lifecycle.sh"

observe_env_init || exit 2
observe_runtime_ensure || exit 2

if [ ! -d "$OBSERVE_LOCK" ]; then
  observe_lifecycle_log stop no-op
  printf 'collector: already stopped\n'
  exit 0
fi

if ! observe_owner_matches_lock; then
  if observe_collector_lock_is_abandoned; then
    observe_lifecycle_log stop no-live-owner
    printf 'collector: no live owner to stop\n'
    exit 0
  fi
  observe_lifecycle_log stop unsafe-owner
  printf 'collector: unsafe owner; refusing to signal\n' >&2
  exit 2
fi

observe_collector_lock_snapshot >/dev/null
if [ "$OBSERVE_LOCK_RUNTIME" = docker ]; then
  owner="container=$OBSERVE_LOCK_CONTAINER"
else
  owner="pid=$OBSERVE_LOCK_PID"
fi
observe_lifecycle_log stop signalling "$owner"
observe_signal_locked_collector TERM || exit 1
if observe_wait_for_collector_release "$(observe_shutdown_timeout_for "$OBSERVE_LOCK_RUNTIME")"; then
  observe_lifecycle_log stop stopped
  printf 'collector: stopped\n'
  exit 0
fi

observe_lifecycle_log stop shutdown-timeout
printf 'collector: timed out waiting for shutdown\n' >&2
exit 1
