// test/config.test.mjs
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../')

// Snapshot and restore all env vars we touch
const envKeys = [
  // HOME is overridden per-test to isolate from any real ~/.claude/plugins
  // install on the dev machine — resolvePluginDataDir probes the filesystem.
  'HOME',
  'CLAUDE_PLUGIN_DATA',
  'AGENTS_OBSERVE_SERVER_PORT',
  'AGENTS_OBSERVE_API_BASE_URL',
  'AGENTS_OBSERVE_PROJECT_SLUG',
  'AGENTS_OBSERVE_LOGS_DIR',
  'AGENTS_OBSERVE_LOG_LEVEL',
  'AGENTS_OBSERVE_LOCAL_DATA_ROOT',
  'AGENTS_OBSERVE_RUNTIME',
  'AGENTS_OBSERVE_DEV_CLIENT_PORT',
  'AGENTS_OBSERVE_ALLOW_LOCAL_CALLBACKS',
  'AGENTS_OBSERVE_NOTIFICATION_ON_EVENTS',
  'AGENTS_OBSERVE_BIND',
  'AGENTS_OBSERVE_CORS_ORIGINS',
  'AGENTS_OBSERVE_DATA_ROOT',
  'AGENTS_OBSERVE_INSTANCE_ID',
]

let savedEnv
let tmpHome

beforeEach(() => {
  savedEnv = {}
  for (const k of envKeys) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  tmpHome = mkdtempSync(join(tmpdir(), 'agents-observe-test-home-'))
  process.env.HOME = tmpHome
})

afterEach(() => {
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  if (tmpHome) {
    rmSync(tmpHome, { recursive: true, force: true })
    tmpHome = null
  }
})

// Dynamic import to pick up env changes (module is stateless via getConfig())
async function loadConfig(overrides) {
  const mod = await import('../../../../hooks/scripts/lib/config.mjs')
  return mod.getConfig(overrides)
}

async function loadModule() {
  return await import('../../../../hooks/scripts/lib/config.mjs')
}

