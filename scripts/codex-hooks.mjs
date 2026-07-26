#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MANAGED_MARKER = 'AGENTS_OBSERVE_INTEGRATION=codex-global'
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`
}

export function buildManagedCommand(hookScript, eventName) {
  const env = [MANAGED_MARKER, 'AGENTS_OBSERVE_AGENT_CLASS=codex']
  if (eventName === 'Stop') env.push('AGENTS_OBSERVE_NOTIFICATION_ON_EVENTS=Stop')
  return `${env.join(' ')} bash ${shellQuote(resolve(hookScript))}`
}

function managedHook(hookScript, eventName) {
  const hook = {
    type: 'command',
    command: buildManagedCommand(hookScript, eventName),
  }
  if (eventName === 'SessionStart') hook.statusMessage = 'Starting Agents Observe'
  return {
    ...(eventName === 'SessionStart' || eventName === 'PreToolUse' || eventName === 'PostToolUse'
      ? { matcher: '' }
      : {}),
    hooks: [hook],
  }
}

function isManagedEntry(entry) {
  return Boolean(
    entry?.hooks?.some(
      (hook) => typeof hook?.command === 'string' && hook.command.includes(MANAGED_MARKER),
    ),
  )
}

export function installHooksConfig(existing, hookScript) {
  const next = structuredClone(existing ?? {})
  next.hooks ??= {}

  for (const eventName of EVENTS) {
    const current = Array.isArray(next.hooks[eventName]) ? next.hooks[eventName] : []
    next.hooks[eventName] = [...current.filter((entry) => !isManagedEntry(entry)), managedHook(hookScript, eventName)]
  }

  return next
}

export function uninstallHooksConfig(existing) {
  const next = structuredClone(existing ?? {})
  if (!next.hooks || typeof next.hooks !== 'object') return next

  for (const [eventName, entries] of Object.entries(next.hooks)) {
    if (!Array.isArray(entries)) continue
    const remaining = entries.filter((entry) => !isManagedEntry(entry))
    if (remaining.length > 0) next.hooks[eventName] = remaining
    else delete next.hooks[eventName]
  }

  if (Object.keys(next.hooks).length === 0) delete next.hooks
  return next
}

export function enableCodexHooksFeature(toml) {
  const source = toml ?? ''
  const lines = source.split(/\r?\n/)
  const sectionIndex = lines.findIndex((line) => line.trim() === '[features]')

  if (sectionIndex === -1) {
    const prefix = source.trimEnd()
    return `${prefix}${prefix ? '\n\n' : ''}[features]\ncodex_hooks = true\n`
  }

  let sectionEnd = lines.length
  for (let i = sectionIndex + 1; i < lines.length; i += 1) {
    if (/^\s*\[.+\]\s*$/.test(lines[i])) {
      sectionEnd = i
      break
    }
  }

  const featureIndex = lines
    .slice(sectionIndex + 1, sectionEnd)
    .findIndex((line) => /^\s*codex_hooks\s*=/.test(line))

  if (featureIndex >= 0) {
    lines[sectionIndex + 1 + featureIndex] = 'codex_hooks = true'
  } else {
    lines.splice(sectionEnd, 0, 'codex_hooks = true')
  }

  return `${lines.join('\n').replace(/\n*$/, '')}\n`
}

function readJson(path) {
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf8'))
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, content, 'utf8')
  renameSync(temporary, path)
}

function backup(path) {
  if (!existsSync(path)) return
  writeFileSync(`${path}.agents-observe.bak`, readFileSync(path))
}

function defaultHookScript() {
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  return resolve(scriptDir, '..', 'hooks', 'scripts', 'hook.sh')
}

function parseArgs(argv) {
  const command = argv[0] ?? 'status'
  const options = {
    command,
    codexHome: process.env.CODEX_HOME || join(homedir(), '.codex'),
    hookScript: process.env.AGENTS_OBSERVE_HOOK_SCRIPT || defaultHookScript(),
  }

  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--codex-home') options.codexHome = resolve(argv[++i])
    else if (argv[i] === '--hook-script') options.hookScript = resolve(argv[++i])
    else throw new Error(`Unknown argument: ${argv[i]}`)
  }

  return options
}

function install({ codexHome, hookScript }) {
  if (!existsSync(hookScript)) throw new Error(`Agents Observe hook not found: ${hookScript}`)

  const hooksPath = join(codexHome, 'hooks.json')
  const configPath = join(codexHome, 'config.toml')
  const hooks = installHooksConfig(readJson(hooksPath), hookScript)
  const config = enableCodexHooksFeature(existsSync(configPath) ? readFileSync(configPath, 'utf8') : '')

  backup(hooksPath)
  backup(configPath)
  atomicWrite(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`)
  atomicWrite(configPath, config)

  console.log(`Installed Agents Observe Codex hooks in ${hooksPath}`)
  console.log(`Hook target: ${resolve(hookScript)}`)
  console.log('Existing hook entries were preserved. Restart Codex and approve the hooks when prompted.')
}

function uninstall({ codexHome }) {
  const hooksPath = join(codexHome, 'hooks.json')
  if (!existsSync(hooksPath)) {
    console.log(`No Codex hooks file found at ${hooksPath}`)
    return
  }

  const hooks = uninstallHooksConfig(readJson(hooksPath))
  backup(hooksPath)
  atomicWrite(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`)
  console.log(`Removed Agents Observe entries from ${hooksPath}`)
  console.log('The Codex hooks feature remains enabled because other integrations may use it.')
}

function status({ codexHome }) {
  const hooksPath = join(codexHome, 'hooks.json')
  if (!existsSync(hooksPath)) {
    console.log(`Agents Observe Codex hooks: not installed (${hooksPath} does not exist)`)
    process.exitCode = 1
    return
  }

  const config = readJson(hooksPath)
  const installedEvents = EVENTS.filter((eventName) =>
    config.hooks?.[eventName]?.some((entry) => isManagedEntry(entry)),
  )

  if (installedEvents.length === EVENTS.length) {
    console.log(`Agents Observe Codex hooks: installed (${installedEvents.join(', ')})`)
  } else {
    console.log(
      `Agents Observe Codex hooks: incomplete (${installedEvents.length}/${EVENTS.length} managed events)`,
    )
    process.exitCode = 1
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.command === 'install') install(options)
  else if (options.command === 'uninstall') uninstall(options)
  else if (options.command === 'status') status(options)
  else throw new Error('Usage: node scripts/codex-hooks.mjs <install|uninstall|status> [--codex-home PATH] [--hook-script PATH]')
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    main()
  } catch (error) {
    console.error(`codex-hooks: ${error.message}`)
    process.exit(1)
  }
}
