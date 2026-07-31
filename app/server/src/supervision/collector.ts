// app/server/src/supervision/collector.ts
//
// Collector lifecycle: claim the singleton lock at startup, republish the
// heartbeat while running, and release both on the way out — but only ever
// release what this instance still owns.
//
// The single most important rule here: a stale or replaced collector's
// shutdown must never remove a successor's lock. If the lock no longer names
// this instance, shutdown touches nothing at all.

import { randomUUID } from 'node:crypto'
import { config } from '../config'
import {
  COLLECTOR_SUPPORTED_SPOOL_SCHEMAS,
  HEARTBEAT_SCHEMA_VERSION,
  publishHeartbeat,
  removeHeartbeatIfOwner,
} from './heartbeat'
import { collectorHealth } from './health'
import type { CollectorHealthStatus } from './health'
import {
  LOCK_FILES,
  lockIsAbandoned,
  lockOwnedBy,
  releaseLockIfPidOwner,
  removeLock,
  tryClaimLock,
} from './lock'
import type { LockOptions } from './lock'
import {
  alignOwnerWithDataRoot,
  ensureRuntimeDir,
  nowEpoch,
  resolveDataRoot,
  runtimePaths,
} from './paths'
import type { RuntimePaths } from './paths'
import { pidHasMarker } from './process-identity'

/** Exit code used when the supervision configuration itself is unusable. */
export const EXIT_SUPERVISION_CONFIG = 2
/**
 * Exit code used when another live collector already owns this data root.
 *
 * The behaviour is deliberately deterministic and impatient: the second
 * collector refuses immediately. It does not wait, retry, or take the lock
 * away. Waiting would leave two half-started collectors racing whenever the
 * first one is slow, and the caller that wants a restart has an explicit path
 * for it (stop the running collector, or use a different data root).
 */
export const EXIT_LOCK_HELD = 3

/** Thrown when a live, identity-matched owner already holds the lock. */
export class CollectorLockHeldError extends Error {
  constructor(readonly lockDir: string) {
    super(`collector lock already held by a live owner: ${lockDir}`)
    this.name = 'CollectorLockHeldError'
  }
}

export interface CollectorProbe {
  databaseHealthy: boolean
  httpHealthy: boolean
}

export interface SupervisionOptions {
  dataRoot?: string
  instanceId?: string
  pid?: number
  entrypointMarker?: string
  heartbeatIntervalMs?: number
  graceSeconds?: number
  settleSeconds?: number
  procRoot?: string
  /** Sampled on every heartbeat tick. Defaults to "everything is fine". */
  probe?: () => Promise<CollectorProbe> | CollectorProbe
  /** Set the OS process title to the entrypoint marker. Off in tests. */
  setProcessTitle?: boolean
  log?: (message: string) => void
}

/** The `/api/health` view of this collector: heartbeat fields plus the predicate. */
export interface CollectorStatus {
  schemaVersion: number
  instanceId: string
  pid: number
  dataRoot: string
  startedAt: number
  updatedAt: number | null
  databaseHealthy: boolean
  httpHealthy: boolean
  lastCommittedEventId: string | null
  spoolPending: number | null
  spoolFailed: number | null
  spoolLastFailure: { eventId: string; type: string; reason: string } | null
  collectorSupportedSpoolSchemas: readonly number[]
  collectorBuildId: string
  status: CollectorHealthStatus
  reason: string | null
  heartbeatAgeSeconds: number | null
}

export interface CollectorSupervision {
  readonly instanceId: string
  readonly pid: number
  readonly paths: RuntimePaths
  readonly startedAt: number
  /** Claim the lock. Throws `CollectorLockHeldError` when refused. */
  claim(): void
  /** Publish one heartbeat now. */
  publish(): Promise<boolean>
  startHeartbeat(): void
  stopHeartbeat(): void
  /** Update the durable spool values published in heartbeat and /api/health. */
  setSpoolStats(stats: {
    lastCommittedEventId: string | null
    spoolPending: number
    spoolFailed: number
    spoolLastFailure: { eventId: string; type: string; reason: string } | null
  }): void
  /** Release heartbeat + lock, but only if this instance still owns them. */
  release(): boolean
  status(): CollectorStatus
}

