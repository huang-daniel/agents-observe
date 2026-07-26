/** Common safeguards for promoting completion failures into a visible row. */
export function isWeakSummary(summary: string | undefined | null): boolean {
  if (!summary) return true
  const trimmed = summary.trim()
  return trimmed.length < 3 || trimmed.startsWith('‹')
}

export function truncateSummary(summary: string, max: number): string {
  return summary.length > max ? `${summary.slice(0, max)}...` : summary
}
