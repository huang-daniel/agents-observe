// app/server/src/supervision/test-support.ts
//
// Helpers shared by the supervision tests. Not a test file itself (vitest only
// collects `*.test.ts`) and never imported by runtime code.
//
// The shape mirrors test/hooks/scripts/supervision/helpers.mjs so the two sides
// of the supervision contract are exercised the same way.

import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { LockOptions } from './lock'

const execFileAsync = promisify(execFile)

const here = dirname(fileURLToPath(import.meta.url))
/** app/server/src/supervision -> repo root */
export const REPO_ROOT = resolve(here, '../../../../')
export const HEALTH_CLI = join(REPO_ROOT, 'hooks/scripts/supervision/observe-health.sh')
export const SERVER_ENTRY = join(REPO_ROOT, 'app/server/src/index.ts')

/** The marker the fake collectors below carry in their command line. */
export const MARKER = 'agents-observe-collector'

export function testLockOptions(overrides: Partial<LockOptions> = {}): LockOptions {
  return { procRoot: '/proc', settleSeconds: 2, ...overrides }
}

export function makeDataRoot(label = 'observe-sup'): string {
  return mkdtempSync(join(tmpdir(), `${label}-`))
}

export function removeDataRoot(path: string | undefined): void {
  if (path) rmSync(path, { recursive: true, force: true })
}

/**
 * A long-lived process whose command line carries `marker`. The trailing shell
 * comment is what puts the marker in argv without changing behaviour.
 */
export function spawnFakeProcess(marker: string = MARKER): ChildProcess {
  const child = spawn(
    'bash',
    ['-c', `trap 'exit 0' TERM INT; while true; do sleep 0.2; done # ${marker}`],
    { stdio: 'ignore' },
  )
  child.unref()
  return child
}

export function killProcess(child: ChildProcess | undefined): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    child.kill('SIGKILL')
  } catch {
    // already gone
  }
}

export function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((res) => child.once('exit', () => res()))
}

export async function waitFor(
  check: () => boolean | Promise<boolean>,
  { timeoutMs = 5000, intervalMs = 25 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error('waitFor: timed out')
    await new Promise((res) => setTimeout(res, intervalMs))
  }
}

export interface CliResult {
  stdout: string
  stderr: string
  code: number
}

/** Run the shell health diagnostic against a data root. */
export async function runHealthCli(dataRoot: string): Promise<CliResult> {
  const options = {
    env: { ...process.env, AGENTS_OBSERVE_DATA_ROOT: dataRoot, AGENTS_OBSERVE_HEALTH_URL: '' },
  }
  try {
    const { stdout, stderr } = await execFileAsync(HEALTH_CLI, [], options)
    return { stdout: stdout.trim(), stderr, code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number }
    return { stdout: (e.stdout ?? '').trim(), stderr: e.stderr ?? '', code: e.code ?? 1 }
  }
}

/**
 * Ask the shipped shell primitive whether a data root's lock is reclaimable.
 * Tests use this rather than the TypeScript mirror so the assertion is about
 * the kernel's judgement, not our restatement of it.
 */
export async function shellLockIsAbandoned(dataRoot: string): Promise<boolean> {
  const lib = join(REPO_ROOT, 'hooks/scripts/supervision/lib/observe-lock.sh')
  const script = `set -u
. '${lib}'
observe_env_init || exit 2
if observe_collector_lock_is_abandoned; then echo abandoned; else echo held; fi`
  const { stdout } = await execFileAsync('bash', ['-c', script], {
    env: { ...process.env, AGENTS_OBSERVE_DATA_ROOT: dataRoot },
  })
  return stdout.trim() === 'abandoned'
}

/** The status word `observe-health.sh` reported, e.g. `healthy`, `absent`. */
export function healthCliStatus(result: CliResult): string {
  return result.stdout.replace(/^collector:\s*/, '').split(/\s+/)[0] ?? ''
}
