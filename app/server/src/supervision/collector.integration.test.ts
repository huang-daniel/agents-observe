// Integration coverage for collector supervision: real server processes, real
// lock files, real HTTP. Everything here spawns `src/index.ts` the way the
// project starts it, so the startup and shutdown sequencing is exercised as
// shipped rather than re-assembled in the test.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'

import { readHeartbeat } from './heartbeat'
import { readLock } from './lock'
import { runtimePaths } from './paths'
import {
  SERVER_ENTRY,
  healthCliStatus,
  makeDataRoot,
  removeDataRoot,
  runHealthCli,
  shellLockIsAbandoned,
  waitFor,
} from './test-support'

const SERVER_DIR = SERVER_ENTRY.replace(/\/src\/index\.ts$/, '')
const BOOT_TIMEOUT_MS = 30_000

interface Instance {
  child: ChildProcess
  port: number
  url: string
  output: string[]
  exited: Promise<number | null>
}

const running: Instance[] = []

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })
}

function startServer(dataRoot: string, port: number): Instance {
  const child = spawn(process.execPath, ['--import', 'tsx', SERVER_ENTRY], {
    cwd: SERVER_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AGENTS_OBSERVE_DATA_ROOT: dataRoot,
      AGENTS_OBSERVE_DB_PATH: `${dataRoot}/observe.db`,
      AGENTS_OBSERVE_SERVER_PORT: String(port),
      AGENTS_OBSERVE_BIND_HOST: '127.0.0.1',
      AGENTS_OBSERVE_CLIENT_DIST_PATH: '',
      // Keep the idle auto-shutdown out of the way; it has its own exit path.
      AGENTS_OBSERVE_SHUTDOWN_DELAY_MS: '0',
      AGENTS_OBSERVE_HEARTBEAT_INTERVAL_MS: '300',
      AGENTS_OBSERVE_LOG_LEVEL: 'error',
    },
  })

  const output: string[] = []
  child.stdout?.on('data', (chunk) => output.push(String(chunk)))
  child.stderr?.on('data', (chunk) => output.push(String(chunk)))

  const instance: Instance = {
    child,
    port,
    url: `http://127.0.0.1:${port}`,
    output,
    exited: new Promise((resolve) => child.once('exit', (code) => resolve(code))),
  }
  running.push(instance)
  return instance
}

async function health(instance: Instance): Promise<Record<string, any>> {
  const res = await fetch(`${instance.url}/api/health`)
  return (await res.json()) as Record<string, any>
}

async function waitUntilServing(instance: Instance): Promise<void> {
  await waitFor(
    async () => {
      if (instance.child.exitCode !== null) {
        throw new Error(
          `server exited early (${instance.child.exitCode}): ${instance.output.join('')}`,
        )
      }
      try {
        const body = await health(instance)
        // httpHealthy only flips once a heartbeat has been published since the
        // listener came up, so this is "fully started", not merely "answering".
        return body.collector?.status === 'healthy' && body.collector?.httpHealthy === true
      } catch {
        return false
      }
    },
    { timeoutMs: BOOT_TIMEOUT_MS, intervalMs: 100 },
  )
}

function stop(instance: Instance): Promise<number | null> {
  if (instance.child.exitCode === null) instance.child.kill('SIGKILL')
  return instance.exited
}

/** Nothing may outlive the file, whatever a test did or failed to do. */
afterAll(async () => {
  while (running.length) await stop(running.pop()!)
})

describe('a running collector', () => {
  let root: string
  let paths: ReturnType<typeof runtimePaths>
  let server: Instance

  beforeAll(async () => {
    root = makeDataRoot('observe-integration')
    paths = runtimePaths(root)
    server = startServer(root, await freePort())
    await waitUntilServing(server)
  }, BOOT_TIMEOUT_MS)

  afterAll(async () => {
    while (running.length) await stop(running.pop()!)
    removeDataRoot(root)
  })

  it('owns the data root and says so on /api/health', async () => {
    const body = await health(server)
    const lock = readLock(paths.lockDir)!

    expect(body.collector).toMatchObject({
      status: 'healthy',
      reason: null,
      dataRoot: root,
      databaseHealthy: true,
      httpHealthy: true,
      // Reserved until the spool lands.
      lastCommittedEventId: null,
      spoolPending: null,
    })
    expect(body.collector.instanceId).toBe(lock.instanceId)
    expect(String(body.collector.pid)).toBe(lock.pid)
    // Collector state is reported, not conflated with the DB check that drives
    // the status code.
    expect(body.ok).toBe(true)
  })

  it('agrees with observe-health.sh', async () => {
    const cli = await runHealthCli(root)
    expect(healthCliStatus(cli)).toBe('healthy')
    expect(cli.code).toBe(0)
    expect(cli.stdout).toContain(`pid=${readLock(paths.lockDir)!.pid}`)
  })

  it('keeps the heartbeat moving', async () => {
    const first = readHeartbeat(paths.heartbeatFile)!.updatedAt
    await waitFor(() => readHeartbeat(paths.heartbeatFile)!.updatedAt !== first, {
      timeoutMs: 10_000,
    })
    const second = readHeartbeat(paths.heartbeatFile)!.updatedAt
    expect(Number(second)).toBeGreaterThan(Number(first))
    expect((await health(server)).collector.heartbeatAgeSeconds).toBeLessThan(30)
  })

  it(
    'refuses a second collector on the same data root',
    async () => {
      // A different port, so the only thing that can stop it is the lock.
      const second = startServer(root, await freePort())
      const code = await second.exited

      expect(code).toBe(3)
      expect(second.output.join('')).toContain('another collector already owns')

      // The incumbent is untouched and still healthy.
      expect(readLock(paths.lockDir)!.instanceId).toBe((await health(server)).collector.instanceId)
      expect((await health(server)).collector.status).toBe('healthy')
    },
    BOOT_TIMEOUT_MS,
  )
})

