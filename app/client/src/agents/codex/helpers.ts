import type { RawEvent } from '../types'

const SUMMARY_MAX = 240

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function oneLine(value: unknown, max = SUMMARY_MAX): string {
  if (typeof value !== 'string') return ''
  const result = value.replace(/\s+/g, ' ').trim()
  return result.length > max ? `${result.slice(0, max)}…` : result
}

export function compactJson(value: unknown, max = 180): string {
  try {
    const result = JSON.stringify(value)
    if (!result || result === '{}') return ''
    return result.length > max ? `${result.slice(0, max)}…` : result
  } catch {
    return ''
  }
}

/** Only documented Codex response fields count as a failure signal. */
export function isToolFailure(payload: Record<string, unknown>): boolean {
  const response = record(payload.tool_response)
  return (
    response.is_error === true ||
    response.isError === true ||
    response.error === true ||
    (typeof response.error === 'string' && response.error.length > 0) ||
    (typeof response.exit_code === 'number' && response.exit_code !== 0) ||
    (typeof response.exitCode === 'number' && response.exitCode !== 0) ||
    response.status === 'failed'
  )
}

function bashSummary(input: Record<string, unknown>): string {
  const command = typeof input.command === 'string' ? oneLine(input.command) : ''
  if (!command) return ''
  const first = command.split(' ')[0]?.replace(/^.*\//, '')
  return first ? `[${first}] ${command.slice(first.length).trim()}`.trim() : command
}

function patchSummary(input: Record<string, unknown>): string {
  const patch =
    typeof input.patch === 'string'
      ? input.patch
      : typeof input.input === 'string'
        ? input.input
        : ''
  const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)]
  if (files.length > 1) return `Updated ${files.length} files`
  if (files.length === 1) {
    const [line, path] = files[0]
    if (line.includes('Add')) return `Added ${path}`
    if (line.includes('Update')) return `Modified ${path}`
    return `Deleted ${path}`
  }
  return 'Updated files'
}

function mcpSummary(toolName: string, input: Record<string, unknown>): string {
  const normalized = toolName.replace(/^mcp__(.+?)__(.+)$/, '$1.$2')
  const target =
    (typeof input.path === 'string' && input.path) ||
    (typeof input.file_path === 'string' && input.file_path) ||
    (typeof input.pull_number === 'number' && `#${input.pull_number}`) ||
    (typeof input.pr_number === 'number' && `#${input.pr_number}`) ||
    ''
  return target ? `${normalized} — ${target}` : normalized
}

export function getEventSummary(event: RawEvent, toolName: string | null): string {
  const payload = record(event.payload)
  const input = record(payload.tool_input)
  switch (event.hookName) {
    case 'SessionStart':
      return 'Session started'
    case 'SessionEnd':
      return 'Session ended'
    case 'UserPromptSubmit':
      return oneLine(payload.prompt ?? payload.message) || 'User prompt submitted'
    case 'PermissionRequest': {
      const tool = typeof payload.tool_name === 'string' ? payload.tool_name : 'Tool'
      return ` ${tool} approval — ${oneLine(input.command ?? input.description ?? compactJson(input))}`.trim()
    }
    case 'PreCompact':
      return 'Compacting context'
    case 'PostCompact':
      return 'Context compacted'
    case 'SubagentStart':
      return `Started ${String(payload.agent_type ?? payload.name ?? 'subagent')}`
    case 'SubagentStop':
      return `Stopped ${String(payload.agent_type ?? payload.agent_id ?? 'subagent')}`
    case 'Stop': {
      const excerpt = oneLine(payload.last_assistant_message)
      return excerpt ? `Waiting for input — ${excerpt}` : 'Waiting for input'
    }
    case 'PreToolUse':
    case 'PostToolUse':
      break
    default:
      return event.hookName || 'Event'
  }

  if (toolName === 'Bash') return bashSummary(input) || 'Bash'
  if (toolName === 'apply_patch') return patchSummary(input)
  if (toolName === 'update_plan') return 'Updated implementation plan'
  if (toolName === 'spawn_agent' || toolName === 'Agent') {
    const name = oneLine(input.name ?? input.agent_type) || 'agent'
    const description = oneLine(input.description ?? input.prompt)
    return description ? `Started ${name} — ${description}` : `Started ${name}`
  }
  if (toolName?.startsWith('mcp__')) return mcpSummary(toolName, input)
  return toolName
    ? `${toolName} — ${compactJson(input) || 'no input'}`
    : compactJson(input) || 'Tool call'
}

export function buildSearchText(event: RawEvent, summary: string, toolName: string | null): string {
  const payload = record(event.payload)
  const response = record(payload.tool_response)
  return [
    event.hookName,
    toolName,
    summary,
    compactJson(payload.tool_input, 600),
    compactJson(response, 600),
    payload.last_assistant_message,
  ]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ')
    .toLowerCase()
}

export function getResultSummary(payload: Record<string, unknown>): string {
  const response = record(payload.tool_response)
  return (
    oneLine(
      response.stdout ?? response.stderr ?? response.output ?? response.content ?? response.error,
      SUMMARY_MAX,
    ) || compactJson(response, SUMMARY_MAX)
  )
}
