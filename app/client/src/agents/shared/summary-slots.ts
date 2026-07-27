export interface SummarySlots {
  summaryTool?: string
  summaryCmd?: string
  summary: string
}

/** Shared slotted row layout for tool summaries. */
export function toolSummarySlots(toolName: string | null, summary: string): SummarySlots {
  if (!toolName) return { summary }
  const match = summary.match(/^\[([^\]]+)\]\s*(.*)$/)
  const displayTool = toolName.startsWith('mcp__') ? 'MCP' : toolName
  return {
    summaryTool: displayTool,
    summaryCmd: toolName.startsWith('mcp__') ? toolName : (match?.[1] ?? undefined),
    summary: match?.[2] ?? summary,
  }
}
