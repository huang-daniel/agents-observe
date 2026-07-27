// test/hooks/scripts/supervision/docker-runtime.test.mjs
//
// The container half of the supervision contract. A collector running in the
// managed container cannot be identified by PID — that PID belongs to another
// namespace — so it is identified by the container name plus the instance id
// the container was labelled with. These tests exercise that substitution
// through the shipped shell code, with a stand-in docker CLI (see
// fixtures/fake-docker/docker) in place of a daemon.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runShell, runHealth, makeDataRoot, removeDataRoot, waitFor } from './helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const FAKE_DOCKER_DIR = resolve(here, 'fixtures/fake-docker')
const FAKE_NODE_DIR = resolve(here, 'fixtures/fake-node')

const CONTAINER = 'agents-observe-test'
const INSTANCE = 'inst-docker-1'

let root
let dockerLog

beforeEach(() => {
  root = makeDataRoot('observe-docker')
  dockerLog = join(root, 'docker-calls.log')
})

afterEach(() => {
  removeDataRoot(root)
})

/**
 * Env for a run that sees the stand-in docker CLI instead of the real one.
 * `running` and `instance` are what it reports for CONTAINER; `daemon: false`
 * makes it fail the way an unreachable daemon does, which is the "cannot
 * verify" case (identical to docker not being installed at all).
 */
function dockerEnv({ running = 'true', instance = INSTANCE, exists = true, daemon = true } = {}) {
  return {
    FAKE_DOCKER_CONTAINER: CONTAINER,
    FAKE_DOCKER_RUNNING: running,
    FAKE_DOCKER_INSTANCE: instance,
    FAKE_DOCKER_EXISTS: exists ? '1' : '0',
    FAKE_DOCKER_DAEMON: daemon ? '1' : '0',
    FAKE_DOCKER_LOG: dockerLog,
    AGENTS_OBSERVE_DOCKER_CONTAINER_NAME: CONTAINER,
    PATH: `${FAKE_DOCKER_DIR}:${process.env.PATH}`,
  }
}

const heartbeatPath = () => join(root, 'runtime/collector.heartbeat')

function writeHeartbeat({ instance = INSTANCE, ageSeconds = 0 } = {}) {
  mkdirSync(join(root, 'runtime'), { recursive: true })
  const updatedAt = Math.floor(Date.now() / 1000) - ageSeconds
  writeFileSync(heartbeatPath(), `instanceId=${instance}\npid=1\nupdatedAt=${updatedAt}\n`)
}

/** Claim a lock the way a collector inside the container does. */
async function claimDockerLock({ instance = INSTANCE, container = CONTAINER, env = {} } = {}) {
  return runShell(
    `observe_runtime_ensure &&
     observe_collector_lock_claim '${instance}' 1 '' '' docker '${container}'`,
    { dataRoot: root, lib: 'observe-heartbeat.sh', env },
  )
}

const dockerCalls = () => (existsSync(dockerLog) ? readFileSync(dockerLog, 'utf8').trim() : '')

describe('a lock claimed by a containerized collector', () => {
  it('records the runtime and container instead of relying on the PID', async () => {
    await claimDockerLock()
    const { stdout } = await runShell('observe_collector_lock_snapshot', {
      dataRoot: root,
      lib: 'observe-heartbeat.sh',
    })
    expect(stdout).toContain('runtime=docker')
    expect(stdout).toContain(`container=${CONTAINER}`)
    expect(stdout).toContain(`instance-id=${INSTANCE}`)
  })

  it('is removable by the kernel, so a stale one can still be reclaimed', async () => {
    await claimDockerLock()
    const { code } = await runShell('observe_lock_remove "$OBSERVE_LOCK"', {
      dataRoot: root,
      lib: 'observe-heartbeat.sh',
    })
    expect(code).toBe(0)
    expect(existsSync(join(root, 'runtime/collector.lock'))).toBe(false)
  })
})

