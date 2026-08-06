import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAdapter } from '../storage/sqlite-adapter'
import { findExistingWorktreeProjectSlug, resolveProject } from './project-resolver'

let store: SqliteAdapter

beforeEach(() => {
  store = new SqliteAdapter(':memory:')
})

async function seedSession(opts: {
  id: string
  projectId?: number | null
  slug?: string | null
  startCwd?: string | null
  transcriptPath?: string | null
  lastActivity?: number
}) {
  await store.upsertSession(
    opts.id,
    opts.projectId ?? null,
    opts.slug ?? null,
    null,
    opts.lastActivity ?? 1000,
    opts.transcriptPath ?? null,
    opts.startCwd ?? null,
  )
}

describe('resolveProject', () => {
  test('returns existing project id when session already assigned', async () => {
    const id = await store.findOrCreateProjectBySlug('existing')
    const result = await resolveProject(store, {
      sessionId: 'sess1',
      currentProjectId: id.id,
      startCwd: null,
      transcriptPath: null,
    })
    expect(result).toBe(id.id)
  })

  test('honors explicit _meta.project.id', async () => {
    const proj = await store.findOrCreateProjectBySlug('alpha')
    const result = await resolveProject(store, {
      sessionId: 'sess1',
      meta: { id: proj.id },
      currentProjectId: null,
      startCwd: null,
      transcriptPath: null,
    })
    expect(result).toBe(proj.id)
  })

  test('explicit _meta.project.slug — creates if missing', async () => {
    const result = await resolveProject(store, {
      sessionId: 'sess1',
      meta: { slug: 'fresh-slug' },
      currentProjectId: null,
      startCwd: null,
      transcriptPath: null,
    })
    expect(result).not.toBeNull()
    const proj = await store.getProjectBySlug('fresh-slug')
    expect(proj?.id).toBe(result)
  })

  test('explicit _meta.project.slug — finds existing', async () => {
    const existing = await store.findOrCreateProjectBySlug('reused-slug')
    const result = await resolveProject(store, {
      sessionId: 'sess1',
      meta: { slug: 'reused-slug' },
      currentProjectId: null,
      startCwd: null,
      transcriptPath: null,
    })
    expect(result).toBe(existing.id)
  })

  test('falls through when explicit project.id does not exist', async () => {
    const result = await resolveProject(store, {
      sessionId: 'sess1',
      meta: { id: 999_999 },
      currentProjectId: null,
      startCwd: null,
      transcriptPath: null,
    })
    expect(result).toBeNull()
  })

  test('flags.resolveProject — sibling match by start_cwd', async () => {
    const proj = await store.findOrCreateProjectBySlug('shared')
    await seedSession({ id: 'sib', projectId: proj.id, startCwd: '/Users/joe/repo' })
    const result = await resolveProject(store, {
      sessionId: 'new',
      flags: { resolveProject: true },
      currentProjectId: null,
      startCwd: '/Users/joe/repo',
      transcriptPath: null,
    })
    expect(result).toBe(proj.id)
  })

  test('flags.resolveProject — sibling match by transcript basedir', async () => {
    const proj = await store.findOrCreateProjectBySlug('via-transcript')
    await seedSession({
      id: 'sib',
      projectId: proj.id,
      transcriptPath: '/Users/joe/.claude/projects/my-app/session-a.jsonl',
    })
    const result = await resolveProject(store, {
      sessionId: 'new',
      flags: { resolveProject: true },
      currentProjectId: null,
      startCwd: null,
      transcriptPath: '/Users/joe/.claude/projects/my-app/session-b.jsonl',
    })
    expect(result).toBe(proj.id)
  })

  test('flags.resolveProject — cwd takes precedence over a shared transcript basedir', async () => {
    const alpha = await resolveProject(store, {
      sessionId: 'alpha-session',
      flags: { resolveProject: true },
      currentProjectId: null,
      startCwd: '/repos/alpha',
      transcriptPath: '/Users/joe/.codex/sessions/2026/07/30/rollout-alpha.jsonl',
    })
    await seedSession({
      id: 'alpha-session',
      projectId: alpha,
      startCwd: '/repos/alpha',
      transcriptPath: '/Users/joe/.codex/sessions/2026/07/30/rollout-alpha.jsonl',
    })

    const beta = await resolveProject(store, {
      sessionId: 'beta-session',
      flags: { resolveProject: true },
      currentProjectId: null,
      startCwd: '/repos/beta',
      transcriptPath: '/Users/joe/.codex/sessions/2026/07/30/rollout-beta.jsonl',
    })

    expect(beta).not.toBe(alpha)
    expect((await store.getProjectById(beta!)).slug).toBe('beta')
  })

  test('flags.resolveProject — most recent sibling wins', async () => {
    const projOld = await store.findOrCreateProjectBySlug('old')
    const projNew = await store.findOrCreateProjectBySlug('new')
    await seedSession({
      id: 'sib-old',
      projectId: projOld.id,
      startCwd: '/repo',
      lastActivity: 1000,
    })
    await seedSession({
      id: 'sib-new',
      projectId: projNew.id,
      startCwd: '/repo',
      lastActivity: 5000,
    })
    const result = await resolveProject(store, {
      sessionId: 'fresh',
      flags: { resolveProject: true },
      currentProjectId: null,
      startCwd: '/repo',
      transcriptPath: null,
    })
    expect(result).toBe(projNew.id)
  })

  test('flags.resolveProject — no siblings → creates new project from cwd basename', async () => {
    const result = await resolveProject(store, {
      sessionId: 'sess1',
      flags: { resolveProject: true },
      currentProjectId: null,
      startCwd: '/Users/joe/Development/my-app',
      transcriptPath: null,
    })
    expect(result).not.toBeNull()
    const proj = await store.getProjectById(result!)
    expect(proj.slug).toBe('my-app')
  })

  test('flags.resolveProject — no cwd, falls back to transcript basedir basename', async () => {
    const result = await resolveProject(store, {
      sessionId: 'sess1',
      flags: { resolveProject: true },
      currentProjectId: null,
      startCwd: null,
      transcriptPath: '/Users/joe/.claude/projects/my-app/session.jsonl',
    })
    expect(result).not.toBeNull()
    const proj = await store.getProjectById(result!)
    expect(proj.slug).toBe('my-app')
  })

  test('flags.resolveProject — no signal → returns null', async () => {
    const result = await resolveProject(store, {
      sessionId: 'sess1',
      flags: { resolveProject: true },
      currentProjectId: null,
      startCwd: null,
      transcriptPath: null,
    })
    expect(result).toBeNull()
  })

  test('no flag and no slug → returns null (sessions land unassigned)', async () => {
    const result = await resolveProject(store, {
      sessionId: 'sess1',
      currentProjectId: null,
      startCwd: '/Users/joe/repo',
      transcriptPath: '/Users/joe/.claude/projects/foo/session.jsonl',
    })
    expect(result).toBeNull()
  })

  test('UNIQUE collision on slug recovers via re-select', async () => {
    // Seed the slug already so the INSERT in findOrCreateProjectBySlug
    // hits the ON CONFLICT branch.
    const first = await store.findOrCreateProjectBySlug('clash')
    expect(first.created).toBe(true)
    const result = await resolveProject(store, {
      sessionId: 'sess1',
      meta: { slug: 'clash' },
      currentProjectId: null,
      startCwd: null,
      transcriptPath: null,
    })
    expect(result).toBe(first.id)
  })

  test('flags.resolveProject — worktree path joins existing parent project', async () => {
    const proj = await store.findOrCreateProjectBySlug('my-app')
    const result = await resolveProject(store, {
      sessionId: 'wt-sess',
      flags: { resolveProject: true },
      currentProjectId: null,
      startCwd: '/Users/joe/dev/my-app/.worktrees/feat-foo',
      transcriptPath: null,
    })
    expect(result).toBe(proj.id)
    // The worktree-branch slug must NOT have been auto-created.
    const featProj = await store.getProjectBySlug('feat-foo')
    expect(featProj).toBeNull()
  })

  test('flags.resolveProject — .claude/worktrees variant joins existing parent', async () => {
    const proj = await store.findOrCreateProjectBySlug('my-app')
    const result = await resolveProject(store, {
      sessionId: 'wt-sess',
      flags: { resolveProject: true },
      currentProjectId: null,
      startCwd: '/Users/joe/dev/my-app/.claude/worktrees/feat-foo',
      transcriptPath: null,
    })
    expect(result).toBe(proj.id)
  })

  test('flags.resolveProject — worktree path with no matching parent project creates branch-name project (regression guard)', async () => {
    const result = await resolveProject(store, {
      sessionId: 'wt-sess',
      flags: { resolveProject: true },
      currentProjectId: null,
      startCwd: '/Users/joe/dev/my-app/.worktrees/feat-foo',
      transcriptPath: null,
    })
    expect(result).not.toBeNull()
    const proj = await store.getProjectById(result!)
    expect(proj.slug).toBe('feat-foo')
  })

  describe('git-origin fallback (no-mistakes-style worktree layout)', () => {
    let root = ''

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'project-resolver-git-origin-'))
    })

    afterEach(() => {
      rmSync(root, { recursive: true, force: true })
    })

    function makeNoMistakesStyleWorktree(originUrl: string): string {
      const bareDir = join(root, 'repos', 'abc123.git')
      const adminDir = join(bareDir, 'worktrees', '01ULID')
      const checkoutDir = join(root, 'worktrees', 'abc123', '01ULID')
      mkdirSync(adminDir, { recursive: true })
      mkdirSync(checkoutDir, { recursive: true })
      writeFileSync(join(bareDir, 'config'), `[remote "origin"]\n\turl = ${originUrl}\n`)
      writeFileSync(join(adminDir, 'commondir'), '../..\n')
      writeFileSync(join(checkoutDir, '.git'), `gitdir: ${adminDir}\n`)
      return checkoutDir
    }

    test('resolves the real repo instead of the ULID basename, and creates the project', async () => {
      const checkoutDir = makeNoMistakesStyleWorktree(
        'https://github.com/huang-daniel/yogi-flow.git',
      )
      const result = await resolveProject(store, {
        sessionId: 'nm-sess',
        flags: { resolveProject: true },
        currentProjectId: null,
        startCwd: checkoutDir,
        transcriptPath: null,
      })
      expect(result).not.toBeNull()
      const proj = await store.getProjectById(result!)
      expect(proj.slug).toBe('yogi-flow')
    })

    test('joins an existing project created by a prior worktree run of the same repo', async () => {
      const existing = await store.findOrCreateProjectBySlug('yogi-flow')
      const checkoutDir = makeNoMistakesStyleWorktree('git@github.com:huang-daniel/yogi-flow.git')
      const result = await resolveProject(store, {
        sessionId: 'nm-sess-2',
        flags: { resolveProject: true },
        currentProjectId: null,
        startCwd: checkoutDir,
        transcriptPath: null,
      })
      expect(result).toBe(existing.id)
    })

    test('falls through to ULID basename when the worktree has no resolvable origin', async () => {
      const bareDir = join(root, 'repos', 'abc123.git')
      const adminDir = join(bareDir, 'worktrees', '01ULID')
      const checkoutDir = join(root, 'worktrees', 'abc123', '01ULID')
      mkdirSync(adminDir, { recursive: true })
      mkdirSync(checkoutDir, { recursive: true })
      writeFileSync(join(bareDir, 'config'), '[core]\n\trepositoryformatversion = 0\n')
      writeFileSync(join(adminDir, 'commondir'), '../..\n')
      writeFileSync(join(checkoutDir, '.git'), `gitdir: ${adminDir}\n`)

      const result = await resolveProject(store, {
        sessionId: 'nm-sess-3',
        flags: { resolveProject: true },
        currentProjectId: null,
        startCwd: checkoutDir,
        transcriptPath: null,
      })
      expect(result).not.toBeNull()
      const proj = await store.getProjectById(result!)
      expect(proj.slug).toBe('01ulid')
    })

    test('plain non-worktree checkout is unaffected (still uses cwd basename)', async () => {
      const plainDir = join(root, 'my-real-project')
      mkdirSync(join(plainDir, '.git'), { recursive: true })
      const result = await resolveProject(store, {
        sessionId: 'plain-sess',
        flags: { resolveProject: true },
        currentProjectId: null,
        startCwd: plainDir,
        transcriptPath: null,
      })
      expect(result).not.toBeNull()
      const proj = await store.getProjectById(result!)
      expect(proj.slug).toBe('my-real-project')
    })
  })
})

