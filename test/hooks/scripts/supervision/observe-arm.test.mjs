// Integration coverage for the shell supervisor arm. These tests start the
// real collector and exercise the same lock, heartbeat, and HTTP predicate the
// command uses in production.

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MARKER,
  makeDataRoot,
  removeDataRoot,
  runShell,
  spawnFakeProcess,
  killProcess,
  waitFor,
} from './helpers.mjs'

const execFileAsync = promisify(execFile)
const SUPERVISION_DIR = join(process.cwd(), 'hooks/scripts/supervision')
const ARM = join(SUPERVISION_DIR, 'observe-arm.sh')
const STOP = join(SUPERVISION_DIR, 'observe-stop.sh')
const FAKE_COLLECTOR = join(
  SUPERVISION_DIR,
  '../../../test/hooks/scripts/supervision/fixtures/fake-collector.sh',
)
const PHASE_COLLECTOR = join(
  SUPERVISION_DIR,
  '../../../test/hooks/scripts/supervision/fixtures/phase-collector.sh',
)

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

async function command(script, args, root, port, overrides = {}) {
  const env = {
    ...process.env,
    AGENTS_OBSERVE_DATA_ROOT: root,
    AGENTS_OBSERVE_DB_PATH: `${root}/observe.db`,
    AGENTS_OBSERVE_SERVER_PORT: String(port),
    AGENTS_OBSERVE_BIND_HOST: '127.0.0.1',
    AGENTS_OBSERVE_CLIENT_DIST_PATH: '',
    AGENTS_OBSERVE_SHUTDOWN_DELAY_MS: '0',
    AGENTS_OBSERVE_HEARTBEAT_INTERVAL_MS: '100',
    AGENTS_OBSERVE_HEALTH_URL: `http://127.0.0.1:${port}/api/health`,
    AGENTS_OBSERVE_START_TIMEOUT: '20',
    AGENTS_OBSERVE_START_POLL: '0.05',
    AGENTS_OBSERVE_LOG_LEVEL: 'error',
    AGENTS_OBSERVE_COLLECTOR_ENTRYPOINT: FAKE_COLLECTOR,
    ...overrides,
  }
  try {
    const { stdout, stderr } = await execFileAsync(script, args, { env })
    return { code: 0, stdout, stderr }
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

async function start(root, port) {
  return command(ARM, ['start'], root, port)
}

async function stop(root, port) {
  return command(STOP, [], root, port)
}

afterEach(async () => {
  for (const item of roots.splice(0)) {
    await stop(item.root, item.port)
    removeDataRoot(item.root)
  }
})

function fixture() {
  const root = makeDataRoot('observe-arm')
  roots.push({ root, port: 0 })
  return { root, entry: roots.at(-1) }
}

describe('observe-arm.sh', () => {
  it('starts and confirms a healthy collector, then attaches without a second spawn', async () => {
    const { root, entry } = fixture()
    entry.port = await freePort()

    const first = await start(root, entry.port)
    expect(first.code, first.stderr).toBe(0)
    expect(first.stdout).toMatch(/^collector: started pid=\d+ instance=/)

    const second = await command(ARM, ['attach'], root, entry.port)
    expect(second.code, second.stderr).toBe(0)
    expect(second.stdout).toMatch(/^collector: attached pid=\d+ instance=/)
    expect(second.stdout.match(/pid=(\d+)/)[1]).toBe(first.stdout.match(/pid=(\d+)/)[1])
  }, 30_000)

  it('serializes concurrent starts through the start lock', async () => {
    const { root, entry } = fixture()
    entry.port = await freePort()
    // This is intentionally a live integration race: only independent arm
    // processes can verify that the kernel's O_EXCL start-lock claim lets one
    // invocation start and makes its peer attach.
    const [a, b] = await Promise.all([start(root, entry.port), start(root, entry.port)])

    expect(a.code, a.stderr).toBe(0)
    expect(b.code, b.stderr).toBe(0)
    const outputs = `${a.stdout}${b.stdout}`
    expect((outputs.match(/collector: started/g) ?? []).length).toBe(1)
    expect((outputs.match(/collector: attached/g) ?? []).length).toBe(1)
  }, 30_000)

  it('rejects a reused PID as unsafe instead of spawning over it', async () => {
    const { root, entry } = fixture()
    entry.port = await freePort()
    const original = spawnFakeProcess(MARKER)
    const claimed = await runShell(
      `observe_runtime_ensure && observe_collector_lock_claim 'old-instance' ${original.pid}`,
      { dataRoot: root },
    )
    expect(claimed.code).toBe(0)
    const lockDir = `${root}/runtime/collector.lock`
    const identity = readFileSync(`${lockDir}/pid-identity`, 'utf8')
    killProcess(original)

    const unrelated = spawnFakeProcess()
    writeFileSync(`${lockDir}/pid`, `${unrelated.pid}\n`)
    writeFileSync(`${lockDir}/pid-identity`, identity.replace(/^pid=\d+/, `pid=${unrelated.pid}`))

    const result = await start(root, entry.port)
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(readFileSync(`${lockDir}/instance-id`, 'utf8')).toBe('old-instance\n')
    killProcess(unrelated)
  }, 30_000)

  it('does not replace a live owner merely because its heartbeat is stale', async () => {
    const { root, entry } = fixture()
    entry.port = await freePort()
    const owner = spawnFakeProcess(MARKER)
    const setup = await runShell(
      `observe_runtime_ensure && observe_collector_lock_claim 'wedged-instance' ${owner.pid} && observe_heartbeat_publish 'wedged-instance' ${owner.pid}`,
      { dataRoot: root },
    )
    expect(setup.code).toBe(0)
    writeFileSync(
      `${root}/runtime/collector.heartbeat`,
      `instanceId=wedged-instance\npid=${owner.pid}\nupdatedAt=1\n`,
    )

    const result = await start(root, entry.port)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('live or unsafe owner remains')
    expect(readFileSync(`${root}/runtime/collector.lock/instance-id`, 'utf8')).toBe(
      'wedged-instance\n',
    )
    killProcess(owner)
  }, 30_000)

  for (const phase of ['before-lock', 'after-lock', 'after-heartbeat']) {
    it(`recovers after a collector is killed ${phase.replace('-', ' ')}`, async () => {
      const { root, entry } = fixture()
      entry.port = await freePort()
      const ready = `${root}/runtime/phase-collector.pid`
      const failedStart = command(ARM, ['start'], root, entry.port, {
        AGENTS_OBSERVE_COLLECTOR_ENTRYPOINT: PHASE_COLLECTOR,
        AGENTS_OBSERVE_TEST_COLLECTOR_PHASE: phase,
        AGENTS_OBSERVE_START_TIMEOUT: '1',
        AGENTS_OBSERVE_START_POLL: '0.02',
      })
      await waitFor(() => existsSync(ready))
      process.kill(Number(readFileSync(ready, 'utf8').trim()), 'SIGKILL')
      const failed = await failedStart

      expect(failed.code).toBe(1)
      if (phase === 'before-lock') expect(existsSync(`${root}/runtime/collector.lock`)).toBe(false)
      else expect(existsSync(`${root}/runtime/collector.lock`)).toBe(true)

      const recovered = await start(root, entry.port)
      expect(recovered.code, recovered.stderr).toBe(0)
      expect(recovered.stdout).toContain('collector: started')
    }, 30_000)
  }

  it('reclaims a lock whose owner is provably dead before starting', async () => {
    const { root, entry } = fixture()
    entry.port = await freePort()
    const dead = spawnFakeProcess(MARKER)
    await runShell(
      `observe_runtime_ensure && observe_collector_lock_claim 'dead-instance' ${dead.pid}`,
      {
        dataRoot: root,
      },
    )
    killProcess(dead)

    const result = await start(root, entry.port)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('collector: started')
  }, 30_000)

  it('restarts both a live owner and an absent data root into one healthy collector', async () => {
    const { root, entry } = fixture()
    entry.port = await freePort()
    const first = await start(root, entry.port)
    const firstPid = first.stdout.match(/pid=(\d+)/)[1]

    const live = await command(ARM, ['restart'], root, entry.port)
    expect(live.code, live.stderr).toBe(0)
    expect(live.stdout).toContain('collector: started')
    expect(live.stdout.match(/pid=(\d+)/)[1]).not.toBe(firstPid)

    await stop(root, entry.port)
    const absent = await command(ARM, ['restart'], root, entry.port)
    expect(absent.code, absent.stderr).toBe(0)
    expect(absent.stdout).toContain('collector: started')
  }, 45_000)

  it('stops a live collector and treats an already stopped root as a clean no-op', async () => {
    const { root, entry } = fixture()
    entry.port = await freePort()
    await start(root, entry.port)

    const live = await stop(root, entry.port)
    expect(live.code, live.stderr).toBe(0)
    expect(live.stdout).toContain('collector: stopped')
    expect(existsSync(`${root}/runtime/collector.lock`)).toBe(false)

    const absent = await stop(root, entry.port)
    expect(absent.code, absent.stderr).toBe(0)
    expect(absent.stdout).toContain('collector: already stopped')
  }, 30_000)
})
