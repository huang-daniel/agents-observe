#!/usr/bin/env node
// hooks/scripts/observe_cli.mjs
// CLI entrypoint for Agents Observe plugin.
// Thin dispatcher — command implementations live in lib/.

import { createInterface } from 'node:readline'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { getConfig } from './lib/config.mjs'
import { getJson } from './lib/http.mjs'
import { createLogger } from './lib/logger.mjs'
import { removeDatabase } from './lib/fs.mjs'
import { buildHookEnvelope, hookCommand, hookSyncCommand } from './lib/hooks.mjs'

const cliArgs = parseArgs(process.argv.slice(2))
const config = getConfig(cliArgs)
const log = createLogger('cli.log', config)

switch (cliArgs.commands[0] || 'help') {
  case 'help':
    console.log('Usage: node observe_cli.mjs <command> [--base-url URL] [--project-slug SLUG]')
    console.log('  hook:            Send an event (fire-and-forget)')
    console.log('  hook-sync:       Send an event and return systemMessage JSON')
    console.log('  spool-envelope:  Normalize a hook event for legacy spool schema')
    console.log('  health:          Check the server health')
    console.log('  start:           Start the server')
    console.log('  stop:            Stop the server')
    console.log('  restart:         Restart the server')
    console.log('  db-reset:        Delete the SQLite database [--force to skip confirmation]')
    console.log('  logs-server:     Tail the collector server log [-n N] (default 20 lines)')
    console.log('  logs-cli [-n N]: Tail the local cli.log file (default 20 lines)')
    process.exit(0)
  case 'hook':
    hookCommand(config, log)
    break
  case 'hook-sync':
    hookSyncCommand(config, log)
    break
  case 'spool-envelope':
    spoolEnvelopeCommand()
    break
  case 'health':
    healthCommand()
    break
  case 'start':
    startCommand()
    break
  case 'stop':
    stopCommand()
    break
  case 'restart':
    startCommand('restart', 'Restarting server...')
    break
  case 'db-reset':
    dbResetCommand()
    break
  case 'logs-server':
    logsFileCommand(config.collectorLogFile)
    break
  case 'logs-cli':
    logsFileCommand(resolve(config.logsDir, 'cli.log'))
    break
  default:
    console.error(`Unknown command: ${cliArgs.commands[0]}`)
    console.error('Run `node observe_cli.mjs help` to see available commands.')
    process.exit(1)
}

// -- Commands -----------------------------------------------------

/**
 * Get health and runtime info about the server.
 * Used by /observe and /observe status skills.
 */
async function healthCommand(exit = true) {
  log.trace('CLI health command invoked')
  const healthUrl = `${config.apiBaseUrl}/health`
  const result = await getJson(healthUrl, { log })
  if (result.status === 200 && result.body?.ok) {
    const b = result.body

    console.log(`Raw ${healthUrl} response:`)
    console.log(JSON.stringify(b, null, 2))
    console.log('')
    console.log('Hooks CLI (local):')
    console.log(`  CLI Path: ${config.cliPath}`)
    console.log(`  Log Level: ${config.logLevel || 'unknown'}`)
    console.log(`  Logs: ${config.logsDir}`)
    console.log(
      `  Allowed Callbacks: ${
        config.allowedCallbacks.size ? [...config.allowedCallbacks].join(', ') : 'none'
      }`,
    )
    console.log('')
    console.log('Agents Observe Server:')
    console.log(`  Version: v${b.version || 'unknown'}`)
    console.log(`  Dashboard: ${config.baseOrigin}`)
    console.log(`  API: ${config.apiBaseUrl}`)
    console.log(`  Database: ${b.dbPath || 'unknown'}`)
    console.log(`  Server Log: ${config.collectorLogFile}`)
    console.log(`  Log Level: ${b.logLevel || 'unknown'}`)

    if (config.expectedVersion && b.version && config.expectedVersion !== b.version) {
      console.log('')
      console.log(`⚠ Version mismatch: CLI is v${config.expectedVersion}, server is v${b.version}`)
      console.log(`  To update the server, run: node ${config.cliPath} restart`)
    }
    exit && process.exit(0)
  } else if (result.status === 0) {
    console.log(`Agents Observe server is not running.`)
    console.log(`  Checked: ${healthUrl}`)
    console.log(`  Error: ${result.error || 'connection refused'}`)
    exit && process.exit(1)
  } else {
    console.log(`Agents Observe server error (HTTP ${result.status}):`)
    console.log(JSON.stringify(result.body, null, 2))
    exit && process.exit(1)
  }
}

