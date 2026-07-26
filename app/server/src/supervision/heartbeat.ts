// app/server/src/supervision/heartbeat.ts
//
// The collector heartbeat, mirroring
// `hooks/scripts/supervision/lib/observe-heartbeat.sh`.
//
// The heartbeat answers a question the lock cannot: the collector process is
// alive, but is it still *working*? A wedged collector holds its lock and its
// PID perfectly while serving nothing. So the collector republishes the
// heartbeat on a timer, and a heartbeat older than the grace window means
// unhealthy even though the process is up.
//
// The heartbeat carries the same instanceId as the lock. Without that binding a
// heartbeat left behind by a previous collector — or published by a second
// collector that lost the lock race — would keep the current lock looking
// healthy. Fresh is not enough; it has to be fresh *and* ours.
//
// FILE FORMAT — one `key=value` per line, not JSON. The shell reader shipped in
// `observe-heartbeat.sh` parses lines, so a JSON file would be unreadable to
// `observe-health.sh` and the two implementations would stop agreeing. The
// field *set* is the one the supervision plan specifies; `/api/health` renders
// exactly these fields as JSON, which is where a JSON shape belongs.

import { renameSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { isUint, nowEpoch, pathMtime } from './paths'

/** Bump when the field set changes in a way readers must notice. */
export const HEARTBEAT_SCHEMA_VERSION = 1

/**
 * Age reported for a heartbeat that does not exist or cannot be parsed. Larger
 * than any sane grace window, so "missing" always compares as "not fresh".
 */
export const HEARTBEAT_AGE_UNKNOWN = 999999

export interface HeartbeatRecord {
  schemaVersion: number
  pid: number
  instanceId: string
  startedAt: number
  updatedAt: number
  databaseHealthy: boolean
  httpHealthy: boolean
  /** Wired in when the spool lands; `null` until then. */
  lastCommittedEventId: number | null
  /** Wired in when the spool lands; `null` until then. */
  spoolPending: number | null
}

function encode(record: HeartbeatRecord): string {
  return (
    [
      `schemaVersion=${record.schemaVersion}`,
      `instanceId=${record.instanceId}`,
      `pid=${record.pid}`,
      `startedAt=${record.startedAt}`,
      `updatedAt=${record.updatedAt}`,
      `databaseHealthy=${record.databaseHealthy}`,
      `httpHealthy=${record.httpHealthy}`,
      `lastCommittedEventId=${record.lastCommittedEventId ?? ''}`,
      `spoolPending=${record.spoolPending ?? ''}`,
    ].join('\n') + '\n'
  )
}

/**
 * Publish a heartbeat. Written to a temp file and renamed so a reader never
 * sees a half-written record. Returns false rather than throwing: a heartbeat
 * that cannot be written is a health signal, not a reason to crash the server.
 */
export function publishHeartbeat(path: string, record: HeartbeatRecord): boolean {
  const tmp = `${path}.tmp.${process.pid}`
  try {
    writeFileSync(tmp, encode(record))
    renameSync(tmp, path)
    return true
  } catch {
    try {
      unlinkSync(tmp)
    } catch {
      // nothing to clean up
    }
    return false
  }
}

/** All `key=value` pairs in the heartbeat, or `null` when there is no file. */
export function readHeartbeat(path: string): Record<string, string> | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const fields: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    fields[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return fields
}

/**
 * Age of the heartbeat in seconds, or `null` when it cannot be determined.
 * Prefers the embedded `updatedAt` (survives copies and filesystems with coarse
 * timestamps) and falls back to mtime.
 */
export function heartbeatAge(path: string): number | null {
  const fields = readHeartbeat(path)
  if (!fields) return null
  let stamp: number | null = null
  if (isUint(fields.updatedAt ?? '')) {
    stamp = Number(fields.updatedAt)
  } else {
    stamp = pathMtime(path)
  }
  if (stamp === null) return null
  const age = nowEpoch() - stamp
  // A clock step backwards must not read as a huge age; clamp the impossible
  // side to 0.
  return age < 0 ? 0 : age
}

/** The heartbeat's instanceId, or `''` when there is no readable heartbeat. */
export function heartbeatInstanceId(path: string): string {
  return readHeartbeat(path)?.instanceId ?? ''
}

/**
 * Remove the heartbeat only when it is still ours. A heartbeat republished by a
 * successor must survive this instance's shutdown, exactly like the lock.
 */
export function removeHeartbeatIfOwner(path: string, instanceId: string): boolean {
  if (!instanceId) return false
  if (heartbeatInstanceId(path) !== instanceId) return false
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}