describe('config', () => {
  // --- Core defaults ---

  it('defaults serverPort to 4981', async () => {
    const cfg = await loadConfig()
    expect(cfg.serverPort).toBe('4981')
  })

  it('uses AGENTS_OBSERVE_SERVER_PORT env var', async () => {
    process.env.AGENTS_OBSERVE_SERVER_PORT = '9999'
    const cfg = await loadConfig()
    expect(cfg.serverPort).toBe('9999')
  })

  it('accepts serverPort via overrides', async () => {
    const cfg = await loadConfig({ serverPort: '8888' })
    expect(cfg.serverPort).toBe('8888')
  })

  it('defaults API_ID to agents-observe', async () => {
    const cfg = await loadConfig()
    expect(cfg.API_ID).toBe('agents-observe')
  })

  it('defaults pluginName to agents-observe', async () => {
    const cfg = await loadConfig()
    expect(cfg.pluginName).toBe('agents-observe')
  })

  it('exposes installDir as an absolute path', async () => {
    const cfg = await loadConfig()
    expect(cfg.installDir.startsWith('/')).toBe(true)
  })

  // --- Runtime ---

  it('defaults runtime to local', async () => {
    const cfg = await loadConfig()
    expect(cfg.runtime).toBe('local')
  })

  it('reads AGENTS_OBSERVE_RUNTIME env var', async () => {
    process.env.AGENTS_OBSERVE_RUNTIME = 'local'
    const cfg = await loadConfig()
    expect(cfg.runtime).toBe('local')
  })

  it('accepts runtime via overrides', async () => {
    const cfg = await loadConfig({ runtime: 'dev' })
    expect(cfg.runtime).toBe('dev')
  })

  // --- Server bind host (issue #22) ---

  it('defaults serverBindHost to loopback', async () => {
    const cfg = await loadConfig()
    expect(cfg.serverBindHost).toBe('127.0.0.1')
  })

  it('reads AGENTS_OBSERVE_BIND', async () => {
    process.env.AGENTS_OBSERVE_BIND = '0.0.0.0'
    const cfg = await loadConfig()
    expect(cfg.serverBindHost).toBe('0.0.0.0')
  })

  it('accepts bindHost via overrides', async () => {
    const cfg = await loadConfig({ bindHost: '192.168.1.5' })
    expect(cfg.serverBindHost).toBe('192.168.1.5')
  })

  // --- CORS origins (issue #22) ---

  it('defaults corsOrigins to empty', async () => {
    const cfg = await loadConfig()
    expect(cfg.corsOrigins).toBe('')
  })

  it('reads AGENTS_OBSERVE_CORS_ORIGINS', async () => {
    process.env.AGENTS_OBSERVE_CORS_ORIGINS = 'https://a.example,https://b.example'
    const cfg = await loadConfig()
    expect(cfg.corsOrigins).toBe('https://a.example,https://b.example')
  })

  // --- isPlugin ---

  it('sets isPlugin false when CLAUDE_PLUGIN_DATA is unset', async () => {
    const cfg = await loadConfig()
    expect(cfg.isPlugin).toBe(false)
  })

  it('sets isPlugin true when CLAUDE_PLUGIN_DATA is set', async () => {
    process.env.CLAUDE_PLUGIN_DATA = '/some/plugin/data/agents-observe'
    const cfg = await loadConfig()
    expect(cfg.isPlugin).toBe(true)
  })

  // --- Data directories ---

  it('derives dataDir as localDataRootDir/data', async () => {
    const cfg = await loadConfig()
    expect(cfg.dataDir).toBe(`${cfg.localDataRootDir}/data`)
  })

  it('uses AGENTS_OBSERVE_LOCAL_DATA_ROOT when set', async () => {
    process.env.AGENTS_OBSERVE_LOCAL_DATA_ROOT = '/custom/root'
    const cfg = await loadConfig()
    expect(cfg.localDataRootDir).toBe('/custom/root')
  })

  it('accepts localDataRootDir via overrides', async () => {
    const cfg = await loadConfig({ localDataRootDir: '/override/root' })
    expect(cfg.localDataRootDir).toBe('/override/root')
  })

  it('uses CLAUDE_PLUGIN_DATA for localDataRootDir when set correctly', async () => {
    process.env.CLAUDE_PLUGIN_DATA = '/plugin/dir/agents-observe'
    const cfg = await loadConfig()
    expect(cfg.localDataRootDir).toBe('/plugin/dir/agents-observe')
    expect(cfg.dataDir).toBe('/plugin/dir/agents-observe/data')
    expect(cfg.logsDir).toBe('/plugin/dir/agents-observe/logs')
    expect(cfg.serverPortFile).toBe('/plugin/dir/agents-observe/server-port')
  })

  it('falls back to $HOME/.agents-observe when CLAUDE_PLUGIN_DATA points to wrong plugin', async () => {
    process.env.CLAUDE_PLUGIN_DATA = '/plugin/some-other-plugin/data'
    const cfg = await loadConfig()
    expect(cfg.localDataRootDir).toBe(`${process.env.HOME}/.agents-observe`)
  })

  it('defaults localDataRootDir to $HOME/.agents-observe when not a plugin', async () => {
    // Pre-fix this fell back to installDir/data, which lives under the
    // version-scoped plugin cache dir and gets orphaned on every plugin
    // upgrade — see GitHub issue #17. The stable per-user path survives.
    const cfg = await loadConfig()
    expect(cfg.localDataRootDir).toBe(`${process.env.HOME}/.agents-observe`)
  })

  it('flags usingDefaultDataDir true when AGENTS_OBSERVE_LOCAL_DATA_ROOT is unset', async () => {
    const cfg = await loadConfig()
    expect(cfg.usingDefaultDataDir).toBe(true)
  })

  it('flags usingDefaultDataDir false when AGENTS_OBSERVE_LOCAL_DATA_ROOT is set', async () => {
    process.env.AGENTS_OBSERVE_LOCAL_DATA_ROOT = '/custom/root'
    const cfg = await loadConfig()
    expect(cfg.usingDefaultDataDir).toBe(false)
  })

  // --- Logs ---

  it('derives logsDir from localDataRootDir', async () => {
    const cfg = await loadConfig()
    expect(cfg.logsDir).toBe(`${cfg.localDataRootDir}/logs`)
  })

  it('prefers AGENTS_OBSERVE_LOGS_DIR over localDataRootDir', async () => {
    process.env.AGENTS_OBSERVE_LOGS_DIR = '/custom/logs'
    const cfg = await loadConfig()
    expect(cfg.logsDir).toBe('/custom/logs')
  })

  // --- Log level ---

  it('defaults logLevel to warn', async () => {
    const cfg = await loadConfig()
    expect(cfg.logLevel).toBe('warn')
  })

  it('reads AGENTS_OBSERVE_LOG_LEVEL', async () => {
    process.env.AGENTS_OBSERVE_LOG_LEVEL = 'trace'
    const cfg = await loadConfig()
    expect(cfg.logLevel).toBe('trace')
  })

  it('lowercases logLevel', async () => {
    process.env.AGENTS_OBSERVE_LOG_LEVEL = 'DEBUG'
    const cfg = await loadConfig()
    expect(cfg.logLevel).toBe('debug')
  })

  it('accepts logLevel via overrides', async () => {
    const cfg = await loadConfig({ logLevel: 'trace' })
    expect(cfg.logLevel).toBe('trace')
  })

  // --- Client port ---

  it('defaults clientPort to serverPort when not dev mode', async () => {
    const cfg = await loadConfig()
    expect(cfg.clientPort).toBe(cfg.serverPort)
  })

  it('defaults clientPort to 5174 in dev mode', async () => {
    const cfg = await loadConfig({ runtime: 'dev' })
    expect(cfg.clientPort).toBe('5174')
  })

  it('reads AGENTS_OBSERVE_DEV_CLIENT_PORT', async () => {
    process.env.AGENTS_OBSERVE_DEV_CLIENT_PORT = '3000'
    const cfg = await loadConfig()
    expect(cfg.clientPort).toBe('3000')
  })

  // --- API URL ---

  it('derives apiBaseUrl from serverPort', async () => {
    const cfg = await loadConfig()
    expect(cfg.apiBaseUrl).toBe(`http://127.0.0.1:${cfg.serverPort}/api`)
  })

  it('prefers AGENTS_OBSERVE_API_BASE_URL env var', async () => {
    process.env.AGENTS_OBSERVE_API_BASE_URL = 'http://custom:9999/api'
    const cfg = await loadConfig()
    expect(cfg.apiBaseUrl).toBe('http://custom:9999/api')
  })

  it('accepts baseUrl via overrides', async () => {
    const cfg = await loadConfig({ baseUrl: 'http://override:8888/api' })
    expect(cfg.apiBaseUrl).toBe('http://override:8888/api')
  })

  it('derives baseOrigin from apiBaseUrl', async () => {
    const cfg = await loadConfig()
    expect(cfg.baseOrigin).toBe(`http://127.0.0.1:${cfg.serverPort}`)
  })

  // --- hasCustomApiUrl ---

  it('sets hasCustomApiUrl false when using default', async () => {
    const cfg = await loadConfig()
    expect(cfg.hasCustomApiUrl).toBe(false)
  })

  it('sets hasCustomApiUrl true when AGENTS_OBSERVE_API_BASE_URL is set', async () => {
    process.env.AGENTS_OBSERVE_API_BASE_URL = 'http://remote:9999/api'
    const cfg = await loadConfig()
    expect(cfg.hasCustomApiUrl).toBe(true)
  })

  it('sets hasCustomApiUrl true when baseUrl override is provided', async () => {
    const cfg = await loadConfig({ baseUrl: 'http://override:8888/api' })
    expect(cfg.hasCustomApiUrl).toBe(true)
  })

  // --- Callbacks ---

  it('defaults allowedCallbacks to all handlers', async () => {
    const cfg = await loadConfig()
    expect(cfg.allowedCallbacks.has('getSessionInfo')).toBe(true)
  })

  it('restricts allowedCallbacks from env var', async () => {
    process.env.AGENTS_OBSERVE_ALLOW_LOCAL_CALLBACKS = 'getSessionInfo'
    const cfg = await loadConfig()
    expect(cfg.allowedCallbacks.size).toBe(1)
    expect(cfg.allowedCallbacks.has('getSessionInfo')).toBe(true)
  })

  it('filters out unknown callback names', async () => {
    process.env.AGENTS_OBSERVE_ALLOW_LOCAL_CALLBACKS = 'getSessionInfo,nonexistent'
    const cfg = await loadConfig()
    expect(cfg.allowedCallbacks.size).toBe(1)
  })

  // --- Project slug ---

  it('defaults projectSlug to null', async () => {
    const cfg = await loadConfig()
    expect(cfg.projectSlug).toBeNull()
  })

  it('reads AGENTS_OBSERVE_PROJECT_SLUG', async () => {
    process.env.AGENTS_OBSERVE_PROJECT_SLUG = 'my-project'
    const cfg = await loadConfig()
    expect(cfg.projectSlug).toBe('my-project')
  })

  it('accepts projectSlug via overrides', async () => {
    const cfg = await loadConfig({ projectSlug: 'override-slug' })
    expect(cfg.projectSlug).toBe('override-slug')
  })

  describe('notificationOnEvents', () => {
    it('returns undefined when env var is unset', async () => {
      const cfg = await loadConfig()
      expect(cfg.notificationOnEvents).toBeUndefined()
    })

    it('returns an empty array when env var is set to empty string', async () => {
      process.env.AGENTS_OBSERVE_NOTIFICATION_ON_EVENTS = ''
      const cfg = await loadConfig()
      expect(cfg.notificationOnEvents).toEqual([])
    })

    it('parses a single name', async () => {
      process.env.AGENTS_OBSERVE_NOTIFICATION_ON_EVENTS = 'Notification'
      const cfg = await loadConfig()
      expect(cfg.notificationOnEvents).toEqual(['Notification'])
    })

    it('parses a comma-separated list and trims whitespace', async () => {
      process.env.AGENTS_OBSERVE_NOTIFICATION_ON_EVENTS = 'Notification, Stop ,  SubagentStop'
      const cfg = await loadConfig()
      expect(cfg.notificationOnEvents).toEqual(['Notification', 'Stop', 'SubagentStop'])
    })

    it('filters out blanks from separator-only input', async () => {
      process.env.AGENTS_OBSERVE_NOTIFICATION_ON_EVENTS = ' , ,  '
      const cfg = await loadConfig()
      expect(cfg.notificationOnEvents).toEqual([])
    })
  })
})

