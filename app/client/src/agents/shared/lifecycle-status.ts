import type { ParsedEvent } from '@/types'

export type AgentLifecycleStatus = 'active' | 'waiting' | 'stopped'

/**
 * Derive the agent's current lifecycle from ordered hook activity.
 * Stop ends a turn, not a session; any subsequent activity resumes active.
 */
export function deriveLifecycleStatus(
  events: ParsedEvent[],
  agentId: string,
): AgentLifecycleStatus {
  let status: AgentLifecycleStatus = 'active'
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>
    const isTargetedSubagentStop = event.hookName === 'SubagentStop' && payload.agent_id === agentId
    if (event.agentId !== agentId && !isTargetedSubagentStop) continue

    if (event.hookName === 'SessionEnd' || isTargetedSubagentStop) status = 'stopped'
    else if (event.hookName === 'Stop' || event.hookName === 'stop_hook_summary') status = 'waiting'
    else status = 'active'
  }
  return status
}
