import { describe, test, expect } from 'vitest'
import {
  deriveTitleFromPrompt,
  buildFallbackSlug,
  isReplaceableFallbackSlug,
} from './session-title'

describe('deriveTitleFromPrompt', () => {
  test('returns short prompt text verbatim', () => {
    expect(deriveTitleFromPrompt('fix the login bug')).toBe('fix the login bug')
  })

  test('collapses internal whitespace and newlines', () => {
    expect(deriveTitleFromPrompt('fix   the\n\nlogin   bug')).toBe('fix the login bug')
  })

  test('trims leading/trailing whitespace', () => {
    expect(deriveTitleFromPrompt('   fix the bug   ')).toBe('fix the bug')
  })

  test('truncates to 90 chars with an ellipsis', () => {
    const long = 'a'.repeat(150)
    const result = deriveTitleFromPrompt(long)
    expect(result).toBe(`${'a'.repeat(90)}…`)
  })

  test('does not add ellipsis when exactly at the limit', () => {
    const exact = 'a'.repeat(90)
    expect(deriveTitleFromPrompt(exact)).toBe(exact)
  })

  test('returns null for empty/whitespace-only prompt', () => {
    expect(deriveTitleFromPrompt('   ')).toBeNull()
    expect(deriveTitleFromPrompt('')).toBeNull()
  })
})

describe('buildFallbackSlug', () => {
  test('branch + uuid + agent short name', () => {
    expect(buildFallbackSlug('019d9d13-24c6-76f0', 'feat/x', 'claude-code')).toBe(
      'feat/x:019d9d13:claude',
    )
  })

  test('omits agent segment when agentClass is absent', () => {
    expect(buildFallbackSlug('019d9d13-24c6-76f0', 'feat/x', null)).toBe('feat/x:019d9d13')
  })

  test('returns null when branch is absent', () => {
    expect(buildFallbackSlug('019d9d13-24c6-76f0', null, 'claude-code')).toBeNull()
  })
})

describe('isReplaceableFallbackSlug', () => {
  test('true when current slug is null', () => {
    expect(isReplaceableFallbackSlug(null, 'sess-1', 'HEAD', 'claude-code')).toBe(true)
  })

  test('true when current slug exactly matches the recomputed fallback', () => {
    expect(isReplaceableFallbackSlug('HEAD:sess:claude', 'sess-1-abc', 'HEAD', 'claude-code')).toBe(
      true,
    )
  })

  test('false when current slug is an explicit/native slug', () => {
    expect(
      isReplaceableFallbackSlug('refactored-bouncing-cake', 'sess-1-abc', 'HEAD', 'claude-code'),
    ).toBe(false)
  })

  test('false when current slug was already derived from a prompt', () => {
    expect(
      isReplaceableFallbackSlug('fix the login bug', 'sess-1-abc', 'HEAD', 'claude-code'),
    ).toBe(false)
  })
})
