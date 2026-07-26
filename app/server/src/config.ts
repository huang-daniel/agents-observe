// app/server/src/config.ts
// Central config for the server. All env var reads happen here.

import { resolve, dirname } from 'path'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'

const logLevel = (process.env.AGENTS_OBSERVE_LOG_LEVEL || 'debug').toLowerCase()

/**
 * Resolve the host-side DB path surfaced on `/api/health`.
 *
 * In docker the CLI passes `AGENTS_OBSERVE_HOST_DB_PATH` — an already-absolute
 * path on the *host*, which may be a Windows path (`C:\Users\...`). Running
 * `resolve()` on it inside the Linux container mangles it, because POSIX
 * `resolve` treats `C:\...` as relative and prefixes the container cwd
 * (`/app/server/C:\Users\...`) — GitHub issue #21. So pass it through
 * verbatim; only the local-mode fallback (a real path on this OS) needs
 * `resolve()`.
 */
export function resolveHostDbPath(hostDbPath?: string, dbPath?: string): string {
  if (hostDbPath) return hostDbPath
  return resolve(dbPath || '../../data/observe.db')
}

function detectRuntime(): 'docker' | 'local' {
  const explicit = process.env.AGENTS_OBSERVE_RUNTIME
  if (explicit === 'docker' || explicit === 'local') return explicit
  if (existsSync('/.dockerenv')) return 'docker'
  return 'local'
}

function readVersion(): string {
  const dir = dirname(fileURLToPath(import.meta.url))
  const paths = [
    resolve(dir, '../../../VERSION'), // dev: app/server/src -> root
    resolve(dir, '../../VERSION'), // Docker: /app/server/src -> /app
    '/app/VERSION', // Docker fallback
  ]
  for (const p of paths) {
    try {
      return readFileSync(p, 'utf8').trim()
    } catch {
      continue
    }
  }
  return 'unknown'
}

