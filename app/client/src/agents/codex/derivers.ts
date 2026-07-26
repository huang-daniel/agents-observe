import type { EventStatus, RawEvent } from '../types'
import { parseTranscriptEvent } from './parse-transcript'
import { isToolFailure, record } from './helpers'

/** Native hook fields win; old transcript lines are a compatibility fallback. */
export function deriveToolName(event: RawEvent): string | null {
  const payload = record(event.payload)
  if (typeof payload.tool_name === 'string' && payload.tool_name) return payload.tool_name
  return parseTranscriptEvent(payload).toolName
}

export function deriveStatus(event: RawEvent, grouped: RawEvent[]): EventStatus | null {
  if (event.hookName === 'PreToolUse') {
    const post = grouped.find((candidate) => candidate.hookName === 'PostToolUse')
    if (!post) return 'running'
    return isToolFailure(record(post.payload)) ? 'failed' : 'completed'
  }
  if (event.hookName === 'PostToolUse')
    return isToolFailure(record(event.payload)) ? 'failed' : 'completed'
  if (event.hookName === 'PermissionRequest') return 'pending'
  if (event.hookName === 'PreCompact' || event.hookName === 'SubagentStart') return 'running'
  return null
}
