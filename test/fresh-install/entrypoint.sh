#!/bin/bash
# Fresh install test harness — entrypoint (runs inside test container)
#
# Runs the real claude CLI against a source-only copy of the plugin — no
# app/server/node_modules, no built dashboard — and verifies that the hooks
# bootstrap the collector from that state on their own.

set -uo pipefail

TEST_USER=node
TEST_HOME=/home/node

echo "=== Fresh install test harness — entrypoint starting ==="
echo "Container: $(hostname)"
echo "Date: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo ""

# --- Prove the checkout really is dependency-free -----------------------
# The whole point of the harness. If the build context ever starts carrying
# node_modules or a built dashboard, every check below passes for the wrong
# reason, so fail loudly here instead.
echo "=== Confirming a source-only checkout ==="
PRISTINE=true
for path in /plugin/app/server/node_modules /plugin/app/client/node_modules /plugin/app/client/dist; do
  if [ -e "$path" ]; then
    echo "FATAL: $path exists — the build context is not a fresh install."
    echo "       Check .dockerignore."
    PRISTINE=false
  fi
done
$PRISTINE || exit 1
echo "no server deps, no client deps, no built dashboard — as a marketplace install ships"
echo ""

# --- Set CLAUDE_PLUGIN_ROOT ---------------------------------------------
# --plugin-dir loads the plugin's hooks.json. The hook commands reference
# ${CLAUDE_PLUGIN_ROOT} (bash expands it at exec time), so the var must be in
# the environment when claude launches the hook. Claude sets this automatically
# for installed plugins; for --plugin-dir we set it ourselves so the commands
# resolve correctly. The hooks are the whole integration — there is no separate
# launcher process to configure.
export CLAUDE_PLUGIN_ROOT=/plugin
echo "CLAUDE_PLUGIN_ROOT=$CLAUDE_PLUGIN_ROOT"
echo ""

# --- Run claude as a non-root user --------------------------------------
# Claude CLI refuses --permission-mode bypassPermissions as root.
echo "=== Running claude -p ... (as $TEST_USER) ==="
CLAUDE_STDOUT=/tmp/claude.stdout
CLAUDE_STDERR=/tmp/claude.stderr
CLAUDE_DEBUG_LOG=/tmp/claude-debug.log
set +e
su -s /bin/bash "$TEST_USER" -c "
  export HOME='$TEST_HOME'
  export CLAUDE_CODE_OAUTH_TOKEN='$CLAUDE_CODE_OAUTH_TOKEN'
  export AGENTS_OBSERVE_LOG_LEVEL='${AGENTS_OBSERVE_LOG_LEVEL:-trace}'
  export AGENTS_OBSERVE_PROJECT_SLUG='claude-test'
  # The server binds loopback by default (issue #22). Inside this container
  # that makes the dashboard unreachable from the host port-forward used for
  # the manual UI check, so publish on all interfaces. Safe: the container is
  # the isolation boundary, not a shared host.
  export AGENTS_OBSERVE_BIND='0.0.0.0'
  export CLAUDE_PLUGIN_ROOT='$CLAUDE_PLUGIN_ROOT'
  claude \
    --plugin-dir /plugin \
    --permission-mode bypassPermissions \
    --debug hooks \
    --debug-file '$CLAUDE_DEBUG_LOG' \
    -p '/observe status' \
    >'$CLAUDE_STDOUT' 2>'$CLAUDE_STDERR'
"
CLAUDE_EXIT=$?
# Do NOT restore set -e here — the rest of the script (verification +
# diagnostic dump) must tolerate individual command failures.

echo "claude exit code: $CLAUDE_EXIT"
echo ""

# The bootstrap install runs while the start lock is held, and the first hook
# event is what triggers it. `claude -p` can exit well before that finishes, so
# give the collector a bounded window to come up rather than racing it.
echo "=== Waiting for the collector to finish bootstrapping ==="
for i in $(seq 1 300); do
  if curl -sf http://127.0.0.1:4981/api/health >/dev/null 2>&1; then
    echo "server answered after ${i}s"
    break
  fi
  sleep 1
