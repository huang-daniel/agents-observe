import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import type { ChildProcess } from 'node:child_process'

import { CollectorLockHeldError, createCollectorSupervision } from './collector'
import type { CollectorSupervision } from './collector'
import { readHeartbeat } from './heartbeat'
import { readLock, tryClaimLock } from './lock'
import { ensureRuntimeDir, runtimePaths } from './paths'
import {
  MARKER,
  killProcess,
  makeDataRoot,
  removeDataRoot,
  shellLockIsAbandoned,
  spawnFakeProcess,
  testLockOptions,
  waitFor,
  waitForExit,
} from './test-support'

let root: string
let paths: ReturnType<typeof runtimePaths>
const children: ChildProcess[] = []
const started: CollectorSupervision[] = []

beforeEach(() => {
  root = makeDataRoot('observe-collector-ts')
  paths = runtimePaths(root)
})

afterEach(() => {
  while (started.length) started.pop()!.stopHeartbeat()
  while (children.length) killProcess(children.pop())
  removeDataRoot(root)
})

function fakeCollector(marker = MARKER): ChildProcess {
  const child = spawnFakeProcess(marker)
  children.push(child)
  return child
}

function supervise(overrides: Parameters<typeof createCollectorSupervision>[0] = {}) {
  const supervision = createCollectorSupervision({
    dataRoot: root,
    instanceId: 'inst-A',
    heartbeatIntervalMs: 100,
    graceSeconds: 30,
    settleSeconds: 2,
    procRoot: '/proc',
    log: () => {},
    ...overrides,
  })
  started.push(supervision)
  return supervision
}

/** Claim the lock on behalf of an unrelated live process. */
function claimForOther(pid: number, instanceId = 'inst-other'): void {
  ensureRuntimeDir(paths)
  const claimed = tryClaimLock(
    { lockDir: paths.lockDir, instanceId, entrypoint: MARKER, dataRoot: root, pid },
    testLockOptions(),
  )
  if (!claimed) throw new Error('test setup: could not claim the lock for another process')
}

describe('claim', () => {
  it('records the identity metadata the shell primitives expect', () => {
    const supervision = supervise()
    supervision.claim()

    const lock = readLock(paths.lockDir)!
    expect(lock.pid).toBe(String(process.pid))
    expect(lock.instanceId).toBe('inst-A')
    expect(lock.dataRoot).toBe(root)
    expect(lock.identity).toMatch(/^pid=\d+ (starttime|started)=/)
    expect(lock.startedAt).toMatch(/^\d+$/)
    expect(readdirSync(paths.lockDir).sort()).toEqual([
      'data-root',
      'entrypoint',
      'executable',
      'instance-id',
      'pid',
      'pid-identity',
      'started-at',
    ])
  })

  it('refuses immediately when a live owner already holds the data root', () => {
    const other = fakeCollector()
    claimForOther(other.pid!)

    const supervision = supervise()
    expect(() => supervision.claim()).toThrow(CollectorLockHeldError)
    // The incumbent's lock is left exactly as it was.
    expect(readLock(paths.lockDir)!.instanceId).toBe('inst-other')
  })

  it('reclaims a lock whose owner is provably gone', async () => {
    const dead = fakeCollector()
    claimForOther(dead.pid!)
    dead.kill('SIGKILL')
    await waitForExit(dead)

    // The shell primitive is the one that decides this, and it agrees the
    // lock is reclaimable.
    expect(await shellLockIsAbandoned(root)).toBe(true)

    const supervision = supervise()
    supervision.claim()
    expect(readLock(paths.lockDir)!.instanceId).toBe('inst-A')
  })

  it('keeps two data roots completely independent', () => {
    const other = makeDataRoot('observe-collector-ts-b')
    try {
      const a = supervise()
      const b = supervise({ dataRoot: other, instanceId: 'inst-B' })
      a.claim()
      b.claim()

      expect(readLock(paths.lockDir)!.instanceId).toBe('inst-A')
      expect(readLock(runtimePaths(other).lockDir)!.instanceId).toBe('inst-B')

      a.release()
      expect(existsSync(paths.lockDir)).toBe(false)
      expect(existsSync(runtimePaths(other).lockDir)).toBe(true)
    } finally {
      removeDataRoot(other)
    }
  })
})

