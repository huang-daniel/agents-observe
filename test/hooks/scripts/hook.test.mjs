import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MARKER,
  makeDataRoot,
  removeDataRoot,
  runShell,
  spawnFakeProcess,
  killProcess,
  waitFor,
} from './supervision/helpers.mjs'

const execFileAsync = promisify(execFile)
const HOOK = resolve(process.cwd(), 'hooks/scripts/hook.sh')
const ARM_FIXTURE = resolve(
  process.cwd(),
  'test/hooks/scripts/supervision/fixtures/fake-collector.sh',
)
const roots = []
const children = []

afterEach(async () => {
  for (const root of roots) {
    await runShell('observe_signal_locked_process TERM || true', { dataRoot: root })
  }
  while (children.length) killProcess(children.pop())
  while (roots.length) removeDataRoot(roots.pop())
})

async function runHook(root, env = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'bash',
      [HOOK],
      {
        env: {
          ...process.env,
          AGENTS_OBSERVE_DATA_ROOT: root,
          AGENTS_OBSERVE_HEALTH_URL: '',
          AGENTS_OBSERVE_COLLECTOR_ENTRYPOINT: ARM_FIXTURE,
          AGENTS_OBSERVE_START_TIMEOUT: '3',
          AGENTS_OBSERVE_START_POLL: '0.05',
          ...env,
        },
      },
      (error) => (error ? reject(error) : resolve()),
    )
    child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'hook-session' }))
  })
}

function pendingEntry(root) {
  const dir = join(root, 'runtime/spool/pending')
  const [name] = readdirSync(dir).filter((file) => file.endsWith('.json'))
  return JSON.parse(readFileSync(join(dir, name), 'utf8'))
}

describe('hook.sh spool-first delivery', () => {
  it('writes a raw hook to the spool without arming an already healthy collector', async () => {
    const root = makeDataRoot('hook-healthy')
    roots.push(root)
    const owner = spawnFakeProcess(MARKER)
    children.push(owner)
    await runShell(
      `observe_runtime_ensure && observe_collector_lock_claim healthy-instance ${owner.pid} && observe_heartbeat_publish healthy-instance ${owner.pid}`,
      { dataRoot: root },
    )
    appendFileSync(
      join(root, 'runtime/collector.heartbeat'),
      'collectorSupportedSpoolSchemas=1,2\n',
    )

    await runHook(root, {
      AGENTS_OBSERVE_AGENT_CLASS: 'codex',
      AGENTS_OBSERVE_PROJECT_SLUG: 'hook-proj',
    })

    expect(pendingEntry(root)).toMatchObject({
      rawHook: {
        agentClass: 'codex',
        projectSlug: 'hook-proj',
        payload: { hook_event_name: 'SessionStart', session_id: 'hook-session' },
      },
    })
    expect(existsSync(join(root, 'runtime/collector-lifecycle.log'))).toBe(false)
  })

  it('uses a schema-1 envelope with a healthy previous-generation collector', async () => {
    const root = makeDataRoot('hook-rolling-upgrade')
    roots.push(root)
    // This live marked process and pre-negotiation heartbeat model the
    // collector generation that only understood fully normalized envelopes.
    const previousCollector = spawnFakeProcess(MARKER)
    children.push(previousCollector)
    await runShell(
      `observe_runtime_ensure && observe_collector_lock_claim previous-generation ${previousCollector.pid} && observe_heartbeat_publish previous-generation ${previousCollector.pid}`,
      { dataRoot: root },
    )

    await runHook(root, { AGENTS_OBSERVE_AGENT_CLASS: 'codex' })

    const entry = pendingEntry(root)
    expect(entry).toMatchObject({
      spoolSchemaVersion: 1,
      envelope: {
        sessionId: 'hook-session',
        hookName: 'SessionStart',
        agentClass: 'codex',
      },
    })
    expect(entry.rawHook).toBeUndefined()
    expect(readdirSync(join(root, 'runtime/spool/failed'))).toEqual([])
  })

  it('arms the collector after spooling when its health predicate is false', async () => {
    const root = makeDataRoot('hook-unhealthy')
    roots.push(root)

    await runHook(root)

    await waitFor(() => existsSync(join(root, 'runtime/collector.lock')), { timeoutMs: 5_000 })
    expect(pendingEntry(root).rawHook.payload).toMatchObject({ session_id: 'hook-session' })
  })
})