done
echo ""

# --- Verification phase -------------------------------------------------
echo "=== Running verification checks ==="
CHECK_1_RESULT="FAIL"; CHECK_1_DETAIL=""
CHECK_2_RESULT="FAIL"; CHECK_2_DETAIL=""
CHECK_3_RESULT="FAIL"; CHECK_3_DETAIL=""
CHECK_4_CLI_COUNT=0
SUPERVISION_STATUS="(not collected)"

# Check 1: the collector installed its own dependencies.
#
# This is the check that replaces "an agents-observe container is running": a
# marketplace install ships source only, so a running collector means the
# bootstrap in observe-lifecycle.sh did its job.
if [ -d /plugin/app/server/node_modules ]; then
  CHECK_1_RESULT="PASS"
  CHECK_1_DETAIL="app/server/node_modules present ($(find /plugin/app/server/node_modules -maxdepth 1 -mindepth 1 | wc -l | tr -d ' ') entries)"
else
  CHECK_1_DETAIL="app/server/node_modules still missing — the bootstrap install did not run or failed"
fi

# Check 2: the server is not merely answering — it is a supervised collector.
#
# `ok:true` at the expected version used to be the whole check, and that is
# exactly how source drift slipped through: a server that predates collector
# supervision serves this endpoint perfectly while never claiming the lock or
# publishing a heartbeat, so the hooks can never confirm it. The collector block
# is the capability evidence.
EXPECTED_VERSION="$(tr -d '[:space:]' < /plugin/VERSION 2>/dev/null || true)"
HEALTH_BODY="$(curl -sf http://127.0.0.1:4981/api/health 2>/tmp/curl-health.err || true)"
if [ -z "$HEALTH_BODY" ] || ! echo "$HEALTH_BODY" | jq -e '.ok == true' >/dev/null 2>&1; then
  CHECK_2_DETAIL="body='$HEALTH_BODY' curl-err='$(cat /tmp/curl-health.err 2>/dev/null || true)'"
elif [ -n "$EXPECTED_VERSION" ] &&
  ! echo "$HEALTH_BODY" | jq -e --arg v "$EXPECTED_VERSION" '.version == $v' >/dev/null 2>&1; then
  CHECK_2_DETAIL="version mismatch: served $(echo "$HEALTH_BODY" | jq -r '.version') expected $EXPECTED_VERSION"
elif ! echo "$HEALTH_BODY" | jq -e '.collector != null' >/dev/null 2>&1; then
  CHECK_2_DETAIL="incompatible-collector: v$(echo "$HEALTH_BODY" | jq -r '.version') serves /api/health but exposes no collector block"
elif ! echo "$HEALTH_BODY" | jq -e '.collector.status == "healthy"' >/dev/null 2>&1; then
  CHECK_2_DETAIL="collector $(echo "$HEALTH_BODY" | jq -c '{status: .collector.status, reason: .collector.reason}')"
else
  CHECK_2_RESULT="PASS"
  CHECK_2_DETAIL="$(echo "$HEALTH_BODY" |
    jq -c '{ok, version, collector: (.collector | {instanceId, dataRoot, status})}')"
fi

# Check 3: at least one session with at least one event captured
SESSIONS_BODY="$(curl -sf http://127.0.0.1:4981/api/sessions/recent 2>/tmp/curl-sessions.err || true)"
if [ -n "$SESSIONS_BODY" ]; then
  SESSION_COUNT="$(echo "$SESSIONS_BODY" | jq 'if type == "array" then length elif .sessions then (.sessions | length) else 0 end' 2>/dev/null || echo 0)"
  if [ "${SESSION_COUNT:-0}" -gt 0 ]; then
    CHECK_3_RESULT="PASS"
    CHECK_3_DETAIL="session_count=$SESSION_COUNT"
  else
    CHECK_3_DETAIL="session_count=0 (expected >=1) body='$(echo "$SESSIONS_BODY" | head -c 200)'"
  fi
