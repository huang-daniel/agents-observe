import { describe, expect, test } from 'vitest'
import { compileFilters } from '@/lib/filters/compile'
import type { ProcessingContext } from '../types'
import { processEvent } from './process-event'

function context(overrides: Partial<ProcessingContext> = {}): ProcessingContext {
  return {
    dedupEnabled: true,
    compiledFilters: compileFilters([]),
    getAgent: () => undefined,
    getGroupedEvents: () => [],
    getAgentEvents: () => [],
    getCurrentTurn: () => null,
    setCurrentTurn: () => {},
    clearCurrentTurn: () => {},
    getPendingGroup: () => null,
    setPendingGroup: () => {},
    clearPendingGroup: () => {},
    stashPendingAgentMeta: () => {},
    consumePendingAgentMeta: () => null,
    updateEvent: () => {},
    ...overrides,
  }
}

describe('Codex processEvent', () => {
  test('pairs native tool_use_id rows and merges successful output into the pre-event', () => {
    const pre = processEvent(
      {
        id: 1,
        agentId: 'a',
        hookName: 'PreToolUse',
        timestamp: 1,
        payload: {
          tool_use_id: 'x',
          turn_id: 't',
          tool_name: 'Bash',
          tool_input: { command: 'git status --short' },
        },
      },
      context(),
    ).event
    const updates: Array<{ id: number; patch: Record<string, unknown> }> = []
    const post = processEvent(
      {
        id: 2,
        agentId: 'a',
        hookName: 'PostToolUse',
        timestamp: 2,
        payload: {
          tool_use_id: 'x',
          turn_id: 't',
          tool_name: 'Bash',
          tool_response: { stdout: ' M README.md' },
        },
      },
      context({
        getGroupedEvents: () => [pre],
        updateEvent: (id, patch) => updates.push({ id, patch }),
      }),
    ).event
    expect(pre).toMatchObject({
      groupId: 'x',
      status: 'running',
      summary: '[git] status --short',
      turnId: 't',
    })
    expect(post).toMatchObject({ displayEventStream: false, displayTimeline: false })
    expect(updates[0]).toMatchObject({
      id: 1,
      patch: { status: 'completed', resultSummary: 'M README.md' },
    })
  })

  test('strips a path-prefixed bash command by the original token length', () => {
    const pre = processEvent(
      {
        id: 1,
        agentId: 'a',
        hookName: 'PreToolUse',
        timestamp: 1,
        payload: {
          tool_use_id: 'y',
          tool_name: 'Bash',
          tool_input: { command: '/usr/bin/git status --short' },
        },
      },
      context(),
    ).event
    expect(pre.summary).toBe('[git] status --short')
  })

  test('marks only explicit Codex post-response failure fields as failed', () => {
    const failed = processEvent(
      {
        id: 1,
        agentId: 'a',
        hookName: 'PostToolUse',
        timestamp: 1,
        payload: { tool_response: { exit_code: 1 } },
      },
      context(),
    ).event
    const warning = processEvent(
      {
        id: 2,
        agentId: 'a',
        hookName: 'PostToolUse',
        timestamp: 2,
        payload: { tool_response: { stdout: 'warning: cache stale' } },
      },
      context(),
    ).event
    expect(failed.status).toBe('failed')
    expect(warning.status).toBe('completed')
  })

  test('uses native turns and gives lifecycle events Codex semantics', () => {
    const stop = processEvent(
      {
        id: 1,
        agentId: 'a',
        hookName: 'Stop',
        timestamp: 1,
        payload: { turn_id: 'turn-7', last_assistant_message: 'Need a decision.' },
      },
      context(),
    ).event
    const start = processEvent(
      {
        id: 2,
        agentId: 'a',
        hookName: 'SubagentStart',
        timestamp: 2,
        payload: { agent_id: 'sub', agent_type: 'reviewer', turn_id: 'turn-7' },
      },
      context(),
    ).event
    expect(stop).toMatchObject({
      status: 'completed',
      turnId: 'turn-7',
      summary: 'Waiting for input — Need a decision.',
    })
    expect(start).toMatchObject({
      status: 'running',
      agentType: 'reviewer',
      agentIdFromPayload: 'sub',
      startedAt: 2,
    })
  })
})
