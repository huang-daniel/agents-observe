#!/usr/bin/env node

/**
 * Runs the API server & dashboard UI in the foreground.
 *
 * This is the developer entrypoint (`just dev`, `just start-foreground`). The
 * supervised path the plugin's hooks use is
 * hooks/scripts/supervision/observe-arm.sh, which forks the collector detached
 * and bootstraps a source-only checkout first.
 *
 * Set AGENTS_OBSERVE_RUNTIME=local|dev in env or claude settings.json.
 * Reads all config from hooks/scripts/lib/config.mjs (central source of truth).
 *
 * Modes:
 *   local — install deps, build client, start server (production-like)
 *   dev   — install deps, start server + client with hot reload
 */

import { execFileSync, spawn } from 'node:child_process'
import { resolve } from 'node:path'
import {
  getConfig,
  getServerEnv,
  getClientEnv,
  initLocalDataDirs,
} from './hooks/scripts/lib/config.mjs'
import { saveServerPortFile, removeServerPortFile } from './hooks/scripts/lib/fs.mjs'

const config = getConfig()
const serverDir = resolve(config.installDir, 'app/server')
const clientDir = resolve(config.installDir, 'app/client')
const isDev = config.isDevRuntime
const skipInstall = process.argv.includes('--skip-install')

function run(cmd, args, cwd, env = {}) {
  const rel = cwd.replace(config.installDir + '/', '') || '.'
  console.log(`\n> ${cmd} ${args.join(' ')}  (in ${rel})`)
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } })
}

// 1. Install dependencies
if (skipInstall) {
  console.log('\nSkipping npm install (--skip-install)')
} else {
  run('npm', ['install'], serverDir)
  run('npm', ['install'], clientDir)
}

// 2. Build client (skip in dev — vite serves it directly)
if (!isDev) {
  run('npm', ['run', 'build'], clientDir, getClientEnv(config))
}

// 3. Initialize the local data dirs before starting the server
initLocalDataDirs(config)

// 4. Start server
const serverEnv = getServerEnv(config)

saveServerPortFile(config, config.serverPort)

if (isDev) {
  console.log(`\nStarting dev server on http://localhost:${config.serverPort} (API)\n`)
  console.log(`Starting dev client on http://localhost:${config.clientPort} (UI + proxy)\n`)

  const server = spawn('npm', ['run', 'dev'], {
    cwd: serverDir,
    stdio: 'inherit',
    env: { ...process.env, ...serverEnv },
  })

  const client = spawn('npm', ['run', 'dev'], {
    cwd: clientDir,
    stdio: 'inherit',
    env: { ...process.env, ...getClientEnv(config) },
  })

  function cleanup() {
    removeServerPortFile(config)
    server.kill('SIGINT')
    client.kill('SIGINT')
  }

  server.on('close', (code) => {
    removeServerPortFile(config)
    client.kill()
    process.exit(code ?? 0)
  })
  client.on('close', () => {
    server.kill()
  })
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
} else {
  console.log(`\nStarting server on http://localhost:${config.serverPort} (API + UI)\n`)

  const server = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: serverDir,
    stdio: 'inherit',
    env: { ...process.env, ...serverEnv },
  })

  server.on('close', (code) => {
    removeServerPortFile(config)
    process.exit(code ?? 0)
  })
  process.on('SIGINT', () => {
    removeServerPortFile(config)
    server.kill('SIGINT')
  })
  process.on('SIGTERM', () => {
    removeServerPortFile(config)
    server.kill('SIGTERM')
  })
}