describe('getServerEnv', () => {
  it('uses host paths for the local runtime', async () => {
    const mod = await loadModule()
    const cfg = mod.getConfig({ runtime: 'local' })
    const env = mod.getServerEnv(cfg)

    expect(env.AGENTS_OBSERVE_SERVER_PORT).toBe(cfg.serverPort)
    expect(env.AGENTS_OBSERVE_DB_PATH).toContain(cfg.dataDir)
    expect(env.AGENTS_OBSERVE_DB_PATH).toContain('observe.db')
    expect(env.AGENTS_OBSERVE_CLIENT_DIST_PATH).toContain('app/client/dist')
    expect(env.AGENTS_OBSERVE_CLIENT_DIST_PATH).toContain(cfg.installDir)
    expect(env.AGENTS_OBSERVE_RUNTIME).toBe('local')
    expect(env.AGENTS_OBSERVE_STORAGE_ADAPTER).toBe('sqlite')
  })

  it('sets empty CLIENT_DIST_PATH and RUNTIME_DEV for dev runtime', async () => {
    const mod = await loadModule()
    const cfg = mod.getConfig({ runtime: 'dev' })
    const env = mod.getServerEnv(cfg)

    expect(env.AGENTS_OBSERVE_SERVER_PORT).toBe(cfg.serverPort)
    expect(env.AGENTS_OBSERVE_CLIENT_DIST_PATH).toBe('')
    expect(env.AGENTS_OBSERVE_RUNTIME).toBe('dev')
    expect(env.AGENTS_OBSERVE_RUNTIME_DEV).toBe('1')
    expect(env.AGENTS_OBSERVE_SHUTDOWN_DELAY_MS).toBe(String(cfg.shutdownDelayMs))
  })

  // --- Bind host + CORS passthrough (issue #22) ---

  it('binds loopback by default', async () => {
    const mod = await loadModule()
    const env = mod.getServerEnv(mod.getConfig({ runtime: 'local' }))
    expect(env.AGENTS_OBSERVE_BIND_HOST).toBe('127.0.0.1')
  })

  it('forwards AGENTS_OBSERVE_BIND to the listen host', async () => {
    process.env.AGENTS_OBSERVE_BIND = '0.0.0.0'
    const mod = await loadModule()
    const env = mod.getServerEnv(mod.getConfig({ runtime: 'local' }))
    expect(env.AGENTS_OBSERVE_BIND_HOST).toBe('0.0.0.0')
  })

  it('omits the CORS allowlist env when unset', async () => {
    const mod = await loadModule()
    const env = mod.getServerEnv(mod.getConfig({ runtime: 'local' }))
    expect(env.AGENTS_OBSERVE_CORS_ORIGINS).toBeUndefined()
  })

  it('forwards the CORS allowlist env when set', async () => {
    process.env.AGENTS_OBSERVE_CORS_ORIGINS = 'https://a.example,https://b.example'
    const mod = await loadModule()
    const env = mod.getServerEnv(mod.getConfig({ runtime: 'local' }))
    expect(env.AGENTS_OBSERVE_CORS_ORIGINS).toBe('https://a.example,https://b.example')
  })

  it('always includes log level and storage adapter', async () => {
    const mod = await loadModule()
    for (const runtime of ['local', 'dev']) {
      const cfg = mod.getConfig({ runtime })
      const env = mod.getServerEnv(cfg)
      expect(env.AGENTS_OBSERVE_LOG_LEVEL).toBe(cfg.logLevel)
      expect(env.AGENTS_OBSERVE_STORAGE_ADAPTER).toBe('sqlite')
    }
  })
})

