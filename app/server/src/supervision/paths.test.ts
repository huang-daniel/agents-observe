import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { promisify } from 'node:util'

import { DataRootError, isSafeDataRoot, readLine, resolveDataRoot, runtimePaths } from './paths'
import { REPO_ROOT, makeDataRoot, removeDataRoot } from './test-support'

const execFileAsync = promisify(execFile)

const SAFE = ['/home/someone/.agents-observe', '/tmp/observe', '/a', '/data/observe-root']
const UNSAFE = ['', '/', 'relative/path', '../up', '/has/../dots', '/trailing/.', '/tab\there']

describe('isSafeDataRoot', () => {
  it.each(SAFE)('accepts %j', (path) => expect(isSafeDataRoot(path)).toBe(true))
  it.each(UNSAFE)('rejects %j', (path) => expect(isSafeDataRoot(path)).toBe(false))

  it('agrees with observe_data_root_is_safe for every case', async () => {
    const lib = `${REPO_ROOT}/hooks/scripts/supervision/lib/observe-env.sh`
    const checks = [...SAFE, ...UNSAFE]
      .map((path) => `if observe_data_root_is_safe '${path}'; then echo safe; else echo unsafe; fi`)
      .join('\n')
    const { stdout } = await execFileAsync('bash', ['-c', `set -u\n. '${lib}'\n${checks}`])
    expect(stdout.trim().split('\n')).toEqual([
      ...SAFE.map(() => 'safe'),
      ...UNSAFE.map(() => 'unsafe'),
    ])
  })
})

describe('resolveDataRoot', () => {
  it('takes the first candidate that is set', () => {
    expect(resolveDataRoot(['/first', '/second'])).toBe('/first')
    expect(resolveDataRoot([undefined, '', '/second'])).toBe('/second')
  })

  it('strips a single trailing slash so paths never double up', () => {
    expect(resolveDataRoot(['/root/'])).toBe('/root')
    expect(runtimePaths(resolveDataRoot(['/root/'])).lockDir).toBe('/root/runtime/collector.lock')
  })

  it('throws when nothing resolves', () => {
    expect(() => resolveDataRoot([undefined, ''])).toThrow(DataRootError)
  })

  it('throws on an unsafe root rather than building paths under it', () => {
    expect(() => resolveDataRoot(['relative/path'])).toThrow(/unsafe data root/)
  })
})

describe('runtimePaths', () => {
  it('lays out exactly the files the shell kernel documents', () => {
    expect(runtimePaths('/root')).toEqual({
      dataRoot: '/root',
      runtimeDir: '/root/runtime',
      lockDir: '/root/runtime/collector.lock',
      startLockDir: '/root/runtime/collector-start.lock',
      heartbeatFile: '/root/runtime/collector.heartbeat',
      lifecycleLog: '/root/runtime/collector-lifecycle.log',
    })
  })
})

describe('readLine', () => {
  it('returns the first line, and an empty string when there is no file', () => {
    const root = makeDataRoot('observe-paths-ts')
    try {
      writeFileSync(`${root}/one`, 'first\nsecond\n')
      writeFileSync(`${root}/empty`, '')
      expect(readLine(`${root}/one`)).toBe('first')
      expect(readLine(`${root}/empty`)).toBe('')
      expect(readLine(`${root}/missing`)).toBe('')
    } finally {
      removeDataRoot(root)
    }
  })
})
