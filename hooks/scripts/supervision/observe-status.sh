#!/usr/bin/env bash
# Status is intentionally only the canonical health diagnostic. A held start
# lock is not reported as a second health state because it says nothing about
# collector ownership or working health.

SUPERVISION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SUPERVISION_DIR/observe-health.sh" "$@"
