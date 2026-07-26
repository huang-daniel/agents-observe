import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'

import {
  HEARTBEAT_SCHEMA_VERSION,
  heartbeatAge,
  heartbeatInstanceId,
  publishHeartbeat,
  readHeartbeat,
  removeHeartbeatIfOwner,
} from './heartbeat'
import { ensureRuntimeDir, nowEpoch, runtimePaths } from './paths'
import { REPO_ROOT, makeDataRoot, removeDataRoot } from './test-support'

const execFileAsync = promisify(execFile)

let root: string
let paths: ReturnType<typeof runtimePaths>

beforeEach(() => {
  root = makeDataRoot('observe-heartbeat-ts')
  paths = runtimePaths(root)
  ensureRuntimeDir(paths)
})

afterEach(() => removeDataRoot(root))

function record(overrides: Partial<Parameters<typeof publishHeartbeat>[1]> = {}) {
  return {
    schemaVersion: HEARTBEAT_SCHEMA_VERSION,
    pid: process.pid,
    instanceId: 'inst-1',
    startedAt: nowEpoch(),
    updatedAt: nowEpoch(),
    databaseHealthy: true,
    httpHealthy: true,
    lastCommittedEventId: null,
    spoolPending: null,
    ...overrides,
  }
}

/** Read a field the way observe-heartbeat.sh does, from a real bash process. */
async function shellField(key: string): Promise<string> {
  const lib = `${REPO_ROOT}/hooks/scripts/supervision/lib/observe-heartbeat.sh`
  const script = `set -u
. '${lib}'
observe_env_init || exit 2
observe_heartbeat_field ${key} || exit 1`
  const { stdout } = await execFileAsync('bash', ['-c', script], {
    env: { ...process.env, AGENTS_OBSERVE_DATA_ROOT: root },
  })
  return stdout.trim()
}

describe('publishHeartbeat', () => {
  it('writes every field the supervision plan specifies', () => {
    expect(publishHeartbeat(paths.heartbeatFile, record())).toBe(true)
    const fields = readHeartbeat(paths.heartbeatFile)!
    expect(Object.keys(fields).sort()).toEqual(
      [
        'databaseHealthy',
        'httpHealthy',
        'instanceId',
        'lastCommittedEventId',
        'pid',
        'schemaVersion',
        'spoolPending',
        'startedAt',
        'updatedAt',
      ].sort(),
    )
    expect(fields.instanceId).toBe('inst-1')
    expect(fields.databaseHealthy).toBe('true')
    // Reserved for the spool; empty until it lands.
    expect(fields.lastCommittedEventId).toBe('')
    expect(fields.spoolPending).toBe('')
  })

  it('stays readable by the shell primitive that ships with the kernel', async () => {
    publishHeartbeat(paths.heartbeatFile, record({ instanceId: 'inst-shell' }))
    expect(await shellField('instanceId')).toBe('inst-shell')
    expect(await shellField('updatedAt')).toMatch(/^\d+$/)
  })

  it('leaves no temp file behind', () => {
    publishHeartbeat(paths.heartbeatFile, record())
    expect(existsSync(`${paths.heartbeatFile}.tmp.${process.pid}`)).toBe(false)
    expect(readFileSync(paths.heartbeatFile, 'utf8').endsWith('\n')).toBe(true)
  })

  it('reports failure rather than throwing when the path is unwritable', () => {
    const unwritable = `${root}/does/not/exist/collector.heartbeat`
    expect(publishHeartbeat(unwritable, record())).toBe(false)
  })
})

describe('heartbeatAge', () => {
  it('is null when there is no heartbeat', () => {
    expect(heartbeatAge(paths.heartbeatFile)).toBeNull()
    expect(heartbeatInstanceId(paths.heartbeatFile)).toBe('')
  })

  it('uses the embedded updatedAt', () => {
    publishHeartbeat(paths.heartbeatFile, record({ updatedAt: nowEpoch() - 120 }))
    expect(heartbeatAge(paths.heartbeatFile)).toBeGreaterThanOrEqual(120)
  })

  it('falls back to mtime when updatedAt is unusable', () => {
    writeFileSync(paths.heartbeatFile, 'instanceId=inst-1\nupdatedAt=not-a-number\n')
    expect(heartbeatAge(paths.heartbeatFile)).toBeGreaterThanOrEqual(0)
  })

  it('clamps a backwards clock step to zero rather than reading as fresh forever', () => {
    publishHeartbeat(paths.heartbeatFile, record({ updatedAt: nowEpoch() + 600 }))
    expect(heartbeatAge(paths.heartbeatFile)).toBe(0)
  })
})

describe('removeHeartbeatIfOwner', () => {
  it('removes our own heartbeat', () => {
    publishHeartbeat(paths.heartbeatFile, record({ instanceId: 'inst-1' }))
    expect(removeHeartbeatIfOwner(paths.heartbeatFile, 'inst-1')).toBe(true)
    expect(existsSync(paths.heartbeatFile)).toBe(false)
  })

  it('leaves a successor heartbeat alone', () => {
    publishHeartbeat(paths.heartbeatFile, record({ instanceId: 'inst-2' }))
    expect(removeHeartbeatIfOwner(paths.heartbeatFile, 'inst-1')).toBe(false)
    expect(existsSync(paths.heartbeatFile)).toBe(true)
  })
})
