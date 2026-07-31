// test/hooks/scripts/lib/docker.test.mjs
import { describe, it, expect } from 'vitest'
import {
  buildPortMapping,
  buildTranscriptMounts,
  buildDataMount,
  buildSupervisionMounts,
  evaluateHealthResponse,
} from '../../../../hooks/scripts/lib/docker.mjs'

describe('buildPortMapping (issue #22)', () => {
  it('prefixes the loopback bind host by default', () => {
    expect(buildPortMapping('127.0.0.1', 4981, 4981)).toBe('127.0.0.1:4981:4981')
  })

  it('supports auto-assign (host port 0) while keeping the loopback prefix', () => {
    expect(buildPortMapping('127.0.0.1', 0, 4981)).toBe('127.0.0.1:0:4981')
  })

  it('allows binding all interfaces for LAN access', () => {
    expect(buildPortMapping('0.0.0.0', 4981, 4981)).toBe('0.0.0.0:4981:4981')
  })

  it('omits the host prefix when bind host is empty (docker default)', () => {
    expect(buildPortMapping('', 4981, 4981)).toBe('4981:4981')
  })
})

describe('buildTranscriptMounts (issue #21)', () => {
  const alwaysExists = () => true
  const neverExists = () => false

  it('does NOT drop a Windows host path with a drive-letter colon', () => {
    // Regression: the old filter split the mount on ':' and mistook the
    // drive letter ("C") for the source, dropping both mounts on Windows.
    const mounts = buildTranscriptMounts(
      { claudeHost: 'C:\\Users\\me\\.claude\\projects', codexHost: '', enabled: true },
      alwaysExists,
    )
    expect(mounts).toEqual(['-v', 'C:\\Users\\me\\.claude\\projects:/host/.claude/projects:ro'])
  })

  it('mounts both agent classes on POSIX', () => {
    const mounts = buildTranscriptMounts(
      {
        claudeHost: '/home/me/.claude/projects',
        codexHost: '/home/me/.codex/sessions',
        enabled: true,
      },
      alwaysExists,
    )
    expect(mounts).toEqual([
      '-v',
      '/home/me/.claude/projects:/host/.claude/projects:ro',
      '-v',
      '/home/me/.codex/sessions:/host/.codex/sessions:ro',
    ])
  })

  it('skips a host path that does not exist', () => {
    const mounts = buildTranscriptMounts(
      {
        claudeHost: '/home/me/.claude/projects',
        codexHost: '/home/me/.codex/sessions',
        enabled: true,
      },
      (p) => p.includes('.claude'),
    )
    expect(mounts).toEqual(['-v', '/home/me/.claude/projects:/host/.claude/projects:ro'])
  })

  it('returns nothing when transcript stats are disabled', () => {
    expect(
      buildTranscriptMounts(
        {
          claudeHost: '/home/me/.claude/projects',
          codexHost: '/home/me/.codex/sessions',
          enabled: false,
        },
        alwaysExists,
      ),
    ).toEqual([])
  })

  it('returns nothing when no host path exists', () => {
    expect(
      buildTranscriptMounts(
        {
          claudeHost: '/home/me/.claude/projects',
          codexHost: '/home/me/.codex/sessions',
          enabled: true,
        },
        neverExists,
      ),
    ).toEqual([])
  })

  it('appends the shared SELinux relabel option (,z) when relabel is set (issue #20)', () => {
    const mounts = buildTranscriptMounts(
      {
        claudeHost: '/home/me/.claude/projects',
        codexHost: '/home/me/.codex/sessions',
        enabled: true,
        relabel: true,
      },
      alwaysExists,
    )
    expect(mounts).toEqual([
      '-v',
      '/home/me/.claude/projects:/host/.claude/projects:ro,z',
      '-v',
      '/home/me/.codex/sessions:/host/.codex/sessions:ro,z',
    ])
  })
})

describe('buildDataMount (issue #20)', () => {
  it('mounts the data dir at /data without a relabel option by default', () => {
    expect(buildDataMount('/home/me/.agents-observe/data')).toBe(
      '/home/me/.agents-observe/data:/data',
    )
  })

  it('appends the SELinux relabel option (:z) when relabel is set', () => {
    expect(buildDataMount('/home/me/.agents-observe/data', true)).toBe(
      '/home/me/.agents-observe/data:/data:z',
    )
  })

  it('does not relabel when relabel is false', () => {
    expect(buildDataMount('/home/me/.agents-observe/data', false)).toBe(
      '/home/me/.agents-observe/data:/data',
    )
  })
})

// The container and the hooks share one supervision data root: the hooks write
// the spool, the collector inside the container drains it, and both read the
// same lock and heartbeat. That only works if the path means the same thing on
// both sides — see docs/collector-supervision.md.
describe('buildSupervisionMounts', () => {
  it('mounts the data root at the same absolute path inside the container', () => {
    expect(buildSupervisionMounts('/home/you/.agents-observe')).toEqual([
      '-v',
      '/home/you/.agents-observe:/home/you/.agents-observe',
    ])
  })

  it('appends the SELinux relabel option when asked (issue #20)', () => {
    expect(buildSupervisionMounts('/home/you/.agents-observe', true)).toEqual([
      '-v',
      '/home/you/.agents-observe:/home/you/.agents-observe:z',
    ])
  })

  it('mounts nothing when there is no data root to share', () => {
    expect(buildSupervisionMounts('')).toEqual([])
    expect(buildSupervisionMounts(undefined)).toEqual([])
  })

  it('refuses a non-absolute root, which could not be mounted at its own path', () => {
    // The shell kernel rejects these outright (observe_data_root_is_safe), and
    // a Windows host path cannot be a Linux container path either.
    expect(buildSupervisionMounts('relative/path')).toEqual([])
    expect(buildSupervisionMounts('C:\\Users\\you\\.agents-observe')).toEqual([])
  })
})

