import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { ChildProcess } from 'node:child_process'

import {
  lockIsAbandoned,
  lockIsSettling,
  lockOwnedBy,
  processMatchesLock,
  readLock,
  releaseLockIfPidOwner,
  removeLock,
  tryClaimLock,
} from './lock'
import { ensureRuntimeDir, runtimePaths } from './paths'
import {
  MARKER,
  killProcess,
  makeDataRoot,
  removeDataRoot,
  spawnFakeProcess,
  testLockOptions,
  waitForExit,
} from './test-support'

let root: string
let paths: ReturnType<typeof runtimePaths>
const children: ChildProcess[] = []

beforeEach(() => {
  root = makeDataRoot('observe-lock-ts')
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

function claimFor(pid: number, instanceId = 'inst-1', entrypoint = MARKER): boolean {
  return tryClaimLock(
    { lockDir: paths.lockDir, instanceId, entrypoint, dataRoot: root, pid },
    testLockOptions(),
  )
}

describe('tryClaimLock', () => {
  it('records every field the shell primitives read back', () => {
    const child = fakeCollector()
    expect(claimFor(child.pid!)).toBe(true)

    const lock = readLock(paths.lockDir)!
    expect(lock.pid).toBe(String(child.pid))
    expect(lock.instanceId).toBe('inst-1')
    expect(lock.dataRoot).toBe(root)
    expect(lock.entrypoint).toBe(MARKER)
    expect(lock.identity).toMatch(/^pid=\d+ (starttime|started)=/)
    expect(lock.executable).not.toBe('')
    expect(lock.startedAt).toMatch(/^\d+$/)
    // Every file is newline-terminated, one value per line — the format
    // observe_read_line expects.
    expect(readFileSync(`${paths.lockDir}/pid`, 'utf8')).toBe(`${child.pid}\n`)
  })

  it('refuses a second claim while the first owner holds it', () => {
    const first = fakeCollector()
    const second = fakeCollector()
    expect(claimFor(first.pid!, 'inst-1')).toBe(true)
    expect(claimFor(second.pid!, 'inst-2')).toBe(false)
    expect(readLock(paths.lockDir)!.instanceId).toBe('inst-1')
  })

  it('rejects a claim with no instance id or no usable pid', () => {
    const child = fakeCollector()
    expect(claimFor(child.pid!, '')).toBe(false)
    expect(claimFor(NaN as unknown as number, 'inst-1')).toBe(false)
    expect(existsSync(`${paths.lockDir}/instance-id`)).toBe(false)
  })
})

describe('lockIsAbandoned', () => {
  it('is false for a lock whose owner is alive and identity-matched', () => {
    const child = fakeCollector()
    claimFor(child.pid!)
    expect(processMatchesLock(paths.lockDir, testLockOptions())).toBe(true)
    expect(lockIsAbandoned(paths.lockDir, testLockOptions())).toBe(false)
  })

  it('is true once the recorded owner is gone', async () => {
    const child = fakeCollector()
    claimFor(child.pid!)
    child.kill('SIGKILL')
    await waitForExit(child)
    expect(lockIsAbandoned(paths.lockDir, testLockOptions())).toBe(true)
  })

  it('is true when a live pid no longer matches the recorded identity', () => {
    const child = fakeCollector()
    claimFor(child.pid!)
    writeFileSync(`${paths.lockDir}/pid-identity`, 'pid=1 starttime=1 exe=/nope\n')
    expect(lockIsAbandoned(paths.lockDir, testLockOptions())).toBe(true)
  })

  it('is true when a live pid does not carry the recorded entrypoint marker', () => {
    const child = fakeCollector('some-other-process')
    claimFor(child.pid!, 'inst-1', 'some-other-process')
    writeFileSync(`${paths.lockDir}/entrypoint`, `${MARKER}\n`)
    expect(lockIsAbandoned(paths.lockDir, testLockOptions())).toBe(true)
  })

  it('leaves a half-written lock alone inside the settle window', () => {
    mkdirSync(paths.lockDir)
    expect(lockIsSettling(paths.lockDir, testLockOptions())).toBe(true)
    expect(lockIsAbandoned(paths.lockDir, testLockOptions())).toBe(false)
    // With no settle grace the same lock is reclaimable.
    expect(lockIsAbandoned(paths.lockDir, testLockOptions({ settleSeconds: 0 }))).toBe(true)
  })

  it('is false when there is no lock at all', () => {
    expect(lockIsAbandoned(paths.lockDir, testLockOptions())).toBe(false)
    expect(readLock(paths.lockDir)).toBeNull()
  })
})

describe('release', () => {
  it('removes a lock this pid owns', () => {
    const child = fakeCollector()
    claimFor(child.pid!)
    expect(releaseLockIfPidOwner(paths.lockDir, child.pid!)).toBe(true)
    expect(existsSync(paths.lockDir)).toBe(false)
  })

  it('leaves a lock recording somebody else entirely alone', () => {
    const owner = fakeCollector()
    const other = fakeCollector()
    claimFor(owner.pid!)
    expect(releaseLockIfPidOwner(paths.lockDir, other.pid!)).toBe(false)
    expect(existsSync(paths.lockDir)).toBe(true)
  })

  it('refuses to remove a lock directory holding files it does not recognise', () => {
    const child = fakeCollector()
    claimFor(child.pid!)
    writeFileSync(`${paths.lockDir}/something-else`, 'x\n')
    expect(removeLock(paths.lockDir)).toBe(false)
    expect(existsSync(paths.lockDir)).toBe(true)
  })
})

describe('lockOwnedBy', () => {
  it('requires both the instance id and the data root to match', () => {
    const child = fakeCollector()
    claimFor(child.pid!, 'inst-1')
    expect(lockOwnedBy(paths.lockDir, 'inst-1', root)).toBe(true)
    expect(lockOwnedBy(paths.lockDir, 'inst-2', root)).toBe(false)
    expect(lockOwnedBy(paths.lockDir, 'inst-1', '/somewhere/else')).toBe(false)
    expect(lockOwnedBy(paths.lockDir, '', root)).toBe(false)
  })
})

// A collector can only apply the proof its own runtime gives it: a host process
// reads /proc, a container can see neither the host's processes nor the docker
// daemon. Judging across that boundary would mean calling an owner dead because
// we cannot see it — which is how a data root ends up with two collectors.
describe('abandonment across collector runtimes', () => {
  const dockerOpts = (instanceId: string, containerName = 'agents-observe') =>
    testLockOptions({ runtime: 'docker', containerName, instanceId })

  function claimDocker(instanceId: string, container = 'agents-observe'): void {
    tryClaimLock(
      {
        lockDir: paths.lockDir,
        instanceId,
        entrypoint: '',
        dataRoot: root,
        pid: process.pid,
        runtime: 'docker',
        container,
      },
      dockerOpts(instanceId, container),
    )
  }

  it('records the runtime and container it was claimed by', () => {
    claimDocker('inst-docker')
    const lock = readLock(paths.lockDir)!
    expect(lock.runtime).toBe('docker')
    expect(lock.container).toBe('agents-observe')
  })

  it('never lets a container judge a host process abandoned', async () => {
    const child = fakeCollector()
    claimFor(child.pid!)
    killProcess(child)
    await waitForExit(child)
    // The process really is gone, and a host caller would say so...
    expect(lockIsAbandoned(paths.lockDir, testLockOptions())).toBe(true)
    // ...but a collector in a container has no way to know that.
    expect(lockIsAbandoned(paths.lockDir, dockerOpts('inst-docker'))).toBe(false)
  })

  it('never lets a host process judge a container abandoned', () => {
    claimDocker('inst-docker')
    // The host supervisor resolves this by asking docker; the TypeScript side,
    // which runs inside the collector, must not guess.
    expect(lockIsAbandoned(paths.lockDir, testLockOptions())).toBe(false)
  })

  it('lets a container reclaim an earlier run recorded under its own name', () => {
    claimDocker('an-earlier-run')
    // Docker allows one live container per name, so running *as* that container
    // is proof the earlier run under it has ended.
    expect(lockIsAbandoned(paths.lockDir, dockerOpts('this-run'))).toBe(true)
  })

  it('does not reclaim its own lock', () => {
    claimDocker('this-run')
    expect(lockIsAbandoned(paths.lockDir, dockerOpts('this-run'))).toBe(false)
  })

  it('does not reclaim a lock held by a different container', () => {
    claimDocker('an-earlier-run', 'some-other-container')
    expect(lockIsAbandoned(paths.lockDir, dockerOpts('this-run', 'agents-observe'))).toBe(false)
  })
})
