#!/usr/bin/env bash
# Test-only collector whose explicit pause points let arm tests kill it at
# startup boundaries without relying on scheduler timing.
set -u

FIXTURE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$FIXTURE_DIR/../../../../.." && pwd)"
. "$REPO_ROOT/hooks/scripts/supervision/lib/observe-heartbeat.sh"

observe_env_init || exit 2
observe_runtime_ensure || exit 2
phase=${AGENTS_OBSERVE_TEST_COLLECTOR_PHASE:?}
ready="$OBSERVE_RUNTIME/phase-collector.pid"

if [ "$phase" = before-lock ]; then
  printf '%s\n' "${BASHPID:-$$}" > "$ready"
  while :; do sleep 1; done
fi

instance="phase-${BASHPID:-$$}"
observe_collector_lock_claim "$instance" "${BASHPID:-$$}" || exit 3
if [ "$phase" = after-lock ]; then
  printf '%s\n' "${BASHPID:-$$}" > "$ready"
  while :; do sleep 1; done
fi

observe_heartbeat_publish "$instance" "${BASHPID:-$$}" || exit 1
if [ "$phase" = after-heartbeat ]; then
  printf '%s\n' "${BASHPID:-$$}" > "$ready"
  while :; do sleep 1; done
fi