describe('two data roots', () => {
  it(
    'run fully independent collectors at the same time',
    async () => {
      const rootA = makeDataRoot('observe-integration-a')
      const rootB = makeDataRoot('observe-integration-b')
      try {
        const a = startServer(rootA, await freePort())
        const b = startServer(rootB, await freePort())
        await waitUntilServing(a)
        await waitUntilServing(b)

        const [bodyA, bodyB] = [await health(a), await health(b)]
        expect(bodyA.collector.status).toBe('healthy')
        expect(bodyB.collector.status).toBe('healthy')
        expect(bodyA.collector.instanceId).not.toBe(bodyB.collector.instanceId)
        expect(bodyA.collector.dataRoot).toBe(rootA)
        expect(bodyB.collector.dataRoot).toBe(rootB)

        expect(healthCliStatus(await runHealthCli(rootA))).toBe('healthy')
        expect(healthCliStatus(await runHealthCli(rootB))).toBe('healthy')

        // Stopping one leaves the other exactly as it was.
        a.child.kill('SIGTERM')
        await a.exited
        expect(existsSync(runtimePaths(rootA).lockDir)).toBe(false)
        expect(healthCliStatus(await runHealthCli(rootB))).toBe('healthy')
        expect((await health(b)).collector.status).toBe('healthy')
      } finally {
        while (running.length) await stop(running.pop()!)
        removeDataRoot(rootA)
        removeDataRoot(rootB)
      }
    },
    BOOT_TIMEOUT_MS * 2,
  )
})

describe('a collector that was killed outright', () => {
  it(
    'leaves a lock the kernel calls abandoned, and a successor reclaims it',
    async () => {
      const root = makeDataRoot('observe-integration-kill')
      try {
        const paths = runtimePaths(root)
        const first = startServer(root, await freePort())
        await waitUntilServing(first)
        const firstInstance = readLock(paths.lockDir)!.instanceId

        first.child.kill('SIGKILL')
        await first.exited

        // SIGKILL runs no shutdown path, so the lock is still on disk. Deciding
        // it is reclaimable belongs to the shell primitive, not to the server.
        expect(existsSync(paths.lockDir)).toBe(true)
        expect(await shellLockIsAbandoned(root)).toBe(true)
        expect(healthCliStatus(await runHealthCli(root))).toBe('unhealthy')

        const second = startServer(root, await freePort())
        await waitUntilServing(second)
        expect(readLock(paths.lockDir)!.instanceId).not.toBe(firstInstance)
        expect(healthCliStatus(await runHealthCli(root))).toBe('healthy')
      } finally {
        while (running.length) await stop(running.pop()!)
        removeDataRoot(root)
      }
    },
    BOOT_TIMEOUT_MS * 2,
  )
})

describe('graceful shutdown', () => {
  it(
    'releases the lock and heartbeat it owns on SIGTERM',
    async () => {
      const root = makeDataRoot('observe-integration-term')
      try {
        const paths = runtimePaths(root)
        const server = startServer(root, await freePort())
        await waitUntilServing(server)
        expect(existsSync(paths.lockDir)).toBe(true)

        server.child.kill('SIGTERM')
        expect(await server.exited).toBe(0)

        expect(existsSync(paths.lockDir)).toBe(false)
        expect(existsSync(paths.heartbeatFile)).toBe(false)
        expect(healthCliStatus(await runHealthCli(root))).toBe('absent')
      } finally {
        while (running.length) await stop(running.pop()!)
        removeDataRoot(root)
      }
    },
    BOOT_TIMEOUT_MS,
  )
})