describe('health of a containerized collector', () => {
  it('is healthy on a fresh heartbeat without asking docker at all', async () => {
    await claimDockerLock()
    writeHeartbeat()

    const { code } = await runShell('observe_collector_healthy', {
      dataRoot: root,
      lib: 'observe-heartbeat.sh',
      env: dockerEnv(),
    })

    expect(code).toBe(0)
    // The hook path runs this predicate on every single event. A fresh
    // heartbeat from the right instance already proves the collector is
    // working, so spending a docker subprocess to re-prove it would be a tax
    // on every hook.
    expect(dockerCalls()).toBe('')
  })

  it('reports a stale heartbeat as wedged while the container is still running', async () => {
    await claimDockerLock()
    writeHeartbeat({ ageSeconds: 120 })

    const { stdout, code } = await runShell(
      'observe_collector_healthy; printf "%s\\n" "$OBSERVE_HEALTH_REASON"',
      { dataRoot: root, lib: 'observe-heartbeat.sh', env: dockerEnv() },
    )

    expect(code).toBe(0) // the printf ran; the reason is the assertion
    expect(stdout.trim()).toBe('stale-heartbeat')
    expect(dockerCalls()).toContain('inspect')
  })

  it('reports a stopped container as a plain restartable fault', async () => {
    await claimDockerLock()
    writeHeartbeat({ ageSeconds: 120 })

    const { stdout } = await runShell(
      'observe_collector_healthy; printf "%s %s\\n" "$OBSERVE_HEALTH_STATUS" "$OBSERVE_HEALTH_REASON"',
      { dataRoot: root, lib: 'observe-heartbeat.sh', env: dockerEnv({ running: 'false' }) },
    )

    expect(stdout.trim()).toBe('unhealthy dead-container')
  })

  it('refuses to guess when the docker daemon cannot be reached', async () => {
    await claimDockerLock()
    writeHeartbeat({ ageSeconds: 120 })

    const { stdout } = await runShell(
      'observe_collector_healthy; printf "%s %s\\n" "$OBSERVE_HEALTH_STATUS" "$OBSERVE_HEALTH_REASON"',
      { dataRoot: root, lib: 'observe-heartbeat.sh', env: dockerEnv({ daemon: false }) },
    )

    // Not "unhealthy": a supervisor acting on that would start a second
    // collector next to a container that may be running perfectly well.
    expect(stdout.trim()).toBe('invalid-owner container-unverifiable')
  })

  it('treats a heartbeat from another instance as two collectors, not health', async () => {
    await claimDockerLock()
    writeHeartbeat({ instance: 'someone-else' })

    const { stdout } = await runShell(
      'observe_collector_healthy; printf "%s %s\\n" "$OBSERVE_HEALTH_STATUS" "$OBSERVE_HEALTH_REASON"',
      { dataRoot: root, lib: 'observe-heartbeat.sh', env: dockerEnv() },
    )

    expect(stdout.trim()).toBe('invalid-owner instance-mismatch')
  })

  it('rejects a docker lock with no container recorded', async () => {
    await claimDockerLock({ container: '' })
    writeHeartbeat()

    const { stdout } = await runShell(
      'observe_collector_healthy; printf "%s %s\\n" "$OBSERVE_HEALTH_STATUS" "$OBSERVE_HEALTH_REASON"',
      { dataRoot: root, lib: 'observe-heartbeat.sh', env: dockerEnv() },
    )

    expect(stdout.trim()).toBe('invalid-owner malformed-lock')
  })
})

describe('abandonment of a container lock', () => {
  it('is not abandoned while the container runs this instance', async () => {
    await claimDockerLock()
    const { code } = await runShell('observe_collector_lock_is_abandoned', {
      dataRoot: root,
      lib: 'observe-heartbeat.sh',
      env: dockerEnv(),
    })
    expect(code).toBe(1)
  })

  it('is abandoned once that container is gone', async () => {
    await claimDockerLock()
    const { code } = await runShell('observe_collector_lock_is_abandoned', {
      dataRoot: root,
      lib: 'observe-heartbeat.sh',
      env: dockerEnv({ exists: false }),
    })
    expect(code).toBe(0)
  })

  it('is abandoned when the container is running a different collector run', async () => {
    await claimDockerLock()
    const { code } = await runShell('observe_collector_lock_is_abandoned', {
      dataRoot: root,
      lib: 'observe-heartbeat.sh',
      env: dockerEnv({ instance: 'a-later-run' }),
    })
    expect(code).toBe(0)
  })

  it('is never abandoned merely because the daemon cannot be asked', async () => {
    await claimDockerLock()
    const { code } = await runShell('observe_collector_lock_is_abandoned', {
      dataRoot: root,
      lib: 'observe-heartbeat.sh',
      env: dockerEnv({ daemon: false }),
    })
    expect(code).toBe(1)
  })
})