describe('getClientEnv', () => {
  it('returns server port and client port', async () => {
    const mod = await loadModule()
    const cfg = mod.getConfig()
    const env = mod.getClientEnv(cfg)

    expect(env.AGENTS_OBSERVE_SERVER_PORT).toBe(cfg.serverPort)
    expect(env.AGENTS_OBSERVE_DEV_CLIENT_PORT).toBeDefined()
  })
})

describe('getServerEnv — transcript-stats env vars', () => {
  beforeEach(() => {
    delete process.env.AGENTS_OBSERVE_TRANSCRIPT_STATS
  })
  afterEach(() => {
    delete process.env.AGENTS_OBSERVE_TRANSCRIPT_STATS
  })

  it('forwards the disabled flag when the feature is explicitly off', async () => {
    process.env.AGENTS_OBSERVE_TRANSCRIPT_STATS = '0'
    const mod = await loadModule()
    const env = mod.getServerEnv(mod.getConfig({ runtime: 'local' }))
    expect(env.AGENTS_OBSERVE_TRANSCRIPT_STATS).toBe('0')
  })

  it('enables transcript-stats by default when env var is unset', async () => {
    const mod = await loadModule()
    const env = mod.getServerEnv(mod.getConfig({ runtime: 'local' }))
    expect(env.AGENTS_OBSERVE_TRANSCRIPT_STATS).toBe('1')
  })
})

