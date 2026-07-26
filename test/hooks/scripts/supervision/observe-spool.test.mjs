import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeDataRoot, removeDataRoot, runShell } from './helpers.mjs'

const roots = []
afterEach(() => {
  while (roots.length) removeDataRoot(roots.pop())
})

describe('observe-spool.sh', () => {
  it('atomically writes a stable-id entry into pending', async () => {
    const root = makeDataRoot('observe-spool')
    roots.push(root)
    const result = await runShell("printf '%s' '{\"hello\":true}' | observe_spool_write event-1", {
      dataRoot: root,
      lib: '../observe-spool.sh',
    })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('event-1')
    const path = join(root, 'runtime/spool/pending/event-1.json')
    expect(existsSync(path)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      eventId: 'event-1',
      envelope: { hello: true },
    })
  })

  it('moves an entry through processing and failed without dropping it', async () => {
    const root = makeDataRoot('observe-spool')
    roots.push(root)
    const result = await runShell(
      "printf '{}' | observe_spool_write event-2 >/dev/null && observe_spool_move event-2 pending processing && observe_spool_move event-2 processing failed",
      { dataRoot: root, lib: '../observe-spool.sh' },
    )
    expect(result.code).toBe(0)
    expect(existsSync(join(root, 'runtime/spool/failed/event-2.json'))).toBe(true)
    expect(existsSync(join(root, 'runtime/spool/pending/event-2.json'))).toBe(false)
  })
})
