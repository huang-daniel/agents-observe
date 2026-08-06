import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@/test/test-utils'
import { useUIStore } from '@/stores/ui-store'
import { ConstellationView } from './constellation-view'
import type { RecentSession } from '@/types'
import type { ProjectCostSummary } from '@/lib/api-client'

// The constellation fetches its own activity-windowed sessions; mock that hook.
let mockWindowed: { data: RecentSession[]; isLoading: boolean } = { data: [], isLoading: false }
vi.mock('@/hooks/use-windowed-sessions', () => ({
  useWindowedSessions: () => mockWindowed,
}))

// Per-project cost/token label — mock the summary endpoint directly so
// tests control what each well's label renders without a real server.
let mockCostSummaries: Record<number, ProjectCostSummary | null> = {}
vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      getProjectCostSummary: (projectId: number) =>
        Promise.resolve(mockCostSummaries[projectId] ?? null),
    },
  }
})

function session(id: string, over: Partial<RecentSession> = {}): RecentSession {
  return {
    id,
    projectId: 1,
    projectSlug: 'alpha',
    projectName: 'alpha',
    slug: id,
    status: 'active',
    startedAt: 0,
    stoppedAt: null,
    metadata: null,
    lastActivity: Date.now(),
    agentClasses: ['ClaudeCode'],
    eventCount: 100,
    agentCount: 3,
    ...over,
  }
}

const props = { sessions: [], isLoading: false, onOpenSession: () => {} }

afterEach(() => {
  cleanup()
  useUIStore.getState().clearPreviewSession()
  mockWindowed = { data: [], isLoading: false }
  mockCostSummaries = {}
})

describe('ConstellationView', () => {
  it('mounts and renders a star + well label per session/project without throwing', () => {
    mockWindowed = {
      data: [
        session('swift-otter'),
        session('calm-harbor', { projectName: 'beta', projectId: 2, projectSlug: 'beta' }),
      ],
      isLoading: false,
    }
    renderWithProviders(<ConstellationView {...props} />)
    expect(screen.getByText('swift-otter')).toBeTruthy()
    expect(screen.getByText('calm-harbor')).toBeTruthy()
    expect(screen.getByText('alpha')).toBeTruthy() // well label
    expect(screen.getByText('beta')).toBeTruthy()
    expect(screen.getByText('Deep Space')).toBeTruthy() // palette control
  })

  it('shows an empty state when there are no sessions in the window', () => {
    mockWindowed = { data: [], isLoading: false }
    renderWithProviders(<ConstellationView {...props} />)
    expect(screen.getByText(/No sessions active in the last 24 hours/i)).toBeTruthy()
  })

  it('runs its animation frame without error', () => {
    mockWindowed = { data: [session('a')], isLoading: false }
    let fired = false
    const raf = vi
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        if (!fired) {
          fired = true
          cb(0)
        }
        return 0
      })
    expect(() => renderWithProviders(<ConstellationView {...props} />)).not.toThrow()
    raf.mockRestore()
  })

  it('renders inline sliders and collapses the controls to a gear', () => {
    mockWindowed = { data: [session('a')], isLoading: false }
    renderWithProviders(<ConstellationView {...props} />)
    // sliders present
    expect(screen.getByText('window')).toBeTruthy()
    expect(screen.getByText('zoom')).toBeTruthy()
    expect(screen.getByText('decay τ')).toBeTruthy()
    expect(screen.getByText('Deep Space')).toBeTruthy() // palette visible while expanded

    fireEvent.click(screen.getByLabelText('Hide controls'))
    expect(screen.queryByText('Deep Space')).toBeNull() // body collapsed
    expect(screen.getByLabelText('Show controls')).toBeTruthy() // gear remains

    fireEvent.click(screen.getByLabelText('Show controls'))
    expect(screen.getByText('Deep Space')).toBeTruthy() // expanded again
  })

  it('shows a cost/token label on the well once the project cost summary loads', async () => {
    mockWindowed = { data: [session('swift-otter', { projectId: 1 })], isLoading: false }
    mockCostSummaries = {
      1: {
        projectId: 1,
        inputTokens: 900_000,
        outputTokens: 100_000,
        costCents: 1234,
        sessionsTotal: 1,
        sessionsWithUsage: 1,
        hasData: true,
        cachedAt: Date.now(),
      },
    }
    renderWithProviders(<ConstellationView {...props} />)
    await waitFor(() => expect(screen.getByText('1.0M tok · $12.34')).toBeTruthy())
  })

  it('renders no cost label when the project has no transcript-derived usage data', async () => {
    mockWindowed = { data: [session('swift-otter', { projectId: 1 })], isLoading: false }
    mockCostSummaries = {
      1: {
        projectId: 1,
        inputTokens: 0,
        outputTokens: 0,
        costCents: null,
        sessionsTotal: 1,
        sessionsWithUsage: 0,
        hasData: false,
        cachedAt: Date.now(),
      },
    }
    renderWithProviders(<ConstellationView {...props} />)
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())
    expect(screen.queryByText(/tok/)).toBeNull()
  })

  it('sets the sidebar preview on focus and clears it on background click', () => {
    mockWindowed = { data: [session('swift-otter', { projectId: 7 })], isLoading: false }
    const { container } = renderWithProviders(<ConstellationView {...props} />)
    expect(useUIStore.getState().previewSessionId).toBeNull()

    const star = screen.getByText('swift-otter').closest('g.cst-star')!
    fireEvent.click(star)
    expect(useUIStore.getState().previewSessionId).toBe('swift-otter')
    expect(useUIStore.getState().previewProjectId).toBe(7)

    fireEvent.click(container.querySelector('svg')!)
    expect(useUIStore.getState().previewSessionId).toBeNull()
  })
})
