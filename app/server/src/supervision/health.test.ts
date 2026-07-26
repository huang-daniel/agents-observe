import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import type { ChildProcess } from 'node:child_process'

import { collectorHealth, healthExitCode } from './health'
import type { CollectorHealth } from './health'
import { HEARTBEAT_SCHEMA_VERSION, publishHeartbeat } from './heartbeat'
import { tryClaimLock } from './lock'
import { ensureRuntimeDir, nowEpoch, runtimePaths } from './paths'
import {
  MARKER,
  healthCliStatus,
  killProcess,
  makeDataRoot,
  removeDataRoot,
  runHealthCli,
  spawnFakeProcess,
  testLockOptions,
  waitForExit,
} from './test-support'

/** The shell CLI's default grace window, so both sides judge staleness alike. */
const GRACE = 30

let root: string
let paths: ReturnType<typeof runtimePaths>
const children: ChildProcess[] = []

beforeEach(() => {
  root = makeDataRoot('observe-health-ts')
  paths = runtimePaths(root)
  ensureRuntimeDir(paths)
})

afterEach(() => {
  while (children.length) killProcess(children.pop())
  removeDataRoot(root)
})

function fakeCollector(marker = MARKER): ChildProcess {
  const child = spawnFakeProcess(marker)
  children.push(child)
  return child
}

function health(expectedInstanceId?: string): CollectorHealth {
  return collectorHealth(paths, { ...testLockOptions(), graceSeconds: GRACE, expectedInstanceId })
}

function beat(instanceId: string, pid: number, updatedAt = nowEpoch()) {
  publishHeartbeat(paths.heartbeatFile, {
    schemaVersion: HEARTBEAT_SCHEMA_VERSION,
    pid,
    instanceId,
    startedAt: updatedAt,
    updatedAt,
    databaseHealthy: true,
    httpHealthy: true,
    lastCommittedEventId: null,
    spoolPending: null,
  })
}

/** A fully healthy data root: lock claimed by a live marked process + heartbeat. */
function makeHealthy(instanceId = 'inst-1'): ChildProcess {
  const child = fakeCollector()
  tryClaimLock(
    { lockDir: paths.lockDir, instanceId, entrypoint: MARKER, dataRoot: root, pid: child.pid! },
    testLockOptions(),
  )
  beat(instanceId, child.pid!)
  return child
}

