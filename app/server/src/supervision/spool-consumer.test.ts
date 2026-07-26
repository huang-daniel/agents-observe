import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SqliteAdapter } from '../storage/sqlite-adapter'
import type { EventStore } from '../storage/types'
import { runtimePaths } from './paths'
import { createSpoolConsumer } from './spool-consumer'
import { makeDataRoot, removeDataRoot } from './test-support'

const roots: string[] = []
afterEach(() => {
  while (roots.length) removeDataRoot(roots.pop())
})

function writeEntry(root: string, eventId: string, attempts = 0): void {
  const pending = join(runtimePaths(root).spoolDir, 'pending')
  mkdirSync(pending, { recursive: true })
  writeFileSync(
    join(pending, `${eventId}.json`),
    JSON.stringify({
      timestamp: 1_700_000_000_000,
      attempts,
      envelope: {
        agentId: 'agent-1',
        sessionId: 'session-1',
        hookName: 'PostToolUse',
        agentClass: 'claude-code',
        payload: { tool_name: 'Read' },
      },
    }),
  )
}

function count(store: EventStore): Promise<number> {
  return store.getEventsForSession('session-1').then((events) => events.length)
}

describe('spool consumer', () => {
  it('recovers a processing entry after a consumer crash and commits it once', async () => {
    const root = makeDataRoot('spool-restart')
    roots.push(root)
    const store = new SqliteAdapter(':memory:')
    writeEntry(root, 'crash-replay')
    const paths = runtimePaths(root)
    mkdirSync(join(paths.spoolDir, 'processing'), { recursive: true })
    renameSync(
      join(paths.spoolDir, 'pending/crash-replay.json'),
      join(paths.spoolDir, 'processing/crash-replay.json'),
    )

    const restarted = createSpoolConsumer({ dataRoot: root, store })
    await restarted.consumeOnce()

    expect(await count(store)).toBe(1)
    expect(restarted.stats()).toEqual({ lastCommittedEventId: 'crash-replay', spoolPending: 0 })
  })

  it('uses the SQLite spool-event unique constraint when replayed twice', async () => {
    const root = makeDataRoot('spool-idempotent')
    roots.push(root)
    const store = new SqliteAdapter(':memory:')
    writeEntry(root, 'same-event')
    const consumer = createSpoolConsumer({ dataRoot: root, store })
    await consumer.consumeOnce()
    // Recreate the durable entry exactly as a post-commit crash would leave it.
    writeEntry(root, 'same-event')
    await consumer.consumeOnce()

    expect(await count(store)).toBe(1)
    expect(consumer.stats().lastCommittedEventId).toBe('same-event')
  })

  it('moves repeatedly failing entries to failed and keeps consuming', async () => {
    const root = makeDataRoot('spool-failed')
    roots.push(root)
    const realStore = new SqliteAdapter(':memory:')
    const store = new Proxy(realStore, {
      get(target, property, receiver) {
        if (property === 'insertEvent') return async () => Promise.reject(new Error('disk full'))
        return Reflect.get(target, property, receiver)
      },
    }) as EventStore
    writeEntry(root, 'will-fail')
    const consumer = createSpoolConsumer({ dataRoot: root, store, maxAttempts: 2 })
    await consumer.consumeOnce()
    await consumer.consumeOnce()

    expect(consumer.stats().spoolPending).toBe(0)
    expect(existsSync(join(runtimePaths(root).spoolDir, 'failed/will-fail.json'))).toBe(true)
  })
})