function lockOptions(
  opts: Required<Pick<SupervisionOptions, 'procRoot' | 'settleSeconds'>> & {
    instanceId: string
  },
): LockOptions {
  return {
    procRoot: opts.procRoot,
    settleSeconds: opts.settleSeconds,
    instanceId: opts.instanceId,
  }
}

export function createCollectorSupervision(options: SupervisionOptions = {}): CollectorSupervision {
  const log = options.log ?? ((message: string) => console.log(message))
  const pid = options.pid ?? process.pid
  const instanceId = options.instanceId || config.supervision.instanceId || randomUUID()
  const marker = options.entrypointMarker ?? config.supervision.entrypointMarker
  const procRoot = options.procRoot ?? config.supervision.procRoot
  const settleSeconds = options.settleSeconds ?? config.supervision.lockSettleSeconds
  const graceSeconds = options.graceSeconds ?? config.supervision.healthGraceSeconds
  const intervalMs = options.heartbeatIntervalMs ?? config.supervision.heartbeatIntervalMs
  const probe = options.probe ?? (() => ({ databaseHealthy: true, httpHealthy: true }))

  const dataRoot = resolveDataRoot([
    options.dataRoot,
    config.supervision.dataRoot,
    config.supervision.localDataRoot,
    config.supervision.homeDir ? `${config.supervision.homeDir}/.agents-observe` : undefined,
  ])
  const paths = runtimePaths(dataRoot)
  const locking = lockOptions({ procRoot, settleSeconds, instanceId })
  const startedAt = nowEpoch()

  let timer: ReturnType<typeof setInterval> | null = null
  let ticking = false
  let released = false
  let updatedAt: number | null = null
  let lastProbe: CollectorProbe = { databaseHealthy: false, httpHealthy: false }
  let spoolStats = {
    lastCommittedEventId: null as string | null,
    spoolPending: 0,
    spoolFailed: 0,
    spoolLastFailure: null as { eventId: string; type: string; reason: string } | null,
  }

  if (options.setProcessTitle && marker) {
    // Gives the live process a stable, greppable identity. It is deliberately
    // not the full command line: argv changes across restarts, and matching it
    // whole would make every ordinary restart look like an impostor.
    process.title = marker
  }

  function claim(): void {
    ensureRuntimeDir(paths)
    // Record the marker only when this process really carries it. Where the
    // platform will not surface a process title (so the marker never reaches
    // the command line), recording it anyway would make every later health
    // check report `entrypoint-mismatch` forever. An empty entrypoint is the
    // shell kernel's documented "skip this leg" value.
    const entrypoint = marker && pidHasMarker(pid, marker, locking) ? marker : ''
    const spec = {
      lockDir: paths.lockDir,
      instanceId,
      entrypoint,
      dataRoot,
      pid,
    }

    if (tryClaimLock(spec, locking)) return alignOwnership()

    // The only lock we may take away is one whose owner is provably gone.
    // Age is never evidence — that decision belongs entirely to
    // `lockIsAbandoned`, which mirrors `observe_collector_lock_is_abandoned`.
    if (lockIsAbandoned(paths.lockDir, locking)) {
      log(`[supervision] Reclaiming abandoned collector lock at ${paths.lockDir}`)
      removeLock(paths.lockDir)
      if (tryClaimLock(spec, locking)) return alignOwnership()
    }

    throw new CollectorLockHeldError(paths.lockDir)
  }

  /**
   * Keep supervision state owned by whoever owns the data root.
   *
   * A collector started as root writes a root-owned lock directory inside a
   * user-owned tree, and the user's supervisor can never reclaim it once that
   * collector is gone — `rmdir` needs write access to the lock directory
   * itself. A no-op wherever the two identities already agree.
   */
  function alignOwnership(): void {
    alignOwnerWithDataRoot(paths.lockDir, dataRoot, LOCK_FILES)
  }

  async function publish(): Promise<boolean> {
    const sampled = await probe()
    lastProbe = sampled
    const at = nowEpoch()
    const ok = publishHeartbeat(paths.heartbeatFile, {
      schemaVersion: HEARTBEAT_SCHEMA_VERSION,
      pid,
      instanceId,
      startedAt,
      updatedAt: at,
      databaseHealthy: sampled.databaseHealthy,
      httpHealthy: sampled.httpHealthy,
      lastCommittedEventId: spoolStats.lastCommittedEventId,
      spoolPending: spoolStats.spoolPending,
      collectorSupportedSpoolSchemas: COLLECTOR_SUPPORTED_SPOOL_SCHEMAS,
      collectorBuildId: config.version,
    })
    if (ok) {
      updatedAt = at
      alignOwnerWithDataRoot(paths.heartbeatFile, dataRoot)
    }
    return ok
  }

  function startHeartbeat(): void {
    if (timer) return
    void tick()
    timer = setInterval(tick, intervalMs)
    // The collector must never be the reason the process stays alive; the HTTP
    // server is.
    timer.unref?.()
  }

  async function tick(): Promise<void> {
    if (ticking) return
    ticking = true
    try {
      if (!(await publish())) {
        log(`[supervision] Failed to publish heartbeat at ${paths.heartbeatFile}`)
      }
    } catch (err) {
      log(`[supervision] Heartbeat tick failed: ${(err as Error).message}`)
    } finally {
      ticking = false
    }
  }

  function stopHeartbeat(): void {
    if (!timer) return
    clearInterval(timer)
    timer = null
  }

  function setSpoolStats(stats: typeof spoolStats): void {
    spoolStats = stats
  }

  function release(): boolean {
    stopHeartbeat()
    if (released) return false
    released = true

    // The whole invariant in one condition: if the lock is no longer ours, a
    // successor owns this data root and none of its state is ours to remove.
    if (!lockOwnedBy(paths.lockDir, instanceId, dataRoot)) {
      log(`[supervision] Lock at ${paths.lockDir} is no longer ours — leaving it untouched`)
      return false
    }

    removeHeartbeatIfOwner(paths.heartbeatFile, instanceId)
    return releaseLockIfPidOwner(paths.lockDir, pid)
  }

  function status(): CollectorStatus {
    const health = collectorHealth(paths, {
      ...locking,
      graceSeconds,
      expectedInstanceId: instanceId,
    })
    return {
      schemaVersion: HEARTBEAT_SCHEMA_VERSION,
      instanceId,
      pid,
      dataRoot,
      startedAt,
      updatedAt,
      databaseHealthy: lastProbe.databaseHealthy,
      httpHealthy: lastProbe.httpHealthy,
      lastCommittedEventId: spoolStats.lastCommittedEventId,
      spoolPending: spoolStats.spoolPending,
      spoolFailed: spoolStats.spoolFailed,
      spoolLastFailure: spoolStats.spoolLastFailure,
      collectorSupportedSpoolSchemas: COLLECTOR_SUPPORTED_SPOOL_SCHEMAS,
      collectorBuildId: config.version,
      status: health.status,
      reason: health.reason,
      heartbeatAgeSeconds: health.heartbeatAgeSeconds,
    }
  }

  return {
    instanceId,
    pid,
    paths,
    startedAt,
    claim,
    publish,
    startHeartbeat,
    stopHeartbeat,
    setSpoolStats,
    release,
    status,
  }
}

// ─── active instance ────────────────────────────────────────────────────────
//
// One collector per process, exposed the same way the consumer tracker and the
// WebSocket module expose their state, so routes can read it without threading
// it through `createApp`.

let active: CollectorSupervision | null = null

/**
 * Claim this data root and register the result as the process's collector.
 * Throws `CollectorLockHeldError` when a live owner already holds the lock.
 *
 * The heartbeat is deliberately *not* started here: the caller starts it once
 * the things it probes — the database, the HTTP listener — actually exist.
 */
export function claimCollectorSupervision(options: SupervisionOptions = {}): CollectorSupervision {
  const supervision = createCollectorSupervision({ setProcessTitle: true, ...options })
  supervision.claim()
  active = supervision
  return supervision
}

export function getActiveCollector(): CollectorSupervision | null {
  return active
}

/** `/api/health` view, or `null` when supervision is not running. */
export function getCollectorStatus(): CollectorStatus | null {
  return active ? active.status() : null
}

/** Test-only: forget the active instance without touching on-disk state. */
export function resetActiveCollectorForTests(): void {
  active = null
}