// The acceptance rule that decides "this server is already the collector I
// asked for". Its whole reason to exist is that a healthy API at the right
// version is not evidence of that — see the block comment on the function.
describe('evaluateHealthResponse', () => {
  const DATA_ROOT = '/home/you/.agents-observe'
  const INSTANCE = 'instance-a'

  const supervisor = {
    API_ID: 'agents-observe',
    expectedVersion: '0.9.13',
    instanceId: INSTANCE,
    supervisionDataRoot: DATA_ROOT,
  }
  // No instance requested: a plain `observe start`, not a supervised arm.
  const plain = { ...supervisor, instanceId: '' }

  const ok = (body) => ({ status: 200, body })
  const collector = (over = {}) => ({
    instanceId: INSTANCE,
    dataRoot: DATA_ROOT,
    status: 'healthy',
    reason: null,
    ...over,
  })
  const current = (over = {}) => ({
    ok: true,
    id: 'agents-observe',
    version: '0.9.13',
    collector: collector(),
    ...over,
  })

  it('accepts a supervision-capable server running the requested instance', () => {
    expect(evaluateHealthResponse(supervisor, ok(current()))).toMatchObject({ ok: true })
  })

  // The regression this whole change exists for: the published image and the
  // source tree drifted apart while both called themselves the same version.
  // A same-version server with no collector block must never be reported as
  // "already running" — the supervisor would then wait out its entire
  // confirmation window for a collector that can never appear.
  it('rejects a legacy same-version server as incompatible, not as already running', () => {
    const legacy = ok({
      ok: true,
      id: 'agents-observe',
      version: '0.9.13',
      runtime: 'docker',
      dbPath: '/home/you/.agents-observe/data/observe.db',
      activeConsumers: 0,
      activeClients: 2,
      transcriptStatsEnabled: true,
    })

    const verdict = evaluateHealthResponse(supervisor, legacy)

    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('incompatible-collector')
    expect(verdict.detail).toContain('collector block')
  })

  it('still accepts that legacy server when no collector run was requested', () => {
    // `observe start` by hand has no supervision contract to enforce, and
    // breaking it would make the CLI unusable against any older server.
    const legacy = ok({ ok: true, id: 'agents-observe', version: '0.9.13' })
    expect(evaluateHealthResponse(plain, legacy)).toMatchObject({ ok: true })
  })

  it('rejects a supervised collector that is a different run', () => {
    const verdict = evaluateHealthResponse(
      supervisor,
      ok(current({ collector: collector({ instanceId: 'instance-b' }) })),
    )
    expect(verdict).toMatchObject({ ok: false, reason: 'collector-mismatch' })
    expect(verdict.detail).toContain('instance-b')
  })

  it('rejects a collector supervising a different data root', () => {
    // Same run id, other root: its lock and heartbeat land where this caller
    // will never read them.
    const verdict = evaluateHealthResponse(
      supervisor,
      ok(current({ collector: collector({ dataRoot: '/tmp/other-root' }) })),
    )
    expect(verdict).toMatchObject({ ok: false, reason: 'collector-mismatch' })
  })

  it('rejects a collector that is present but not healthy, and says why', () => {
    const verdict = evaluateHealthResponse(
      supervisor,
      ok(current({ collector: collector({ status: 'unhealthy', reason: 'stale-heartbeat' }) })),
    )
    expect(verdict).toMatchObject({ ok: false, reason: 'collector-unhealthy' })
    expect(verdict.detail).toContain('stale-heartbeat')
  })

  it('separates a wrong version from a missing collector', () => {
    // Version is checked first: an older image is an upgrade (recreate the
    // container), not the unrecoverable same-version drift.
    const verdict = evaluateHealthResponse(supervisor, ok(current({ version: '0.9.12' })))
    expect(verdict).toMatchObject({ ok: false, reason: 'version-mismatch' })
    expect(verdict.detail).toContain('0.9.12')
  })

  it('separates another service on the port from our own server', () => {
    expect(
      evaluateHealthResponse(supervisor, ok({ ok: true, id: 'something-else' })),
    ).toMatchObject({ ok: false, reason: 'foreign-service' })
  })

  it('treats a non-200, an unhealthy body, and no response at all as unavailable', () => {
    expect(evaluateHealthResponse(supervisor, { status: 503, body: { ok: false } })).toMatchObject({
      ok: false,
      reason: 'unavailable',
    })
    expect(evaluateHealthResponse(supervisor, ok({ ok: false }))).toMatchObject({
      ok: false,
      reason: 'unavailable',
    })
    expect(evaluateHealthResponse(supervisor, { status: 0, body: null })).toMatchObject({
      ok: false,
      reason: 'unavailable',
    })
  })
})
