// app/server/src/services/session-title.ts
//
// Titles a session from its first `UserPromptSubmit` prompt text when
// no better identity exists. The fallback label built in
// `routes/callbacks.ts` (`"<branch>:<uuidPrefix>:<agentShortName>"`) is
// low-signal — for a detached-HEAD worktree session (the common case for
// worktree-based launchers) it degrades to `"HEAD:<uuidPrefix>:<agent>"`,
// distinguishable only by the random id. The first user prompt is
// already-ingested data that says what the session is actually for, so
// once it arrives it should replace that fallback.
//
// Truncation length (90 chars) matches the existing prompt-text
// truncation in the constellation event ticker
// (`dashboard/themes/constellation/event-ticker.tsx`), the only other
// place in this codebase that turns a raw prompt string into a UI label.
const TITLE_MAX_LENGTH = 90

/** Collapses whitespace and truncates prompt text into a session title. */
export function deriveTitleFromPrompt(prompt: string): string | null {
  const collapsed = prompt.replace(/\s+/g, ' ').trim()
  if (!collapsed) return null
  if (collapsed.length <= TITLE_MAX_LENGTH) return collapsed
  return `${collapsed.slice(0, TITLE_MAX_LENGTH)}…`
}

/**
 * Rebuilds the auto-generated fallback slug shape from `callbacks.ts` so
 * it can be recognized and safely overwritten. Returns null when the
 * inputs can't produce that shape (no branch known).
 */
export function buildFallbackSlug(
  sessionId: string,
  gitBranch: string | null | undefined,
  agentClass: string | null | undefined,
): string | null {
  if (!gitBranch) return null
  const uuidPrefix = sessionId.split('-')[0]
  const agentShortName = agentClass ? agentClass.split('-')[0] : null
  return agentShortName
    ? `${gitBranch}:${uuidPrefix}:${agentShortName}`
    : `${gitBranch}:${uuidPrefix}`
}

/**
 * True when `currentSlug` is either absent or is exactly the
 * auto-generated branch fallback — i.e. safe to replace with a
 * higher-quality title (first-prompt text). A real explicit slug (the
 * rare Claude-Code-native field, or a user-picked prompt-derived title
 * already set) never matches this shape and is left alone.
 */
export function isReplaceableFallbackSlug(
  currentSlug: string | null | undefined,
  sessionId: string,
  gitBranch: string | null | undefined,
  agentClass: string | null | undefined,
): boolean {
  if (!currentSlug) return true
  return currentSlug === buildFallbackSlug(sessionId, gitBranch, agentClass)
}
