import type { RawEvent, ProcessingContext } from '../types'
import type { ClaudeCodeEnrichedEvent } from './types'
import { getEventSummary, buildSearchText } from './helpers'
import { deriveToolName } from './derivers'
import { agentPatchDebouncer } from '@/lib/agent-patch-debouncer'
import { applyFilters } from '@/lib/filters/matcher'
import { passesAllFilter } from '@/lib/filters/all-filter'
import { isWeakSummary, truncateSummary } from '../shared/failure-detection'
import { extractResultText } from '../shared/result-text'
import {
  commonIconId,
  commonLabel,
  pairCompactCompletion,
  pairToolCompletion,
} from '../shared/tool-pairing'
import { toolSummarySlots } from '../shared/summary-slots'

/** Cap on a failure error promoted into a row summary — errors can be long. */
const SUMMARY_MAX = 200

/** Detect payload-level error indicators. Used to bump status to
 *  'failed' so the Errors filter can rely on `event.status` alone. */
function isPayloadFailed(payload: Record<string, unknown>): boolean {
  if (typeof payload.error === 'string' && (payload.error as string) !== '') return true
  const tr = payload.tool_response
  if (tr && typeof tr === 'object') {
    if ((tr as Record<string, unknown>).is_error === true) return true
    const err = (tr as Record<string, unknown>).error
    if (typeof err === 'string' && err !== '') return true
  }
  return false
}

// Label mapping for the framework's left-side chrome. Keyed by hookName.
const LABELS: Record<string, string> = {
  PostToolBatch: 'Batch',
  UserPromptExpansion: 'PromptExp',
  StopFailure: 'Stop',
  Setup: 'Setup',
  PermissionDenied: 'Permission',
  Notification: 'Notice',
  TaskCreated: 'Task',
  TaskCompleted: 'Task',
  TeammateIdle: 'Idle',
  InstructionsLoaded: 'Config',
  ConfigChange: 'Config',
  CwdChanged: 'Config',
  FileChanged: 'File',
  Elicitation: 'MCP',
  ElicitationResult: 'MCP',
  WorktreeCreate: 'Worktree',
  WorktreeRemove: 'Worktree',
  stop_hook_summary: 'Stop',
}

/**
 * Build the minimal `AgentPatch` that would actually change the canonical
 * agent row, given the values discovered in an event.
 */
function diffAgentPatch(
  current:
    { name?: string | null; description?: string | null; agentType?: string | null } | undefined,
  proposed: { name?: string | null; description?: string | null; agent_type?: string | null },
): { name?: string | null; description?: string | null; agent_type?: string | null } | null {
  const patch: { name?: string | null; description?: string | null; agent_type?: string | null } =
    {}
  if ('name' in proposed && proposed.name != null && proposed.name !== current?.name) {
    patch.name = proposed.name
  }
  if (
    'description' in proposed &&
    proposed.description != null &&
    proposed.description !== current?.description
  ) {
    patch.description = proposed.description
  }
  if (
    'agent_type' in proposed &&
    proposed.agent_type != null &&
    proposed.agent_type !== current?.agentType
  ) {
    patch.agent_type = proposed.agent_type
  }
  return Object.keys(patch).length === 0 ? null : patch
}

/** Local fallback for the inline status decision inside processEvent. */
function deriveLocalStatus(hookName: string): ClaudeCodeEnrichedEvent['status'] {
  if (hookName === 'PreToolUse') return 'running'
  if (hookName === 'PostToolUse') return 'completed'
  if (hookName === 'PostToolUseFailure') return 'failed'
  if (hookName === 'PreCompact') return 'running'
  if (hookName === 'PostCompact') return 'completed'
  return 'completed'
}

// ---- Slot computation (the slotted-row pattern) ----------------------------
// processEvent decides what (if anything) goes in each summary slot. The
// row-summary component just renders whatever it finds — no per-hookName
// switching at render time.

/** Compute the (summaryTool, summaryCmd, summary) tuple for a Claude Code event. */
function computeSlots(
  hookName: string,
  toolName: string | null,
  rawSummary: string,
  payload: Record<string, unknown>,
): { summaryTool?: string; summaryCmd?: string; summary: string } {
  const isTool =
    hookName === 'PreToolUse' || hookName === 'PostToolUse' || hookName === 'PostToolUseFailure'

  if (isTool && toolName) return toolSummarySlots(toolName, rawSummary)

  if (hookName === 'UserPromptExpansion') {
    const expansionType = (payload as Record<string, unknown>).expansion_type
    if (typeof expansionType === 'string' && expansionType) {
      return { summaryTool: expansionType, summary: rawSummary }
    }
  }

  return { summary: rawSummary }
}

/**
 * Claude Code processEvent implementation.
 */
