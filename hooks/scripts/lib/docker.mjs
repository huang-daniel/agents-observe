// hooks/scripts/lib/docker.mjs
// Docker container management for Agents Observe. Node.js built-ins only.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { getJson } from './http.mjs'
import { initLocalDataDirs, getServerEnv } from './config.mjs'
import { saveServerPortFile, removeServerPortFile, ensureSupervisionDirs } from './fs.mjs'

// -- Shell helper -------------------------------------------------

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30000 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err?.code ?? 0,
        stdout: stdout?.trim() || '',
        stderr: stderr?.trim() || '',
      })
    })
  })
}

/**
 * Read the managed label value from a container.
 * Returns the label string (version) if it's our container, null otherwise.
 */
async function getContainerLabel(config) {
  const result = await run('docker', [
    'inspect',
    '--format',
    `{{index .Config.Labels "${config.dockerLabel}"}}`,
    config.containerName,
  ])
  return result.ok && result.stdout ? result.stdout : null
}

/**
 * Check if a container exists and is managed by us.
 */
async function isOurContainer(config) {
  return !!(await getContainerLabel(config))
}

/**
 * Force-remove a container, but only if it has our managed label.
 * Returns true if removed, false if skipped (not ours or doesn't exist).
 */
async function safeRemoveContainer(config, log) {
  if (!(await isOurContainer(config))) {
    const exists = await run('docker', ['inspect', config.containerName])
    if (exists.ok) {
      log.warn(
        `Container "${config.containerName}" exists but is not managed by ${config.dockerLabel} — skipping removal`,
      )
    }
    return false
  }
  await run('docker', ['rm', '-f', config.containerName])
  return true
}

/**
 * Get the status of our container (if it exists).
 * Returns { exists, running, versionMatch } or null if container doesn't exist.
 */
async function getContainerState(config) {
  const label = await getContainerLabel(config)
  if (!label) return null

  const statusResult = await run('docker', [
    'inspect',
    '--format',
    '{{.State.Running}}',
    config.containerName,
  ])
  const running = statusResult.ok && statusResult.stdout === 'true'
  const versionMatch = label === (config.expectedVersion || 'unknown')

  // The collector run baked into this container. A stopped container keeps the
  // instance id it was created with — supervision would then wait forever for a
  // run that can never appear, so a caller asking for a specific instance has
  // to get a fresh container rather than a fast `docker start`.
  const instanceResult = await run('docker', [
    'inspect',
    '--format',
    `{{index .Config.Labels "${config.dockerInstanceLabel}"}}`,
    config.containerName,
  ])
  const instanceId = instanceResult.ok ? instanceResult.stdout : ''

  return { exists: true, running, versionMatch, labelVersion: label, instanceId }
}

// -- Docker lifecycle ---------------------------------------------

/**
 * Build the `-p` value for `docker run`. Prefixes the host interface so the
 * published port binds to loopback by default rather than 0.0.0.0, keeping
 * the unauthenticated dashboard/WebSocket off other interfaces (GitHub
 * issue #22). Pass hostPort `0` to let docker auto-assign a free host port.
 * An empty bindHost falls back to docker's default (all interfaces).
 */
export function buildPortMapping(bindHost, hostPort, containerPort) {
  return bindHost ? `${bindHost}:${hostPort}:${containerPort}` : `${hostPort}:${containerPort}`
}

/**
 * Build the `-v` value for the writable data mount. On SELinux hosts the
 * bind-mounted dir keeps its host label and the confined container can't write
 * to it, so the sqlite DB fails to open (SQLITE_CANTOPEN — GitHub issue #20).
 * Appending `z` relabels the dir to the shared container-accessible type. This
 * dir is ours (`<data root>/data`, only the DB + logs), so relabeling it
 * recursively is safe.
 */
export function buildDataMount(dataDir, relabel = false) {
  return `${dataDir}:/data${relabel ? ':z' : ''}`
}

/**
 * Build the `-v` args for the read-only transcript bind mounts (one per
 * agent class). Returns a flat array suitable for `docker run`, e.g.
 * `['-v', '<host>:/host/.claude/projects:ro', ...]`.
 *
 * Filters on the host path directly rather than parsing it back out of the
 * joined mount string. A Windows host path (`C:\Users\...`) contains the
 * drive-letter colon, so splitting the mount on `:` mistook the drive letter
 * for the source and silently dropped both mounts — GitHub issue #21.
 *
 * When `relabel` is set, appends the shared SELinux relabel option (`,z`) so
 * the container can read these dirs on SELinux hosts (issue #20). These are
 * the user's ~/.claude and ~/.codex dirs, so `z` (shared) is used — never `Z`
 * (private) — and it can be disabled via AGENTS_OBSERVE_SELINUX_RELABEL.
 *
 * `exists` is injectable so the filter can be unit-tested with Windows-style
 * paths on a POSIX host.
 */
