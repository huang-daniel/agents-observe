// app/server/src/supervision/paths.ts
//
// Data-root and runtime-path resolution for the collector, mirroring
// `hooks/scripts/supervision/lib/observe-env.sh` field for field.
//
// The shell primitives and this module read and write the *same files*, so the
// resolution rules have to agree exactly: a server that resolves a different
// data root than `observe-health.sh` would report health about a lock nobody
// else can see. Every rule below has a line-for-line counterpart in the shell,
// and `supervision/parity.test.ts` proves the two agree at runtime.
//
// Resolution is READ-ONLY. Nothing here creates a directory unless the caller
// asks via `ensureRuntimeDir`.

import { mkdirSync, readFileSync, statSync } from 'node:fs'

export interface RuntimePaths {
  dataRoot: string
  runtimeDir: string
  lockDir: string
  startLockDir: string
  heartbeatFile: string
  lifecycleLog: string
  spoolDir: string
}

/** Thrown when no safe data root can be resolved. Maps to exit code 2. */
export class DataRootError extends Error {}

/**
 * Reject data roots that would make the runtime layout unsafe or ambiguous:
 * absolute, not the filesystem root, no relative segments, no newlines or tabs
 * (they would corrupt the line-oriented lock and heartbeat files).
 */
export function isSafeDataRoot(path: string): boolean {
  if (!path) return false
  if (path === '/') return false
  if (!path.startsWith('/')) return false
  if (/[\n\t]/.test(path)) return false
  const segments = path.split('/')
  if (segments.includes('..') || segments.includes('.')) return false
  return true
}

/**
 * Resolve the data root, with the same precedence as `observe_env_init`:
 *
 *   1. an explicit argument (tests, and callers supervising another instance)
 *   2. `AGENTS_OBSERVE_DATA_ROOT` — the supervision namespace
 *   3. `AGENTS_OBSERVE_LOCAL_DATA_ROOT` — the data-dir override config.mjs
 *      already reads, so supervision lands beside the DB rather than in a
 *      second location
 *   4. `$HOME/.agents-observe`
 *
 * Note this is *not* the server's `config.dataDir` (`<root>/data`): the shell
 * side resolves to the root itself, and the two must not disagree.
 */
export function resolveDataRoot(candidates: (string | undefined)[]): string {
  let root = candidates.find((c) => !!c) ?? ''
  if (!root) {
    throw new DataRootError('no data root: set AGENTS_OBSERVE_DATA_ROOT (HOME is unset)')
  }
  // Strip a single trailing slash so paths never come out doubled.
  if (root.length > 1 && root.endsWith('/')) root = root.slice(0, -1)
  if (!isSafeDataRoot(root)) {
    throw new DataRootError(`unsafe data root: '${root}'`)
  }
  return root
}

export function runtimePaths(dataRoot: string): RuntimePaths {
  const runtimeDir = `${dataRoot}/runtime`
  return {
    dataRoot,
    runtimeDir,
    lockDir: `${runtimeDir}/collector.lock`,
    startLockDir: `${runtimeDir}/collector-start.lock`,
    heartbeatFile: `${runtimeDir}/collector.heartbeat`,
    lifecycleLog: `${runtimeDir}/collector-lifecycle.log`,
    spoolDir: `${runtimeDir}/spool`,
  }
}

/** Create the runtime directory. Split out so path resolution stays pure. */
export function ensureRuntimeDir(paths: RuntimePaths): void {
  mkdirSync(paths.runtimeDir, { recursive: true })
}

/**
 * First line of a file, or `''` when it is missing or unreadable — the shell's
 * `observe_read_line`. The lock and heartbeat files are one value per line, so
 * this is the only reader the supervision code needs.
 */
export function readLine(path: string): string {
  try {
    const raw = readFileSync(path, 'utf8')
    const nl = raw.indexOf('\n')
    return nl === -1 ? raw : raw.slice(0, nl)
  } catch {
    return ''
  }
}

/** Current epoch seconds. One definition so age math agrees everywhere. */
export function nowEpoch(): number {
  return Math.floor(Date.now() / 1000)
}

/** True when the path exists and is a directory — the shell's `[ -d ]`. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** mtime of a path in epoch seconds, or `null` when it cannot be read. */
export function pathMtime(path: string): number | null {
  try {
    return Math.floor(statSync(path).mtimeMs / 1000)
  } catch {
    return null
  }
}

/** Non-empty and all digits — the shell's `observe_is_uint`. */
export function isUint(value: string): boolean {
  return /^[0-9]+$/.test(value)
}
