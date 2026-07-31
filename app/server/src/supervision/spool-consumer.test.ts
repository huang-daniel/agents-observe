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
  it('upgrades with pending and processing entries without loss or duplication', async () => {
    const root = makeDataRoot('spool-restart')
    roots.push(root)
    const store = new SqliteAdapter(':memory:')
    writeEntry(root, 'crash-replay')
    writeEntry(root, 'still-pending')
    const paths = runtimePaths(root)
    mkdirSync(join(paths.spoolDir, 'processing'), { recursive: true })
    renameSync(
      join(paths.spoolDir, 'pending/crash-replay.json'),
      join(paths.spoolDir, 'processing/crash-replay.json'),
    )

    const restarted = createSpoolConsumer({ dataRoot: root, store })
    await restarted.consumeOnce()

    expect(await count(store)).toBe(2)
    expect(restarted.stats()).toEqual({
      lastCommittedEventId: 'still-pending',
      spoolPending: 0,
      spoolFailed: 0,
      spoolLastFailure: null,
    })
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

  it('normalizes raw hook entries with the same fields as the old CLI path', async () => {
    const root = makeDataRoot('spool-hook-parity')
    roots.push(root)
    const store = new SqliteAdapter(':memory:')
    const pending = join(runtimePaths(root).spoolDir, 'pending')
    mkdirSync(pending, { recursive: true })
    writeFileSync(
      join(pending, 'raw-hook.json'),
      JSON.stringify({
        timestamp: 1_700_000_000_000,
        rawHook: {
          agentClass: 'codex',
          projectSlug: 'parity-project',
          notificationOnEvents: 'Notification',
          maxImageDataChars: '4',
          payload: {
            hook_event_name: 'SessionStart',
            session_id: 'raw-session',
            agent_id: 'raw-agent',
            cwd: '/repo',
            timestamp: 1_700_000_000_123,
            model: 'gpt-5',
            tool_response: [{ type: 'image', source: { type: 'base64', data: 'abcdef' } }],
          },
        },
      }),
    )

    const consumer = createSpoolConsumer({ dataRoot: root, store })
    await consumer.consumeOnce()
    const [event] = await store.getEventsForSession('raw-session')
    expect(event).toMatchObject({
      agent_id: 'raw-agent',
      hook_name: 'SessionStart',
      timestamp: 1_700_000_000_123,
      cwd: '/repo',
    })
    expect(JSON.parse(event.payload)).toMatchObject({
      tool_response: [{ source: { data: '[REDACTED]' } }],
    })
    expect(JSON.parse(event._meta!)).toMatchObject({
      project: { slug: 'parity-project' },
      codex: { model: 'gpt-5' },
    })
  })

  it.each(['claude-code', 'codex'])(
    'broadcasts committed %s spool events and stopped-session state live',
    async (agentClass) => {
      const root = makeDataRoot(`spool-live-${agentClass}`)
      roots.push(root)
      const store = new SqliteAdapter(':memory:')
      const pending = join(runtimePaths(root).spoolDir, 'pending')
      mkdirSync(pending, { recursive: true })
      writeFileSync(
        join(pending, `${agentClass}-end.json`),
        JSON.stringify({
          timestamp: 1_700_000_000_000,
          envelope: {
            agentId: `${agentClass}-agent`,
            sessionId: `${agentClass}-session`,
            hookName: 'SessionEnd',
            agentClass,
            flags: { stopsSession: true },
            payload: {},
          },
        }),
      )
      const sessionBroadcasts: Array<{ sessionId: string; message: any }> = []
      const activities: Array<{ sessionId: string; eventId: number; projectId: number | null }> = []
      const allBroadcasts: any[] = []

      const consumer = createSpoolConsumer({
        dataRoot: root,
        store,
        broadcastToSession: (sessionId, message) => sessionBroadcasts.push({ sessionId, message }),
        broadcastActivity: (sessionId, eventId, projectId) =>
          activities.push({ sessionId, eventId, projectId }),
        broadcastToAll: (message) => allBroadcasts.push(message),
      })
      await consumer.consumeOnce()

      expect(sessionBroadcasts).toEqual([
        expect.objectContaining({
          sessionId: `${agentClass}-session`,
          message: expect.objectContaining({ type: 'event' }),
        }),
      ])
      expect(activities).toEqual([
        expect.objectContaining({
          sessionId: `${agentClass}-session`,
          eventId: expect.any(Number),
        }),
      ])
      expect(allBroadcasts).toContainEqual({
        type: 'session_update',
        data: { id: `${agentClass}-session`, status: 'stopped' },
      })
      expect((await store.getSessionById(`${agentClass}-session`)).stopped_at).toEqual(
        expect.any(Number),
      )
    },
  )

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
    expect(consumer.stats()).toMatchObject({
      spoolFailed: 1,
      spoolLastFailure: { eventId: 'will-fail', type: 'Error', reason: 'disk full' },
    })
    expect(existsSync(join(runtimePaths(root).spoolDir, 'failed/will-fail.json'))).toBe(true)
  })
})