describe('collectorHealth', () => {
  it('reports absent when nothing has ever claimed the data root', () => {
    expect(health()).toMatchObject({ status: 'absent', reason: null, pid: null })
    expect(healthExitCode('absent')).toBe(1)
  })

  it('reports healthy for a live, identity-matched owner with a fresh heartbeat', () => {
    const child = makeHealthy()
    expect(health('inst-1')).toMatchObject({
      status: 'healthy',
      reason: null,
      pid: child.pid,
      instanceId: 'inst-1',
    })
    expect(healthExitCode('healthy')).toBe(0)
  })

  it('reports dead-pid once the owner is gone', async () => {
    const child = makeHealthy()
    child.kill('SIGKILL')
    await waitForExit(child)
    expect(health()).toMatchObject({ status: 'unhealthy', reason: 'dead-pid' })
  })

  it('reports missing-heartbeat when the process is up but never reported working', () => {
    makeHealthy()
    rmSync(paths.heartbeatFile)
    expect(health()).toMatchObject({ status: 'unhealthy', reason: 'missing-heartbeat' })
  })

  it('reports stale-heartbeat when the process is up but wedged', () => {
    const child = makeHealthy()
    beat('inst-1', child.pid!, nowEpoch() - 900)
    expect(health()).toMatchObject({ status: 'unhealthy', reason: 'stale-heartbeat' })
  })

  it('reports data-root-mismatch for a lock from another namespace', () => {
    makeHealthy()
    writeFileSync(`${paths.lockDir}/data-root`, '/some/other/root\n')
    expect(health()).toMatchObject({ status: 'invalid-owner', reason: 'data-root-mismatch' })
    expect(healthExitCode('invalid-owner')).toBe(2)
  })

  it('reports malformed-lock when no usable pid or identity was recorded', () => {
    mkdirSync(paths.lockDir)
    writeFileSync(`${paths.lockDir}/pid`, 'not-a-pid\n')
    expect(health()).toMatchObject({ status: 'invalid-owner', reason: 'malformed-lock' })
  })

  it('reports pid-identity-mismatch on a reused pid', () => {
    const child = makeHealthy()
    writeFileSync(`${paths.lockDir}/pid-identity`, `pid=${child.pid} starttime=1 exe=/bin/bash\n`)
    expect(health()).toMatchObject({ status: 'invalid-owner', reason: 'pid-identity-mismatch' })
  })

  it('reports entrypoint-mismatch when the live process is not the collector', () => {
    makeHealthy()
    writeFileSync(`${paths.lockDir}/entrypoint`, 'something-else-entirely\n')
    expect(health()).toMatchObject({ status: 'invalid-owner', reason: 'entrypoint-mismatch' })
  })

  it('reports instance-mismatch when heartbeat and lock disagree', () => {
    const child = makeHealthy()
    beat('inst-2', child.pid!)
    expect(health()).toMatchObject({ status: 'invalid-owner', reason: 'instance-mismatch' })
  })

  it('reports instance-mismatch when a successor took the lock from the caller', () => {
    makeHealthy('inst-successor')
    // Everything on disk is healthy — but it is not ours, which the shell
    // predicate cannot see because it has no caller identity.
    expect(health()).toMatchObject({ status: 'healthy' })
    expect(health('inst-1')).toMatchObject({
      status: 'invalid-owner',
      reason: 'instance-mismatch',
    })
  })
})

// The shell diagnostic and this predicate read the same files and must reach
// the same verdict; anything else means one of the two has drifted.
describe('parity with observe-health.sh', () => {
  const cases: [string, () => void | Promise<void>][] = [
    ['absent', () => {}],
    ['healthy', () => void makeHealthy()],
    [
      'unhealthy dead-pid',
      async () => {
        const child = makeHealthy()
        child.kill('SIGKILL')
        await waitForExit(child)
      },
    ],
    [
      'unhealthy missing-heartbeat',
      () => {
        makeHealthy()
        rmSync(paths.heartbeatFile)
      },
    ],
    [
      'unhealthy stale-heartbeat',
      () => {
        const child = makeHealthy()
        beat('inst-1', child.pid!, nowEpoch() - 900)
      },
    ],
    [
      'invalid-owner data-root-mismatch',
      () => {
        makeHealthy()
        writeFileSync(`${paths.lockDir}/data-root`, '/some/other/root\n')
      },
    ],
    [
      'invalid-owner malformed-lock',
      () => {
        mkdirSync(paths.lockDir)
        writeFileSync(`${paths.lockDir}/pid`, 'not-a-pid\n')
      },
    ],
    [
      'invalid-owner pid-identity-mismatch',
      () => {
        const child = makeHealthy()
        writeFileSync(
          `${paths.lockDir}/pid-identity`,
          `pid=${child.pid} starttime=1 exe=/bin/bash\n`,
        )
      },
    ],
    [
      'invalid-owner entrypoint-mismatch',
      () => {
        makeHealthy()
        writeFileSync(`${paths.lockDir}/entrypoint`, 'something-else-entirely\n')
      },
    ],
    [
      'invalid-owner instance-mismatch',
      () => {
        const child = makeHealthy()
        beat('inst-2', child.pid!)
      },
    ],
  ]

  for (const [name, arrange] of cases) {
    it(`agrees on ${name}`, async () => {
      await arrange()
      const mine = health()
      const cli = await runHealthCli(root)
      expect(healthCliStatus(cli)).toBe(mine.status)
      expect(cli.code).toBe(healthExitCode(mine.status))
      if (mine.reason) expect(cli.stdout).toContain(`reason=${mine.reason}`)
    })
  }
})
