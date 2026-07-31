// The dependency-free install path.
//
// A Claude plugin marketplace install is a clone of this repository and nothing
// else — no `app/server/node_modules`, no built dashboard — so the first start
// has to make the checkout runnable before there is any collector to supervise.
// These tests point the arm at a synthetic source-only checkout and assert it
// recovers on its own, rather than trusting that it would.

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { makeDataRoot, removeDataRoot } from './helpers.mjs'

const execFileAsync = promisify(execFile)
const SUPERVISION_DIR = join(process.cwd(), 'hooks/scripts/supervision')
const ARM = join(SUPERVISION_DIR, 'observe-arm.sh')
const STOP = join(SUPERVISION_DIR, 'observe-stop.sh')
const FIXTURES = join(process.cwd(), 'test/hooks/scripts/supervision/fixtures')
const FAKE_COLLECTOR = join(FIXTURES, 'fake-collector.sh')
const FAKE_NPM = join(FIXTURES, 'fake-npm.sh')

const roots = []

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/**
 * A checkout shaped like a marketplace install: server and client sources with
 * lockfiles, and neither `node_modules` nor `app/client/dist`.
 */
function freshCheckout({ clientDist = false } = {}) {
  const root = makeDataRoot('observe-fresh')
  for (const pkg of ['app/server', 'app/client']) {
    mkdirSync(join(root, pkg), { recursive: true })
    writeFileSync(join(root, pkg, 'package.json'), '{"name":"stub","private":true}\n')
    writeFileSync(join(root, pkg, 'package-lock.json'), '{"lockfileVersion":3}\n')
  }
  if (clientDist) {
    mkdirSync(join(root, 'app/client/dist'), { recursive: true })
    writeFileSync(join(root, 'app/client/dist/index.html'), '<div id="root"></div>\n')
  }
  return root
}

function fixture(opts) {
  const dataRoot = makeDataRoot('observe-fresh-data')
  const checkout = freshCheckout(opts)
  const entry = { dataRoot, checkout, port: 0 }
  roots.push(entry)
  return entry
}

async function start(entry, extraEnv = {}) {
  const env = {
    ...process.env,
    OBSERVE_ROOT: entry.checkout,
    AGENTS_OBSERVE_DATA_ROOT: entry.dataRoot,
    AGENTS_OBSERVE_SERVER_PORT: String(entry.port),
    AGENTS_OBSERVE_HEALTH_URL: `http://127.0.0.1:${entry.port}/api/health`,
    AGENTS_OBSERVE_HEARTBEAT_INTERVAL_MS: '100',
    AGENTS_OBSERVE_START_TIMEOUT: '20',
    AGENTS_OBSERVE_START_POLL: '0.05',
    AGENTS_OBSERVE_SHUTDOWN_DELAY_MS: '0',
    AGENTS_OBSERVE_LOG_LEVEL: 'error',
    AGENTS_OBSERVE_COLLECTOR_ENTRYPOINT: FAKE_COLLECTOR,
    AGENTS_OBSERVE_NPM: FAKE_NPM,
    AGENTS_OBSERVE_DB_PATH: `${entry.dataRoot}/observe.db`,
    AGENTS_OBSERVE_BIND_HOST: '127.0.0.1',
    AGENTS_OBSERVE_CLIENT_DIST_PATH: '',
    FAKE_NPM_LOG: join(entry.dataRoot, 'npm-invocations.log'),
    ...extraEnv,
  }
  try {
    const { stdout, stderr } = await execFileAsync(ARM, ['start'], { env })
    return { code: 0, stdout, stderr }
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

function npmInvocations(entry) {
  const path = join(entry.dataRoot, 'npm-invocations.log')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [cwd, args] = line.split('\t')
      return { cwd, args }
    })
}