/**
 * Start (or restart) the collector.
 *
 * The supervisor arm is the one implementation of "start the collector" —
 * lock, spawn, confirm — and this command drives it rather than reimplementing
 * any of it. See docs/collector-supervision.md.
 */
function runSupervisor(action) {
  const script =
    action === 'stop'
      ? resolve(config.installDir, 'hooks/scripts/supervision/observe-stop.sh')
      : resolve(config.installDir, 'hooks/scripts/supervision/observe-arm.sh')
  return spawnSync('bash', [script, ...(action === 'stop' ? [] : [action])], {
    stdio: 'inherit',
    env: { ...process.env, AGENTS_OBSERVE_DATA_ROOT: config.supervisionDataRoot },
  })
}

async function startCommand(action = 'start', msg = 'Starting server...') {
  log.info(msg)
  const result = runSupervisor(action)
  if (result.status === 0) {
    await healthCommand(false)
    console.log(`\n  Dashboard: ${config.baseOrigin}`)
    process.exit(0)
  }
  console.error('Failed to start server')
  console.error(`  Collector log: ${config.collectorLogFile}`)
  process.exit(1)
}

function stopCommand() {
  const result = runSupervisor('stop')
  log.info('Server stopped')
  process.exit(result.status ?? 1)
}

async function spoolEnvelopeCommand() {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    input += chunk
  })
  process.stdin.on('end', () => {
    if (!input.trim()) process.exit(1)
    try {
      process.stdout.write(JSON.stringify(buildHookEnvelope(config, log, JSON.parse(input))) + '\n')
    } catch (err) {
      log.warn(`Failed to normalize legacy spool envelope: ${err.message}`)
      process.exitCode = 1
    }
  })
}

/**
 * Tail a log file. The CLI resolves the path itself so the /observe skill
 * doesn't have to probe ~/.claude/plugins/data/... and ~/.agents-observe/...
 * fallbacks.
 */
function logsFileCommand(path) {
  if (!path || !existsSync(path)) {
    console.log(`Log file not found at ${path}`)
    process.exit(0)
  }
  const lines = cliArgs.tailLines ?? 20
  const child = spawn('tail', ['-n', String(lines), path], { stdio: 'inherit' })
  child.on('error', (err) => {
    console.error(`Failed to tail ${path}: ${err.message}`)
    process.exit(1)
  })
  child.on('close', (code) => process.exit(code ?? 0))
}

async function dbResetCommand() {
  const dbPath = `${config.dataDir}/${config.databaseFileName}`

  if (!cliArgs.force) {
    const confirmed = await confirm(`Delete database at ${dbPath}? This cannot be undone. [y/N] `)
    if (!confirmed) {
      console.log('Aborted.')
      process.exit(0)
    }
  }

  const health = await getJson(`${config.apiBaseUrl}/health`, { log })
  const wasRunning = health.status === 200 && health.body?.ok

  if (wasRunning) {
    console.log('Stopping server...')
    runSupervisor('stop')
  }

  const { removed } = removeDatabase(config)
  if (removed.length > 0) {
    console.log(`Deleted: ${removed.join(', ')}`)
  } else {
    console.log('No database files found.')
  }

  if (wasRunning) {
    console.log('Restarting server...')
    runSupervisor('start')
    console.log('Server restarted.')
  }
}

// -- Helpers ------------------------------------------------------

function confirm(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(prompt, (answer) => {
      rl.close()
      resolve(answer.trim().toLowerCase() === 'y')
    })
  })
}

function parseArgs(args) {
  const parsed = {
    commands: [],
    baseUrl: null,
    projectSlug: null,
    force: false,
    tailLines: null,
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--base-url' && args[i + 1]) {
      parsed.baseUrl = args[i + 1]
      i++
    } else if (args[i] === '--project-slug' && args[i + 1]) {
      parsed.projectSlug = args[i + 1]
      i++
    } else if (args[i] === '--force') {
      parsed.force = true
    } else if (args[i] === '-n' && args[i + 1]) {
      const n = parseInt(args[i + 1], 10)
      if (!Number.isNaN(n)) parsed.tailLines = n
      i++
    } else if (!args[i].startsWith('-')) {
      parsed.commands.push(args[i])
    }
  }
  return parsed
}
