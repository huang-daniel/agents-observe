import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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

  it('keeps identical event ids and state transitions isolated by data root', async () => {
    const first = makeDataRoot('observe-spool-a')
    const second = makeDataRoot('observe-spool-b')
    roots.push(first, second)

    expect(
      (
        await runShell('printf \'{"root":"a"}\' | observe_spool_write shared', {
          dataRoot: first,
          lib: '../observe-spool.sh',
        })
      ).code,
    ).toBe(0)
    expect(
      (
        await runShell('printf \'{"root":"b"}\' | observe_spool_write shared', {
          dataRoot: second,
          lib: '../observe-spool.sh',
        })
      ).code,
    ).toBe(0)
    await runShell('observe_spool_move shared pending processing', {
      dataRoot: first,
      lib: '../observe-spool.sh',
    })

    expect(existsSync(join(first, 'runtime/spool/processing/shared.json'))).toBe(true)
    expect(existsSync(join(second, 'runtime/spool/pending/shared.json'))).toBe(true)
    expect(
      JSON.parse(readFileSync(join(second, 'runtime/spool/pending/shared.json'), 'utf8')),
    ).toMatchObject({
      envelope: { root: 'b' },
    })
  })

  it('fails safely when the filesystem rejects the final spool publish', async () => {
    // A PATH fake is deterministic and models ENOSPC at the atomic publish
    // boundary without depending on the host's remaining disk capacity.
    const root = makeDataRoot('observe-spool-full')
    roots.push(root)
    const fakeBin = mkdtempSync(join(tmpdir(), 'observe-spool-bin-'))
    try {
      const ln = join(fakeBin, 'ln')
      writeFileSync(ln, '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 })
      const result = await runShell('printf \'{"hello":true}\' | observe_spool_write no-space', {
        dataRoot: root,
        lib: '../observe-spool.sh',
        env: { PATH: `${fakeBin}:${process.env.PATH}` },
      })

      expect(result.code).toBe(1)
      const pending = join(root, 'runtime/spool/pending')
      expect(existsSync(join(pending, 'no-space.json'))).toBe(false)
      expect(existsSync(join(pending, '.no-space.tmp'))).toBe(false)
      expect(readdirSync(pending)).toEqual([])
    } finally {
      rmSync(fakeBin, { recursive: true, force: true })
    }
  })
})
