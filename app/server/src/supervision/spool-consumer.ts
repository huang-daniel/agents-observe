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
import type { EventEnvelope, ParsedEvent } from '../types'
import { validateEnvelope } from '../parser'
import type { EventStore } from '../storage/types'
import { DuplicateSpoolEventIdError } from '../storage/types'
import { resolveProject } from '../services/project-resolver'
import { endAgentSession, noteAgentActivity } from '../consumer-tracker'
import { runtimePaths, SUPPORTED_SPOOL_SCHEMAS } from './paths'

interface RawHookEntry {
  agentClass?: string
  projectSlug?: string
  notificationOnEvents?: string | null
  maxImageDataChars?: string
  payload: Record<string, unknown>
}

export interface SpoolStats {
  lastCommittedEventId: string | null
  spoolPending: number
  spoolFailed: number
  spoolLastFailure: SpoolFailure | null
}

export interface SpoolFailure {
  eventId: string
  type: string
  reason: string
}

export interface SpoolConsumerOptions {
  dataRoot: string
  store: EventStore
  /** Failed entries move aside after this many unsuccessful commits. */
  maxAttempts?: number
  pollIntervalMs?: number
  onStats?: (stats: SpoolStats) => void
  broadcastToSession?: (sessionId: string, message: object) => void
  broadcastToAll?: (message: object) => void
  broadcastActivity?: (sessionId: string, eventId: number, projectId: number | null) => void
}

interface SpoolEntry {
  eventId?: string
  spoolSchemaVersion?: number
  envelope?: EventEnvelope
  rawHook?: RawHookEntry
  timestamp: number
  attempts?: number
  failureType?: string
  failureReason?: string
}

/** An entry for a newer/unknown spool protocol. It may become consumable after an upgrade. */
export class UnsupportedSpoolSchemaError extends Error {
  readonly failureType = 'unsupported-spool-schema'

  constructor(version: unknown) {
    super(
      `spool schema version ${String(version)} is not supported (supported: ${SUPPORTED_SPOOL_SCHEMAS.join(', ')})`,
    )
    this.name = 'UnsupportedSpoolSchemaError'
  }
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
  let spoolLastFailure: SpoolFailure | null = null
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
      spoolFailed: eventFiles(failed).length,
      spoolLastFailure,
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
    const normalized = validateEnvelope(await entryEnvelope(entry))
    const { envelope } = normalized
    const timestamp = normalized.timestamp
    const sessionHints = envelope._meta?.session
    const agentHints = envelope._meta?.agent
    // A session that is producing events counts as a consumer, so the idle
    // auto-shutdown cannot pull the collector out from under a working agent
    // that has no dashboard tab open. See consumer-tracker.ts.
    if (envelope.hookName === 'SessionEnd') {
      endAgentSession(envelope.sessionId)
    } else {
      noteAgentActivity(envelope.sessionId)
    }

    const sessionBefore = await options.store.getSessionById(envelope.sessionId)
    await options.store.upsertSession(
      envelope.sessionId,
      sessionBefore?.project_id ?? null,
      sessionHints?.slug ?? null,
      sessionHints?.metadata ?? null,
      timestamp,
      sessionHints?.transcriptPath ?? null,
      sessionHints?.startCwd ?? null,
    )
    const session = await options.store.getSessionById(envelope.sessionId)
    const resolvedProjectId = await resolveProject(options.store, {
      sessionId: envelope.sessionId,
      meta: envelope._meta?.project,
      flags: envelope.flags,
      startCwd: session?.start_cwd ?? null,
      transcriptPath: session?.transcript_path ?? null,
      currentProjectId: session?.project_id ?? null,
    })
    if (resolvedProjectId !== null && resolvedProjectId !== session?.project_id) {
      await options.store.updateSessionProject(envelope.sessionId, resolvedProjectId)
    }
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
      const inserted = await options.store.insertEvent({
        agentId: envelope.agentId,
        sessionId: envelope.sessionId,
        hookName: envelope.hookName,
        timestamp,
        payload: envelope.payload,
        cwd: envelope.cwd ?? null,
        _meta: (envelope._meta as Record<string, unknown> | undefined) ?? null,
        spoolEventId: eventId,
      })
      const flags = envelope.flags ?? {}
      const wasPending = session?.pending_notification_ts ?? null
      let pendingTransition: 'set' | 'cleared' | 'none' = 'none'
      if (flags.clearsNotification) {
        await options.store.clearSessionNotification(envelope.sessionId)
        if (wasPending !== null) pendingTransition = 'cleared'
      }
      if (flags.startsNotification) {
        await options.store.startSessionNotification(envelope.sessionId, timestamp)
        if (wasPending === null || pendingTransition === 'cleared') pendingTransition = 'set'
      }
      if (flags.stopsSession) {
        await options.store.stopSession(envelope.sessionId, timestamp)
      }

