// hooks/scripts/lib/config.mjs
// Centralized config resolution for the Agents Observe CLI and hook scripts.
// No dependencies - uses only Node.js built-ins.

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_CALLBACK_HANDLERS } from './callbacks.mjs'
import {
  resolvePluginDataDir,
  readServerPortFile,
  readVersionFile,
  ensureLocalDataDirs,
} from './fs.mjs'
import { maybeMigrateLegacyDb } from './migrate-db.mjs'

// Absolute path to root of this project, where the plugin is installed
const installDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../')

/**
 * Returns shared config. Accepts optional CLI overrides.
 */
export function getConfig(overrides = {}) {
  /** Name of plugin to use for validating CLAUDE_PLUGIN_* env vars at runtime */
  const pluginName = 'agents-observe'
  /** True when claude is running the scripts via plugin hooks */
  const isPlugin = !!process.env.CLAUDE_PLUGIN_DATA

  /** Runtime used by start scripts: local | dev */
  const runtime = overrides.runtime || process.env.AGENTS_OBSERVE_RUNTIME || 'local'
  /** True when running in dev mode (hot reload, vite client) */
  const isDevRuntime = runtime === 'dev'
  /** Shutdown delay in ms. 0 or negative disables auto-shutdown. Default 30s. */
  const shutdownDelayMs = parseInt(
    overrides.shutdownDelayMs || process.env.AGENTS_OBSERVE_SHUTDOWN_DELAY_MS || '30000',
    10,
  )

  const homeDir = process.env.HOME || ''
  const pluginDataDir = process.env.CLAUDE_PLUGIN_DATA

  const serverPortFileName = 'server-port'

  // Mini config to pass to resolvePluginDataDir and readVersionFile
  const tmpConfig = {
    installDir,
    pluginName,
    pluginDataDir,
    homeDir,
    serverPortFileName,
  }

  // Resolve the data root dir.
  //
  // Order of precedence:
  //   1. AGENTS_OBSERVE_LOCAL_DATA_ROOT — explicit user override. No
  //      migration runs in this case; the user has told us where to look.
  //   2. CLAUDE_PLUGIN_DATA (validated via resolvePluginDataDir) — we're
  //      running as a Claude plugin. resolvePluginDataDir defends against
  //      a Claude Code bug where CLAUDE_PLUGIN_DATA can point at the
  //      wrong plugin during skill invocations (commit 486e7eb).
  //   3. ~/.<pluginName> — stable per-user fallback for non-Claude
  //      runtimes (Codex, manual CLI, dev) so we never store the DB
  //      under the version-scoped install/cache dir (the bug that #17
  //      fixed).
  //
  // If none of the above applies (no HOME, no plugin context, no
  // override) we throw rather than falling back to installDir/data —
  // that path lives under the version-scoped plugin cache and would
  // silently reintroduce #17.
  const userDataRoot = overrides.localDataRootDir || process.env.AGENTS_OBSERVE_LOCAL_DATA_ROOT
  const usingDefaultDataDir = !userDataRoot

  let localDataRootDir
  if (userDataRoot) {
    localDataRootDir = userDataRoot
  } else {
    const claudePluginPath = resolvePluginDataDir(tmpConfig)
    if (claudePluginPath) {
      localDataRootDir = claudePluginPath
    } else if (homeDir) {
      localDataRootDir = resolve(homeDir, `.${pluginName}`)
    } else {
      throw new Error(
        'Cannot resolve data dir: HOME is not set, no CLAUDE_PLUGIN_DATA, ' +
          'and AGENTS_OBSERVE_LOCAL_DATA_ROOT is not set.',
      )
    }
  }

  const dataDir = `${localDataRootDir}/data`

  // The collector supervision namespace — the lock, heartbeat and durable spool
  // the hooks and the collector share. This deliberately mirrors
  // `observe_env_init` in hooks/scripts/supervision/lib/observe-env.sh rather
  // than reusing localDataRootDir: the shell knows nothing about
  // CLAUDE_PLUGIN_DATA, and the two sides read and write the same files, so
  // they have to resolve the same path. See docs/collector-supervision.md.
  const supervisionDataRoot =
    process.env.AGENTS_OBSERVE_DATA_ROOT ||
    process.env.AGENTS_OBSERVE_LOCAL_DATA_ROOT ||
    (homeDir ? resolve(homeDir, `.${pluginName}`) : '')

  const serverPortFile = `${localDataRootDir}/${serverPortFileName}`
  const serverPort = overrides.serverPort || process.env.AGENTS_OBSERVE_SERVER_PORT || '4981'
  const savedPort = readServerPortFile(serverPortFile)
  const customApiBaseUrl = overrides.baseUrl || process.env.AGENTS_OBSERVE_API_BASE_URL || null
  const apiBaseUrl =
    customApiBaseUrl ||
    (savedPort ? `http://127.0.0.1:${savedPort}/api` : `http://127.0.0.1:${serverPort}/api`)
  const baseOrigin = new URL(apiBaseUrl).origin
  const version = readVersionFile(tmpConfig)

  // Notification trigger list. Three states — preserve the distinction:
  //   undefined  → agent-lib falls back to its default (['Notification'])
  //   []         → user opted out of all bells (explicit empty env var)
  //   [names...] → explicit list
  const rawNotificationOnEvents = process.env.AGENTS_OBSERVE_NOTIFICATION_ON_EVENTS
  const notificationOnEvents =
    rawNotificationOnEvents === undefined
      ? undefined
      : rawNotificationOnEvents
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)

  const allowedCallbacksRaw = (process.env.AGENTS_OBSERVE_ALLOW_LOCAL_CALLBACKS ?? 'all').trim()
  const allowedCallbacks = new Set(
    allowedCallbacksRaw.toLowerCase() === 'all'
      ? ALL_CALLBACK_HANDLERS
      : allowedCallbacksRaw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => ALL_CALLBACK_HANDLERS.includes(s)),
  )

  return {
    pluginName,
    isPlugin,
    pluginDataDir, // Only set when running as a plugin
    installDir,
    homeDir,

    runtime,
    isDevRuntime,
    shutdownDelayMs,

    serverPort,
    serverPortFile,
    serverPortFileName,
    /**
     * Host interface the server is published on. Loopback by default so the
     * unauthenticated dashboard/WebSocket is not exposed beyond the local
     * machine (GitHub issue #22). Set AGENTS_OBSERVE_BIND=0.0.0.0 to allow
     * LAN access. Passed to the server as the listen host.
     */
    serverBindHost: overrides.bindHost || process.env.AGENTS_OBSERVE_BIND || '127.0.0.1',
    /**
     * Raw AGENTS_OBSERVE_CORS_ORIGINS value: a comma-separated allowlist, or
     * `*` to allow any origin. Empty/unset → the server defaults to
     * reflecting loopback origins only. Passed through to the server env.
     */
    corsOrigins: overrides.corsOrigins || process.env.AGENTS_OBSERVE_CORS_ORIGINS || '',
    apiBaseUrl,
    hasCustomApiUrl: !!customApiBaseUrl,
    baseOrigin,
    localDataRootDir,
    /**
     * True when AGENTS_OBSERVE_LOCAL_DATA_ROOT is not set, so the dataDir
     * was chosen by our own default-resolution logic. Migration from
     * legacy locations only runs in this mode — when the user has set an
     * explicit path, we leave it alone.
     */
    usingDefaultDataDir,

    clientPort:
      process.env.AGENTS_OBSERVE_DEV_CLIENT_PORT || (runtime === 'dev' ? '5174' : serverPort),

    agentClass: overrides.agentClass || process.env.AGENTS_OBSERVE_AGENT_CLASS || 'claude-code',

    /**
     * Hook events that should stamp `meta.isNotification: true` on the
     * outgoing envelope. `undefined` = agent-lib default. Empty array =
     * explicit opt-out (no bells). See docs/ENVIRONMENT.md.
     */
    notificationOnEvents,

    cliPath: resolve(installDir, './hooks/scripts/observe_cli.mjs'),
    logLevel: (overrides.logLevel || process.env.AGENTS_OBSERVE_LOG_LEVEL || 'warn').toLowerCase(),
    logsDir: resolve(installDir, process.env.AGENTS_OBSERVE_LOGS_DIR || `${localDataRootDir}/logs`),

    /** Allowed server callbacks array */
    allowedCallbacks,

    projectSlug: overrides.projectSlug || process.env.AGENTS_OBSERVE_PROJECT_SLUG || null,

    /* Local dir used to store sqlite database */
    dataDir,
    databaseFileName: 'observe.db',

    /** Collector supervision namespace — see the resolution note above. */
    supervisionDataRoot,
    /**
     * Where the supervisor redirects the collector's stdout/stderr. Must agree
     * with `observe_spawn_collector_local` in
     * hooks/scripts/supervision/observe-lifecycle.sh, which writes it.
     */
    collectorLogFile: supervisionDataRoot ? `${supervisionDataRoot}/runtime/collector.log` : '',
    /**
     * Identifies one collector *run*. Empty when nothing outside the collector
     * needs to predict it.
     */
    instanceId: process.env.AGENTS_OBSERVE_INSTANCE_ID || '',

    API_ID: 'agents-observe',
    expectedVersion: version,

    /**
     * Maximum base64-encoded image data size (in chars) kept in the
     * tool_response payload sent to the server. Images larger than
     * this are replaced with '[REDACTED]' before the event is POSTed,
     * so huge screenshots (MCP devtools take_screenshot, etc.) don't
     * balloon the event DB. Set to 0 to disable redaction entirely.
     */
    maxImageDataChars: parseInt(
      overrides.maxImageDataChars || process.env.AGENTS_OBSERVE_MAX_IMAGE_DATA_CHARS || '50000',
      10,
    ),

    /** When true, the server exposes /api/sessions/:id/transcript-stats. On by default; set to '0' to disable. */
    transcriptStatsEnabled: process.env.AGENTS_OBSERVE_TRANSCRIPT_STATS !== '0',

    serverPortFile,

    installDir,
  }
}