/**
 * Build the `-v` args for the collector's supervision data root.
 *
 * Mounted at the *same absolute path* inside the container, which is what makes
 * one supervision contract work across the boundary: the lock records a data
 * root, the spool consumer resolves paths from it, and the host reads both
 * back. A translated path would make every one of those comparisons a mismatch.
 *
 * Empty when there is no data root to share, or when it is the same directory
 * the DB mount already covers. Returns a flat array for `docker run`.
 */
export function buildSupervisionMounts(dataRoot, relabel = false) {
  if (!dataRoot || !dataRoot.startsWith('/')) return []
  return ['-v', `${dataRoot}:${dataRoot}${relabel ? ':z' : ''}`]
}

export function buildTranscriptMounts(
  { claudeHost, codexHost, enabled, relabel = false },
  exists = existsSync,
) {
  if (!enabled) return []
  const opts = relabel ? 'ro,z' : 'ro'
  return [
    { host: claudeHost, container: '/host/.claude/projects' },
    { host: codexHost, container: '/host/.codex/sessions' },
  ]
    .filter(({ host }) => host && exists(host))
    .flatMap(({ host, container }) => ['-v', `${host}:${container}:${opts}`])
}

/**
 * Starts the Docker container. Returns the actual port the server is running on.
 * Handles: version mismatch (restart), port conflict (auto-assign), stale containers.
 *
 * Fast path: if a stopped container exists with the correct version, just
 * `docker start` it instead of rm + pull + run.
 */
