import { describe, test, expect } from 'vitest'
import { processEvent } from './process-event'
import { isWeakSummary } from '../shared/failure-detection'
import { compileFilters } from '@/lib/filters/compile'
import type { Filter } from '@/types'
import type { ProcessingContext } from '../types'

const ALL_FILTER: Filter = {
  id: 'default-all',
  name: 'All',
  pillName: 'All',
  display: 'primary',
  combinator: 'and',
  patterns: [{ target: 'hook', regex: '^PostToolBatch$', negate: true }],
  kind: 'default',
  enabled: true,
  config: { role: 'all-exclusions' },
  createdAt: 0,
  updatedAt: 0,
}

function createCtx(filters: Filter[] = [ALL_FILTER]): ProcessingContext {
  return {
    dedupEnabled: true,
    compiledFilters: compileFilters(filters),
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
  }
}

describe('claude-code processEvent — All filter gating', () => {
  test('hides PostToolBatch events from timeline and event stream when default-all is enabled', () => {
    const raw = {
      id: 1,
      agentId: 'a',
      hookName: 'PostToolBatch',
      timestamp: 0,
      payload: {},
    }
    const { event } = processEvent(raw, createCtx())
    expect(event.displayEventStream).toBe(false)
    expect(event.displayTimeline).toBe(false)
  })

  test('shows PostToolBatch events when default-all is disabled', () => {
    const raw = {
      id: 1,
      agentId: 'a',
      hookName: 'PostToolBatch',
      timestamp: 0,
      payload: {},
    }
    const { event } = processEvent(raw, createCtx([{ ...ALL_FILTER, enabled: false }]))
    expect(event.displayEventStream).toBe(true)
    expect(event.displayTimeline).toBe(true)
  })

  test('shows non-excluded events with default-all enabled', () => {
    const raw = {
      id: 1,
      agentId: 'a',
      hookName: 'UserPromptSubmit',
      timestamp: 0,
      payload: { prompt: 'hi' },
    }
    const { event } = processEvent(raw, createCtx())
    expect(event.displayEventStream).toBe(true)
    expect(event.displayTimeline).toBe(true)
  })
})

describe('claude-code processEvent — tool Pre/Post pairing', () => {
  test('Workflow Pre/Post pair groups by tool_use_id despite a taskId in the response', () => {
    // Regression: the Workflow tool_response carries a background `taskId`,
    // which used to hijack the Post event into a `task-<id>` group while
    // the Pre event grouped by tool_use_id — so the pair never merged and
    // both rows showed. They must share the tool_use_id group, and the
    // Post must fold into the Pre (hidden, marks it completed).
    const tuid = 'toolu_wf1'
    const pre = {
      id: 1,
      agentId: 'a',
      hookName: 'PreToolUse',
      timestamp: 0,
      payload: {
        tool_name: 'Workflow',
        tool_use_id: tuid,
        tool_input: { name: 'deep-research', args: 'q' },
      },
    }
    const preResult = processEvent(pre, createCtx())
    expect(preResult.event.groupId).toBe(tuid)

    const updates: Array<{ id: number; patch: Record<string, unknown> }> = []
    const ctx: ProcessingContext = {
      ...createCtx(),
      getGroupedEvents: (gid: string) => (gid === tuid ? [preResult.event] : []),
      updateEvent: (id, patch) => updates.push({ id: id as number, patch }),
    }
    const post = {
      id: 2,
      agentId: 'a',
      hookName: 'PostToolUse',
      timestamp: 1,
      payload: {
        tool_name: 'Workflow',
        tool_use_id: tuid,
        tool_input: { name: 'deep-research' },
        tool_response: { status: 'async_launched', taskId: 'wykxbl4m6', runId: 'wf_x' },
      },
    }
    const postResult = processEvent(post, ctx)
    expect(postResult.event.groupId).toBe(tuid)
    // Post folds into the Pre row.
    expect(postResult.event.displayEventStream).toBe(false)
    expect(postResult.event.displayTimeline).toBe(false)
    expect(updates.find((u) => u.id === 1)?.patch.status).toBe('completed')
  })
})