export function processEvent(
  raw: RawEvent,
  ctx: ProcessingContext,
): { event: ClaudeCodeEnrichedEvent } {
  const p = raw.payload as Record<string, any>
  const hookName = raw.hookName
  const toolName = deriveToolName(raw)
  const toolUseId: string | null = typeof p.tool_use_id === 'string' ? p.tool_use_id : null

  // ---- Subagent-pairing (PreToolUse:Agent → PostToolUse:Agent) ---------
  if (hookName === 'PreToolUse' && toolName === 'Agent' && toolUseId) {
    const inputName = typeof p.tool_input?.name === 'string' ? (p.tool_input.name as string) : null
    const inputDesc =
      typeof p.tool_input?.description === 'string' ? (p.tool_input.description as string) : null
    if (inputName !== null || inputDesc !== null) {
      ctx.stashPendingAgentMeta(toolUseId, { name: inputName, description: inputDesc })
    }
  }
  if (hookName === 'SubagentStart') {
    const agentType = typeof p.agent_type === 'string' ? (p.agent_type as string) : null
    const agentName = typeof p.name === 'string' ? (p.name as string) : null
    const patch = diffAgentPatch(ctx.getAgent(raw.agentId), {
      name: agentName,
      agent_type: agentType,
    })
    if (patch) agentPatchDebouncer.schedule(raw.agentId, patch)
  }
  if (hookName === 'PostToolUse' && toolName === 'Agent' && toolUseId) {
    const spawnedAgentId =
      typeof p.tool_response?.agentId === 'string' ? (p.tool_response.agentId as string) : null
    if (spawnedAgentId) {
      const meta = ctx.consumePendingAgentMeta(toolUseId)
      if (meta && (meta.name || meta.description)) {
        const patch = diffAgentPatch(ctx.getAgent(spawnedAgentId), {
          name: meta.name,
          description: meta.description,
        })
        if (patch) agentPatchDebouncer.schedule(spawnedAgentId, patch)
      }
    }
  }

  // Pick the registry icon id; renderers resolve to component + color
  // at render time via resolveEventIcon / resolveEventColor.
  const iconId = hookName === 'PostToolBatch' ? 'ToolBatch' : commonIconId(hookName, toolName)
  const dedup = ctx.dedupEnabled

  // Turn tracking (only when dedup is on)
  let turnId: string | null = null
  if (dedup) {
    turnId = ctx.getCurrentTurn(raw.agentId)
    if (hookName === 'UserPromptSubmit' || hookName === 'SubagentStart') {
      turnId = `turn-${raw.id}`
      ctx.setCurrentTurn(raw.agentId, turnId)
    } else if (
      hookName === 'Stop' ||
      hookName === 'SessionEnd' ||
      hookName === 'SubagentStop' ||
      hookName === 'stop_hook_summary'
    ) {
      ctx.clearCurrentTurn(raw.agentId)
    }
  }

  // Group ID, display flags, status override (only when dedup is on)
  let groupId: string | null = null
  let displayEventStream = true
  let displayTimeline = true
  let statusOverride: ClaudeCodeEnrichedEvent['status'] | null = null

  if (dedup) {
    // Task grouping. The tool_input/tool_response taskId only counts for
    // Task-lifecycle tools — other tools (e.g. Workflow, which returns a
    // background `taskId` in its response) must NOT be hijacked into a
    // task group, or their Pre/Post pair never reunites under the shared
    // tool_use_id below. `task_id` is only emitted by Task* hooks.
    const isTaskTool = toolName === 'TaskCreate' || toolName === 'TaskUpdate'
    const taskId = (p.task_id ??
      (isTaskTool ? (p.tool_input?.taskId ?? p.tool_response?.taskId) : undefined)) as
      string | undefined
    if (taskId) {
      groupId = `task-${taskId}`
    }

    if (hookName === 'TaskCreated') {
      statusOverride = 'pending'
    } else if (hookName === 'TaskCompleted') {
      const grouped = groupId ? ctx.getGroupedEvents(groupId) : []
      const createdEvent = grouped.find((e) => e.hookName === 'TaskCreated')
      if (createdEvent) {
        displayEventStream = false
        displayTimeline = false
        ctx.updateEvent(createdEvent.id, { status: 'completed' })
      }
    }

    if (toolName === 'TaskCreate') {
      displayEventStream = false
      displayTimeline = false
    }

    if (toolName === 'TaskUpdate') {
      const updateTaskId = p.tool_input?.taskId as string | undefined
      if (updateTaskId) {
        groupId = `task-${updateTaskId}`
        displayEventStream = false
        displayTimeline = false

        const grouped = ctx.getGroupedEvents(groupId)
        const createdEvent = grouped.find((e) => e.hookName === 'TaskCreated')
        if (createdEvent) {
          const newStatus = p.tool_input?.status as string | undefined
          if (newStatus === 'completed') {
            ctx.updateEvent(createdEvent.id, { status: 'completed' })
          } else if (newStatus === 'in_progress') {
            ctx.updateEvent(createdEvent.id, { status: 'running' })
          }
        }
      }
    }

    if (hookName === 'PreToolUse' && toolUseId) {
      if (!groupId) groupId = toolUseId
    } else if ((hookName === 'PostToolUse' || hookName === 'PostToolUseFailure') && toolUseId) {
      if (!groupId) groupId = toolUseId

      const paired = pairToolCompletion({
        raw,
        ctx,
        groupId,
        status: hookName === 'PostToolUseFailure' ? 'failed' : 'completed',
        makePatch: (preEvent) => {
          displayEventStream = false
          displayTimeline = false
          const resultText = extractResultText(p.tool_response)
          // Re-evaluate filters for the merged-displayed Pre event using a
          // synthesized raw event that includes the Post's payload (e.g.,
          // `is_error`, `error`, `tool_response`). Without this, the Errors
          // default — which matches on payload — never fires for tool
          // failures because the Pre event's own payload has no error markers
          // and the Post event is hidden via displayEventStream=false.
          const mergedRaw: RawEvent = {
            id: preEvent.id,
            agentId: preEvent.agentId,
            hookName: preEvent.hookName,
            timestamp: preEvent.timestamp,
            payload: { ...preEvent.payload, ...p },
          }
          const refreshedFilters = applyFilters(mergedRaw, preEvent.toolName, ctx.compiledFilters)
          const patch: Parameters<typeof ctx.updateEvent>[1] = {
            searchText: preEvent.searchText + ' ' + (resultText?.toLowerCase() ?? ''),
            filters: refreshedFilters,
          }
          // A failure folds onto the Pre row, whose summary was computed before
          // the error existed. When that summary carries no real information,
          // surface the error so the row isn't blank. getEventSummary's
          // PostToolUseFailure path is already error-first.
          if (hookName === 'PostToolUseFailure' && isWeakSummary(preEvent.summary)) {
            const failSummary = getEventSummary(mergedRaw, hookName, preEvent.toolName)
            if (failSummary && !isWeakSummary(failSummary)) {
              patch.summary = truncateSummary(failSummary, SUMMARY_MAX)
            }
          }
          return patch
        },
      })
      if (paired) {
        displayEventStream = false
        displayTimeline = false
      }
    }

    // Compact pairing
    const compact = pairCompactCompletion({
      raw,
      ctx,
      pendingKey: `compact:${raw.agentId}`,
      complete: (preEvent) => {
        const summaryText =
          typeof p.compact_summary === 'string' ? p.compact_summary.toLowerCase() : ''
        return {
          payload: { ...preEvent.payload, ...p },
          summary: 'Compacted context',
          searchText: preEvent.searchText + (summaryText ? ' ' + summaryText : ''),
        }
      },
    })
    if (compact.groupId) groupId = compact.groupId
    if (compact.hidden) displayEventStream = displayTimeline = false
  }

  // Build the enriched event
  const rawSummary = getEventSummary(raw, hookName, toolName)
  const slots = computeSlots(hookName, toolName, rawSummary, raw.payload)

  // Gate visibility on the All filter's exclusions. Events that fail
  // are still added to the store, but suppressed from both views.
  const passesAll = passesAllFilter(raw, toolName, ctx.compiledFilters)

  const enriched: ClaudeCodeEnrichedEvent = {
    // Identity
    id: raw.id,
    agentId: raw.agentId,
    hookName,
    timestamp: raw.timestamp,

    // Per-class enrichment
    toolName,
    groupId,
    turnId,
    displayEventStream: passesAll && displayEventStream,
    displayTimeline: passesAll && displayTimeline,
    label: LABELS[hookName] || commonLabel(hookName) || hookName || 'Event',
    labelTooltip: hookName,
    iconId,
    dedupMode: dedup,
    status:
      statusOverride ?? (isPayloadFailed(raw.payload) ? 'failed' : deriveLocalStatus(hookName)),
    filters: applyFilters(raw, toolName, ctx.compiledFilters),
    searchText: buildSearchText(raw, slots.summary, toolName),
    summary: slots.summary,

    // Original payload
    payload: raw.payload,

    // Claude-specific fields (optional — only set when payload carries them)
    ...(toolUseId !== null ? { toolUseId } : {}),
    ...(typeof p.cwd === 'string' ? { cwd: p.cwd as string } : {}),

    // Summary slots (optional — set by computeSlots when applicable)
    ...(slots.summaryTool !== undefined ? { summaryTool: slots.summaryTool } : {}),
    ...(slots.summaryCmd !== undefined ? { summaryCmd: slots.summaryCmd } : {}),
  }

  return { event: enriched }
}