      const event: ParsedEvent = {
        id: inserted.eventId,
        agentId: envelope.agentId,
        sessionId: envelope.sessionId,
        hookName: envelope.hookName,
        timestamp,
        cwd: envelope.cwd ?? null,
        _meta: (envelope._meta as Record<string, unknown> | undefined) ?? null,
        payload: envelope.payload,
      }
      options.broadcastToSession?.(envelope.sessionId, { type: 'event', data: event })
      const broadcastProjectId =
        resolvedProjectId ?? (session?.project_id as number | null | undefined) ?? null
      options.broadcastActivity?.(envelope.sessionId, inserted.eventId, broadcastProjectId)
      if (flags.stopsSession) {
        options.broadcastToAll?.({
          type: 'session_update',
          data: { id: envelope.sessionId, status: 'stopped' },
        })
      }
      if (pendingTransition === 'set') {
        const sessionAfter = await options.store.getSessionById(envelope.sessionId)
        options.broadcastToAll?.({
          type: 'notification',
          data: {
            sessionId: envelope.sessionId,
            projectId: resolvedProjectId ?? sessionAfter?.project_id ?? null,
            ts: timestamp,
          },
        })
      } else if (pendingTransition === 'cleared') {
        options.broadcastToAll?.({
          type: 'notification_clear',
          data: { sessionId: envelope.sessionId, ts: timestamp },
        })
      }
    } catch (error) {
      if (error instanceof DuplicateSpoolEventIdError) return
      throw error
    }
  }

  async function entryEnvelope(entry: SpoolEntry): Promise<EventEnvelope> {
    // Entries written before negotiation had no version. They were always
    // envelope records, so retain that replay path indefinitely.
    const schemaVersion =
      entry.spoolSchemaVersion ?? (entry.envelope ? 1 : entry.rawHook ? 2 : undefined)
    if (!SUPPORTED_SPOOL_SCHEMAS.includes(schemaVersion as 1 | 2)) {
      throw new UnsupportedSpoolSchemaError(schemaVersion)
    }
    if (schemaVersion === 1 && !entry.envelope) {
      throw new UnsupportedSpoolSchemaError(schemaVersion)
    }
    if (schemaVersion === 2 && !entry.rawHook) {
      throw new UnsupportedSpoolSchemaError(schemaVersion)
    }
    if (entry.envelope) return entry.envelope
    if (!entry.rawHook?.payload) throw new Error('spool entry has no envelope or raw hook payload')

    // This is intentionally the same registry used by observe_cli's old
    // per-hook path. The collector loads it once, rather than spawning Node
    // for every lifecycle event.
    const agents = await import('../../../../hooks/scripts/lib/agents/index.mjs')
    const configured = entry.rawHook.agentClass
    const agentClass = agents.getAgentClass({ agentClass: configured }, null, entry.rawHook.payload)
    const notificationOnEvents =
      entry.rawHook.notificationOnEvents == null
        ? undefined
        : entry.rawHook.notificationOnEvents
            .split(',')
            .map((name) => name.trim())
            .filter(Boolean)
    const maxImageDataChars = Number.parseInt(entry.rawHook.maxImageDataChars ?? '50000', 10)
    const config = {
      agentClass,
      projectSlug: entry.rawHook.projectSlug || null,
      notificationOnEvents,
      maxImageDataChars: Number.isNaN(maxImageDataChars) ? 50000 : maxImageDataChars,
    }
    const log = { debug() {}, trace() {}, info() {}, warn() {}, error() {} }
    const lib = agents.getAgentLib(agentClass)

    // Keep the old hook's image redaction behavior before building its envelope.
    const payload = structuredClone(entry.rawHook.payload)
    const response = payload.tool_response
    if (config.maxImageDataChars > 0 && Array.isArray(response)) {
      for (const item of response) {
        if (!item || typeof item !== 'object' || item.type !== 'image') continue
        const source = item.source
        if (
          source &&
          typeof source === 'object' &&
          source.type === 'base64' &&
          typeof source.data === 'string' &&
          source.data.length > config.maxImageDataChars
        ) {
          source.data = '[REDACTED]'
        }
      }
    }
    return lib.buildHookEvent(config, log, payload).envelope as EventEnvelope
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
          let rawEntry: string | null = null
          try {
            rawEntry = readFileSync(processingPath, 'utf8')
            entry = JSON.parse(rawEntry) as SpoolEntry
          } catch {
            // Invalid data cannot become valid on retry; preserve it for inspection.
          }
          const attempts = (entry?.attempts ?? 0) + 1
          const failureType =
            error instanceof UnsupportedSpoolSchemaError ? error.failureType : 'spool-commit-error'
          const failureReason = error instanceof Error ? error.message : String(error)
          if (entry) {
            entry.attempts = attempts
            entry.failureType = failureType
            entry.failureReason = failureReason
            writeFileSync(processingPath, JSON.stringify(entry) + '\n')
          } else if (existsSync(processingPath)) {
            // Even invalid JSON must leave a useful forensic record when it is
            // dead-lettered; the original bytes remain available in `rawEntry`.
            writeFileSync(
              processingPath,
              JSON.stringify({
                attempts,
                failureType: 'invalid-spool-entry',
                failureReason,
                rawEntry,
              }) + '\n',
            )
          }
          if (entry && attempts < maxAttempts) {
            renameSync(processingPath, pendingPath)
          } else if (existsSync(processingPath)) {
            spoolLastFailure = {
              eventId,
              type: error instanceof Error ? error.name : 'UnknownError',
              reason: error instanceof Error ? error.message : String(error),
            }
            renameSync(processingPath, join(failed, name))
          }
          // A failed entry must not stop later pending work.
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