else
  CHECK_3_DETAIL="empty response curl-err='$(cat /tmp/curl-sessions.err 2>/dev/null || true)'"
fi

# Check 4 (soft): grep ERROR lines in cli.log
CLI_LOG_FILES="$(find "$TEST_HOME/.agents-observe" /plugin/data -type f -name 'cli.log' 2>/dev/null)"
if [ -n "$CLI_LOG_FILES" ]; then
  CHECK_4_CLI_COUNT="$(grep -c 'ERROR' $CLI_LOG_FILES 2>/dev/null | awk -F: '{s+=$NF} END {print s+0}')"
fi

# --- Unconditional diagnostic dump -------------------------------------
echo ""
echo "=============================================="
echo "=== DIAGNOSTIC BUNDLE (always printed)     ==="
echo "=============================================="
echo ""
echo "=== claude version ==="
claude --version 2>&1 || echo "(claude --version failed)"
echo ""

echo "=== claude invocation ==="
echo "exit code: $CLAUDE_EXIT"
echo ""
echo "--- claude stdout ---"
cat "$CLAUDE_STDOUT" 2>/dev/null || echo "(file not found)"
echo ""
echo "--- claude stderr ---"
cat "$CLAUDE_STDERR" 2>/dev/null || echo "(file not found)"
echo ""
echo "--- claude debug log (plugin + hook loading) ---"
# Filter to lines that matter for plugin/hook diagnosis. If the full log
# is needed, docker exec into the kept-alive container and cat
# $CLAUDE_DEBUG_LOG directly.
if [ -f "$CLAUDE_DEBUG_LOG" ]; then
  grep -E '\[ERROR\]|\[WARN\]|Registered .* hooks|Loaded .* plugin|Loaded hooks|Hooks: Found|Invalid key|Invalid option|SyntaxError|Hook [A-Z]' "$CLAUDE_DEBUG_LOG" 2>/dev/null | head -60 || true
  DBG_SIZE="$(wc -l < "$CLAUDE_DEBUG_LOG" 2>/dev/null || echo 0)"
  echo "(filtered view; full log is $DBG_SIZE lines at $CLAUDE_DEBUG_LOG inside the container)"
else
  echo "(no debug log at $CLAUDE_DEBUG_LOG)"
fi
echo ""

# The collector's own account of itself: what the supervisor decided, whether
# the bootstrap install succeeded, and whether events are draining out of the
# durable spool. This is where a capture failure shows up first.
echo "=== collector supervision ==="
SUPERVISION_STATUS="$(su -s /bin/bash "$TEST_USER" -c "HOME='$TEST_HOME' /plugin/hooks/scripts/supervision/observe-health.sh" 2>&1 || true)"
echo "$SUPERVISION_STATUS"
for root in "$TEST_HOME/.agents-observe" /root/.agents-observe; do
  if [ -d "$root/runtime" ]; then
    echo "--- $root/runtime ---"
    find "$root/runtime" -maxdepth 3 2>/dev/null | head -40 || true
    echo "--- $root/runtime/collector-lifecycle.log ---"
    tail -n 40 "$root/runtime/collector-lifecycle.log" 2>/dev/null || true
    echo "--- $root/runtime/collector-install.log (tail) ---"
    tail -n 40 "$root/runtime/collector-install.log" 2>/dev/null || echo "(no install log)"
    echo "--- $root/runtime/collector.log (tail) ---"
    tail -n 40 "$root/runtime/collector.log" 2>/dev/null || echo "(no collector log)"
  fi
done
echo ""

echo "=== cli.log ==="
if [ -n "$CLI_LOG_FILES" ]; then
  for f in $CLI_LOG_FILES; do
    echo "--- $f ---"
    cat "$f" || true
  done
else
  echo "(no cli.log files found)"
fi
echo ""