// The supervision data root is resolved twice — here and in
// hooks/scripts/supervision/lib/observe-env.sh — because the shell hooks and
// the Node CLI both have to find the same lock, heartbeat and spool. These
// assert against the shell's own answer rather than against a restatement of
// its rules, so the two cannot drift apart quietly.
describe('supervision data root', () => {
  const shellDataRoot = async (env) => {
    const lib = join(REPO_ROOT, 'hooks/scripts/supervision/lib/observe-env.sh')
    const { stdout } = await execFileAsync(
      'bash',
      [
        '-c',
        `set -u
. '${lib}'
observe_env_init || exit 2
printf '%s\\n' "$OBSERVE_DATA_ROOT"`,
      ],
      { env: { ...process.env, ...env } },
    )
    return stdout.trim()
  }

  it('agrees with the shell when AGENTS_OBSERVE_DATA_ROOT is set', async () => {
    process.env.AGENTS_OBSERVE_DATA_ROOT = '/tmp/observe-root-explicit'
    const { getConfig } = await import('../../../../hooks/scripts/lib/config.mjs')
    expect(getConfig().supervisionDataRoot).toBe(
      await shellDataRoot({ AGENTS_OBSERVE_DATA_ROOT: '/tmp/observe-root-explicit' }),
    )
  })

  it('agrees with the shell when only the data-dir override is set', async () => {
    process.env.AGENTS_OBSERVE_LOCAL_DATA_ROOT = tmpHome
    const { getConfig } = await import('../../../../hooks/scripts/lib/config.mjs')
    expect(getConfig().supervisionDataRoot).toBe(
      await shellDataRoot({
        AGENTS_OBSERVE_DATA_ROOT: '',
        AGENTS_OBSERVE_LOCAL_DATA_ROOT: tmpHome,
      }),
    )
  })

  it('agrees with the shell on the bare ~/.agents-observe fallback', async () => {
    const { getConfig } = await import('../../../../hooks/scripts/lib/config.mjs')
    expect(getConfig().supervisionDataRoot).toBe(join(tmpHome, '.agents-observe'))
    expect(getConfig().supervisionDataRoot).toBe(
      await shellDataRoot({
        AGENTS_OBSERVE_DATA_ROOT: '',
        AGENTS_OBSERVE_LOCAL_DATA_ROOT: '',
        HOME: tmpHome,
      }),
    )
  })

  it('does not follow CLAUDE_PLUGIN_DATA, which the shell cannot see', async () => {
    // The DB may live under the plugin data dir; supervision state deliberately
    // does not, because observe-env.sh knows nothing about that variable.
    process.env.CLAUDE_PLUGIN_DATA = join(tmpHome, '.claude/plugins/data/agents-observe-inline')
    const { getConfig } = await import('../../../../hooks/scripts/lib/config.mjs')
    expect(getConfig().supervisionDataRoot).toBe(join(tmpHome, '.agents-observe'))
  })
})