function ledger(entry) {
  const path = join(entry.dataRoot, 'runtime/collector-lifecycle.log')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

afterEach(async () => {
  for (const entry of roots.splice(0)) {
    try {
      await execFileAsync(STOP, [], {
        env: { ...process.env, AGENTS_OBSERVE_DATA_ROOT: entry.dataRoot },
      })
    } catch {
      // Nothing to stop is a clean outcome here.
    }
    removeDataRoot(entry.dataRoot)
    removeDataRoot(entry.checkout)
  }
})

describe('bootstrapping a dependency-free checkout', () => {
  it('installs the server dependencies and starts a collector from nothing', async () => {
    const entry = fixture()
    entry.port = await freePort()

    expect(existsSync(join(entry.checkout, 'app/server/node_modules'))).toBe(false)

    const result = await start(entry)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/^collector: started pid=\d+ instance=/)

    // The dependencies now exist, and `npm ci` — not `npm install` — is what
    // put them there: a shipped checkout has a lockfile and deserves the
    // reproducible install.
    expect(existsSync(join(entry.checkout, 'app/server/node_modules/.installed-by-ci'))).toBe(true)
    expect(npmInvocations(entry)).toContainEqual({
      cwd: join(entry.checkout, 'app/server'),
      args: 'ci --no-audit --no-fund',
    })
    expect(ledger(entry)).toContain('outcome=server-deps-installed')

    // The dashboard is a build artifact, so a fresh checkout has to build it too.
    expect(existsSync(join(entry.checkout, 'app/client/dist/index.html'))).toBe(true)
    expect(ledger(entry)).toContain('outcome=client-build-succeeded')
  }, 30_000)

  it('falls back to npm install when npm ci refuses the lockfile', async () => {
    const entry = fixture()
    entry.port = await freePort()

    const result = await start(entry, { FAKE_NPM_FAIL_CI: '1' })
    expect(result.code, result.stderr).toBe(0)

    // `npm ci` was tried first and its refusal did not leave the collector dead.
    const serverRuns = npmInvocations(entry).filter((r) =>
      r.cwd.endsWith(`${join('app', 'server')}`),
    )
    expect(serverRuns.map((r) => r.args)).toEqual([
      'ci --no-audit --no-fund',
      'install --no-audit --no-fund',
    ])
    expect(existsSync(join(entry.checkout, 'app/server/node_modules/.installed-by-install'))).toBe(
      true,
    )
  }, 30_000)

  it('does not reinstall when the dependencies are already there', async () => {
    const entry = fixture({ clientDist: true })
    entry.port = await freePort()
    mkdirSync(join(entry.checkout, 'app/server/node_modules'), { recursive: true })

    const result = await start(entry)
    expect(result.code, result.stderr).toBe(0)
    expect(npmInvocations(entry)).toEqual([])
  }, 30_000)

  it('fails the start with an actionable message when the install fails', async () => {
    const entry = fixture()
    entry.port = await freePort()

    const result = await start(entry, { FAKE_NPM_FAIL_ALL: '1' })

    // A failed install is reported, not silently degraded into "no collector".
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('could not install')
    expect(result.stderr).toContain('collector-install.log')
    expect(ledger(entry)).toContain('outcome=server-deps-failed')
    // And nothing was left half-started.
    expect(existsSync(join(entry.dataRoot, 'runtime/collector.lock'))).toBe(false)
  }, 30_000)

  it('still starts a collector when only the dashboard build fails', async () => {
    const entry = fixture()
    entry.port = await freePort()
    // Server deps present, so the only bootstrap work left is the client build.
    mkdirSync(join(entry.checkout, 'app/server/node_modules'), { recursive: true })

    const result = await start(entry, { FAKE_NPM_FAIL_ALL: '1' })

    // Events are still captured without a UI, so this is a warning, not a fault.
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/^collector: started pid=\d+/)
    expect(result.stderr).toContain('dashboard build failed')
    expect(ledger(entry)).toContain('outcome=client-build-failed')
  }, 30_000)
})
