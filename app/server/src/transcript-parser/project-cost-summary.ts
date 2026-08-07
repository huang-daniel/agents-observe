import { promises as fs } from 'node:fs'
import type { EventStore } from '../storage/types'
import { config } from '../config'
import { parseSessionTranscripts } from './index'

export interface ProjectCostSummary {
  projectId: number
  inputTokens: number
  outputTokens: number
  /** null when any contributing session has usage on a model with no
   *  known pricing — same "unknown, not zero" convention as the
   *  per-session summary's costTotalCents. */
  costCents: number | null
  sessionsTotal: number
  /** Sessions that actually contributed token data (supported agent
   *  class, readable transcript, at least one call). */
  sessionsWithUsage: number
  hasData: boolean
  cachedAt: number
}

const TTL_MS = 60 * 1000

const cache = new Map<number, { data: ProjectCostSummary; fetchedAt: number }>()
const inFlight = new Map<number, Promise<ProjectCostSummary>>()

/**
 * Per-project cost/token aggregate, summed across every session's
 * transcript-stats. Cached in-memory per project (TTL_MS) so the
 * constellation view's polling doesn't re-parse every session's full
 * transcript on every render — mirrors the pricing cache pattern in
 * models-pricing.ts.
 */
export async function getProjectCostSummary(
  projectId: number,
  store: EventStore,
): Promise<ProjectCostSummary> {
  const now = Date.now()
  const cached = cache.get(projectId)
  if (cached && now - cached.fetchedAt < TTL_MS) {
    return cached.data
  }

  const pending = inFlight.get(projectId)
  if (pending) return pending

  const promise = computeProjectCostSummary(projectId, store)
    .then((data) => {
      cache.set(projectId, { data, fetchedAt: Date.now() })
      return data
    })
    .finally(() => {
      inFlight.delete(projectId)
    })
  inFlight.set(projectId, promise)
  return promise
}

async function computeProjectCostSummary(
  projectId: number,
  store: EventStore,
): Promise<ProjectCostSummary> {
  const sessions = await store.getSessionsForProject(projectId)
  let inputTokens = 0
  let outputTokens = 0
  let costCents: number | null = 0
  let sessionsWithUsage = 0

  for (const session of sessions as any[]) {
    const sessionId = session.id
    const transcriptPath = await store.getSessionTranscriptPath(sessionId)
    if (!transcriptPath) continue

    let stat
    try {
      stat = await fs.stat(transcriptPath)
    } catch {
      continue
    }
    if (stat.size > config.transcriptStats.maxFileBytes) continue

    let stats
    try {
      stats = await parseSessionTranscripts(sessionId, store, transcriptPath)
    } catch {
      continue
    }
    // Unsupported agent class or a main-transcript parse failure —
    // skip the session rather than folding in a misleading zero.
    if (stats.errors.some((e) => e.scope === 'main')) continue
    if (stats.summary.totalCalls === 0) continue

    sessionsWithUsage += 1
    inputTokens += stats.summary.inputTotal
    outputTokens += stats.summary.outputTotal
    if (stats.summary.costTotalCents == null) {
      costCents = null
    } else if (costCents !== null) {
      costCents += stats.summary.costTotalCents
    }
  }

  return {
    projectId,
    inputTokens,
    outputTokens,
    costCents,
    sessionsTotal: sessions.length,
    sessionsWithUsage,
    hasData: sessionsWithUsage > 0,
    cachedAt: Date.now(),
  }
}

/** Test-only: clear the cache and any in-flight computations. */
export function _testResetProjectCostSummaryCache(): void {
  cache.clear()
  inFlight.clear()
}
