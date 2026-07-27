#!/usr/bin/env bash
# Records the environment received from observe_spawn_collector, then delegates
# to the normal test collector so the arm still verifies the real lifecycle.
set -eu

FIXTURE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

{
  printf 'AGENTS_OBSERVE_LOCAL_DATA_ROOT=%s\n' "${AGENTS_OBSERVE_LOCAL_DATA_ROOT:-}"
  printf 'AGENTS_OBSERVE_DB_PATH=%s\n' "${AGENTS_OBSERVE_DB_PATH:-}"
  printf 'AGENTS_OBSERVE_CLIENT_DIST_PATH=%s\n' "${AGENTS_OBSERVE_CLIENT_DIST_PATH:-}"
  printf 'AGENTS_OBSERVE_BIND_HOST=%s\n' "${AGENTS_OBSERVE_BIND_HOST:-}"
} > "$AGENTS_OBSERVE_CAPTURE_ENV_PATH"

exec "$FIXTURE_DIR/fake-collector.sh" "$@"
