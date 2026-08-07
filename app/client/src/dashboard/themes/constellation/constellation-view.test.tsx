import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
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

function costSummary(over: Partial<ProjectCostSummary> = {}): ProjectCostSummary {
  return {
    projectId: 1,
    inputTokens: 0,
    outputTokens: 0,
    costCents: null,
    sessionsTotal: 1,
    sessionsWithUsage: 0,
    hasData: false,
    cachedAt: Date.now(),
    bySource: {
      pipeline: { inputTokens: 0, outputTokens: 0, costCents: null, sessionsWithUsage: 0 },
      direct: { inputTokens: 0, outputTokens: 0, costCents: null, sessionsWithUsage: 0 },
    },
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

  it('zooms on wheel over the canvas and prevents the page from scrolling with it', () => {
    mockWindowed = { data: [session('a')], isLoading: false }
    // The component schedules two independent rAF chains (the animation
    // loop's self-rescheduling `frame`, and the wheel handler's one-off
    // batched `setViewH` flush) — queue every pending callback per tick
    // and flush them all, rather than tracking a single latest callback,
    // so neither chain silently displaces the other.
    let queue: FrameRequestCallback[] = []
    const raf = vi
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        queue.push(cb)
        return queue.length
      })
    const tick = () => {
      const pending = queue
      queue = []
      act(() => pending.forEach((cb) => cb(0)))
    }

    const { container } = renderWithProviders(<ConstellationView {...props} />)
    const svg = container.querySelector('svg.constellation__svg') as SVGSVGElement
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 800,
      height: 500,
      right: 800,
      bottom: 500,
      x: 0,
      y: 0,
      toJSON: () => {},
    } as DOMRect)

    // Let the camera settle to its initial position before measuring.
    for (let i = 0; i < 5; i++) tick()
    const before = svg.getAttribute('viewBox')!.split(' ').map(Number)

    const wheelEvent = new WheelEvent('wheel', {
      deltaY: -400, // scroll "up" — zoom in
      clientX: 200,
      clientY: 200,
      bubbles: true,
      cancelable: true,
    })
    const notCancelled = svg.dispatchEvent(wheelEvent)
    // dispatchEvent returns false when preventDefault() was called — this is
    // what keeps the page/site from also scrolling while zooming the canvas.
    expect(notCancelled).toBe(false)

    for (let i = 0; i < 30; i++) tick()
    const after = svg.getAttribute('viewBox')!.split(' ').map(Number)

    // Zooming in shrinks the world-space viewBox.
    expect(after[2]).toBeLessThan(before[2])
    expect(after[3]).toBeLessThan(before[3])

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
      1: costSummary({
        inputTokens: 900_000,
        outputTokens: 100_000,
        costCents: 1234,
        sessionsWithUsage: 1,
        hasData: true,
      }),
    }
    renderWithProviders(<ConstellationView {...props} />)
    await waitFor(() => expect(screen.getByText('1.0M tok · $12.34')).toBeTruthy())
  })

  it('renders no cost label when the project has no transcript-derived usage data', async () => {
    mockWindowed = { data: [session('swift-otter', { projectId: 1 })], isLoading: false }
    mockCostSummaries = { 1: costSummary() }
    renderWithProviders(<ConstellationView {...props} />)
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())
    expect(screen.queryByText(/tok/)).toBeNull()
  })

  it('shows a pipeline-vs-direct split label once a pipeline session has usage', async () => {
    mockWindowed = { data: [session('swift-otter', { projectId: 1 })], isLoading: false }
    mockCostSummaries = {
      1: costSummary({
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        costCents: 1300,
        sessionsWithUsage: 2,
        hasData: true,
        bySource: {
          pipeline: {
            inputTokens: 300_000,
            outputTokens: 30_000,
            costCents: 400,
            sessionsWithUsage: 1,
          },
          direct: {
            inputTokens: 700_000,
            outputTokens: 70_000,
            costCents: 900,
            sessionsWithUsage: 1,
          },
        },
      }),
    }
    renderWithProviders(<ConstellationView {...props} />)
    await waitFor(() =>
      expect(
        screen.getByText('◆ pipeline 330.0K tok/$4.00 · direct 770.0K tok/$9.00'),
      ).toBeTruthy(),
    )
  })

  it('does not show a split label when the project has no pipeline-sourced sessions', async () => {
    mockWindowed = { data: [session('swift-otter', { projectId: 1 })], isLoading: false }
    mockCostSummaries = {
      1: costSummary({
        inputTokens: 900_000,
        outputTokens: 100_000,
        costCents: 1234,
        sessionsWithUsage: 1,
        hasData: true,
        bySource: {
          pipeline: { inputTokens: 0, outputTokens: 0, costCents: 0, sessionsWithUsage: 0 },
          direct: {
            inputTokens: 900_000,
            outputTokens: 100_000,
            costCents: 1234,
            sessionsWithUsage: 1,
          },
        },
      }),
    }
    renderWithProviders(<ConstellationView {...props} />)
    await waitFor(() => expect(screen.getByText('1.0M tok · $12.34')).toBeTruthy())
    expect(screen.queryByText(/◆ pipeline/)).toBeNull()
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
