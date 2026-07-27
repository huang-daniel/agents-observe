/** Extract text-like tool output for result previews and search indexing. */
export function extractResultText(response: unknown): string | null {
  if (!response) return null
  if (typeof response === 'string') return response
  if (typeof response !== 'object' || Array.isArray(response)) return null

  const value = response as Record<string, unknown>
  for (const key of ['stdout', 'stderr', 'output', 'content', 'error']) {
    if (typeof value[key] === 'string' && value[key]) return value[key]
  }
  if (Array.isArray(value.content)) {
    const text = value.content
      .map((part) => {
        if (!part || typeof part !== 'object') return ''
        const item = part as Record<string, unknown>
        return item.type === 'text' && typeof item.text === 'string' ? item.text : ''
      })
      .filter(Boolean)
      .join(' ')
    return text || null
  }
  return null
}
