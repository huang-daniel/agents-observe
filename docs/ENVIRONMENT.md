# Environment Variables

This is the authoritative list of every environment variable the project
reads. README and `docs/DEVELOPMENT.md` link here so the tables below
stay the single source of truth.

All variables are prefixed `AGENTS_OBSERVE_*` except a few set by
external systems.

---

## Hook CLI

Read at CLI invocation by `hooks/scripts/lib/config.mjs`. Set these in
your shell profile or the Claude Code plugin config to customize
per-user behavior. `hooks/scripts/supervision/observe-spool.sh` mirrors
`AGENT_CLASS`, `PROJECT_SLUG`, `NOTIFICATION_ON_EVENTS`, and
`MAX_IMAGE_DATA_CHARS` in bash so `hook.sh` can encode them onto each raw
spool entry without invoking Node — keep the two readers' defaults in sync,
same as the [collector supervision](./collector-supervision.md#two-implementations-one-contract)
shell/TypeScript pairs.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENTS_OBSERVE_AGENT_CLASS` | `claude-code` | Which agent class the CLI dispatches through: `claude-code`, `codex`, or anything else (falls back to the `unknown` lib). |
| `AGENTS_OBSERVE_PROJECT_SLUG` | *(unset)* | Override the project slug the CLI reports on each event. |
| `AGENTS_OBSERVE_NOTIFICATION_ON_EVENTS` | *(unset — defaults to `Notification`)* | Comma-separated hook events that trigger the notification bell. Empty string (`""`) disables bells entirely. Claude Code's `Notification` hook fires by default; Codex has no equivalent, so Codex users must opt in (e.g. set to `Stop` to fire on turn end). See [spec-configurable-notification-events.md](./plans/spec-configurable-notification-events.md). |
| `AGENTS_OBSERVE_MAX_IMAGE_DATA_CHARS` | `50000` | Base64 image `tool_response` data longer than this many characters is replaced with `[REDACTED]` before storage. |
| `AGENTS_OBSERVE_ALLOW_LOCAL_CALLBACKS` | `all` | Comma-separated allowlist of server-initiated callbacks the CLI will execute. `all` permits every known handler. |
| `AGENTS_OBSERVE_API_BASE_URL` | *(derived from `AGENTS_OBSERVE_SERVER_PORT`)* | Full URL of the server API (e.g. `http://remote:4981/api`). Overrides the auto-started local server. |
| `AGENTS_OBSERVE_LOG_LEVEL` | `warn` | CLI log level: `error`, `warn`, `info`, `debug`, `trace`. |
| `AGENTS_OBSERVE_LOGS_DIR` | `<data root>/logs` | Directory where the CLI writes logs. |
| `AGENTS_OBSERVE_LOCAL_DATA_ROOT` | `$CLAUDE_PLUGIN_DATA` (plugin) / `~/.agents-observe` (else) | Root directory for the SQLite DB, logs, and server-port file. The DB lives at `<root>/data/observe.db`. |

---

## Server runtime

Read by the API server in `app/server/src/config.ts`. When you start
the server via the CLI (the normal path), these are populated
automatically from the CLI config via `getServerEnv()`. When a hook
auto-arms a local collector directly — bypassing the CLI —
`hooks/scripts/supervision/observe-lifecycle.sh`'s `observe_spawn_collector_local`
computes the defaults (`AGENTS_OBSERVE_DB_PATH`,
`AGENTS_OBSERVE_CLIENT_DIST_PATH`, `AGENTS_OBSERVE_BIND_HOST`) in shell so
hook-spawned collectors match. Override them only when running the server
directly.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENTS_OBSERVE_SERVER_PORT` | `4981` | HTTP + WebSocket port the server listens on. |
| `AGENTS_OBSERVE_BIND` | `127.0.0.1` | Host interface the server is published on. Loopback by default so the unauthenticated dashboard/WebSocket isn't exposed beyond this machine (issue #22). Set to `0.0.0.0` for LAN access. Passed through to the server as its listen host. |
| `AGENTS_OBSERVE_CORS_ORIGINS` | *(unset — loopback origins only)* | Comma-separated origin allowlist for the browser API **and the WebSocket handshake**. Unset allows only loopback origins (the client is served same-origin, so this covers normal use). `*` allows any origin (opt-in). A WebSocket request with no `Origin` header (non-browser client) is always allowed. |
| `AGENTS_OBSERVE_BIND_HOST` | *(set by CLI)* | Internal: the actual listen host the server binds to, derived from `AGENTS_OBSERVE_BIND`. Don't set this manually. |
| `AGENTS_OBSERVE_DB_PATH` | derived | Absolute path to the SQLite DB file. Computed as `<AGENTS_OBSERVE_LOCAL_DATA_ROOT>/data/observe.db`. |
| `AGENTS_OBSERVE_STORAGE_ADAPTER` | `sqlite` | Storage backend. Only `sqlite` is supported today. |
| `AGENTS_OBSERVE_CLIENT_DIST_PATH` | derived | Path to the built React client (`app/client/dist`). Empty in dev runtime (Vite serves the client). |
| `AGENTS_OBSERVE_ALLOW_DB_RESET` | `backup` | Admin reset policy: `allow` (wipe without backup), `backup` (snapshot the DB then wipe), `deny` (refuse). |
| `AGENTS_OBSERVE_SHUTDOWN_DELAY_MS` | `30000` | Ms with no consumers before the collector auto-shuts down. A consumer is a dashboard WebSocket client **or** an agent session that recently produced an event. Set to `0` or negative to disable auto-shutdown. |
| `AGENTS_OBSERVE_SESSION_ACTIVITY_TTL_MS` | `300000` | How long an agent session keeps counting as a consumer after its last stored event. `SessionEnd` drops it immediately. See [collector-supervision.md](./collector-supervision.md#who-keeps-it-alive). |
| `AGENTS_OBSERVE_LOG_LEVEL` | `debug` | Server log level. Same values as the CLI variable. |

---

## Transcript stats

Parses the source-of-truth jsonl transcripts on demand to surface
per-prompt / per-agent token usage, model info, and cost estimates in
the Session Stats tab and the constellation view's per-project well
label. Pricing is fetched from `models.dev` and cached on disk at
`<data dir>/models-dev.json` (24h TTL). Enabled by default; set the
flag below to `0` to disable.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENTS_OBSERVE_TRANSCRIPT_STATS` | `1` | Enables the `/api/sessions/:id/transcript-stats` and `/api/projects/:id/cost-summary` routes. Set to `0` to disable both. Surfaced on `/api/health` as `transcriptStatsEnabled` so the client can skip the round-trip when off. |

The server reads each session's `transcript_path` straight off the host filesystem. A missing transcript is reported as `file_not_found` rather than failing the request — a user without Codex installed needs no configuration at all.

---

## Runtime selection

Controls how the server runs.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENTS_OBSERVE_RUNTIME` | `local` | How to run the server: `local` (node subprocess) or `dev` (vite dev server + local node). |
| `AGENTS_OBSERVE_RUNTIME_DEV` | *(set by CLI)* | Internal flag (`1` or empty) so the server knows it's running under `dev`. Don't set this manually. |
| `AGENTS_OBSERVE_DEV_CLIENT_PORT` | `5174` | Port the Vite dev server listens on in `dev` runtime. |

---

## Collector supervision

Read by the shell-side supervision primitives in
`hooks/scripts/supervision/lib/observe-env.sh` and by the server in
`app/server/src/config.ts` (`config.supervision`), not by `config.mjs`. Both
sides read and write the same files, so the names and defaults are shared.
`hooks/scripts/hook.sh` reads the health predicate to decide whether to arm the
collector; the CLI itself still does not read them. See
[collector-supervision.md](./collector-supervision.md#configuration) for the
full variable list, defaults, and the contract they support.

The server uses them to claim `runtime/collector.lock` for its data root at
startup, publish `runtime/collector.heartbeat` while it runs, and report the
health predicate on `/api/health`. Two servers sharing one data root is refused:
the second exits `3`. Give each a different `AGENTS_OBSERVE_DATA_ROOT` (or
`AGENTS_OBSERVE_LOCAL_DATA_ROOT`) to run them side by side.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENTS_OBSERVE_COLLECTOR_ENTRYPOINT` | *(empty)* | Optional executable the supervisor arm starts instead of the bundled Node entrypoint. Primarily useful for integration harnesses. |
| `AGENTS_OBSERVE_NPM` | `npm` | The package manager the bootstrap install runs. Override on a host where npm is named or installed differently. |
| `AGENTS_OBSERVE_INSTALL_TIMEOUT` | `300` | Seconds each bootstrap install (`npm ci` / `npm install`, then the client build) is given on the first start of a source-only checkout. Applied via `timeout` where the host has it. See [collector-supervision.md](./collector-supervision.md#one-collector-runtime). |
| `AGENTS_OBSERVE_INSTANCE_ID` | *(a fresh UUID)* | Pins the instance id for one collector run. |

---

## Test harness / external

Rarely user-set.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLAUDE_PLUGIN_DATA` | *(set by Claude Code)* | The plugin data directory path; set by the Claude Code plugin loader. The CLI checks for its presence to detect plugin mode. |

---

## Where to set env vars

- **Local development**: `.env` in the repo root (loaded by `just dev`).
- **Plugin installs**: your shell profile (`.zshrc`, `.bashrc`) or the
  Claude Code plugin config.
- **Remote / standalone server**: wherever you launch the server
  process — shell, systemd unit, etc.

Add new variables to both this doc and the relevant config module:
`hooks/scripts/lib/config.mjs` for CLI-read vars, `app/server/src/config.ts`
for server-read vars.
