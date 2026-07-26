// Durable spool consumer. The hook does not write this spool until the next
// rollout step; keeping this isolated makes crash recovery testable now.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { EventEnvelope } from '../types'
import type { EventStore } from '../storage/types'
import { DuplicateSpoolEventIdError } from '../storage/types'
import { runtimePaths } from './paths'

export interface SpoolStats {
  lastCommittedEventId: string | null
  spoolPending: number
}

export interface SpoolConsumerOptions {
  dataRoot: string
  store: EventStore
  /** Failed entries move aside after this many unsuccessful commits. */
  maxAttempts?: number
  pollIntervalMs?: number
  onStats?: (stats: SpoolStats) => void
}

interface SpoolEntry {
  eventId?: string
  envelope: EventEnvelope
  timestamp: number
  attempts?: number
}

export interface SpoolConsumer {
  consumeOnce(): Promise<void>
  start(): void
  stop(): void
  stats(): SpoolStats
}

function eventFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
  } catch {
    return []
  }
}

export function createSpoolConsumer(options: SpoolConsumerOptions): SpoolConsumer {
  const paths = runtimePaths(options.dataRoot)
  const spool = paths.spoolDir
  const pending = join(spool, 'pending')
  const processing = join(spool, 'processing')
  const failed = join(spool, 'failed')
  const maxAttempts = options.maxAttempts ?? 3
  const pollIntervalMs = options.pollIntervalMs ?? 250
  let lastCommittedEventId: string | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let consuming = false

  function ensureDirs(): void {
    mkdirSync(pending, { recursive: true })
    mkdirSync(processing, { recursive: true })
    mkdirSync(failed, { recursive: true })
  }

  function currentStats(): SpoolStats {
    return {
      lastCommittedEventId,
      spoolPending: eventFiles(pending).length + eventFiles(processing).length,
    }
  }

  function report(): void {
    options.onStats?.(currentStats())
  }

  function recoverProcessing(): void {
    for (const name of eventFiles(processing)) {
      renameSync(join(processing, name), join(pending, name))
    }
  }

  async function commit(eventId: string, entry: SpoolEntry): Promise<void> {
    const { envelope } = entry
    const sessionHints = envelope._meta?.session
    const agentHints = envelope._meta?.agent
    await options.store.upsertSession(
      envelope.sessionId,
      null,
      sessionHints?.slug ?? null,
      sessionHints?.metadata ?? null,
      entry.timestamp,
      sessionHints?.transcriptPath ?? null,
      sessionHints?.startCwd ?? null,
    )
    await options.store.upsertAgent(
      envelope.agentId,
      envelope.sessionId,
      null,
      agentHints?.name ?? null,
      agentHints?.description ?? null,
      agentHints?.type ?? null,
      envelope.agentClass,
    )
    try {
      await options.store.insertEvent({
        agentId: envelope.agentId,
        sessionId: envelope.sessionId,
        hookName: envelope.hookName,
        timestamp: entry.timestamp,
        payload: envelope.payload,
        cwd: envelope.cwd ?? null,
        _meta: (envelope._meta as Record<string, unknown> | undefined) ?? null,
        spoolEventId: eventId,
      })
    } catch (error) {
      if (error instanceof DuplicateSpoolEventIdError) return
      throw error
    }
  }

  async function consumeOnce(): Promise<void> {
    if (consuming) return
    consuming = true
    try {
      ensureDirs()
      // A process dying after the pending -> processing rename has not made a
      // commit promise. Put those entries back before taking fresh work.
      recoverProcessing()
      report()
      for (const name of eventFiles(pending)) {
        const eventId = name.slice(0, -'.json'.length)
        const pendingPath = join(pending, name)
        const processingPath = join(processing, name)
        try {
          renameSync(pendingPath, processingPath)
        } catch {
          continue
        }
        report()
        try {
          const entry = JSON.parse(readFileSync(processingPath, 'utf8')) as SpoolEntry
          if (entry.eventId && entry.eventId !== eventId) {
            throw new Error(`spool event id does not match filename: ${eventId}`)
          }
          await commit(eventId, entry)
          lastCommittedEventId = eventId
          rmSync(processingPath)
        } catch (error) {
          let entry: SpoolEntry | null = null
          try {
            entry = JSON.parse(readFileSync(processingPath, 'utf8')) as SpoolEntry
          } catch {
            // Invalid data cannot become valid on retry; preserve it for inspection.
          }
          const attempts = (entry?.attempts ?? 0) + 1
          if (entry && attempts < maxAttempts) {
            entry.attempts = attempts
            writeFileSync(processingPath, JSON.stringify(entry) + '\n')
            renameSync(processingPath, pendingPath)
          } else if (existsSync(processingPath)) {
            renameSync(processingPath, join(failed, name))
          }
          // A failed entry must not stop later pending work.
          void error
        }
        report()
      }
    } finally {
      consuming = false
      report()
    }
  }

  function start(): void {
    if (timer) return
    void consumeOnce()
    timer = setInterval(() => void consumeOnce(), pollIntervalMs)
    timer.unref?.()
  }

  function stop(): void {
    if (!timer) return
    clearInterval(timer)
    timer = null
  }

  ensureDirs()
  report()
  return { consumeOnce, start, stop, stats: currentStats }
}
