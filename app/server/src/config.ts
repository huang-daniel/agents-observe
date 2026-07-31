// app/server/src/config.ts
// Central config for the server. All env var reads happen here.

import { resolve, dirname } from 'path'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

const logLevel = (process.env.AGENTS_OBSERVE_LOG_LEVEL || 'debug').toLowerCase()

function readVersion(): string {
  const dir = dirname(fileURLToPath(import.meta.url))
  const paths = [
    resolve(dir, '../../../VERSION'), // app/server/src -> repo root
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
  isDev: process.env.AGENTS_OBSERVE_RUNTIME_DEV === '1',
  version: readVersion(),
  port: parseInt(process.env.AGENTS_OBSERVE_SERVER_PORT || '4981', 10),
  // Interface the HTTP/WebSocket server binds to. Loopback by default so the
  // unauthenticated dashboard is not exposed beyond this machine; the supervisor
  // and the CLI pass the user's AGENTS_OBSERVE_BIND through. See issue #22.
  bindHost: process.env.AGENTS_OBSERVE_BIND_HOST || '127.0.0.1',
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
  // Directory for persistent server state outside the SQLite DB —
  // currently just the models.dev pricing cache. Derived from dbPath so both
  // live together.
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
  // How long an agent session counts as an active consumer after its last
  // stored event. Long enough to cover an agent thinking, running a slow tool,
  // or waiting on the user between prompts — the collector should not exit out
  // from under a session that is merely quiet. Short enough that a session that
  // dies without a SessionEnd cannot pin the collector alive indefinitely.
  sessionActivityTtlMs: parseInt(
    process.env.AGENTS_OBSERVE_SESSION_ACTIVITY_TTL_MS || '300000',
    10,
  ),
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
    // 100 MB safety cap — defensive, not an expected operating point.
    maxFileBytes: 100 * 1024 * 1024,
  },
}
