#!/usr/bin/env bash
# Production-image regression coverage for raw hook normalization. The server
# and the shipped hook.sh share one data root, exactly as a plugin install does.

set -euo pipefail

IMAGE='agents-observe:docker-hooks-smoke'
ROOT="$(mktemp -d /tmp/agents-observe-docker-hooks.XXXXXX)"
NAME="agents-observe-docker-hooks-$$"
INSTANCE="docker-hooks-smoke-$$"
PORT="$(node -e "const net=require('net'); const server=net.createServer(); server.listen(0, '127.0.0.1', () => { console.log(server.address().port); server.close() })")"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$ROOT"
}
trap cleanup EXIT

mkdir -p "$ROOT/data" "$ROOT/runtime/spool/pending" "$ROOT/runtime/spool/processing" "$ROOT/runtime/spool/failed"

docker build -t "$IMAGE" .
docker run -d --name "$NAME" \
  --label "simple10-agents-observe.managed=smoke" \
  --label "simple10-agents-observe.instance=$INSTANCE" \
  -p "127.0.0.1:$PORT:4981" \
  -e AGENTS_OBSERVE_RUNTIME=docker \
  -e AGENTS_OBSERVE_BIND_HOST=0.0.0.0 \
  -e AGENTS_OBSERVE_DATA_ROOT="$ROOT" \
  -e AGENTS_OBSERVE_DB_PATH=/data/observe.db \
  -e AGENTS_OBSERVE_COLLECTOR_CONTAINER="$NAME" \
  -e AGENTS_OBSERVE_INSTANCE_ID="$INSTANCE" \
  -e AGENTS_OBSERVE_SHUTDOWN_DELAY_MS=0 \
  -v "$ROOT/data:/data" \
  -v "$ROOT:$ROOT" \
  "$IMAGE" >/dev/null

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" | grep -q '"ok":true'; then
    break
  fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/api/health" | grep -q '"ok":true'

# The image has to be a *supervised collector*, not merely a server that
# answers. An image built before collector supervision serves this endpoint
# exactly as well while never claiming the lock or publishing a heartbeat, so
# the hooks can never confirm it — the source/image drift that took the
# collector down. Assert the capability, the requested run, and the shared data
# root, so a Dockerfile or build that drops supervision fails here instead of
# after publication.
node -e '
  const health = JSON.parse(process.argv[1]);
  const [instance, dataRoot] = process.argv.slice(2);
  const collector = health.collector;
  if (!collector) {
    console.error(`incompatible-collector: v${health.version} exposes no collector block`);
    process.exit(1);
  }
  const mismatches = [
    ["instanceId", collector.instanceId, instance],
    ["dataRoot", collector.dataRoot, dataRoot],
    ["status", collector.status, "healthy"],
  ].filter(([, actual, expected]) => actual !== expected);
  if (mismatches.length) {
    for (const [field, actual, expected] of mismatches) {
      console.error(`collector.${field}: got ${actual}, expected ${expected}`);
    }
    process.exit(1);
  }
' "$(curl -fsS "http://127.0.0.1:$PORT/api/health")" "$INSTANCE" "$ROOT"

run_hook() {
  local agent_class=$1 session_id=$2
  printf '{"hook_event_name":"SessionStart","session_id":"%s","agent_id":"%s-agent","cwd":"/workspace"}' \
    "$session_id" "$agent_class" \
    | AGENTS_OBSERVE_DATA_ROOT="$ROOT" \
      AGENTS_OBSERVE_COLLECTOR_RUNTIME=docker \
      AGENTS_OBSERVE_DOCKER_CONTAINER_NAME="$NAME" \
      AGENTS_OBSERVE_INSTANCE_ID="$INSTANCE" \
      AGENTS_OBSERVE_HEALTH_URL="http://127.0.0.1:$PORT/api/health" \
      AGENTS_OBSERVE_AGENT_CLASS="$agent_class" \
      bash hooks/scripts/hook.sh
}

run_hook claude-code docker-smoke-claude
run_hook codex docker-smoke-codex

# hook.sh backgrounds its work and returns immediately, so a raw event can
# still be in flight when the loop below takes its first sample. Re-check
# health *and* API queryability together on every iteration so a premature
# "already drained" reading (observed before the slower hook's event has
# even reached the spool) gets caught by the session checks and retried,
# instead of being asserted once against a possibly-incomplete snapshot.
verify() {
  HEALTH="$(curl -fsS "http://127.0.0.1:$PORT/api/health")" || return 1
  node -e '
    const health = JSON.parse(process.argv[1]);
    process.exit(
      health.collector?.spoolPending === 0 &&
        health.collector?.spoolFailed === 0 &&
        Boolean(health.collector?.lastCommittedEventId)
        ? 0
        : 1,
    )
  ' "$HEALTH" || return 1

  SESSIONS="$(curl -fsS "http://127.0.0.1:$PORT/api/sessions/recent?limit=20")" || return 1
  node -e '
    const sessions = JSON.parse(process.argv[1]);
    for (const id of ["docker-smoke-claude", "docker-smoke-codex"]) {
      const session = sessions.find((item) => item.id === id);
      if (!session || session.eventCount < 1) process.exit(1);
    }
  ' "$SESSIONS" || return 1

  for session_id in docker-smoke-claude docker-smoke-codex; do
    EVENTS="$(curl -fsS "http://127.0.0.1:$PORT/api/sessions/$session_id/events")" || return 1
    node -e '
      const events = JSON.parse(process.argv[1]);
      process.exit(events.some((event) => event.hookName === "SessionStart") ? 0 : 1);
    ' "$EVENTS" || return 1
  done
}

verified=0
for _ in $(seq 1 30); do
  if verify; then
    verified=1
    break
  fi
  sleep 1
done
if [ "$verified" -ne 1 ]; then
  echo 'Docker hook smoke test failed: spool/session state did not settle in time' >&2
  curl -fsS "http://127.0.0.1:$PORT/api/health" >&2 || true
  exit 1
fi

echo 'Docker hook smoke test passed'
