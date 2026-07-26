// app/server/src/supervision/process-identity.ts
//
// Process identity, mirroring `hooks/scripts/supervision/lib/observe-process.sh`.
//
// A PID alone is never proof of ownership: the kernel recycles PIDs, so a lock
// recorded against PID 4242 can, minutes later, be pointing at somebody's
// `vim`. Identity therefore combines the PID, the process start time (immune to
// PID reuse — a reused PID always has a later start time) and the executable.
//
// The identity *string format* is part of the on-disk contract: the shell
// primitives write and compare the same bytes, so the templates below must not
// drift from `observe_pid_identity`.

import { execFileSync } from 'node:child_process'
import { readFileSync, readlinkSync } from 'node:fs'
import { isUint } from './paths'

export interface IdentityOptions {
  /** Root under which per-process identity is read. Overridable for tests. */
  procRoot: string
}

export function isPid(value: string | number): boolean {
  return isUint(String(value))
}

export function pidAlive(pid: number): boolean {
  if (!isPid(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but belongs to somebody else.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function ps(pid: number, format: string): string {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', format], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    }).trim()
  } catch {
    return ''
  }
}

/**
 * Path to the executable behind a PID, or `''` when it cannot be determined.
 * `/proc/<pid>/exe` is exact; `ps` is the bounded fallback where /proc does not
 * exist (macOS) or is not readable.
 */
export function pidExecutable(pid: number, opts: IdentityOptions): string {
  if (!isPid(pid)) return ''
  try {
    const exe = readlinkSync(`${opts.procRoot}/${pid}/exe`)
    if (exe) return exe
  } catch {
    // fall through to ps
  }
  return ps(pid, 'comm=')
}

/** The command line as one space-separated string, for marker matching only. */
export function pidCmdline(pid: number, opts: IdentityOptions): string {
  if (!isPid(pid)) return ''
  try {
    const raw = readFileSync(`${opts.procRoot}/${pid}/cmdline`, 'utf8')
    if (raw) return raw.replace(/\0/g, ' ')
  } catch {
    // fall through to ps
  }
  return ps(pid, 'command=')
}

/**
 * Stable identity string for a PID, or `''` when the process is gone.
 *
 * On Linux/WSL field 22 of `/proc/<pid>/stat` is the start time in clock ticks
 * since boot. It is monotonic against the boot clock, so — unlike a formatted
 * wall-clock date — it does not re-render when the host clock steps and falsely
 * evict a live collector. Elsewhere identity falls back to `ps -o lstart` under
 * `LC_ALL=C`; the locale pin matters because an identity is written under one
 * locale and re-read under whatever is ambient later.
 */
export function pidIdentity(pid: number, opts: IdentityOptions): string {
  if (!isPid(pid)) return ''
  const exe = pidExecutable(pid, opts)

  let statLine = ''
  try {
    statLine = readFileSync(`${opts.procRoot}/${pid}/stat`, 'utf8')
  } catch {
    statLine = ''
  }
  if (statLine) {
    // comm (field 2) may contain spaces and parens; everything after the last
    // ')' is field 3 onward, so index 19 there is field 22 (starttime).
    const fields = statLine
      .slice(statLine.lastIndexOf(')') + 1)
      .trim()
      .split(/\s+/)
    if (fields.length < 20) return ''
    const starttime = fields[19]
    if (!isUint(starttime)) return ''
    return `pid=${pid} starttime=${starttime} exe=${exe}`
  }

  const started = ps(pid, 'lstart=')
  if (!started) return ''
  return `pid=${pid} started=${started} exe=${exe}`
}

/**
 * True when the live process carries the expected entrypoint marker.
 *
 * The marker is deliberately not the full command line: argv changes across
 * restarts (port, flags, node path), and matching it whole would make every
 * ordinary restart look like an impostor.
 */
export function pidHasMarker(pid: number, marker: string, opts: IdentityOptions): boolean {
  if (!marker) return false
  const cmdline = pidCmdline(pid, opts)
  if (!cmdline) return false
  return cmdline.includes(marker)
}
