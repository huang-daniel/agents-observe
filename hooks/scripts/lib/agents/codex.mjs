// hooks/scripts/lib/agents/codex.mjs
// Codex hook lib. Composes default.mjs and overrides agentClass, lifecycle
// flags, and Codex-specific metadata —
// Codex hook payloads use the same identity-field shape as Claude
// (session_id, agent_id, hook_event_name, cwd, transcript_path), so the
// default lib's extraction works without further overrides.

import { readFileSync } from 'node:fs'
import { defaultLib } from './default.mjs'

const CLEARS_NOTIFICATION = new Set(['UserPromptSubmit'])
const STOPS_SESSION = new Set(['SessionEnd'])

export function buildEnv(config) {
  return defaultLib.buildEnv(config)
}

/**
 * Build the event envelope for a Codex hook payload.
 *
 * Codex shares the SessionStart, UserPromptSubmit, SessionEnd, and Stop
 * lifecycle semantics used by the dashboard. Notification opt-in is handled
 * by the default lib via AGENTS_OBSERVE_NOTIFICATION_ON_EVENTS.
 *
 * @param {object} config
 * @param {object} log
 * @param {object} payload
 * @returns {{ envelope: object, hookEvent: string, toolName: string }}
 */
export function buildHookEvent(config, log, payload) {
  const result = defaultLib.buildHookEvent(config, log, payload)
  result.envelope.agentClass = 'codex'

  const flags = result.envelope.flags ?? {}
  const hookName = result.envelope.hookName
  if (CLEARS_NOTIFICATION.has(hookName)) flags.clearsNotification = true
  if (STOPS_SESSION.has(hookName)) flags.stopsSession = true
  if (hookName === 'SessionStart') flags.resolveProject = true
  if (Object.keys(flags).length > 0) result.envelope.flags = flags

  const codex = {}
  const fields = [
    ['turnId', 'turn_id'],
    ['model', 'model'],
    ['permissionMode', 'permission_mode'],
    ['agentType', 'agent_type'],
  ]
  for (const [normalized, raw] of fields) {
    if (payload?.[raw] !== undefined) codex[normalized] = payload[raw]
  }
  if (Object.keys(codex).length > 0) {
    result.envelope._meta = { ...result.envelope._meta, codex }
  }

  if (hookName === 'SubagentStart') {
    const agent = {}
    const fields = [
      ['name', 'name'],
      ['description', 'description'],
      ['type', 'agent_type'],
    ]
    for (const [normalized, raw] of fields) {
      if (payload?.[raw] !== undefined) agent[normalized] = payload[raw]
    }
    if (Object.keys(agent).length > 0) {
      result.envelope._meta = { ...result.envelope._meta, agent }
    }
  }
  return result
}

/**
 * Scan a Codex transcript jsonl for session_meta git info. Example:
 *
 *   {
 *     "type": "session_meta",
 *     "payload": {
 *       "git": {
 *         "branch": "feat/foo",
 *         "repository_url": "git@github.com:..."
 *       }
 *     }
 *   }
 *
 * Codex transcripts do not carry a human-friendly slug of their own, so
 * the server falls back to git.branch for the session label.
 *
 * Shape returned matches the shared getSessionInfo contract:
 *   { slug: null, git: { branch: string|null, repository_url: string|null } }
 *
 * @param {object} args
 * @param {string} [args.transcriptPath] Absolute path to the jsonl transcript.
 * @param {string} [args.transcript_path] Snake-case alias accepted for
 *   back-compat with older callers.
 * @param {string} [args.agentClass] The session's agent class — always
 *   "codex" by the time this handler is dispatched, but kept in the arg
 *   signature for symmetry with other agents.
 * @param {string|null} [args.cwd] Working dir of the session when the
 *   callback was requested. Currently unused; reserved for future
 *   heuristics (e.g. reading git info directly via `git -C <cwd>` when
 *   the transcript hasn't been written yet).
 * @param {object} ctx
 * @param {object} ctx.log Logger with debug/warn/etc.
 */
export function getSessionInfo(args, { log }) {
  const transcriptPath = args?.transcriptPath ?? args?.transcript_path
  if (!transcriptPath) {
    log.debug('codex.getSessionInfo: no transcriptPath provided')
    return null
  }

  let content
  try {
    content = readFileSync(transcriptPath, 'utf8')
  } catch (err) {
    log.warn(`codex.getSessionInfo: cannot read transcript ${transcriptPath}: ${err.message}`)
    return null
  }

  let branch = null
  let repository_url = null

  let pos = 0
  while (pos < content.length) {
    const nextNewline = content.indexOf('\n', pos)
    const end = nextNewline === -1 ? content.length : nextNewline
    const line = content.slice(pos, end).trim()
    pos = end + 1
    if (!line || !line.includes('"git"')) continue

    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    // session_meta carries git under payload.git; tolerate git at the
    // top level too in case the transcript shape drifts in the future.
    const git = entry?.payload?.git ?? entry?.git
    if (!git || typeof git !== 'object') continue

    if (branch === null && typeof git.branch === 'string' && git.branch) {
      branch = git.branch
    }
    if (repository_url === null && typeof git.repository_url === 'string' && git.repository_url) {
      repository_url = git.repository_url
    }
    if (branch !== null && repository_url !== null) break
  }

  if (branch === null && repository_url === null) {
    log.debug(`codex.getSessionInfo: no git info in ${transcriptPath}`)
  } else {
    log.debug(`codex.getSessionInfo: branch=${branch} repo=${repository_url}`)
  }

  return {
    slug: null,
    git: { branch, repository_url },
  }
}
