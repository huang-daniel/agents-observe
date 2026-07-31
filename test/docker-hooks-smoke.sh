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

for _ in $(seq 1 30); do
  HEALTH="$(curl -fsS "http://127.0.0.1:$PORT/api/health")"
  if node -e '
    const health = JSON.parse(process.argv[1]);
    process.exit(
      health.collector?.spoolPending === 0 &&
        health.collector?.spoolFailed === 0 &&
        Boolean(health.collector?.lastCommittedEventId)
        ? 0
        : 1,
    )
  ' "$HEALTH"; then
    break
  fi
  sleep 1
done

node -e '
  const health = JSON.parse(process.argv[1]);
  if (health.collector?.spoolPending !== 0) throw new Error("spool did not drain");
  if (health.collector?.spoolFailed !== 0) throw new Error("raw hook dead-lettered");
  if (!health.collector?.lastCommittedEventId) throw new Error("no event was committed");
' "$(curl -fsS "http://127.0.0.1:$PORT/api/health")"

SESSIONS="$(curl -fsS "http://127.0.0.1:$PORT/api/sessions/recent?limit=20")"
node -e '
  const sessions = JSON.parse(process.argv[1]);
  for (const id of ["docker-smoke-claude", "docker-smoke-codex"]) {
    const session = sessions.find((item) => item.id === id);
    if (!session || session.eventCount < 1) throw new Error(`event for ${id} is not queryable`);
  }
' "$SESSIONS"

for session_id in docker-smoke-claude docker-smoke-codex; do
  EVENTS="$(curl -fsS "http://127.0.0.1:$PORT/api/sessions/$session_id/events")"
  node -e '
    const events = JSON.parse(process.argv[1]);
    if (!events.some((event) => event.hookName === "SessionStart")) {
      throw new Error("committed hook event is not queryable");
    }
  ' "$EVENTS"
done

echo 'Docker hook smoke test passed'
