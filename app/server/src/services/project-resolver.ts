// app/server/src/services/project-resolver.ts
//
// Project resolution per the three-layer contract spec
// (docs/specs/2026-04-25-three-layer-contract-design.md
// §"Project resolution algorithm").
//
// Trigger contract:
//  - The resolver runs at most once per session-event ingest. Callers
//    invoke it after the session row has been upserted, passing
//    `currentProjectId` from the freshly-read session.
//  - If the session already has a project_id, the resolver short-circuits
//    (sticky after first assignment).
//  - Explicit `_meta.project.id` and `_meta.project.slug` are honored
//    unconditionally; sibling matching only fires when the envelope
//    sets `flags.resolveProject`.
//
// Returns the project_id the caller should write back, or `null` to
// leave the session unassigned.

import { dirname } from 'node:path'
import type { EventStore } from '../storage/types'
import type { EventEnvelopeCreationHints, EventEnvelopeFlags } from '../types'
import { deriveSlugFromPath } from '../utils/slug'
import { resolveGitOriginProjectSlug } from './git-origin'

const WORKTREE_SEGMENT_RE = /^\.?worktrees?$/

/**
 * Detects a worktree-style cwd and returns the slug of the most likely
 * parent-repo project for a *match-only* lookup. Walks the path from
 * right to left for a `worktree` / `worktrees` / `.worktree` /
 * `.worktrees` segment, then continues leftward past any dotfile
 * directory (e.g. `.claude`, `.codex`) to the first non-dot ancestor.
 * Returns `null` when no worktree segment is found, when the worktree
 * segment is at the root, or when every ancestor is a dotfile dir.
 *
 * The returned slug is normalized via `deriveSlugFromPath` so it can
 * be compared directly against `projects.slug` values.
 */
export function findExistingWorktreeProjectSlug(startCwd: string | null): string | null {
  if (!startCwd) return null
  const parts = startCwd.split('/').filter(Boolean)
  let worktreeIdx = -1
  for (let i = parts.length - 1; i >= 0; i--) {
    if (WORKTREE_SEGMENT_RE.test(parts[i])) {
      worktreeIdx = i
      break
    }
  }
  if (worktreeIdx <= 0) return null
  for (let i = worktreeIdx - 1; i >= 0; i--) {
    if (!parts[i].startsWith('.')) {
      return deriveSlugFromPath(parts[i])
    }
  }
  return null
}

export interface ResolveProjectInput {
  sessionId: string
  meta?: EventEnvelopeCreationHints['project']
  flags?: EventEnvelopeFlags
  /** sessions.start_cwd for this session (already populated). */
  startCwd: string | null
  /** sessions.transcript_path for this session (already populated). */
  transcriptPath: string | null
  /** sessions.project_id from the freshly-read row. */
  currentProjectId: number | null
}

/**
 * 'pipeline' — resolved by walking a worktree cwd (or its git origin) to
 * a parent project, i.e. the session was launched by a worktree-based
 * verification pipeline (no-mistakes or any future launcher matching the
 * same `WORKTREE_SEGMENT_RE` / git-origin-walk path) rather than run
 * directly in the project's own checkout.
 * 'direct' — every other resolution path (explicit meta, sibling match,
 * cwd/transcript basename fallback).
 * `null` — session is still unassigned, or already had a project (the
 * short-circuit path doesn't re-derive origin).
 */
export type SessionOriginKind = 'pipeline' | 'direct'

export interface ResolveProjectResult {
  projectId: number | null
  originKind: SessionOriginKind | null
}

export async function resolveProject(
  store: EventStore,
  input: ResolveProjectInput,
): Promise<ResolveProjectResult> {
  if (input.currentProjectId !== null && input.currentProjectId !== undefined) {
    return { projectId: input.currentProjectId, originKind: null }
  }

  // Explicit project.id wins (validated to exist).
  if (input.meta?.id !== undefined && input.meta.id !== null) {
    const exists = await store.getProjectById(input.meta.id)
    if (exists) return { projectId: exists.id, originKind: 'direct' }
    // Fall through if the id is invalid — better to attempt slug/sibling
    // resolution than leave the session unassigned because of a stale id.
  }

  // Explicit project.slug — find or create.
  if (input.meta?.slug) {
    const result = await store.findOrCreateProjectBySlug(input.meta.slug)
    return { projectId: result.id, originKind: 'direct' }
  }

  // Sibling matching only fires on explicit flag.
  if (input.flags?.resolveProject) {
    const transcriptBasedir = input.transcriptPath ? dirname(input.transcriptPath) : null
    const sibling = await store.findSiblingSessionWithProject({
      startCwd: input.startCwd,
      transcriptBasedir,
      excludeSessionId: input.sessionId,
    })
    if (sibling) return { projectId: sibling.projectId, originKind: 'direct' }

    // Worktree-aware match against an EXISTING project. Match-only —
    // never creates from the walk-up candidate, so unrelated ancestor
    // dirs (e.g. `Development`, `joe`) cannot become projects.
    const worktreeSlug = findExistingWorktreeProjectSlug(input.startCwd)
    if (worktreeSlug) {
      const existing = await store.getProjectBySlug(worktreeSlug)
      if (existing) return { projectId: existing.id, originKind: 'pipeline' }
    }

    // Worktree-based launchers whose cwd doesn't sit under the real repo
    // (e.g. no-mistakes's `~/.no-mistakes/worktrees/<hash>/<ULID>`) don't
    // match the heuristic above. Resolve the real origin repo from the
    // worktree's `.git` file instead — this find-or-creates, so a fresh
    // repo seen for the first time via a worktree still gets its own
    // project rather than falling through to the ULID basename.
    const originSlug = await resolveGitOriginProjectSlug(input.startCwd)
    if (originSlug) {
      const result = await store.findOrCreateProjectBySlug(originSlug)
      return { projectId: result.id, originKind: 'pipeline' }
    }

    const slugSource = input.startCwd ?? transcriptBasedir
    if (slugSource) {
      const slug = deriveSlugFromPath(slugSource)
      const result = await store.findOrCreateProjectBySlug(slug)
      return { projectId: result.id, originKind: 'direct' }
    }
  }

  return { projectId: null, originKind: null }
}
