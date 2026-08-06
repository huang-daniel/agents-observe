// app/server/src/services/git-origin.ts
//
// Resolves the real origin repo for a worktree-based session cwd, so
// launchers that spawn agents into scratch git worktrees (no-mistakes's
// `~/.no-mistakes/worktrees/<hash>/<ULID>`, or any other tool using the
// same layout) get attributed to their real repo project instead of a
// meaningless worktree-directory-name project.
//
// A worktree checkout has a `.git` *file* (not directory) containing
// `gitdir: <bare-repo>/worktrees/<name>`. That per-worktree admin dir
// holds a `commondir` file pointing back to the repo's real git dir,
// whose `config` has the `[remote "origin"]` URL we want. This walks
// that chain and normalizes the URL to a project slug. Any missing file,
// unexpected shape, or unparsable URL is treated as "not applicable" —
// this never throws, it only returns null so callers fall through to
// their existing resolution logic.

import { promises as fsp } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { deriveSlugFromPath } from '../utils/slug'

async function readFileIfExists(path: string): Promise<string | null> {
  try {
    return await fsp.readFile(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Walks up from `startCwd` looking for the nearest `.git` entry. Returns
 * its path only when it's a *file* (the worktree/submodule indirection
 * case); a directory `.git` means a plain checkout, which isn't this
 * function's concern, so that returns null without walking further.
 */
async function findGitFile(startCwd: string): Promise<string | null> {
  let dir = startCwd.replace(/\/+$/, '')
  for (;;) {
    const candidate = `${dir}/.git`
    try {
      const stat = await fsp.lstat(candidate)
      return stat.isFile() ? candidate : null
    } catch {
      // no .git here — keep walking up.
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Parses the `gitdir: <path>` pointer out of a worktree/submodule `.git` file. */
async function readGitdirPointer(gitFilePath: string): Promise<string | null> {
  const content = await readFileIfExists(gitFilePath)
  if (!content) return null
  const match = content.match(/^gitdir:\s*(.+?)\s*$/m)
  if (!match) return null
  const raw = match[1]
  if (!raw) return null
  return isAbsolute(raw) ? raw : resolve(dirname(gitFilePath), raw)
}

/** Resolves the `commondir` pointer from a worktree admin dir to the real git dir. */
async function readCommonGitDir(worktreeGitDir: string): Promise<string | null> {
  const content = await readFileIfExists(`${worktreeGitDir}/commondir`)
  if (content === null) return null
  const raw = content.trim()
  if (!raw) return null
  return isAbsolute(raw) ? raw : resolve(worktreeGitDir, raw)
}

/** Parses the `[remote "origin"] url = ...` line out of a git `config` file. */
async function readOriginUrl(commonGitDir: string): Promise<string | null> {
  const content = await readFileIfExists(`${commonGitDir}/config`)
  if (!content) return null
  const sectionMatch = content.match(/\[remote\s+"origin"\][^[]*/i)
  if (!sectionMatch) return null
  const urlMatch = sectionMatch[0].match(/^\s*url\s*=\s*(.+?)\s*$/m)
  if (!urlMatch) return null
  const url = urlMatch[1].trim()
  return url || null
}

/**
 * Normalizes a git remote URL to a project slug derived from the repo
 * name, so SSH and HTTPS forms of the same repo produce the same slug.
 * Returns null for shapes that can't be confidently parsed rather than
 * guessing.
 */
export function normalizeRemoteUrlToSlug(url: string): string | null {
  let path: string | null = null

  // SSH scp-like syntax: user@host:owner/repo(.git)? — must be checked
  // before URL parsing since `new URL()` doesn't accept this form.
  const scpMatch = url.match(/^[\w.-]+@[\w.-]+:(.+)$/)
  if (scpMatch) {
    path = scpMatch[1]
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    // A URL with an explicit scheme: https://, http://, ssh://, git://, file://.
    try {
      path = new URL(url).pathname
    } catch {
      return null
    }
  } else if (isAbsolute(url)) {
    // A local filesystem remote (e.g. another bare repo on disk).
    path = url
  } else {
    return null
  }

  if (!path) return null
  path = path.replace(/\/+$/, '').replace(/\.git$/i, '')
  const segments = path.split(/[\/:]/).filter(Boolean)
  if (segments.length === 0) return null

  const slug = deriveSlugFromPath(segments[segments.length - 1])
  return slug === 'unnamed' ? null : slug
}

/**
 * Resolves the project slug for `startCwd` by following its worktree
 * `.git` indirection to the real repo's `origin` remote. Returns null
 * (never throws) whenever any step doesn't apply: no `.git` file, no
 * worktree/commondir indirection, no `origin` remote, or an unparsable
 * URL — callers should fall through to their existing fallback in that
 * case.
 */
export async function resolveGitOriginProjectSlug(startCwd: string | null): Promise<string | null> {
  if (!startCwd) return null
  const gitFile = await findGitFile(startCwd)
  if (!gitFile) return null
  const worktreeGitDir = await readGitdirPointer(gitFile)
  if (!worktreeGitDir) return null
  const commonGitDir = await readCommonGitDir(worktreeGitDir)
  if (!commonGitDir) return null
  const originUrl = await readOriginUrl(commonGitDir)
  if (!originUrl) return null
  return normalizeRemoteUrlToSlug(originUrl)
}
