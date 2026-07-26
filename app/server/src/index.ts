// app/server/src/index.ts
import type { Server } from 'http'
import { serve } from '@hono/node-server'
import { createApp } from './app'
import { createStore } from './storage'
import {
  attachWebSocket,
  broadcastToSession,
  broadcastToAll,
  broadcastActivity,
  closeWebSocket,
} from './websocket'
import { config } from './config'
import { startConsumerSweep } from './consumer-tracker'
import {
  CollectorLockHeldError,
  EXIT_LOCK_HELD,
  EXIT_SUPERVISION_CONFIG,
  claimCollectorSupervision,
} from './supervision/collector'
import type { CollectorSupervision } from './supervision/collector'
import { DataRootError } from './supervision/paths'
import { createSpoolConsumer } from './supervision/spool-consumer'

const PORT = config.port

let httpServer: Server | null = null
let httpListening = false

/**
 * Sampled on every heartbeat tick, so the heartbeat proves the collector is
 * still *working*, not merely alive.
 */
async function probe() {
  let databaseHealthy = false
  try {
    databaseHealthy = (await store.healthCheck()).ok
  } catch {
    databaseHealthy = false
  }
  return { databaseHealthy, httpHealthy: httpListening }
}

/**
 * Claim this data root before opening the database or the port.
 *
 * Refusal is immediate and deterministic: if another live, identity-matched
 * collector owns the lock, this process exits non-zero rather than waiting or
 * taking the lock away. A lock whose owner is provably gone is reclaimed —
 * that decision belongs entirely to the supervision primitives.
 */
function claimDataRootOrExit(): CollectorSupervision {
  try {
    const supervision = claimCollectorSupervision({ probe })
    console.log(
      `[supervision] Collector instance ${supervision.instanceId} owns ${supervision.paths.dataRoot}`,
    )
    return supervision
  } catch (err) {
    if (err instanceof CollectorLockHeldError) {
      console.error(
        `[supervision] Refusing to start: another collector already owns ${err.lockDir}. ` +
          `Stop it first, or start this one against a different AGENTS_OBSERVE_DATA_ROOT.`,
      )
      process.exit(EXIT_LOCK_HELD)
    }
    if (err instanceof DataRootError) {
      console.error(`[supervision] Refusing to start: ${err.message}`)
      process.exit(EXIT_SUPERVISION_CONFIG)
    }
    throw err
  }
}

const supervision = claimDataRootOrExit()
const store = createStore()
const spoolConsumer = createSpoolConsumer({
  dataRoot: supervision.paths.dataRoot,
  store,
  onStats: (stats) => supervision.setSpoolStats(stats),
})
spoolConsumer.start()
// Only now can the heartbeat answer what it reports on.
supervision.startHeartbeat()

// Release is ownership-checked and idempotent, so this is a safe last-ditch
// hook for every exit path that does not go through `shutdown` — the consumer
// tracker's idle auto-shutdown, and the bind failure below.
process.on('exit', () => supervision.release())
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

let shuttingDown = false

/**
 * Stop accepting new work, close HTTP/WebSocket, close the database, then give
 * up the heartbeat and the lock — in that order, and only if this instance
 * still owns them. A collector that has already been replaced must never
 * delete its successor's state.
 */
function shutdown(reason: string): void {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[shutdown] ${reason} — stopping collector`)

  supervision.stopHeartbeat()
  spoolConsumer.stop()
  httpListening = false
  closeWebSocket()
  httpServer?.close()
  try {
    store.close()
  } catch (err) {
    console.error(`[shutdown] Failed to close the database: ${(err as Error).message}`)
  }

  supervision.release()
  process.exit(0)
}

// Repair any rows with broken foreign keys before serving traffic.
// Logs what it found so the user knows if state was unexpected.
store.repairOrphans().then((result) => {
  const total =
    result.sessionsReassigned +
    result.agentsDeleted +
    result.agentsReparented +
    result.eventsDeleted
  if (total > 0) {
    console.log(
      `[startup] Repaired orphaned rows: ` +
        `${result.sessionsReassigned} sessions reassigned to 'unknown', ` +
        `${result.agentsDeleted} agents deleted, ` +
        `${result.agentsReparented} agents reparented, ` +
        `${result.eventsDeleted} events deleted`,
    )
  }
})

const app = createApp(store, broadcastToSession, broadcastToAll, broadcastActivity)

function start(retries = 3) {
  const server = serve({ fetch: app.fetch, port: PORT, hostname: config.bindHost }, () => {
    httpListening = true
    // Republish straight away so the heartbeat reflects the listener rather
    // than waiting out the interval.
    void supervision.publish()
    console.log(`Server running on http://localhost:${PORT} (bound to ${config.bindHost})`)
    console.log(`POST events: http://localhost:${PORT}/api/events`)
  })
  httpServer = server as unknown as Server

  ;(server as unknown as Server).on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && retries > 0) {
      console.log(`Port ${PORT} in use, retrying in 1s... (${retries} left)`)
      setTimeout(() => start(retries - 1), 1000)
    } else {
      console.error(err)
      process.exit(1)
    }
  })

  attachWebSocket(server as unknown as Server)
  startConsumerSweep()
}

start()
