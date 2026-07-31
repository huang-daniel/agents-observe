import { describe, expect, test } from 'vitest'
import { compileFilters } from '@/lib/filters/compile'
import type { Agent, ParsedEvent } from '@/types'
import { EventStore } from './event-store'

const filters = compileFilters([])

function agent(agentClass: string | null): Agent {
  return {
    id: 'codex-subagent-1',
    sessionId: 'codex-session-1',
    parentAgentId: 'codex-session-1',
    name: null,
    description: null,
    agentType: null,
    agentClass,
    status: 'active',
    eventCount: 2,
    firstEventAt: 1,
    lastEventAt: 2,
  }
}

const subagentEvents: ParsedEvent[] = [
  {
    id: 1,
    agentId: 'codex-subagent-1',
    hookName: 'SubagentStart',
    timestamp: 1,
    payload: { agent_id: 'codex-subagent-1' },
  },
  {
    id: 2,
    agentId: 'codex-subagent-1',
    hookName: 'SubagentStop',
    timestamp: 2,
    payload: { agent_id: 'codex-subagent-1' },
  },
]

describe('EventStore', () => {
  test('reprocesses fallback-enriched events when Codex agent metadata arrives', () => {
    const store = new EventStore()

    // Event-derived agents have no server class while the agents query is loading.
    store.setAgents([agent(null)])
    expect(store.process(subagentEvents, true, filters)).toMatchObject([
      { label: 'SubStart', status: 'completed', iconId: 'SubagentStart' },
      { label: 'SubStop', status: 'completed', iconId: 'SubagentStop' },
    ])

    // The same raw rows must be enriched again after the query resolves.
    store.setAgents([agent('codex')])
    expect(store.process(subagentEvents, true, filters)).toMatchObject([
      { label: 'Subagent', status: 'running', iconId: 'SubagentStart' },
      { label: 'Subagent', status: 'completed', iconId: 'SubagentStop' },
    ])
  })
})