describe('findExistingWorktreeProjectSlug', () => {
  test('returns null for null cwd', () => {
    expect(findExistingWorktreeProjectSlug(null)).toBeNull()
  })

  test('returns null for empty string', () => {
    expect(findExistingWorktreeProjectSlug('')).toBeNull()
  })

  test('returns null when no worktree segment is present', () => {
    expect(findExistingWorktreeProjectSlug('/Users/joe/dev/my-app/src')).toBeNull()
  })

  test('matches `.worktrees` and returns parent dir slug', () => {
    expect(findExistingWorktreeProjectSlug('/Users/joe/dev/my-app/.worktrees/feat-foo')).toBe(
      'my-app',
    )
  })

  test('matches `.claude/worktrees` and skips `.claude` dotfile ancestor', () => {
    expect(
      findExistingWorktreeProjectSlug('/Users/joe/dev/my-app/.claude/worktrees/feat-foo'),
    ).toBe('my-app')
  })

  test('matches `.codex/worktrees` and skips `.codex` dotfile ancestor', () => {
    expect(findExistingWorktreeProjectSlug('/Users/joe/dev/my-app/.codex/worktrees/feat')).toBe(
      'my-app',
    )
  })

  test('matches plain `worktrees` (no leading dot)', () => {
    expect(findExistingWorktreeProjectSlug('/Users/joe/dev/my-app/worktrees/feat')).toBe('my-app')
  })

  test('matches singular `worktree`', () => {
    expect(findExistingWorktreeProjectSlug('/Users/joe/dev/my-app/worktree/feat')).toBe('my-app')
  })

  test('returns null when every ancestor is a dotfile dir', () => {
    expect(findExistingWorktreeProjectSlug('/.dev/.repo/.worktrees/x')).toBeNull()
  })

  test('tolerates a trailing slash on cwd', () => {
    expect(findExistingWorktreeProjectSlug('/Users/joe/dev/my-app/.worktrees/feat-foo/')).toBe(
      'my-app',
    )
  })

  test('returns null when worktree segment has no non-dot ancestor', () => {
    expect(findExistingWorktreeProjectSlug('/.worktrees/feat')).toBeNull()
  })

  test('normalizes the candidate slug through deriveSlugFromPath', () => {
    expect(findExistingWorktreeProjectSlug('/Users/joe/dev/My_App!/.worktrees/feat')).toBe('my-app')
  })
})