export async function startServer(config, log = console) {
  // Check Docker availability
  const dockerCheck = await run('docker', ['info'])
  if (!dockerCheck.ok) {
    log.error('ERROR: Docker is not running or not installed')
    log.error('Install Docker: https://docs.docker.com/get-docker/')
    return null
  }

  // Check if something is already running on the target port
  const healthResult = await getJson(`${config.apiBaseUrl}/health`)
  if (healthResult.status === 200 && healthResult.body?.ok) {
    if (healthResult.body.id !== config.API_ID) {
      log.warn(
        `Port ${config.serverPort} is in use by another service, auto-assigning a free port...`,
      )
    } else if (config.expectedVersion && healthResult.body.version !== config.expectedVersion) {
      log.warn(
        `Server version mismatch: running ${healthResult.body.version}, expected ${config.expectedVersion}. Restarting...`,
      )
      await safeRemoveContainer(config, log)
    } else {
      const port = new URL(config.apiBaseUrl).port || '4981'
      log.info(`Server already running on port ${port}`)
      return port
    }
  }

  // Ensure the local data dir has been created
  initLocalDataDirs(config)
  // ...and the supervision layout, before the root-owned container can create
  // it instead and lock the hooks out of their own spool.
  ensureSupervisionDirs(config)

  // Check existing container state
  const state = await getContainerState(config)

  if (state) {
    if (state.running) {
      // Container is running — re-check health in case it came up between our first check and now
      const recheck = await getJson(`${config.apiBaseUrl}/health`)
      if (recheck.status === 200 && recheck.body?.ok) {
        const port = new URL(config.apiBaseUrl).port || '4981'
        log.info(`Server started by another process on port ${port}`)
        return port
      }
      // Running but not healthy — remove and do a fresh start
      log.warn('Container is running but unhealthy, restarting...')
      await safeRemoveContainer(config, log)
    } else if (config.instanceId && state.instanceId !== config.instanceId) {
      // A supervisor asked for a specific collector run; this container is a
      // different one and cannot become it.
      log.info('Recreating container for the requested collector instance...')
      await safeRemoveContainer(config, log)
    } else if (state.versionMatch) {
      // Stopped container with correct version — fast restart
      log.info(`Restarting stopped container (v${state.labelVersion})...`)
      const startResult = await run('docker', ['start', config.containerName])
      if (startResult.ok) {
        const port = config.serverPort
        saveServerPortFile(config, port)
        return await waitForHealth(config, port, log)
      }
      // docker start failed — fall through to fresh start
      log.warn(`Failed to restart container: ${startResult.stderr}`)
      await safeRemoveContainer(config, log)
    } else {
      // Stopped container with wrong version — remove for upgrade
      log.info(`Upgrading container from v${state.labelVersion} to v${config.expectedVersion}...`)
      await safeRemoveContainer(config, log)
    }
  }

  // -- Fresh start: pull + run ------------------------------------

  // Pull image (skipped in test harness when AGENTS_OBSERVE_TEST_SKIP_PULL=1)
  if (!config.testSkipPull) {
    log.info('Pulling image and starting container...')
    const pullResult = await run('docker', ['pull', config.dockerImage])
    if (!pullResult.ok) {
      log.error(`Failed to pull image: ${pullResult.stderr}`)
      return null
    }
  } else {
    log.info('AGENTS_OBSERVE_TEST_SKIP_PULL=1 — skipping docker pull (test harness)')
  }

  // Build docker run args from centralized server env
  const serverEnv = getServerEnv(config)
  const containerPort = serverEnv.AGENTS_OBSERVE_SERVER_PORT
  const preferredPort = config.serverPort
  const envArgs = Object.entries(serverEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  const labelValue = config.expectedVersion || 'unknown'

  function dockerRunArgs(portMapping) {
    // One mount per supported agent class. Each can resolve to a
    // different host path (user override) but the container side is
    // fixed so the server's resolveTranscriptPath knows where things
    // land. Missing host paths are silently skipped so e.g. a user
    // without codex installed doesn't error out.
    const transcriptMounts = buildTranscriptMounts({
      claudeHost: config.transcriptClaudeHost,
      codexHost: config.transcriptCodexHost,
      enabled: config.transcriptStatsEnabled,
      relabel: config.selinuxRelabel,
    })
    return [
      'run',
      '-d',
      '--name',
      config.containerName,
      '--label',
      `${config.dockerLabel}=${labelValue}`,
      // The collector run this container is. Supervision reads this label back
      // to tell this run from an earlier one that shared the container name —
      // the container equivalent of a PID's start time.
      '--label',
      `${config.dockerInstanceLabel}=${serverEnv.AGENTS_OBSERVE_INSTANCE_ID}`,
      '-p',
      portMapping,
      ...envArgs,
      '-v',
      buildDataMount(config.dataDir, config.selinuxRelabel),
      ...buildSupervisionMounts(config.supervisionDataRoot, config.selinuxRelabel),
      ...transcriptMounts,
      config.dockerImage,
    ]
  }

  // Try preferred port, fall back to auto-assign
  let runResult = await run(
    'docker',
    dockerRunArgs(buildPortMapping(config.serverBindHost, preferredPort, containerPort)),
  )
  let actualPort = preferredPort

  if (!runResult.ok && runResult.stderr.includes('port is already allocated')) {
    log.warn(`Port ${preferredPort} is in use, auto-assigning a free port...`)

    runResult = await run(
      'docker',
      dockerRunArgs(buildPortMapping(config.serverBindHost, 0, containerPort)),
    )

    if (!runResult.ok) {
      log.error(`Failed to start container: ${runResult.stderr}`)
      return null
    }

    const portResult = await run('docker', ['port', config.containerName, containerPort])
    if (portResult.ok) {
      const match = portResult.stdout.match(/:(\d+)$/)
      if (match) actualPort = match[1]
    }
  } else if (!runResult.ok) {
    log.error(`Failed to start container: ${runResult.stderr}`)
    return null
  }

  // Save port for hooks to discover
  saveServerPortFile(config, actualPort)

  return await waitForHealth(config, actualPort, log)
}

/**
 * Poll the health endpoint until the server is ready or we give up.
 * Returns the port on success, null on timeout.
 */
async function waitForHealth(config, port, log) {
  const apiUrl = `http://127.0.0.1:${port}/api`
  log.info('Waiting for server to start...')
  for (let i = 0; i < 15; i++) {
    const h = await getJson(`${apiUrl}/health`)
    if (h.status === 200 && h.body?.ok) {
      log.info('Server started successfully')
      return port
    }
    await new Promise((r) => setTimeout(r, 1000))
  }

  log.error('Server failed to start within 15 seconds')
  log.error(`Check: docker logs ${config.containerName}`)
  return null
}

/**
 * Stops the Docker container and cleans up the port file.
 * Container is stopped but NOT removed — it can be fast-restarted
 * on next startServer call if the version hasn't changed.
 */
export async function stopServer(config, log = console) {
  log.info('Stopping server...')
  if (await isOurContainer(config)) {
    await run('docker', ['stop', config.containerName])
  } else {
    const exists = await run('docker', ['inspect', config.containerName])
    if (exists.ok) {
      log.warn(
        `Container "${config.containerName}" is not managed by ${config.dockerLabel} — skipping stop`,
      )
    }
  }
  removeServerPortFile(config)
}
