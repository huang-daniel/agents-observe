import { applyFilters } from '@/lib/filters/matcher'
import { passesAllFilter } from '@/lib/filters/all-filter'
import { EVENT_ICON_REGISTRY } from '@/lib/event-icon-registry'
import type { ProcessingContext, RawEvent } from '../types'
import type { CodexEnrichedEvent } from './types'
import { deriveToolName } from './derivers'
import {
  buildSearchText,
  getEventSummary,
  getResultSummary,
  isToolFailure,
  record,
} from './helpers'
import { parseTranscriptEvent } from './parse-transcript'

const LABELS: Record<string, string> = {
  SessionStart: 'Session',
  UserPromptSubmit: 'Prompt',
  PreToolUse: 'Tool',
  PostToolUse: 'Tool',
  PermissionRequest: 'Permission',
  PreCompact: 'Compact',
  PostCompact: 'Compact',
  SubagentStart: 'Subagent',
  SubagentStop: 'Subagent',
  Stop: 'Stop',
  SessionEnd: 'Session',
}

function iconId(hookName: string, toolName: string | null): string {
  if (hookName === 'PreToolUse' || hookName === 'PostToolUse') {
    if (toolName === 'Bash') return 'ToolBash'
    if (toolName?.startsWith('mcp__')) return 'ToolMcp'
    if (toolName === 'spawn_agent' || toolName === 'Agent') return 'ToolAgent'
    return 'ToolDefault'
  }
  return EVENT_ICON_REGISTRY[hookName] ? hookName : 'Default'
}

export function processEvent(raw: RawEvent, ctx: ProcessingContext): { event: CodexEnrichedEvent } {
  const payload = record(raw.payload)
  const transcript = parseTranscriptEvent(payload)
  const hookName = raw.hookName || transcript.subtype || 'Event'
  const toolName = deriveToolName(raw)
  const subagentName = typeof payload.name === 'string' ? payload.name : transcript.subAgentName
  const subagentDescription =
    typeof payload.description === 'string' ? payload.description : transcript.subAgentDescription
  const toolUseId = typeof payload.tool_use_id === 'string' ? payload.tool_use_id : null
  const nativeTurnId = typeof payload.turn_id === 'string' ? payload.turn_id : null
  const dedup = ctx.dedupEnabled
  let turnId = nativeTurnId
  if (!turnId && dedup) {
    turnId = ctx.getCurrentTurn(raw.agentId)
    if (hookName === 'UserPromptSubmit') {
      turnId = `turn-${raw.id}`
      ctx.setCurrentTurn(raw.agentId, turnId)
    }
  }
  if (dedup && nativeTurnId) ctx.setCurrentTurn(raw.agentId, nativeTurnId)
  if (dedup && (hookName === 'Stop' || hookName === 'SessionEnd')) ctx.clearCurrentTurn(raw.agentId)

  let groupId: string | null = toolUseId
  let displayEventStream = true
  let displayTimeline = true
  let status: CodexEnrichedEvent['status'] = 'completed'
  if (hookName === 'PreToolUse') status = 'running'
  if (hookName === 'PostToolUse') status = isToolFailure(payload) ? 'failed' : 'completed'
  if (hookName === 'PermissionRequest') status = 'pending'
  if (hookName === 'PreCompact' || hookName === 'SubagentStart') status = 'running'

  if (dedup && hookName === 'PreToolUse' && toolUseId) groupId = toolUseId
  if (dedup && hookName === 'PostToolUse' && toolUseId) {
    groupId = toolUseId
    const preEvent = ctx.getGroupedEvents(groupId).find((event) => event.hookName === 'PreToolUse')
    if (preEvent) {
      displayEventStream = false
      displayTimeline = false
      const mergedPayload = { ...preEvent.payload, ...payload }
      const mergedRaw: RawEvent = {
        ...raw,
        id: preEvent.id,
        agentId: preEvent.agentId,
        hookName: preEvent.hookName,
        timestamp: preEvent.timestamp,
        payload: mergedPayload,
      }
      ctx.updateEvent(preEvent.id, {
        status,
        payload: mergedPayload,
        searchText: buildSearchText(mergedRaw, preEvent.summary, preEvent.toolName),
        filters: applyFilters(mergedRaw, preEvent.toolName, ctx.compiledFilters),
        resultSummary: getResultSummary(payload),
      })
    }
  }

  const summary = getEventSummary({ ...raw, hookName }, toolName)
  const passesAll = passesAllFilter(raw, toolName, ctx.compiledFilters)
  const enriched: CodexEnrichedEvent = {
    id: raw.id,
    agentId: raw.agentId,
    hookName,
    timestamp: raw.timestamp,
    toolName,
    groupId,
    turnId,
    displayEventStream: passesAll && displayEventStream,
    displayTimeline: passesAll && displayTimeline,
    label: LABELS[hookName] ?? hookName,
    labelTooltip: hookName,
    iconId: iconId(hookName, toolName),
    dedupMode: dedup,
    status,
    filters: applyFilters(raw, toolName, ctx.compiledFilters),
    searchText: buildSearchText(raw, summary, toolName),
    summary,
    payload: raw.payload,
    ...(toolUseId ? { toolUseId } : {}),
    ...(typeof payload.model === 'string' ? { model: payload.model } : {}),
    ...(typeof payload.permission_mode === 'string'
      ? { permissionMode: payload.permission_mode }
      : {}),
    ...(typeof payload.agent_type === 'string' ? { agentType: payload.agent_type } : {}),
    ...(typeof payload.agent_id === 'string' ? { agentIdFromPayload: payload.agent_id } : {}),
    ...(typeof payload.transcript_path === 'string'
      ? { transcriptPath: payload.transcript_path }
      : {}),
    ...(typeof payload.last_assistant_message === 'string'
      ? { lastAssistantMessage: payload.last_assistant_message }
      : {}),
    ...(subagentName ? { subagentName } : {}),
    ...(subagentDescription ? { subagentDescription } : {}),
    ...(hookName === 'SubagentStart' ? { startedAt: raw.timestamp } : {}),
    ...(hookName === 'SubagentStop' ? { stoppedAt: raw.timestamp } : {}),
  }
  return { event: enriched }
}
