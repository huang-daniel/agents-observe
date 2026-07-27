// app/server/src/supervision/lock.ts
//
// The collector singleton lock, mirroring
// `hooks/scripts/supervision/lib/observe-lock.sh`.
//
// A claim is made in two stages, and there is no check-then-write
// (`existsSync() && writeFile()`) anywhere — that pattern has a race wide
// enough to drive a truck through.
//
//   1. `mkdir` creates the lock directory. mkdir(2) either creates or fails
//      with EEXIST, with no window in between.
//   2. The owner is then claimed by opening `pid` with `wx` — O_CREAT|O_EXCL.
//      Exactly one process can win that, and the winner's PID is what the file
//      holds.
//
// Stage 2 is not belt-and-braces: `mkdir` on the shell side is whatever
// `/usr/bin/mkdir` the host ships, and not every one of those is race-correct.
// Both implementations therefore settle ownership with an O_EXCL create.
//
// A lock is ABANDONED only when its recorded process is provably gone: no
// usable PID, a dead PID, or a live PID whose identity no longer matches what
// was recorded. Age is never evidence — a healthy collector that has been up
// for a week holds a week-old lock.

import {
  closeSync,
  mkdirSync,
  openSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { isDirectory, nowEpoch, pathMtime, readLine } from './paths'
import { isPid, pidAlive, pidExecutable, pidHasMarker, pidIdentity } from './process-identity'
import type { IdentityOptions } from './process-identity'

/** Every file this module writes into a lock directory. */
export const LOCK_FILES = [
  'pid',
  'pid-identity',
  'executable',
  'entrypoint',
  'data-root',
  'instance-id',
  'started-at',
  'runtime',
  'container',
] as const

/**
 * Which kind of thing a lock's owner is. `local` is a process on this host,
 * identified by PID identity; `docker` is the managed container, identified by
 * its name plus the instance id it was labelled with. Locks written before the
 * docker runtime existed have no `runtime` file and were always processes.
 */
export type CollectorRuntime = 'local' | 'docker'

export interface LockSnapshot {
  pid: string
  identity: string
  executable: string
  entrypoint: string
  dataRoot: string
  instanceId: string
  startedAt: string
  runtime: CollectorRuntime
  container: string
}

export interface ClaimSpec {
  lockDir: string
  instanceId: string
  entrypoint: string
  dataRoot: string
  pid: number
  runtime?: CollectorRuntime
  container?: string
}

export interface LockOptions extends IdentityOptions {
  /**
   * Seconds a just-created lock directory is given to finish writing its owner
   * files. Inside this window a lock with no PID yet is treated as live, not
   * abandoned, so a competing acquirer cannot delete a lock mid-claim.
   */
  settleSeconds: number
  /** The runtime the *caller* runs in. Defaults to `local`. */
  runtime?: CollectorRuntime
  /** The caller's container name, when it runs in one. */
  containerName?: string
  /** The caller's instance id — one collector *run*, not one container. */
  instanceId?: string
}

/** Read the lock directory, or `null` when there is no lock at all. */
export function readLock(lockDir: string): LockSnapshot | null {
  if (!isDirectory(lockDir)) return null
  return {
    pid: readLine(`${lockDir}/pid`),
    identity: readLine(`${lockDir}/pid-identity`),
    executable: readLine(`${lockDir}/executable`),
    entrypoint: readLine(`${lockDir}/entrypoint`),
    dataRoot: readLine(`${lockDir}/data-root`),
    instanceId: readLine(`${lockDir}/instance-id`),
    startedAt: readLine(`${lockDir}/started-at`),
    runtime: readLine(`${lockDir}/runtime`) === 'docker' ? 'docker' : 'local',
    container: readLine(`${lockDir}/container`),
  }
}

/** Stage 2 of a claim: create `pid` with O_CREAT|O_EXCL. Exactly one winner. */
function claimPid(lockDir: string, pid: number): boolean {
  try {
    const fd = openSync(`${lockDir}/pid`, 'wx')
    try {
      writeSync(fd, `${pid}\n`)
    } finally {
      closeSync(fd)
    }
    return true
  } catch {
    return false
  }
}

/**
 * Fill in everything the lock records besides the owning PID. The readback is
 * not paranoia: on a full or read-only filesystem the writes can fail quietly
 * enough to leave a lock whose owner cannot be verified later.
 */
function writeDetails(spec: ClaimSpec, opts: LockOptions): boolean {
  const identity = pidIdentity(spec.pid, opts)
  if (!identity) return false
  const exe = pidExecutable(spec.pid, opts)
  try {
    writeFileSync(`${spec.lockDir}/executable`, `${exe}\n`)
    writeFileSync(`${spec.lockDir}/entrypoint`, `${spec.entrypoint}\n`)
    writeFileSync(`${spec.lockDir}/data-root`, `${spec.dataRoot}\n`)
    writeFileSync(`${spec.lockDir}/instance-id`, `${spec.instanceId}\n`)
    writeFileSync(`${spec.lockDir}/runtime`, `${spec.runtime ?? 'local'}\n`)
    writeFileSync(`${spec.lockDir}/container`, `${spec.container ?? ''}\n`)
    writeFileSync(`${spec.lockDir}/started-at`, `${nowEpoch()}\n`)
    // Written last: the shell treats a lock with a PID but no identity as
    // "still being claimed", so identity is what completes the record.
    writeFileSync(`${spec.lockDir}/pid-identity`, `${identity}\n`)
  } catch {
    return false
  }
  return readLine(`${spec.lockDir}/pid`) === String(spec.pid)
}

/**
 * One full claim attempt: create the directory, win the PID, record the
 * details, then confirm the lock still names us. The final confirmation matters
 * because a concurrent reclaim could have removed our lock between stages;
 * failing here is correct and safe — the caller simply did not get the lock.
 */
export function tryClaimLock(spec: ClaimSpec, opts: LockOptions): boolean {
  if (!spec.lockDir || !spec.instanceId || !isPid(spec.pid)) return false

  try {
    mkdirSync(spec.lockDir)
  } catch {
    // EEXIST is the ordinary case; anything else shows up as a failed claim
    // below when the directory turns out not to be there.
  }
  if (!isDirectory(spec.lockDir)) return false

  if (!claimPid(spec.lockDir, spec.pid)) return false
  if (!writeDetails(spec, opts)) {
    releaseLockIfPidOwner(spec.lockDir, spec.pid)
    return false
  }
  return readLine(`${spec.lockDir}/pid`) === String(spec.pid)
}

/**
 * Remove a lock directory and only the files this kernel writes into it.
 * `rmdir` fails if anything unexpected is inside, which is the behaviour we
 * want: never recursively delete a directory whose contents we do not
 * recognise.
 */
export function removeLock(lockDir: string): boolean {
  if (!lockDir) return false
  if (!isDirectory(lockDir)) return true
  for (const name of LOCK_FILES) {
    try {
      unlinkSync(`${lockDir}/${name}`)
    } catch {
      // already gone
    }
  }
  try {
    rmdirSync(lockDir)
    return true
  } catch {
    return false
  }
}

/**
 * True while a lock is young enough that a claim could still be finishing its
 * writes. An unreadable mtime counts as settling: refusing to reclaim leaves a
 * stuck lock a human can clear, while reclaiming a lock mid-claim produces two
 * collectors — the failure this whole module exists to prevent.
 */
export function lockIsSettling(lockDir: string, opts: LockOptions): boolean {
  const created = pathMtime(lockDir)
  if (created === null) return true
  return nowEpoch() - created < opts.settleSeconds
}

/**
 * True only when the process recorded in the lock is still that same process:
 * a usable PID, alive, whose live identity equals the recorded identity (this
 * is what catches PID reuse) and which carries the recorded entrypoint marker
 * (this is what catches an unrelated process that merely happens to be alive).
 */
export function processMatchesLock(lockDir: string, opts: LockOptions): boolean {
  const lock = readLock(lockDir)
  if (!lock) return false
  if (!isPid(lock.pid)) return false
  const pid = Number(lock.pid)
  if (!pidAlive(pid)) return false
  if (!lock.identity) return false
  const live = pidIdentity(pid, opts)
  if (!live || live !== lock.identity) return false
  if (lock.entrypoint && !pidHasMarker(pid, lock.entrypoint, opts)) return false
  return true
}

/**
 * True when a lock directory exists but its recorded owner is provably gone.
 *
 * **Abandonment is only ever judged within one runtime.** A collector can only
 * apply the proof its own runtime gives it: a host process reads `/proc` for
 * PID identity, and a container can see neither the host's processes nor the
 * docker daemon. Judging across that boundary would mean calling an owner dead
 * because we cannot see it — which is how a data root ends up with two
 * collectors. A cross-runtime lock is therefore never abandoned here; the host
 * supervisor (`observe_lock_is_abandoned`), which can ask docker, resolves it.
 *
 * Within the docker runtime the proof is the container name: docker allows at
 * most one live container per name, so a collector running *as* that container
 * knows any earlier instance recorded under it has ended.
 */
export function lockIsAbandoned(lockDir: string, opts: LockOptions): boolean {
  const lock = readLock(lockDir)
  if (!lock) return false

  const callerRuntime = opts.runtime ?? 'local'
  if (lock.runtime !== callerRuntime) return false

  if (lock.runtime === 'docker') {
    if (!lock.container || !lock.instanceId) return !lockIsSettling(lockDir, opts)
    if (lock.container !== (opts.containerName ?? '')) return false
    return lock.instanceId !== opts.instanceId
  }

  if (!isPid(lock.pid) || !lock.identity) {
    // An incomplete record: either a claim still in progress (leave it alone)
    // or one that died mid-write (reclaimable once the settle window passes).
    return !lockIsSettling(lockDir, opts)
  }
  return !processMatchesLock(lockDir, opts)
}

/**
 * Release a lock whose recorded PID is ours. A lock recording somebody else's
 * PID is left alone: releasing another process's lock is how a supervisor
 * deletes the singleton out from under a healthy collector.
 */
export function releaseLockIfPidOwner(lockDir: string, pid: number): boolean {
  if (!lockDir) return false
  if (!isDirectory(lockDir)) return true
  if (readLine(`${lockDir}/pid`) !== String(pid)) return false
  return removeLock(lockDir)
}

/**
 * True when the lock belongs to `instanceId` AND to this data root. The data
 * root check keeps a lock copied or bind-mounted from another instance from
 * being mistaken for ours.
 */
export function lockOwnedBy(lockDir: string, instanceId: string, dataRoot: string): boolean {
  if (!instanceId) return false
  const lock = readLock(lockDir)
  if (!lock) return false
  if (lock.instanceId !== instanceId) return false
  if (lock.dataRoot !== dataRoot) return false
  return true
}