/**
 * Returns env vars for the server process. Use with spawn/exec env overrides.
 */
export function getServerEnv(config) {
  return {
    AGENTS_OBSERVE_SERVER_PORT: config.serverPort,
    AGENTS_OBSERVE_DB_PATH: resolve(config.dataDir, config.databaseFileName),
    AGENTS_OBSERVE_CLIENT_DIST_PATH: config.isDevRuntime
      ? '' // vite dev server serves the client
      : resolve(config.installDir, 'app/client/dist'),
    AGENTS_OBSERVE_LOG_LEVEL: config.logLevel,
    AGENTS_OBSERVE_RUNTIME: config.isDevRuntime ? 'dev' : 'local',
    // Collector supervision — the lock, heartbeat and spool the collector shares
    // with the hooks. See docs/collector-supervision.md.
    AGENTS_OBSERVE_DATA_ROOT: config.supervisionDataRoot,
    AGENTS_OBSERVE_INSTANCE_ID: config.instanceId,
    // Interface the server binds to, defaulting to loopback. See issue #22.
    AGENTS_OBSERVE_BIND_HOST: config.serverBindHost,
    AGENTS_OBSERVE_RUNTIME_DEV: config.isDevRuntime ? '1' : '',
    AGENTS_OBSERVE_SHUTDOWN_DELAY_MS: String(config.shutdownDelayMs),
    ...(config.isDevRuntime && { AGENTS_OBSERVE_DEV_CLIENT_PORT: config.clientPort }),
    AGENTS_OBSERVE_STORAGE_ADAPTER: 'sqlite',
    AGENTS_OBSERVE_TRANSCRIPT_STATS: config.transcriptStatsEnabled ? '1' : '0',
    // Only forward the CORS allowlist when the user set one; otherwise leave
    // it unset so the server applies its loopback-reflect default.
    ...(config.corsOrigins ? { AGENTS_OBSERVE_CORS_ORIGINS: config.corsOrigins } : {}),
  }
}

/**
 * Returns env vars for the client dev server / build. Used by vite.config.ts
 * for the dev proxy target and dev server port.
 */
export function getClientEnv(config) {
  return {
    AGENTS_OBSERVE_SERVER_PORT: config.serverPort,
    AGENTS_OBSERVE_DEV_CLIENT_PORT: process.env.AGENTS_OBSERVE_DEV_CLIENT_PORT || '5174',
  }
}

/**
 * Ensure local data dirs are created, then attempt a one-time migration
 * of any legacy DB found at a known pre-fix location. The migration is a
 * no-op when the user has set explicit path env vars (see
 * `usingDefaultDataDir`) or when a DB already exists at the new path.
 *
 * Called from start.mjs before the server is launched.
 */
export function initLocalDataDirs(config) {
  ensureLocalDataDirs(config)
  return maybeMigrateLegacyDb(config)
}
