import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveGitOriginProjectSlug, normalizeRemoteUrlToSlug } from './git-origin'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'git-origin-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * Builds a `<root>/bare.git` common git dir with an `origin` remote, a
 * `worktrees/<name>` admin dir with a `commondir` pointer back to it, and
 * a `<root>/worktree` checkout dir whose `.git` file points at the admin
 * dir — the same shape as a no-mistakes run worktree.
 */
function makeWorktreeLayout(originUrl: string) {
  const bareDir = join(root, 'bare.git')
  const worktreeAdminDir = join(bareDir, 'worktrees', 'wt-name')
  const checkoutDir = join(root, 'worktree')
  mkdirSync(worktreeAdminDir, { recursive: true })
  mkdirSync(checkoutDir, { recursive: true })
  writeFileSync(
    join(bareDir, 'config'),
    `[remote "origin"]\n\turl = ${originUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
  )
  writeFileSync(join(worktreeAdminDir, 'commondir'), '../..\n')
  writeFileSync(join(checkoutDir, '.git'), `gitdir: ${worktreeAdminDir}\n`)
  return checkoutDir
}

describe('resolveGitOriginProjectSlug', () => {
  test('resolves an HTTPS origin through the worktree indirection', async () => {
    const checkoutDir = makeWorktreeLayout('https://github.com/huang-daniel/yogi-flow.git')
    expect(await resolveGitOriginProjectSlug(checkoutDir)).toBe('yogi-flow')
  })

  test('resolves an SSH origin through the worktree indirection', async () => {
    const checkoutDir = makeWorktreeLayout('git@github.com:huang-daniel/yogi-flow.git')
    expect(await resolveGitOriginProjectSlug(checkoutDir)).toBe('yogi-flow')
  })

  test('same repo, SSH vs HTTPS, produces the same slug', async () => {
    const httpsDir = makeWorktreeLayout('https://github.com/huang-daniel/yogi-flow.git')
    expect(await resolveGitOriginProjectSlug(httpsDir)).toBe(
      normalizeRemoteUrlToSlug('git@github.com:huang-daniel/yogi-flow.git'),
    )
  })

  test('resolves from a subdirectory of the worktree checkout', async () => {
    const checkoutDir = makeWorktreeLayout('https://github.com/huang-daniel/yogi-flow.git')
    const subdir = join(checkoutDir, 'src', 'nested')
    mkdirSync(subdir, { recursive: true })
    expect(await resolveGitOriginProjectSlug(subdir)).toBe('yogi-flow')
  })

  test('returns null for a plain checkout with a real .git directory', async () => {
    const plainDir = join(root, 'plain-repo')
    mkdirSync(join(plainDir, '.git'), { recursive: true })
    expect(await resolveGitOriginProjectSlug(plainDir)).toBeNull()
  })

  test('returns null when no .git entry is found at all', async () => {
    const bareDir = join(root, 'no-git-here')
    mkdirSync(bareDir, { recursive: true })
    expect(await resolveGitOriginProjectSlug(bareDir)).toBeNull()
  })

  test('returns null for null startCwd', async () => {
    expect(await resolveGitOriginProjectSlug(null)).toBeNull()
  })

  test('returns null when the worktree admin dir has no commondir file', async () => {
    const adminDir = join(root, 'bare.git', 'worktrees', 'wt')
    const checkoutDir = join(root, 'checkout')
    mkdirSync(adminDir, { recursive: true })
    mkdirSync(checkoutDir, { recursive: true })
    writeFileSync(join(checkoutDir, '.git'), `gitdir: ${adminDir}\n`)
    expect(await resolveGitOriginProjectSlug(checkoutDir)).toBeNull()
  })

  test('returns null when the common git dir has no origin remote', async () => {
    const bareDir = join(root, 'bare.git')
    const adminDir = join(bareDir, 'worktrees', 'wt')
    const checkoutDir = join(root, 'checkout')
    mkdirSync(adminDir, { recursive: true })
    mkdirSync(checkoutDir, { recursive: true })
    writeFileSync(join(bareDir, 'config'), '[core]\n\trepositoryformatversion = 0\n')
    writeFileSync(join(adminDir, 'commondir'), '../..\n')
    writeFileSync(join(checkoutDir, '.git'), `gitdir: ${adminDir}\n`)
    expect(await resolveGitOriginProjectSlug(checkoutDir)).toBeNull()
  })

  test('returns null when the .git file has no gitdir pointer', async () => {
    const checkoutDir = join(root, 'checkout')
    mkdirSync(checkoutDir, { recursive: true })
    writeFileSync(join(checkoutDir, '.git'), 'not a valid git file\n')
    expect(await resolveGitOriginProjectSlug(checkoutDir)).toBeNull()
  })
})

describe('normalizeRemoteUrlToSlug', () => {
  test('normalizes an HTTPS URL with .git suffix', () => {
    expect(normalizeRemoteUrlToSlug('https://github.com/owner/repo.git')).toBe('repo')
  })

  test('normalizes an HTTPS URL without .git suffix', () => {
    expect(normalizeRemoteUrlToSlug('https://github.com/owner/repo')).toBe('repo')
  })

  test('normalizes an SSH scp-style URL', () => {
    expect(normalizeRemoteUrlToSlug('git@github.com:owner/repo.git')).toBe('repo')
  })

  test('normalizes an ssh:// URL', () => {
    expect(normalizeRemoteUrlToSlug('ssh://git@github.com/owner/repo.git')).toBe('repo')
  })

  test('normalizes a local absolute path remote', () => {
    expect(normalizeRemoteUrlToSlug('/home/dev/.no-mistakes/repos/abc123.git')).toBe('abc123')
  })

  test('lowercases and hyphenates the repo name', () => {
    expect(normalizeRemoteUrlToSlug('https://github.com/owner/My_Repo.git')).toBe('my-repo')
  })

  test('returns null for an unrecognized relative shape', () => {
    expect(normalizeRemoteUrlToSlug('just-some-text')).toBeNull()
  })

  test('returns null for an empty path after normalization', () => {
    expect(normalizeRemoteUrlToSlug('https://github.com/')).toBeNull()
  })
})