describe('claude-code processEvent — StructuredOutput', () => {
  test('gets the ToolStructuredOutput icon', () => {
    const raw = {
      id: 1,
      agentId: 'a',
      hookName: 'PreToolUse',
      timestamp: 0,
      payload: {
        tool_name: 'StructuredOutput',
        tool_use_id: 't1',
        tool_input: { summary: 'lens review' },
      },
    }
    const { event } = processEvent(raw, createCtx())
    expect(event.iconId).toBe('ToolStructuredOutput')
    expect(event.toolName).toBe('StructuredOutput')
  })

  test('summary uses the top-level summary field', () => {
    const raw = {
      id: 1,
      agentId: 'a',
      hookName: 'PreToolUse',
      timestamp: 0,
      payload: {
        tool_name: 'StructuredOutput',
        tool_use_id: 't1',
        tool_input: { summary: 'UI/auth-flow lens', findings: [{ id: 'AUTH-1' }] },
      },
    }
    const { event } = processEvent(raw, createCtx())
    expect(event.summary).toBe('UI/auth-flow lens')
  })

  test('summary falls back to first string field when summary is absent', () => {
    const raw = {
      id: 1,
      agentId: 'a',
      hookName: 'PreToolUse',
      timestamp: 0,
      payload: {
        tool_name: 'StructuredOutput',
        tool_use_id: 't1',
        tool_input: { topRisks: 'token refresh storm', findings: [{ id: 'AUTH-1' }] },
      },
    }
    const { event } = processEvent(raw, createCtx())
    expect(event.summary).toBe('token refresh storm')
  })

  test('summary falls back to a per-field breakdown when no string scalars exist', () => {
    const raw = {
      id: 1,
      agentId: 'a',
      hookName: 'PreToolUse',
      timestamp: 0,
      payload: {
        tool_name: 'StructuredOutput',
        tool_use_id: 't1',
        tool_input: { findings: [{ id: 'AUTH-1' }] },
      },
    }
    const { event } = processEvent(raw, createCtx())
    expect(event.summary).toBe('‹findings: 1›')
  })

  test('summary reports array lengths in the field breakdown', () => {
    const raw = {
      id: 1,
      agentId: 'a',
      hookName: 'PreToolUse',
      timestamp: 0,
      payload: {
        tool_name: 'StructuredOutput',
        tool_use_id: 't1',
        tool_input: {
          findings: [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }],
        },
      },
    }
    const { event } = processEvent(raw, createCtx())
    expect(event.summary).toBe('‹findings: 5›')
  })

  test('field breakdown names every key, with array lengths and object key counts', () => {
    const raw = {
      id: 1,
      agentId: 'a',
      hookName: 'PreToolUse',
      timestamp: 0,
      payload: {
        tool_name: 'StructuredOutput',
        tool_use_id: 't1',
        tool_input: { findings: [{ id: 'A' }, { id: 'B' }], effort: { level: 'xhigh' } },
      },
    }
    const { event } = processEvent(raw, createCtx())
    expect(event.summary).toBe('‹findings: 2, effort: {1}›')
  })

  test('summary uses "<id>: <refinedFix>" when summary is absent', () => {
    const raw = {
      id: 1,
      agentId: 'a',
      hookName: 'PreToolUse',
      timestamp: 0,
      payload: {
        tool_name: 'StructuredOutput',
        tool_use_id: 't1',
        tool_input: { id: 'AUTH-1', severity: 'blocker', refinedFix: 'Emit auth.token_expired' },
      },
    }
    const { event } = processEvent(raw, createCtx())
    expect(event.summary).toBe('AUTH-1: Emit auth.token_expired')
  })

  test('summary skips a too-short (<3 char) summary field', () => {
    const raw = {
      id: 1,
      agentId: 'a',
      hookName: 'PreToolUse',
      timestamp: 0,
      payload: {
        tool_name: 'StructuredOutput',
        tool_use_id: 't1',
        tool_input: { summary: 's', topRisks: 'r', findings: [{ id: 'AUTH-1' }] },
      },
    }
    const { event } = processEvent(raw, createCtx())
    // "s" and "r" are both too short, so fall through to the field breakdown.
    expect(event.summary).toBe('‹summary: s, topRisks: r, findings: 1›')
  })

  test('summary is truncated to 200 chars with an ellipsis', () => {
    const long = 'x'.repeat(500)
    const raw = {
      id: 1,
      agentId: 'a',
      hookName: 'PreToolUse',
      timestamp: 0,
      payload: {
        tool_name: 'StructuredOutput',
        tool_use_id: 't1',
        tool_input: { summary: long },
      },
    }
    const { event } = processEvent(raw, createCtx())
    expect(event.summary).toBe('x'.repeat(200) + '...')
    expect(event.summary.length).toBe(203)
  })

  test('a failure with a weak Pre summary promotes the error to the row summary', () => {
    const tuid = 'toolu_so1'
    const pre = {
      id: 1,
      agentId: 'a',
      hookName: 'PreToolUse',
      timestamp: 0,
      payload: {
        tool_name: 'StructuredOutput',
        tool_use_id: tuid,
        tool_input: { summary: 's' }, // too short → weak placeholder summary
      },
    }
    const preResult = processEvent(pre, createCtx())
    expect(isWeakSummary(preResult.event.summary)).toBe(true)

    const updates: Array<{ id: number; patch: Record<string, unknown> }> = []
    const ctx: ProcessingContext = {
      ...createCtx(),
      getGroupedEvents: (gid: string) => (gid === tuid ? [preResult.event] : []),
      updateEvent: (id, patch) => updates.push({ id: id as number, patch }),
    }
    const fail = {
      id: 2,
      agentId: 'a',
      hookName: 'PostToolUseFailure',
      timestamp: 1,
      payload: {
        tool_name: 'StructuredOutput',
        tool_use_id: tuid,
        tool_input: { summary: 's' },
        error:
          "Output does not match required schema: root: must have required property 'findings'",
      },
    }
    processEvent(fail, ctx)
    const patch = updates.find((u) => u.id === 1)?.patch
    expect(patch?.status).toBe('failed')
    expect(patch?.summary).toContain('must have required property')
  })
})
