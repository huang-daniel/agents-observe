import { EVENT_ICON_REGISTRY } from '@/lib/event-icon-registry'
import type { EnrichedEvent, EventStatus, ProcessingContext, RawEvent } from '../types'

export const TOOL_HOOK_NAMES = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'])

export function isToolHook(hookName: string): boolean {
  return TOOL_HOOK_NAMES.has(hookName)
}

/** Resolve common hook labels and tool icons without source-specific parsing. */
export function commonLabel(hookName: string): string | null {
  return (
    (
      {
        SessionStart: 'Session',
        SessionEnd: 'Session',
        UserPromptSubmit: 'Prompt',
        PreToolUse: 'Tool',
        PostToolUse: 'Tool',
        PostToolUseFailure: 'Tool',
        PermissionRequest: 'Permission',
        PreCompact: 'Compact',
        PostCompact: 'Compact',
        SubagentStart: 'Subagent',
        SubagentStop: 'Subagent',
        Stop: 'Stop',
      } as Record<string, string>
    )[hookName] ?? null
  )
}

export function commonIconId(hookName: string, toolName: string | null): string {
  if (isToolHook(hookName)) {
    if (toolName?.startsWith('mcp__')) return 'ToolMcp'
    const icons: Record<string, string> = {
      Bash: 'ToolBash',
      Read: 'ToolRead',
      Write: 'ToolWrite',
      Edit: 'ToolEdit',
      Glob: 'ToolGlob',
      Grep: 'ToolGrep',
      WebSearch: 'ToolWebSearch',
      WebFetch: 'ToolWebFetch',
      Agent: 'ToolAgent',
      spawn_agent: 'ToolAgent',
      StructuredOutput: 'ToolStructuredOutput',
    }
    return icons[toolName ?? ''] ?? 'ToolDefault'
  }
  return EVENT_ICON_REGISTRY[hookName] ? hookName : 'Default'
}

export function pairToolCompletion({
  raw,
  ctx,
  groupId,
  status,
  makePatch,
}: {
  raw: RawEvent
  ctx: ProcessingContext
  groupId: string | null
  status: EventStatus
  makePatch: (preEvent: EnrichedEvent) => Partial<EnrichedEvent>
}): boolean {
  if (
    !ctx.dedupEnabled ||
    (raw.hookName !== 'PostToolUse' && raw.hookName !== 'PostToolUseFailure') ||
    !groupId
  ) {
    return false
  }
  const preEvent = ctx.getGroupedEvents(groupId).find((event) => event.hookName === 'PreToolUse')
  if (!preEvent) return false
  ctx.updateEvent(preEvent.id, { status, ...makePatch(preEvent) })
  return true
}

export function pairCompactCompletion({
  raw,
  ctx,
  pendingKey,
  complete,
}: {
  raw: RawEvent
  ctx: ProcessingContext
  pendingKey: string
  complete: (preEvent: EnrichedEvent) => Partial<EnrichedEvent>
}): { groupId: string | null; hidden: boolean } {
  if (!ctx.dedupEnabled) return { groupId: null, hidden: false }
  if (raw.hookName === 'PreCompact') {
    const groupId = `compact-${raw.id}`
    ctx.setPendingGroup(pendingKey, groupId)
    return { groupId, hidden: false }
  }
  if (raw.hookName !== 'PostCompact') return { groupId: null, hidden: false }
  const groupId = ctx.getPendingGroup(pendingKey)
  if (!groupId) return { groupId: null, hidden: false }
  ctx.clearPendingGroup(pendingKey)
  const preEvent = ctx.getGroupedEvents(groupId).find((event) => event.hookName === 'PreCompact')
  if (!preEvent) return { groupId, hidden: false }
  ctx.updateEvent(preEvent.id, { status: 'completed', ...complete(preEvent) })
  return { groupId, hidden: true }
}
