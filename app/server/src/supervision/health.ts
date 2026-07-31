// app/server/src/supervision/health.ts
//
// The canonical collector health predicate, mirroring
// `observe_collector_healthy` in
// `hooks/scripts/supervision/lib/observe-heartbeat.sh`.
//
// Read-only: it inspects, it never signals, removes a lock, or writes a file.
//
// Healthy means ALL of:
//   the lock exists
//   AND the lock belongs to this data root
//   AND its PID is alive
//   AND the live process identity matches the recorded identity
//   AND the live process carries the recorded entrypoint marker
//   AND the heartbeat's instanceId matches the lock's
//   AND the heartbeat is within the grace window
//
// The shell predicate has one more leg — an HTTP check against
// `AGENTS_OBSERVE_HEALTH_URL`. There is nothing to check here: this predicate
// runs inside the process that serves that endpoint, so a caller reading the
// answer over HTTP has already exercised the leg.

import type { RuntimePaths } from './paths'
import { heartbeatAge, heartbeatInstanceId } from './heartbeat'
import { isPid, pidAlive, pidHasMarker, pidIdentity } from './process-identity'
import { readLock } from './lock'
import type { LockOptions } from './lock'

export type CollectorHealthStatus = 'healthy' | 'absent' | 'unhealthy' | 'invalid-owner'

export interface CollectorHealth {
  status: CollectorHealthStatus
  reason: string | null
  pid: number | null
  heartbeatAgeSeconds: number | null
  instanceId: string | null
}

export interface HealthOptions extends LockOptions {
  /** Heartbeat freshness window, in seconds. */
  graceSeconds: number
  /**
   * The instance asking. When set, a lock held by a *different* instance is an
   * ownership hazard even if that other instance looks healthy — a state the
   * shell predicate cannot see, because it has no caller identity.
   */
  expectedInstanceId?: string
}

/**
 * Exit-code mapping shared with `observe-health.sh`: 0 healthy, 1 absent or
 * unhealthy (a supervisor may start or restart), 2 an unsafe ownership state a
 * supervisor must not act on blindly.
 */
export function healthExitCode(status: CollectorHealthStatus): 0 | 1 | 2 {
  if (status === 'healthy') return 0
  if (status === 'invalid-owner') return 2
  return 1
}

export function collectorHealth(paths: RuntimePaths, opts: HealthOptions): CollectorHealth {
  const absent: CollectorHealth = {
    status: 'absent',
    reason: null,
    pid: null,
    heartbeatAgeSeconds: null,
    instanceId: null,
  }

  const lock = readLock(paths.lockDir)
  if (!lock) return absent

  const base = {
    pid: isPid(lock.pid) ? Number(lock.pid) : null,
    instanceId: lock.instanceId || null,
  }
  const fail = (
    status: CollectorHealthStatus,
    reason: string,
    heartbeatAgeSeconds: number | null = null,
  ): CollectorHealth => ({ status, reason, heartbeatAgeSeconds, ...base })

  // A lock recorded against a different data root is an ownership hazard, not
  // a restartable fault: something is supervising across namespaces.
  if (lock.dataRoot && lock.dataRoot !== paths.dataRoot) {
    return fail('invalid-owner', 'data-root-mismatch')
  }

  if (!isPid(lock.pid) || !lock.identity) {
    return fail('invalid-owner', 'malformed-lock')
  }
  const pid = Number(lock.pid)

  // A dead PID is a plain fault: the collector went away and a supervisor may
  // restart it. Nothing else has claimed the identity, so it is not a hazard.
  if (!pidAlive(pid)) {
    return fail('unhealthy', 'dead-pid')
  }

  // From here the PID is alive but may not be ours. Everything below is an
  // ownership hazard.
  const live = pidIdentity(pid, opts)
  if (!live || live !== lock.identity) {
    return fail('invalid-owner', 'pid-identity-mismatch')
  }
  if (lock.entrypoint && !pidHasMarker(pid, lock.entrypoint, opts)) {
    return fail('invalid-owner', 'entrypoint-mismatch')
  }

  return heartbeatHealth(paths, opts, lock.instanceId, fail, base)
}

/**
 * The last legs: the collector may be alive, but is it still *working*, and is
 * the thing reporting that the same collector the lock names?
 */
function heartbeatHealth(
  paths: RuntimePaths,
  opts: HealthOptions,
  lockInstanceId: string,
  fail: (
    status: CollectorHealthStatus,
    reason: string,
    heartbeatAgeSeconds?: number | null,
  ) => CollectorHealth,
  base: Pick<CollectorHealth, 'pid' | 'instanceId'>,
): CollectorHealth {
  const age = heartbeatAge(paths.heartbeatFile)
  if (age === null) {
    return fail('unhealthy', 'missing-heartbeat')
  }

  // A fresh heartbeat from a different instance is worse than no heartbeat:
  // two collectors are alive in one data root.
  const beatInstance = heartbeatInstanceId(paths.heartbeatFile)
  if (!beatInstance || !lockInstanceId || beatInstance !== lockInstanceId) {
    return fail('invalid-owner', 'instance-mismatch', age)
  }

  if (age >= opts.graceSeconds) {
    return fail('unhealthy', 'stale-heartbeat', age)
  }

  // Last, because the shell predicate cannot express it: everything above says
  // *a* collector is healthy here, but if it is not us, our view of this data
  // root is stale and acting on it would be unsafe.
  if (opts.expectedInstanceId && lockInstanceId !== opts.expectedInstanceId) {
    return fail('invalid-owner', 'instance-mismatch', age)
  }

  return { status: 'healthy', reason: null, heartbeatAgeSeconds: age, ...base }
}
