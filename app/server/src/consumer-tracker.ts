// app/server/src/consumer-tracker.ts
// Tracks who is currently using this collector, with TTL-based expiry, and
// shuts the collector down once nobody is.
//
// A "consumer" is anything that would notice the collector going away. There
// are two kinds:
//
//   - dashboard clients, counted by the WebSocket module
//   - agent sessions, registered here every time an event of theirs is stored
//
// The second kind is why this file still exists after the plugin's MCP process
// was retired. That process existed mainly to boot the server, but its
// heartbeat had a second job: it kept the collector alive while an agent was
// working and no browser tab was open. Keying auto-shutdown off dashboard
// clients alone would let the collector exit mid-session and be re-armed by the
// next hook, over and over. Events would survive that — they are spooled
// durably — but the restart churn is real, so the signal is preserved rather
// than dropped: an agent that is producing events *is* a consumer.
//
// Session entries expire on their own (`sessionActivityTtlMs`), so a session
// that dies without a SessionEnd cannot pin the collector alive forever.

import { getClientCount } from './websocket'
import { config } from './config'

interface Consumer {
  lastSeen: number
  ttlMs: number
}

const consumers = new Map<string, Consumer>()
const startedAt = Date.now()
const autoShutdownEnabled = config.shutdownDelayMs > 0

let sweepTimer: ReturnType<typeof setInterval> | null = null
let shutdownTimer: ReturnType<typeof setTimeout> | null = null

if (!autoShutdownEnabled) {
  console.log('[consumer] Auto-shutdown is disabled (AGENTS_OBSERVE_SHUTDOWN_DELAY_MS <= 0)')
} else {
  console.log(
    `[consumer] Auto-shutdown is enabled (AGENTS_OBSERVE_SHUTDOWN_DELAY_MS=${config.shutdownDelayMs})`,
  )
}

/** Session consumers are namespaced so they can never collide with other ids. */
function sessionKey(sessionId: string): string {
  return `session:${sessionId}`
}

/** Start the periodic sweep that evicts stale consumers. */
export function startConsumerSweep() {
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    const now = Date.now()
    for (const [id, consumer] of consumers) {
      if (now - consumer.lastSeen > consumer.ttlMs) {
        consumers.delete(id)
        console.log(`[consumer] Evicted stale consumer ${id}`)
      }
    }
    checkShutdown()
  }, config.sweepIntervalMs)
}

/** Register or refresh a consumer heartbeat. Returns current consumer count. */
export function heartbeat(id: string, ttlMs: number = config.consumerTtlMs): number {
  consumers.set(id, { lastSeen: Date.now(), ttlMs })
  cancelPendingShutdown()
  return consumers.size
}

/**
 * An agent session just had an event stored. Both delivery paths call this —
 * the durable spool consumer and the legacy HTTP events route — so the signal
 * does not depend on how the event arrived.
 */
export function noteAgentActivity(sessionId: string): void {
  if (!sessionId) return
  heartbeat(sessionKey(sessionId), config.sessionActivityTtlMs)
}

/**
 * A session ended. Dropping it immediately is what lets the collector wind down
 * promptly after the last agent stops, rather than waiting out the TTL.
 */
export function endAgentSession(sessionId: string): void {
  if (!sessionId) return
  if (!consumers.delete(sessionKey(sessionId))) return
  checkShutdown()
}

/** Remove a consumer. Returns { activeConsumers, activeClients }. */
export function deregister(id: string): { activeConsumers: number; activeClients: number } {
  consumers.delete(id)
  const counts = { activeConsumers: consumers.size, activeClients: getClientCount() }
  checkShutdown()
  return counts
}

/** Current consumer count. */
export function getConsumerCount(): number {
  return consumers.size
}

/** Called when a new WS client connects — cancel any pending shutdown. */
export function cancelPendingShutdown() {
  if (shutdownTimer) {
    clearTimeout(shutdownTimer)
    shutdownTimer = null
    console.log('[consumer] Shutdown cancelled — consumer or client reconnected')
  }
}

/** Check if the server should shut down (no consumers, no WS clients). */
export function checkShutdown() {
  // If anyone is still connected, cancel any pending shutdown
  if (consumers.size > 0 || getClientCount() > 0) {
    cancelPendingShutdown()
    return
  }

  // Within startup grace — don't even start the timer
  if (Date.now() - startedAt < config.startupGraceMs) {
    console.log(
      '[consumer] No active consumers or clients, but within startup grace period — skipping shutdown',
    )
    return
  }

  if (!autoShutdownEnabled) {
    return
  }

  // Already have a pending shutdown timer — let it run
  if (shutdownTimer) return

  // Start the shutdown countdown
  console.log(
    `[consumer] No active consumers or clients — shutting down in ${config.shutdownDelayMs / 1000}s unless someone reconnects`,
  )
  shutdownTimer = setTimeout(() => {
    // Final check — someone may have reconnected during the delay
    if (consumers.size > 0 || getClientCount() > 0) {
      console.log('[consumer] Shutdown aborted — consumer or client reconnected during delay')
      shutdownTimer = null
      return
    }
    console.log('[consumer] Shutdown delay expired, no reconnections — shutting down')
    if (sweepTimer) clearInterval(sweepTimer)
    process.exit(0)
  }, config.shutdownDelayMs)
}
