import { describe, test, expect, beforeEach, vi } from 'vitest'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventStore } from '../storage/types'

const sharedTmpDir = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const os = require('node:os') as typeof import('node:os')
  const path = require('node:path') as typeof import('node:path')
  return fs.mkdtempSync(path.join(os.tmpdir(), 'project-cost-summary-'))
})
const transcriptConfig = vi.hoisted(() => ({
  enabled: true,
  bases: [] as Array<{ agentClass: string; host: string; container: string }>,
  maxFileBytes: 100 * 1024 * 1024,
}))
vi.mock('../config', () => ({
  config: { transcriptStats: transcriptConfig, dataDir: sharedTmpDir },
}))

const FIXTURE = [
  {
    type: 'user',
    uuid: 'u1',
    parentUuid: null,
    promptId: 'p1',
    timestamp: '2026-05-22T00:00:00.000Z',
    message: { content: 'hi' },
  },
  {
    type: 'assistant',
    uuid: 'a1',
    parentUuid: 'u1',
    timestamp: '2026-05-22T00:00:01.000Z',
    isSidechain: false,
    message: {
      id: 'msg1',
      model: 'claude-opus-4-7',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 100000,
        output_tokens: 10000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        service_tier: 'standard',
      },
      content: [{ type: 'text', text: 'hi' }],
    },
  },
]

function writeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'project-cost-summary-session-'))
  const p = join(dir, 'session.jsonl')
  writeFileSync(p, FIXTURE.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return p
}

function makeStore(overrides: Partial<EventStore>): EventStore {
  return {
    getAgentsForSession: async () => [],
    ...overrides,
  } as EventStore
}

describe('getProjectCostSummary', () => {
  beforeEach(() => {
    transcriptConfig.enabled = true
    transcriptConfig.maxFileBytes = 100 * 1024 * 1024
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          anthropic: {
            models: {
              'claude-opus-4-7': {
                id: 'claude-opus-4-7',
                cost: { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
              },
            },
          },
        }),
      }),
    )
  })

  test('sums token/cost totals across every session in the project', async () => {
    vi.resetModules()
    const { getProjectCostSummary, _testResetProjectCostSummaryCache } =
      await import('./project-cost-summary')
    _testResetProjectCostSummaryCache()

    const pathA = writeFixture()
    const pathB = writeFixture()
    const store = makeStore({
      getSessionsForProject: async () => [{ id: 'sessA' }, { id: 'sessB' }] as any,
      getSessionTranscriptPath: async (id: string) => (id === 'sessA' ? pathA : pathB),
      getAgentsForSession: async (id: string) => [{ id, agent_class: 'claude-code' }] as any,
    })

    const summary = await getProjectCostSummary(1, store)
    expect(summary.sessionsTotal).toBe(2)
    expect(summary.sessionsWithUsage).toBe(2)
    expect(summary.hasData).toBe(true)
    expect(summary.inputTokens).toBe(200000)
    expect(summary.outputTokens).toBe(20000)
    expect(summary.costCents).toBeGreaterThan(0)
  })

  test('splits totals into pipeline vs direct by session.origin_kind', async () => {
    vi.resetModules()
    const { getProjectCostSummary, _testResetProjectCostSummaryCache } =
      await import('./project-cost-summary')
    _testResetProjectCostSummaryCache()

    const pathA = writeFixture()
    const pathB = writeFixture()
    const store = makeStore({
      getSessionsForProject: async () =>
        [
          { id: 'sessA', origin_kind: 'pipeline' },
          { id: 'sessB', origin_kind: 'direct' },
        ] as any,
      getSessionTranscriptPath: async (id: string) => (id === 'sessA' ? pathA : pathB),
      getAgentsForSession: async (id: string) => [{ id, agent_class: 'claude-code' }] as any,
    })

    const summary = await getProjectCostSummary(5, store)
    expect(summary.bySource.pipeline.sessionsWithUsage).toBe(1)
    expect(summary.bySource.pipeline.inputTokens).toBe(100000)
    expect(summary.bySource.pipeline.outputTokens).toBe(10000)
    expect(summary.bySource.pipeline.costCents).toBeGreaterThan(0)
    expect(summary.bySource.direct.sessionsWithUsage).toBe(1)
    expect(summary.bySource.direct.inputTokens).toBe(100000)
    expect(summary.bySource.direct.outputTokens).toBe(10000)
    // Grand totals still sum both sources.
    expect(summary.inputTokens).toBe(200000)
    expect(summary.outputTokens).toBe(20000)
  })

  test('buckets a NULL origin_kind (pre-existing sessions) as direct', async () => {
    vi.resetModules()
    const { getProjectCostSummary, _testResetProjectCostSummaryCache } =
      await import('./project-cost-summary')
    _testResetProjectCostSummaryCache()

    const path = writeFixture()
    const store = makeStore({
      getSessionsForProject: async () => [{ id: 'sessA', origin_kind: null }] as any,
      getSessionTranscriptPath: async () => path,
      getAgentsForSession: async () => [{ id: 'sessA', agent_class: 'claude-code' }] as any,
    })

    const summary = await getProjectCostSummary(6, store)
    expect(summary.bySource.direct.sessionsWithUsage).toBe(1)
    expect(summary.bySource.pipeline.sessionsWithUsage).toBe(0)
  })

  test('skips sessions with unsupported agent classes rather than zeroing them in', async () => {
    vi.resetModules()
    const { getProjectCostSummary, _testResetProjectCostSummaryCache } =
      await import('./project-cost-summary')
    _testResetProjectCostSummaryCache()

    const store = makeStore({
      getSessionsForProject: async () => [{ id: 'sessA' }] as any,
      getSessionTranscriptPath: async () => '/nonexistent/does-not-matter.jsonl',
      getAgentsForSession: async () => [{ id: 'sessA', agent_class: 'hermes' }] as any,
    })

    const summary = await getProjectCostSummary(2, store)
    expect(summary.sessionsTotal).toBe(1)
    expect(summary.sessionsWithUsage).toBe(0)
    expect(summary.hasData).toBe(false)
  })

  test('reports hasData false and no misleading zero cost when no sessions have transcripts', async () => {
    vi.resetModules()
    const { getProjectCostSummary, _testResetProjectCostSummaryCache } =
      await import('./project-cost-summary')
    _testResetProjectCostSummaryCache()

    const store = makeStore({
      getSessionsForProject: async () => [{ id: 'sessA' }] as any,
      getSessionTranscriptPath: async () => null,
    })

    const summary = await getProjectCostSummary(3, store)
    expect(summary.hasData).toBe(false)
    expect(summary.sessionsWithUsage).toBe(0)
  })

  test('caches the result within TTL and does not re-query the store', async () => {
    vi.resetModules()
    const { getProjectCostSummary, _testResetProjectCostSummaryCache } =
      await import('./project-cost-summary')
    _testResetProjectCostSummaryCache()

    const path = writeFixture()
    let calls = 0
    const store = makeStore({
      getSessionsForProject: async () => {
        calls += 1
        return [{ id: 'sessA' }] as any
      },
      getSessionTranscriptPath: async () => path,
      getAgentsForSession: async () => [{ id: 'sessA', agent_class: 'claude-code' }] as any,
    })

    await getProjectCostSummary(4, store)
    await getProjectCostSummary(4, store)
    expect(calls).toBe(1)
  })
})
