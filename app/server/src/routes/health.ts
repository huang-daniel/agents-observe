// app/server/src/routes/health.ts

import { Hono } from 'hono'
import type { EventStore } from '../storage/types'
import { config } from '../config'
import { getConsumerCount } from '../consumer-tracker'
import { getClientCount } from '../websocket'
import { getCollectorStatus } from '../supervision/collector'

type Env = { Variables: { store: EventStore } }

const router = new Hono<Env>()

router.get('/health', async (c) => {
  const store = c.get('store')
  const result = await store.healthCheck()

  return c.json(
    {
      ok: result.ok,
      id: config.apiId,
      version: config.version,
      logLevel: config.logLevel,
      runtime: config.runtime,
      // Host-side bind mount path in docker mode, real on-disk path in
      // local mode. Always the path the user can navigate to on their
      // own filesystem — never the in-container /data/observe.db.
      dbPath: config.hostDbPath,
      activeConsumers: getConsumerCount(),
      activeClients: getClientCount(),
      transcriptStatsEnabled: config.transcriptStats.enabled,
      // Collector supervision: the same predicate observe-health.sh computes
      // (lock present, owned by this instance, PID alive, identity matches,
      // heartbeat fresh and instance-matched), plus the heartbeat fields.
      // `null` when supervision is not running — the route is also mounted by
      // unit tests that never claim a lock.
      //
      // Deliberately does NOT drive `ok` or the status code: this endpoint is
      // how the CLI decides the server is up, and flipping it to 503 over a
      // momentarily stale heartbeat would make a supervisor restart a server
      // that is serving traffic perfectly well.
      collector: getCollectorStatus(),
      ...(result.error ? { error: result.error } : {}),
    },
    result.ok ? 200 : 503,
  )
})

export default router
