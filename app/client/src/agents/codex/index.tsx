// Codex agent class registration.

import { Terminal } from 'lucide-react'
import { AgentRegistry } from '../registry'
import { DefaultRowSummary, DefaultEventDetail, DefaultDotTooltip } from '../default/index'
import { deriveStatus, deriveToolName } from './derivers'
import { processEvent } from './process-event'

AgentRegistry.register({
  agentClass: 'codex',
  displayName: 'codex',
  Icon: Terminal,
  processEvent,
  deriveToolName,
  deriveStatus,
  RowSummary: DefaultRowSummary,
  EventDetail: DefaultEventDetail,
  DotTooltip: DefaultDotTooltip,
})
