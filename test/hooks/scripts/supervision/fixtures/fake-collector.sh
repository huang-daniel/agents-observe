#!/usr/bin/env bash
# Test-only collector entrypoint for the arm integration tests. It owns the
# shipped shell lock/heartbeat state and serves the configured HTTP health URL.
set -u

FIXTURE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# fixtures -> supervision -> scripts -> hooks -> test -> repo root
REPO_ROOT="$(cd "$FIXTURE_DIR/../../../../.." && pwd)"
. "$REPO_ROOT/hooks/scripts/supervision/lib/observe-heartbeat.sh"

observe_env_init || exit 2
observe_runtime_ensure || exit 2
instance="fixture-${BASHPID:-$$}-$(observe_now_epoch)"
observe_collector_lock_claim "$instance" "${BASHPID:-$$}" || exit 3

node -e '
  const http = require("node:http")
  http.createServer((_, res) => { res.statusCode = 200; res.end("ok") })
    .listen(Number(process.env.AGENTS_OBSERVE_SERVER_PORT), "127.0.0.1")
' >/dev/null 2>&1 &
http_pid=$!

cleanup() {
  kill -TERM "$http_pid" 2>/dev/null || true
  wait "$http_pid" 2>/dev/null || true
  rm -f "$OBSERVE_HEARTBEAT" 2>/dev/null || true
  observe_collector_lock_release "$OBSERVE_LOCK" "${BASHPID:-$$}" || true
  exit 0
}
trap cleanup TERM INT

while :; do
  observe_heartbeat_publish "$instance" "${BASHPID:-$$}" || cleanup
  sleep 0.05
done