describe('heartbeat', () => {
  it('keeps republishing while the collector runs', async () => {
    const supervision = supervise()
    supervision.claim()
    supervision.startHeartbeat()

    await waitFor(() => readHeartbeat(paths.heartbeatFile) !== null)
    const first = readHeartbeat(paths.heartbeatFile)!.updatedAt
    // updatedAt is epoch seconds, so a change proves a later tick wrote it,
    // not merely that the first write happened twice.
    await waitFor(() => readHeartbeat(paths.heartbeatFile)!.updatedAt !== first, {
      timeoutMs: 5000,
    })
    expect(Number(readHeartbeat(paths.heartbeatFile)!.updatedAt)).toBeGreaterThan(Number(first))
  })

  it('carries the probe result so a wedged collector is visible', async () => {
    const supervision = supervise({
      probe: () => ({ databaseHealthy: false, httpHealthy: true }),
    })
    supervision.claim()
    await supervision.publish()

    const fields = readHeartbeat(paths.heartbeatFile)!
    expect(fields.databaseHealthy).toBe('false')
    expect(fields.httpHealthy).toBe('true')
    expect(fields.instanceId).toBe('inst-A')
    expect(supervision.status()).toMatchObject({ databaseHealthy: false, httpHealthy: true })
  })

  it('reports healthy through status() once claimed and beating', async () => {
    const supervision = supervise()
    supervision.claim()
    await supervision.publish()
    expect(supervision.status()).toMatchObject({
      status: 'healthy',
      reason: null,
      instanceId: 'inst-A',
      pid: process.pid,
      dataRoot: root,
    })
  })
})

describe('release', () => {
  it('gives up the lock and heartbeat it owns', async () => {
    const supervision = supervise()
    supervision.claim()
    await supervision.publish()

    expect(supervision.release()).toBe(true)
    expect(existsSync(paths.lockDir)).toBe(false)
    expect(existsSync(paths.heartbeatFile)).toBe(false)
  })

  it('is idempotent', async () => {
    const supervision = supervise()
    supervision.claim()
    await supervision.publish()
    expect(supervision.release()).toBe(true)
    expect(supervision.release()).toBe(false)
  })

  // The single most important invariant in collector shutdown.
  it('never removes a successor’s lock or heartbeat', async () => {
    const supervision = supervise()
    supervision.claim()
    await supervision.publish()

    // Simulate instance B taking the data root over: the lock now names B.
    writeFileSync(`${paths.lockDir}/instance-id`, 'inst-B\n')
    const lockBefore = readdirSync(paths.lockDir).sort()
    const heartbeatBefore = readFileSync(paths.heartbeatFile, 'utf8')

    // A's shutdown path runs — and must touch nothing.
    expect(supervision.release()).toBe(false)

    expect(existsSync(paths.lockDir)).toBe(true)
    expect(readdirSync(paths.lockDir).sort()).toEqual(lockBefore)
    expect(readLock(paths.lockDir)!.instanceId).toBe('inst-B')
    expect(readFileSync(paths.heartbeatFile, 'utf8')).toBe(heartbeatBefore)
  })

  it('leaves a lock recording a different data root alone', async () => {
    const supervision = supervise()
    supervision.claim()
    await supervision.publish()
    writeFileSync(`${paths.lockDir}/data-root`, '/some/other/root\n')

    expect(supervision.release()).toBe(false)
    expect(existsSync(paths.lockDir)).toBe(true)
    expect(existsSync(paths.heartbeatFile)).toBe(true)
  })

  it('stops the heartbeat even when the lock is not ours to release', async () => {
    const supervision = supervise()
    supervision.claim()
    supervision.startHeartbeat()
    await waitFor(() => readHeartbeat(paths.heartbeatFile) !== null)

    writeFileSync(`${paths.lockDir}/instance-id`, 'inst-B\n')
    supervision.release()

    const after = readHeartbeat(paths.heartbeatFile)!.updatedAt
    await new Promise((res) => setTimeout(res, 400))
    expect(readHeartbeat(paths.heartbeatFile)!.updatedAt).toBe(after)
  })
})