export const config = {
  apiId: 'agents-observe',
  runtime: detectRuntime(),
  isDev: process.env.AGENTS_OBSERVE_RUNTIME_DEV === '1',
  version: readVersion(),
  port: parseInt(process.env.AGENTS_OBSERVE_SERVER_PORT || '4981', 10),
  // Interface the HTTP/WebSocket server binds to. Loopback would be the
  // safest default, but inside docker the container must listen on 0.0.0.0
  // for the host-side `-p 127.0.0.1:...` mapping to reach it — so the CLI
  // sets this to 0.0.0.0 in docker and to the user's AGENTS_OBSERVE_BIND
  // (loopback by default) in local/dev. See GitHub issue #22.
  bindHost: process.env.AGENTS_OBSERVE_BIND_HOST || '0.0.0.0',
  // CORS allowlist. Empty → reflect loopback origins only (same-machine
  // dashboards; the client is served same-origin so this covers normal
  // use). `*` → allow any origin (opt-in). Otherwise an explicit
  // comma-separated allowlist.
  corsAllowedOrigins: (process.env.AGENTS_OBSERVE_CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  logLevel,
  verbose: logLevel === 'debug' || logLevel === 'trace',
  dbPath: resolve(process.env.AGENTS_OBSERVE_DB_PATH || '../../data/observe.db'),
  // Host-side bind mount target for the DB. Set by the CLI when starting
  // the docker container so the dashboard can show the user where the DB
  // lives on their machine rather than the in-container `/data/observe.db`.
  // Falls back to `dbPath` in local mode (where they're already the same).
  hostDbPath: resolveHostDbPath(
    process.env.AGENTS_OBSERVE_HOST_DB_PATH,
    process.env.AGENTS_OBSERVE_DB_PATH,
  ),
  // Directory for persistent server state outside the SQLite DB —
  // currently just the models.dev pricing cache. Derived from dbPath so
  // the docker volume mount covers both files.
  dataDir: dirname(resolve(process.env.AGENTS_OBSERVE_DB_PATH || '../../data/observe.db')),
  storageAdapter: process.env.AGENTS_OBSERVE_STORAGE_ADAPTER || 'sqlite',
  clientDistPath: process.env.AGENTS_OBSERVE_CLIENT_DIST_PATH || '',
  devClientPort: parseInt(process.env.AGENTS_OBSERVE_DEV_CLIENT_PORT || '5174', 10),

  // DB reset policy: 'allow' = permit, 'deny' = reject, 'backup' (default) = backup then reset
  // Unrecognized values are treated as 'deny' to prevent misconfiguration
  allowDbReset:
    ({ allow: 'allow', backup: 'backup' } as Record<string, 'allow' | 'backup'>)[
      (process.env.AGENTS_OBSERVE_ALLOW_DB_RESET || 'backup').toLowerCase()
    ] ?? ('deny' as const),

  // Auto-shutdown: <= 0 disables, > 0 is delay in ms after last consumer disconnects
  shutdownDelayMs: parseInt(process.env.AGENTS_OBSERVE_SHUTDOWN_DELAY_MS || '30000', 10),
  // Consumer tracker tuning
  consumerTtlMs: 30_000,
  sweepIntervalMs: 10_000,
  startupGraceMs: 60_000,

  // Collector supervision. These names and defaults are shared with the shell
  // primitives in hooks/scripts/supervision/lib/observe-env.sh — the two sides
  // read and write the same files, so they must not drift. See
  // docs/collector-supervision.md.
  supervision: {
    // Data root precedence, matching observe_env_init: AGENTS_OBSERVE_DATA_ROOT,
    // then the existing data-dir override, then ~/.agents-observe. Note this is
    // the root itself, not `dataDir` (`<root>/data`) where the DB lives.
    dataRoot: process.env.AGENTS_OBSERVE_DATA_ROOT || '',
    localDataRoot: process.env.AGENTS_OBSERVE_LOCAL_DATA_ROOT || '',
    homeDir: process.env.HOME || '',
    // Identifies one collector *run*. Restarting produces a new one; set it
    // explicitly when something outside the process needs to predict it.
    instanceId: process.env.AGENTS_OBSERVE_INSTANCE_ID || '',
    entrypointMarker: process.env.AGENTS_OBSERVE_ENTRYPOINT_MARKER || 'agents-observe-collector',
    healthGraceSeconds: parseInt(process.env.AGENTS_OBSERVE_HEALTH_GRACE || '30', 10),
    heartbeatIntervalMs: parseInt(process.env.AGENTS_OBSERVE_HEARTBEAT_INTERVAL_MS || '5000', 10),
    lockSettleSeconds: parseInt(process.env.AGENTS_OBSERVE_LOCK_SETTLE || '2', 10),
    procRoot: process.env.AGENTS_OBSERVE_PROC_ROOT || '/proc',
  },

  transcriptStats: {
    enabled: process.env.AGENTS_OBSERVE_TRANSCRIPT_STATS !== '0',
    // Per-agent-class bind-mount bases. The runtime tries each pair when
    // resolving a session's transcript_path; one pair per supported
    // agent class so users can override locations independently
    // (claude can live elsewhere, codex can live elsewhere). Trailing
    // slashes stripped defensively.
    bases: [
      {
        agentClass: 'claude-code' as const,
        host: (process.env.AGENTS_OBSERVE_TRANSCRIPT_CLAUDE_HOST_BASE || '').replace(/\/$/, ''),
        container: (process.env.AGENTS_OBSERVE_TRANSCRIPT_CLAUDE_CONTAINER_BASE || '').replace(
          /\/$/,
          '',
        ),
      },
      {
        agentClass: 'codex' as const,
        host: (process.env.AGENTS_OBSERVE_TRANSCRIPT_CODEX_HOST_BASE || '').replace(/\/$/, ''),
        container: (process.env.AGENTS_OBSERVE_TRANSCRIPT_CODEX_CONTAINER_BASE || '').replace(
          /\/$/,
          '',
        ),
      },
    ],
    // 100 MB safety cap — defensive, not an expected operating point.
    maxFileBytes: 100 * 1024 * 1024,
  },
}