describe('acting on a container lock', () => {
  it('stops the collector through docker rather than by signalling a PID', async () => {
    await claimDockerLock()

    const { code } = await runShell('observe_signal_locked_collector TERM', {
      dataRoot: root,
      lib: 'observe-heartbeat.sh',
      env: dockerEnv(),
    })

    expect(code).toBe(0)
    expect(dockerCalls()).toContain(`stop --time`)
    expect(dockerCalls()).toContain(CONTAINER)
  })

  it('refuses to stop a container that is no longer this collector run', async () => {
    await claimDockerLock()

    const { code } = await runShell('observe_signal_locked_collector TERM', {
      dataRoot: root,
      lib: 'observe-heartbeat.sh',
      env: dockerEnv({ instance: 'a-later-run' }),
    })

    expect(code).not.toBe(0)
    expect(dockerCalls()).not.toContain('stop')
  })
})

describe('the health diagnostic', () => {
  it('names the container, because the recorded PID means nothing on this host', async () => {
    await claimDockerLock()
    writeHeartbeat()

    const { stdout, code } = await runHealth(root, { env: dockerEnv() })

    expect(code).toBe(0)
    expect(stdout).toContain(`collector: healthy container=${CONTAINER}`)
    expect(stdout).not.toContain('pid=')
  })
})

describe('runtime resolution', () => {
  it('picks the local runtime when the server dependencies are installed', async () => {
    const { stdout } = await runShell('observe_resolved_runtime', {
      dataRoot: root,
      lib: 'observe-env.sh',
    })
    // This checkout has app/server/node_modules; that is what `auto` keys off.
    expect(stdout.trim()).toBe('local')
  })

  it('falls back to docker when there is no installed server to run', async () => {
    const emptyRoot = makeDataRoot('observe-no-deps')
    mkdirSync(join(emptyRoot, 'app/server'), { recursive: true })
    try {
      const { stdout } = await runShell('observe_resolved_runtime', {
        dataRoot: root,
        lib: 'observe-env.sh',
        env: { OBSERVE_ROOT: emptyRoot },
      })
      expect(stdout.trim()).toBe('docker')
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true })
    }
  })

  it('honours an explicit runtime override', async () => {
    const { stdout } = await runShell('observe_resolved_runtime', {
      dataRoot: root,
      lib: 'observe-env.sh',
      env: { AGENTS_OBSERVE_COLLECTOR_RUNTIME: 'docker' },
    })
    expect(stdout.trim()).toBe('docker')
  })
})

describe('starting a containerized collector', () => {
  it('hands the container start to the CLI, naming the run it must become', async () => {
    const nodeLog = join(root, 'node-calls.log')

    const { stdout, code } = await runShell('observe_spawn_collector', {
      dataRoot: root,
      lib: '../observe-lifecycle.sh',
      env: {
        ...dockerEnv(),
        AGENTS_OBSERVE_COLLECTOR_RUNTIME: 'docker',
        FAKE_NODE_LOG: nodeLog,
        PATH: `${FAKE_NODE_DIR}:${FAKE_DOCKER_DIR}:${process.env.PATH}`,
      },
    })

    expect(code).toBe(0)
    const token = stdout.trim()
    expect(token).not.toBe('')

    await waitFor(() => existsSync(nodeLog))
    const call = readFileSync(nodeLog, 'utf8')
    // One implementation of "run the container" — the CLI's — driven by the one
    // supervisor. The instance id is generated here, before the container
    // exists, so it can be labelled with it and recognised afterwards.
    expect(call).toContain('observe_cli.mjs start')
    expect(call).toContain(`instance=${token}`)
    expect(call).toContain(`data-root=${root}`)
  })
})
