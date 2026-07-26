import { describe, expect, test } from 'vitest'
import { deriveLifecycleStatus } from './lifecycle-status'

const event = (hookName: string, timestamp: number, agentId = 'root', payload = {}) => ({
  id: timestamp,
  hookName,
  timestamp,
  agentId,
  payload,
})

describe('deriveLifecycleStatus', () => {
  test('distinguishes waiting turns from stopped sessions and resumes on activity', () => {
    expect(deriveLifecycleStatus([event('UserPromptSubmit', 1), event('Stop', 2)], 'root')).toBe('waiting')
    expect(deriveLifecycleStatus([event('Stop', 1), event('PreToolUse', 2)], 'root')).toBe('active')
    expect(deriveLifecycleStatus([event('SessionEnd', 1)], 'root')).toBe('stopped')
  })

  test('stops only the subagent targeted by SubagentStop', () => {
    const events = [event('SubagentStart', 1, 'sub'), event('SubagentStop', 2, 'root', { agent_id: 'sub' })]
    expect(deriveLifecycleStatus(events, 'sub')).toBe('stopped')
    expect(deriveLifecycleStatus(events, 'root')).toBe('active')
  })
})
