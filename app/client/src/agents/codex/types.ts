import type { EnrichedEvent } from '../types'

/** Fields Codex supplies directly in its hook payloads. */
export interface CodexEnrichedEvent extends EnrichedEvent {
  toolUseId?: string
  model?: string
  permissionMode?: string
  agentType?: string
  agentIdFromPayload?: string
  transcriptPath?: string
  lastAssistantMessage?: string
  subagentName?: string
  subagentDescription?: string
  startedAt?: number
  stoppedAt?: number
}
