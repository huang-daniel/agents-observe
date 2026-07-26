import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { compileFilters } from '@/lib/filters/compile'
import type { ProcessingContext } from '../types'
import { processEvent } from './process-event'
import { processEvent as processClaudeEvent } from '../claude-code/process-event'

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`../../../../../test/fixtures/codex/${name}.json`, import.meta.url), 'utf8'),
  )
}

function rawFixture(id: number, name: string) {
  const payload = fixture(name)
  return {
    id,
    agentId: String(payload.agent_id),
    hookName: String(payload.hook_event_name),
    timestamp: id,
    payload,
  }
}

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
  test('normalizes every installed Codex lifecycle fixture', () => {
    const names = [
      'session-start',
      'user-prompt-submit',
      'pre-tool-bash',
      'post-tool-bash-success',
      'post-tool-bash-failure',
      'permission-request',
      'pre-compact',
      'post-compact',
      'subagent-start',
      'subagent-stop',
      'stop',
      'session-end',
    ]
    for (const [index, name] of names.entries()) {
      const event = processEvent(rawFixture(index + 1, name), context()).event
      expect(event.label).not.toBe('')
      expect(event.iconId).not.toBe('Default')
    }
  })

  test('matches Claude for shared action semantics', () => {
    const codexPre = processEvent(rawFixture(1, 'pre-tool-bash'), context()).event
    const claudePre = processClaudeEvent(
      {
        id: 1,
        agentId: 'claude-session-1',
        hookName: 'PreToolUse',
        timestamp: 1,
        payload: { tool_name: 'Bash', tool_use_id: 'toolu-claude-1', tool_input: { command: 'git status --short' } },
      },
      context(),
    ).event
    expect(codexPre).toMatchObject({ label: claudePre.label, iconId: claudePre.iconId, status: 'running' })
    expect(codexPre.groupId).toBeTruthy()

    const codexStop = processEvent(rawFixture(2, 'stop'), context()).event
    const claudeStop = processClaudeEvent(
      { id: 2, agentId: 'claude-session-1', hookName: 'Stop', timestamp: 2, payload: {} },
      context(),
    ).event
    expect(codexStop).toMatchObject({ label: claudeStop.label, iconId: claudeStop.iconId })

    const codexEnd = processEvent(rawFixture(3, 'session-end'), context()).event
    const claudeEnd = processClaudeEvent(
      { id: 3, agentId: 'claude-session-1', hookName: 'SessionEnd', timestamp: 3, payload: {} },
      context(),
    ).event
    expect(codexEnd).toMatchObject({ label: claudeEnd.label, iconId: claudeEnd.iconId })

    const equivalents = [
      ['user-prompt-submit', 'UserPromptSubmit', {}, 'completed'],
      ['post-tool-bash-success', 'PostToolUse', { tool_name: 'Bash' }, 'completed'],
      ['post-tool-bash-failure', 'PostToolUseFailure', { tool_name: 'Bash' }, 'failed'],
      ['pre-compact', 'PreCompact', {}, 'running'],
      ['post-compact', 'PostCompact', {}, 'completed'],
      ['subagent-start', 'SubagentStart', {}, 'running'],
      ['subagent-stop', 'SubagentStop', {}, 'completed'],
    ] as const
    for (const [fixtureName, claudeHook, claudePayload, status] of equivalents) {
      const codex = processEvent(rawFixture(10, fixtureName), context()).event
      const claude = processClaudeEvent(
        { id: 10, agentId: 'claude-session-1', hookName: claudeHook, timestamp: 10, payload: claudePayload },
        context(),
      ).event
      expect(codex).toMatchObject({
        label: claude.label,
        iconId: claude.iconId,
        status,
        displayEventStream: true,
        displayTimeline: true,
      })
    }
  })
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