# claude writes its own internal state (transcripts, plugin cache, and
# sometimes debug logs) under ~/.claude. Dump any log files it left plus
# a listing so plugin/hook loading errors aren't silent.
echo "=== claude internal state (~/.claude) ==="
for home in "$TEST_HOME" /root; do
  if [ -d "$home/.claude" ]; then
    echo "--- $home/.claude (top-level listing) ---"
    find "$home/.claude" -maxdepth 3 -type f 2>/dev/null | head -40 || true
    echo ""
    CLAUDE_LOGS="$(find "$home/.claude" -type f -name '*.log' 2>/dev/null)"
    if [ -n "$CLAUDE_LOGS" ]; then
      for f in $CLAUDE_LOGS; do
        echo "--- $f ---"
        head -n 200 "$f" 2>/dev/null || true
        echo ""
      done
    else
      echo "(no *.log files under $home/.claude)"
    fi
  fi
done
echo ""

echo "=== verification results ==="
echo "1. Bootstrap install ran:  $CHECK_1_RESULT — $CHECK_1_DETAIL"
echo "2. Server health:          $CHECK_2_RESULT — $CHECK_2_DETAIL"
echo "3. Events captured:        $CHECK_3_RESULT — $CHECK_3_DETAIL"
echo "4. cli.log ERROR lines:    $CHECK_4_CLI_COUNT"
echo "   Collector supervision:  $SUPERVISION_STATUS"

# Check 5 (soft): UI HTML loads and references valid assets. This is also the
# only check that covers the client half of the bootstrap — the dashboard is a
# build artifact, so a fresh install has to build it before there is any UI.
CHECK_5_RESULT="SKIP"
CHECK_5_DETAIL=""
UI_HTML="$(curl -sf http://127.0.0.1:4981/ 2>/dev/null || true)"
if [ -n "$UI_HTML" ]; then
  if echo "$UI_HTML" | grep -q '<div id="root">' && echo "$UI_HTML" | grep -q '<script'; then
    # Verify JS assets are reachable
    ASSET_URLS="$(echo "$UI_HTML" | grep -oE '(src|href)="/assets/[^"]+' | sed 's/^[^"]*"//' || true)"
    ASSETS_OK=true
    for asset in $ASSET_URLS; do
      if ! curl -sf "http://127.0.0.1:4981${asset}" -o /dev/null 2>/dev/null; then
        ASSETS_OK=false
        CHECK_5_DETAIL="missing asset: $asset"
        break
      fi
    done
    if $ASSETS_OK; then
      CHECK_5_RESULT="PASS"
      CHECK_5_DETAIL="HTML + $(echo "$ASSET_URLS" | wc -w | tr -d ' ') assets OK"
    else
      CHECK_5_RESULT="FAIL"
    fi
  else
    CHECK_5_RESULT="FAIL"
    CHECK_5_DETAIL="HTML missing root div or script tag"
  fi
else
  CHECK_5_DETAIL="curl to / returned empty"
fi
echo "5. UI assets reachable:    $CHECK_5_RESULT — $CHECK_5_DETAIL"
echo ""

# --- Final status ------------------------------------------------------
if [ "$CHECK_1_RESULT" = "PASS" ] && [ "$CHECK_2_RESULT" = "PASS" ] && [ "$CHECK_3_RESULT" = "PASS" ]; then
  FINAL_STATUS="PASS"
else
  FINAL_STATUS="FAIL"
fi

echo "=== final status: $FINAL_STATUS ==="
echo "[CHECKS_DONE]"

# Keep alive if requested — works on PASS (for manual UI verification)
# AND on FAIL (so the operator can `docker exec -it` in and poke around,
# look at ~/.claude, run `claude --version`, etc.)
if [ "${AGENTS_OBSERVE_TEST_KEEP_ALIVE:-}" = "1" ]; then
  if [ "$FINAL_STATUS" = "PASS" ]; then
    echo "Container staying alive for manual UI check. Kill to exit."
  else
    echo "Test FAILED — container staying alive for investigation."
    echo "  docker exec -it \$(hostname) bash"
  fi
  echo ""
  sleep infinity
fi

if [ "$FINAL_STATUS" = "PASS" ]; then
  exit 0
else
  exit 1
fi
