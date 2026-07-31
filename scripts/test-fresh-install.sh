#!/bin/bash
# scripts/test-fresh-install.sh
# Fresh install test harness — host-side driver.
#
# Builds a pristine test container holding a source-only copy of the plugin
# (no dependency trees, no built dashboard — see .dockerignore), runs the real
# claude CLI against it, and verifies that the hooks bootstrap a working
# collector from that state end-to-end.
#
# Docker is used here only as the isolation boundary for the test. It is not a
# runtime the plugin supports — see docs/collector-supervision.md.
#
# Required env:
#   AGENTS_OBSERVE_TEST_CLAUDE_OAUTH_TOKEN — OAuth token for the claude CLI
#   (can be set in .env at the repo root — this script sources it)
#
# Usage:
#   ./scripts/test-fresh-install.sh [--skip-ui-check]
#
# Flags:
#   --skip-ui-check  Skip the manual UI verification step.

set -euo pipefail

SKIP_UI_CHECK=false
for arg in "$@"; do
  case "$arg" in
    --skip-ui-check) SKIP_UI_CHECK=true ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# --- Source .env if present --------------------------------------------
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
fi

# --- Preflight ---------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not found on PATH" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "ERROR: docker daemon is not responsive" >&2
  echo "       Start Docker Desktop (or equivalent) and try again." >&2
  exit 1
fi

if [ -z "${AGENTS_OBSERVE_TEST_CLAUDE_OAUTH_TOKEN:-}" ]; then
  echo "ERROR: AGENTS_OBSERVE_TEST_CLAUDE_OAUTH_TOKEN is not set" >&2
  echo "" >&2
  echo "This env var holds the OAuth token used to authenticate the claude" >&2
  echo "CLI inside the test container. Set it in .env (gitignored) or" >&2
  echo "export it in your shell:" >&2
  echo "  export AGENTS_OBSERVE_TEST_CLAUDE_OAUTH_TOKEN=sk-ant-oat-..." >&2
  exit 1
fi

CONTAINER_NAME="agents-observe-fresh-install-test"
UI_PORT=4998

trap 'docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1' EXIT

# --- Build test container image ----------------------------------------
echo ""
echo "=== [1/2] Building test container image (agents-observe-test:local) ==="
# Pass a fresh cache-bust token so the claude-code npm-install layer is
# never cached — we want the harness to test against the latest claude
# (claude auto-updates for real users; a stale cached version gives
# false confidence).
docker build \
  -t agents-observe-test:local \
  --build-arg "CLAUDE_CODE_CACHE_BUST=$(date +%s)" \
  -f test/fresh-install/Dockerfile .

# --- Run test container ------------------------------------------------
echo ""
echo "=== [2/2] Running test container ==="

# Determine if we need keep-alive for UI check
KEEP_ALIVE="0"
if ! $SKIP_UI_CHECK; then
  KEEP_ALIVE="1"
fi

# Remove any leftover container from a previous run
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

# Run detached so we can poll logs and keep it alive for UI check
docker run -d \
  --name "$CONTAINER_NAME" \
  -p "${UI_PORT}:4981" \
  -e "CLAUDE_CODE_OAUTH_TOKEN=$AGENTS_OBSERVE_TEST_CLAUDE_OAUTH_TOKEN" \
  -e "AGENTS_OBSERVE_LOG_LEVEL=trace" \
  -e "AGENTS_OBSERVE_TEST_KEEP_ALIVE=$KEEP_ALIVE" \
  agents-observe-test:local

# Stream logs and wait for [CHECKS_DONE] marker
echo ""
echo "Waiting for automated checks to complete..."
while true; do
  if docker logs "$CONTAINER_NAME" 2>&1 | grep -q '\[CHECKS_DONE\]'; then
    break
  fi
  # If container exited (checks failed), break
  if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null)" != "true" ]; then
    break
  fi
  sleep 1
done

# Print the full logs
echo ""
docker logs "$CONTAINER_NAME" 2>&1

# Get the automated check result
FINAL_LINE="$(docker logs "$CONTAINER_NAME" 2>&1 | grep '=== final status:' | tail -1)"
if echo "$FINAL_LINE" | grep -q 'PASS'; then
  AUTO_EXIT=0
else
  AUTO_EXIT=1
fi

# --- Manual UI check (on PASS) or investigation pause (on FAIL) ------
# On both paths we leave the container running until the user presses
# Enter, so failures can be inspected with `docker exec`. The EXIT trap
# still cleans up afterwards.
if ! $SKIP_UI_CHECK; then
  if [ $AUTO_EXIT -eq 0 ]; then
    echo ""
    echo "=============================================="
    echo "=== Manual UI Check                        ==="
    echo "=============================================="
    echo ""
    echo "Dashboard is running at: http://localhost:${UI_PORT}"
    echo ""

    # Open browser (macOS)
    if command -v open >/dev/null 2>&1; then
      open "http://localhost:${UI_PORT}"
    fi

    echo "Please verify:"
    echo "  1. Dashboard loads without errors"
    echo "  2. Session appears in the sidebar"
    echo "  3. Events are visible in the stream"
    echo ""
    read -r -p "Does the UI look correct? [Y/n] " UI_CONFIRM
    if [ "$(echo "$UI_CONFIRM" | tr '[:upper:]' '[:lower:]')" = "n" ]; then
      echo "UI check failed by user."
      AUTO_EXIT=1
    else
      echo "UI check passed."
    fi
  else
    echo ""
    echo "=============================================="
    echo "=== Test FAILED — container kept alive     ==="
    echo "=============================================="
    echo ""
    echo "Investigate with:"
    echo "  docker exec -it $CONTAINER_NAME bash"
    echo "  docker logs $CONTAINER_NAME"
    echo ""
    echo "Once inside the container, useful things to try:"
    echo "  claude --version"
    echo "  ls -la /home/node/.claude"
    echo "  find /home/node/.claude -type f | head"
    echo "  su node -c 'claude --plugin-dir /plugin -p \"/hooks\"'"
    echo ""
    read -r -p "Press Enter to clean up and exit... " _
  fi
fi

echo ""
echo "=== test-fresh-install exited with code $AUTO_EXIT ==="
exit $AUTO_EXIT
