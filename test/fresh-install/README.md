# Fresh Install Test Harness

Reproduces a pristine fresh-install environment and runs the real `claude` CLI against the agents-observe plugin end-to-end, verifying that the hook → spool → supervisor → collector → event-capture flow works from zero state.

## Why this exists

A Claude plugin marketplace install is a source-only clone: no `app/server/node_modules`, no built dashboard. The first hook event has to bootstrap all of that before a collector can exist at all — the supervisor installs the server's dependencies, builds the client, and only then forks the collector (see `observe_bootstrap_collector` in [hooks/scripts/supervision/observe-lifecycle.sh](../../hooks/scripts/supervision/observe-lifecycle.sh)). When that fails on a user's machine (see [#6](https://github.com/simple10/agents-observe/issues/6)), reproducing it locally is hard: an existing checkout already has its dependencies, so the interesting path never runs. This harness runs everything inside a throwaway container so every run starts from nothing.

Docker appears here only as that isolation boundary. It is not a runtime the plugin supports — see [docs/collector-supervision.md](../../docs/collector-supervision.md).

## Usage

```bash
# Set the OAuth token (or put it in .env — the script sources it)
export AGENTS_OBSERVE_TEST_CLAUDE_OAUTH_TOKEN=sk-ant-oat-...

# Run the harness
./scripts/test-fresh-install.sh
```

The script builds the test container, runs it, and exits with the test container's exit code. A full diagnostic bundle is printed at the end of every run.

## Required environment variables

| Variable | Purpose |
|---|---|
| `AGENTS_OBSERVE_TEST_CLAUDE_OAUTH_TOKEN` | OAuth token for the `claude` CLI. The driver remaps this to `CLAUDE_CODE_OAUTH_TOKEN` when launching the test container. Keep it in a gitignored `.env` file — the driver auto-sources it. |

## What the harness verifies

The entrypoint first asserts the copied checkout really is dependency-free (no `node_modules`, no `app/client/dist`); if `.dockerignore` ever stops excluding those, the run fails immediately rather than passing for the wrong reason.

Then, after `claude` exits:

1. **Bootstrap install ran** — `app/server/node_modules` now exists inside the container, i.e. the supervisor installed the collector's dependencies on its own. Hard check.
2. **Server health** — `curl http://127.0.0.1:4981/api/health` returns 200 with `ok: true` at the expected version, and a `collector` block that names this instance's data root and reports `healthy` — an `ok:true` server that lacks a healthy collector block predates supervision and fails this check (see [docs/collector-supervision.md](../../docs/collector-supervision.md)). Hard check.
3. **Events captured** — `curl http://127.0.0.1:4981/api/sessions/recent` returns at least one session. Hard check.
4. **Error count in logs** — greps `ERROR` lines in `cli.log`, and reports the collector supervision status plus the lifecycle ledger. Soft check (reported, does not fail the run).
5. **UI assets reachable** — the dashboard HTML and its `/assets/*` bundles load, which is the only check that covers the client half of the bootstrap. Soft check.

The run exits 0 iff all three hard checks pass.

## Gotchas

- **Performance.** The first start pays for `npm ci` in `app/server`, `npm ci` in `app/client`, and a Vite build, all inside the container. Budget ~3–5 minutes per end-to-end run.
- **Network.** The bootstrap install fetches from the npm registry, so the container needs network access.
- **OAuth token quota.** Every run makes a real API call against Anthropic. The prompt is minimal (one sentence) to keep cost negligible.
- **Node.js and Claude CLI are unpinned** in the test container — the `node:22-alpine` base and the latest `@anthropic-ai/claude-code` from npm. This is intentional (catches regressions against whatever's latest) but means the image needs rebuilding periodically to pick up updates.

## What to do when it fails

Read the diagnostic bundle from top to bottom:

1. Was the checkout actually pristine? (The run aborts before anything else if not.)
2. Did `claude` run? (`claude exit code: 0` and some stdout.)
3. Did the bootstrap install succeed? (`collector-install.log` in the supervision runtime dir — it holds the full `npm` output.)
4. Did the supervisor start the collector? (`collector supervision` section — the lifecycle ledger records each `install` and `start` decision and its outcome.)
5. Did the collector serve? (`collector.log` in the same dir is the collector's stdout/stderr.)
6. Did events reach the collector? (`collector supervision` reports `healthy`, and `runtime/spool/pending` is empty — a growing pending directory means events are being captured but nothing is committing them.)

The first PASS/FAIL that doesn't match what you expect is the bug.

## Files

| Path | Purpose |
|---|---|
| `scripts/test-fresh-install.sh` | Host-side driver (what you run) |
| `test/fresh-install/Dockerfile` | Test container image definition |
| `test/fresh-install/entrypoint.sh` | Orchestrates the claude run and verification inside the container |
| `test/fresh-install/README.md` | This file |
| `.dockerignore` | Keeps the build context dependency-free — the harness depends on it |
| `hooks/scripts/supervision/observe-lifecycle.sh` | `observe_bootstrap_collector` + the one path that starts the collector; the harness exercises both through the plugin's hooks |
