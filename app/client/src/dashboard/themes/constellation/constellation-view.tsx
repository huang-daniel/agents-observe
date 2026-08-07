import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { useUIStore } from '@/stores/ui-store'
import { useNotificationStore } from '@/components/sidebar/notification-indicator'
import { useWindowedSessions } from '@/hooks/use-windowed-sessions'
import type { DashboardThemeProps } from '../../types'
import type { RecentSession } from '@/types'
import { api } from '@/lib/api-client'
import { fmtCents } from '@/components/settings/sections/token-usage-section'
import {
  radius,
  heat,
  packProjects,
  stepSimulation,
  type SimNode,
  type Well,
  type Bounds,
} from './physics'
import { PALETTES, parseColor, resolvePaletteId, tempColor, type RGB } from './palettes'
import { DrillIn } from './drill-in'
import {
  DEFAULT_WINDOW_MS,
  DEFAULT_VIEW_H,
  ZOOM_MIN_VIEW,
  ZOOM_MAX_VIEW,
  windowPosToMs,
  windowMsToPos,
  zoomPosToViewH,
  viewHToZoomPos,
  zoomPercent,
  fmtDuration,
} from './scale'
import { Settings } from 'lucide-react'
import './constellation.css'

const PALETTE_STORAGE_KEY = 'agents-observe-constellation-palette'
const WINDOW_STORAGE_KEY = 'agents-observe-constellation-window'
const ZOOM_STORAGE_KEY = 'agents-observe-constellation-zoom'
const COLLAPSED_STORAGE_KEY = 'agents-observe-constellation-collapsed'
const DRAG_THRESH = 6 // px of movement before a press counts as a pan, not a click
const BOUNDS_PAD = 140 // world-unit margin around content (star clamp + pan overscroll)
const SMALL_WELL_R = 88 // wells below this only label on hover
const DRILL_VIEW_H = 520 // world height when drilled into a session
// Well size reflects activity across the *window*, so it uses a much longer
// half-life than the star glow's τ (which is a live, seconds-scale signal).
// A project touched an hour ago should still read as "big", not collapse to
// the floor. ~4h gives a smooth falloff over the 24h window.
const WELL_TAU_SEC = 4 * 60 * 60

interface NodeMeta {
  id: string
  slug: string
  projectKey: string
  projectName: string
  baseR: number
  orbitDots: number
  lastActivity: number
  originKind: 'pipeline' | 'direct' | null
}

interface NodeEls {
  g: SVGGElement
  core: SVGCircleElement | null
  glow: SVGCircleElement | null
  pulseWrap: SVGGElement | null
  label: SVGTextElement | null
}

interface Cam {
  cx: number
  cy: number
  w: number
  h: number
}

function projectKeyOf(s: RecentSession): string {
  return s.projectId != null ? `p${s.projectId}` : 'unassigned'
}

/** projectKeyOf's inverse for the well keys that came from a real project
 *  (`unassigned` has no cost summary to fetch — it isn't a project row). */
function projectIdFromWellKey(key: string): number | null {
  if (!key.startsWith('p')) return null
  const id = Number(key.slice(1))
  return Number.isFinite(id) ? id : null
}

function fmtTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K tok`
  return `${n} tok`
}

const clampNum = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

function camViewBox(c: Cam): [number, number, number, number] {
  return [c.cx - c.w / 2, c.cy - c.h / 2, c.w, c.h]
}

function clampCam(cam: Cam, b: Bounds): Cam {
  const pad = BOUNDS_PAD
  const worldW = b.maxX + pad - (b.minX - pad)
  const worldH = b.maxY + pad - (b.minY - pad)
  const cx =
    cam.w >= worldW
      ? (b.minX + b.maxX) / 2
      : clampNum(cam.cx, b.minX - pad + cam.w / 2, b.maxX + pad - cam.w / 2)
  const cy =
    cam.h >= worldH
      ? (b.minY + b.maxY) / 2
      : clampNum(cam.cy, b.minY - pad + cam.h / 2, b.maxY + pad - cam.h / 2)
  return { cx, cy, w: cam.w, h: cam.h }
}

// Native palette RGBs as a safe default until the first getComputedStyle read.
const DEFAULT_RGB = { cool: [91, 107, 130], warm: [250, 204, 21], hot: [249, 115, 22] } as {
  cool: RGB
  warm: RGB
  hot: RGB
}

export function ConstellationView({ onOpenSession }: DashboardThemeProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const drillLayerRef = useRef<SVGGElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

  const [paletteId, setPaletteId] = useState(() =>
    resolvePaletteId(localStorage.getItem(PALETTE_STORAGE_KEY)),
  )
  const [reduced, setReduced] = useState(false)
  const [tau, setTau] = useState(90)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [windowMs, setWindowMs] = useState(
    () => Number(localStorage.getItem(WINDOW_STORAGE_KEY)) || DEFAULT_WINDOW_MS,
  )
  const [viewH, setViewH] = useState(
    () => Number(localStorage.getItem(ZOOM_STORAGE_KEY)) || DEFAULT_VIEW_H,
  )
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(COLLAPSED_STORAGE_KEY) === '1',
  )

  // The constellation renders an activity window, not the host's recent-30.
  const { data: sessions = [], isLoading } = useWindowedSessions(windowMs)

  // Attention flags from the global notification store (pending && !dismissed).
  const pending = useNotificationStore((s) => s.pending)
  const dismissed = useNotificationStore((s) => s.dismissed)
  const flaggedSet = useMemo(() => {
    const set = new Set<string>()
    for (const id of pending.keys()) if (!dismissed.has(id)) set.add(id)
    return set
  }, [pending, dismissed])

  const nodes = useMemo<NodeMeta[]>(
    () =>
      sessions.map((s) => ({
        id: s.id,
        slug: s.slug || s.id.slice(0, 8),
        projectKey: projectKeyOf(s),
        projectName:
          s.projectName || (s.projectId == null ? 'Unassigned' : `project ${s.projectId}`),
        baseR: radius(s.eventCount),
        orbitDots: Math.min(Math.max((s.agentCount ?? 1) - 1, 0), 6),
        lastActivity: s.lastActivity,
        originKind: s.originKind ?? null,
      })),
    [sessions],
  )

  // Pack project wells, sized by aggregate recency heat (busiest = biggest,
  // centred). Recomputed when the session set changes (which happens on each
  // WS-driven refetch), so sizes track real activity; CSS transitions smooth it.
  const {
    wells,
    bounds: worldBounds,
    wellNames,
  } = useMemo(() => {
    const now = Date.now()
    const byProject = new Map<
      string,
      { name: string; score: number; count: number; sumR: number }
    >()
    for (const s of sessions) {
      const key = projectKeyOf(s)
      const e = byProject.get(key) ?? {
        name: s.projectName || (s.projectId == null ? 'Unassigned' : `project ${s.projectId}`),
        score: 0,
        count: 0,
        sumR: 0,
      }
      e.score += heat(s.lastActivity, now, WELL_TAU_SEC)
      e.count += 1
      e.sumR += radius(s.eventCount)
      byProject.set(key, e)
    }
    const items = [...byProject.entries()].map(([key, e]) => ({
      key,
      score: e.score,
      // containment floor: enough room for the project's stars to orbit.
      containR: Math.max(60, 30 + 9 * Math.sqrt(e.count) + e.sumR / Math.max(1, e.count)),
    }))
    const packed = packProjects(items)
    const names = new Map<string, string>()
    for (const [key, e] of byProject) names.set(key, e.name)
    return { wells: packed.wells, bounds: packed.bounds, wellNames: names }
  }, [sessions])

  // Per-well cost/token label. One request per visible project, cached
  // server-side (see project-cost-summary.ts) so re-renders/poll ticks
  // don't force a full transcript re-parse. "Unassigned" has no project
  // row to query. staleTime matches the server cache TTL.
  const wellProjectIds = useMemo(
    () => [...new Set(wells.map((w) => projectIdFromWellKey(w.key)).filter((id) => id != null))],
    [wells],
  )
  const costSummaryQueries = useQueries({
    queries: wellProjectIds.map((projectId) => ({
      queryKey: ['project-cost-summary', projectId],
      queryFn: () => api.getProjectCostSummary(projectId),
      staleTime: 60_000,
      refetchInterval: 60_000,
    })),
  })
  const wellCostLabels = useMemo(() => {
    const out = new Map<string, string>()
    wellProjectIds.forEach((projectId, i) => {
      const summary = costSummaryQueries[i]?.data
      if (!summary || !summary.hasData) return
      const tokens = summary.inputTokens + summary.outputTokens
      const label =
        summary.costCents == null
          ? fmtTokensCompact(tokens)
          : `${fmtTokensCompact(tokens)} · ${fmtCents(summary.costCents)}`
      out.set(`p${projectId}`, label)
    })
    return out
  }, [wellProjectIds, costSummaryQueries])

  // Worktree-pipeline vs direct-session cost split — a second line under
  // the well's combined cost label, shown only once at least one session
  // in the project actually went through the pipeline path, so a project
  // that's 100% direct work isn't cluttered with a redundant "direct-only"
  // line.
  const wellCostSplitLabels = useMemo(() => {
    const out = new Map<string, string>()
    wellProjectIds.forEach((projectId, i) => {
      const summary = costSummaryQueries[i]?.data
      if (!summary || !summary.hasData) return
      const { pipeline, direct } = summary.bySource
      if (pipeline.sessionsWithUsage === 0) return
      const fmtSplit = (s: (typeof summary.bySource)['pipeline']) => {
        const tok = fmtTokensCompact(s.inputTokens + s.outputTokens)
        return s.costCents == null ? tok : `${tok}/${fmtCents(s.costCents)}`
      }
      out.set(`p${projectId}`, `◆ pipeline ${fmtSplit(pipeline)} · direct ${fmtSplit(direct)}`)
    })
    return out
  }, [wellProjectIds, costSummaryQueries])

  // ---- imperative state shared with the animation loop (no re-render) ----
  const simRef = useRef(new Map<string, SimNode>())
  const elRef = useRef(new Map<string, NodeEls>())
  const nodesRef = useRef<NodeMeta[]>([])
  const simListRef = useRef<SimNode[]>([])
  const orbitIdsRef = useRef(new Set<string>())
  const wellByKeyRef = useRef(new Map<string, Well>())
  const flaggedRef = useRef(flaggedSet)
  const focusedRef = useRef<string | null>(null)
  const paletteRgbRef = useRef(DEFAULT_RGB)
  const tauRef = useRef(tau)
  const viewHRef = useRef(viewH)

  // camera / pan
  const containerSizeRef = useRef({ w: 1, h: 1 })
  const worldBoundsRef = useRef<Bounds>(worldBounds)
  const paddedBoundsRef = useRef<Bounds>(worldBounds)
  const camRef = useRef<Cam>({ cx: 0, cy: 0, w: DEFAULT_VIEW_H * 1.6, h: viewH })
  const camInitedRef = useRef(false)
  const viewRef = useRef<[number, number, number, number]>([
    -DEFAULT_VIEW_H * 0.8,
    -viewH / 2,
    DEFAULT_VIEW_H * 1.6,
    viewH,
  ])
  const drillBoxRef = useRef<[number, number, number, number] | null>(null)
  const draggingRef = useRef(false)
  const movedRef = useRef(false)
  const capturedRef = useRef(false)
  const panStartRef = useRef({ x: 0, y: 0, cx: 0, cy: 0 })
  const wheelZoomFrameRef = useRef(0)

  useEffect(() => {
    flaggedRef.current = flaggedSet
  }, [flaggedSet])
  useEffect(() => {
    tauRef.current = tau
  }, [tau])
  useEffect(() => {
    focusedRef.current = focusedId
  }, [focusedId])

  const camSize = useCallback((): { w: number; h: number } => {
    const { w, h } = containerSizeRef.current
    const aspect = w && h ? w / h : 16 / 9
    const vh = viewHRef.current
    return { w: vh * aspect, h: vh }
  }, [])

  // Zoom: resize the camera when the zoom slider changes (the loop eases the
  // viewBox toward it, so zoom animates smoothly). Persist the choice.
  // NOT gated on camInited — a window change clears that flag to force a
  // recenter, and gating here would silently swallow zoom in that interval.
  // Resizing camRef is always safe: the loop follows it, and the pending
  // recenter re-derives its size from camSize() (this viewH).
  useEffect(() => {
    viewHRef.current = viewH
    localStorage.setItem(ZOOM_STORAGE_KEY, String(viewH))
    camRef.current = clampCam({ ...camRef.current, ...camSize() }, worldBoundsRef.current)
  }, [viewH, camSize])

  // Measure the container for px↔world conversion and camera aspect.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => {
      containerSizeRef.current = { w: el.clientWidth, h: el.clientHeight }
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Keep sim ↔ node list in sync; spawn new stars near their well centre.
  useEffect(() => {
    const wellByKey = new Map(wells.map((w) => [w.key, w]))
    wellByKeyRef.current = wellByKey
    const sim = simRef.current
    const live = new Set(nodes.map((n) => n.id))
    for (const id of [...sim.keys()]) if (!live.has(id)) sim.delete(id)
    for (const n of nodes) {
      const w = wellByKey.get(n.projectKey)
      if (!sim.has(n.id)) {
        sim.set(n.id, {
          id: n.id,
          x: (w ? w.cx : 0) + (Math.random() - 0.5) * 120,
          y: (w ? w.cy : 0) + (Math.random() - 0.5) * 120,
          vx: 0,
          vy: 0,
          projectKey: n.projectKey,
          baseR: n.baseR,
          heat: 0,
          attention: false,
        })
      } else {
        const s = sim.get(n.id)!
        s.projectKey = n.projectKey
        s.baseR = n.baseR
      }
    }
    nodesRef.current = nodes
    simListRef.current = nodes.map((n) => sim.get(n.id)!).filter(Boolean)
    orbitIdsRef.current = new Set(nodes.filter((n) => n.orbitDots > 0).map((n) => n.id))
  }, [nodes, wells])

  // Update world bounds + camera on layout changes; center on the busiest well once.
  useEffect(() => {
    worldBoundsRef.current = worldBounds
    paddedBoundsRef.current = {
      minX: worldBounds.minX - BOUNDS_PAD,
      minY: worldBounds.minY - BOUNDS_PAD,
      maxX: worldBounds.maxX + BOUNDS_PAD,
      maxY: worldBounds.maxY + BOUNDS_PAD,
    }
    if (!wells.length) return
    const busiest = wells.reduce((m, w) => (w.r > m.r ? w : m), wells[0])
    const size = camSize()
    if (!camInitedRef.current) {
      camRef.current = clampCam({ cx: busiest.cx, cy: busiest.cy, ...size }, worldBounds)
      viewRef.current = [...camViewBox(camRef.current)]
      svgRef.current?.setAttribute('viewBox', viewRef.current.join(' '))
      camInitedRef.current = true
    } else {
      // keep current pan valid against the new bounds/size
      camRef.current = clampCam({ ...camRef.current, ...size }, worldBounds)
    }
  }, [wells, worldBounds, camSize])

  // Recompute cached palette RGBs whenever the palette changes.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const cs = getComputedStyle(el)
    const read = (name: string, fallback: RGB): RGB => {
      const v = cs.getPropertyValue(name).trim()
      return v ? parseColor(v) : fallback
    }
    paletteRgbRef.current = {
      cool: read('--c-cool', DEFAULT_RGB.cool),
      warm: read('--c-warm', DEFAULT_RGB.warm),
      hot: read('--c-hot', DEFAULT_RGB.hot),
    }
  }, [paletteId])

  const registerNode = useCallback((id: string, g: SVGGElement | null) => {
    if (!g) {
      elRef.current.delete(id)
      return
    }
    elRef.current.set(id, {
      g,
      core: g.querySelector('.cst-core'),
      glow: g.querySelector('.cst-glow'),
      pulseWrap: g.querySelector('.cst-pulse-wrap'),
      label: g.querySelector('.cst-label'),
    })
  }, [])

  // ---- the animation loop ----
  useEffect(() => {
    let raf = 0
    const hasOrbit = (n: SimNode) => orbitIdsRef.current.has(n.id)

    const frame = () => {
      const now = Date.now()
      const activityAt = useUIStore.getState().sessionActivityAt
      const flagged = flaggedRef.current
      const { cool, warm, hot } = paletteRgbRef.current
      const tauSec = tauRef.current
      const metas = nodesRef.current
      const sim = simRef.current

      for (const m of metas) {
        const s = sim.get(m.id)
        if (!s) continue
        s.heat = heat(activityAt[m.id] ?? m.lastActivity, now, tauSec)
        s.attention = flagged.has(m.id)
      }

      if (!focusedRef.current) {
        stepSimulation(simListRef.current, wellByKeyRef.current, hasOrbit, paddedBoundsRef.current)
      }

      // camera: snap to pan while dragging, else ease toward target (pan or drill box)
      const target =
        focusedRef.current && drillBoxRef.current ? drillBoxRef.current : camViewBox(camRef.current)
      const vb = viewRef.current
      if (draggingRef.current && !focusedRef.current) {
        for (let i = 0; i < 4; i++) vb[i] = target[i]
        svgRef.current?.setAttribute('viewBox', vb.join(' '))
      } else {
        let moved = false
        for (let i = 0; i < 4; i++) {
          const d = target[i] - vb[i]
          if (Math.abs(d) > 0.5) {
            vb[i] += d * 0.16
            moved = true
          } else vb[i] = target[i]
        }
        if (moved) svgRef.current?.setAttribute('viewBox', vb.join(' '))
      }

      for (const m of metas) {
        const s = sim.get(m.id)
        const els = elRef.current.get(m.id)
        if (!s || !els) continue
        const h = s.heat
        const col = tempColor(h, cool, warm, hot)
        const r = m.baseR * (0.82 + 0.18 * h)
        els.g.style.transform = `translate(${s.x}px, ${s.y}px)`
        els.g.style.opacity = s.attention ? '1' : (0.2 + 0.8 * h).toFixed(3)
        if (els.core) {
          els.core.setAttribute('r', r.toFixed(2))
          els.core.setAttribute('fill', col)
          els.core.style.filter =
            h > 0.06 ? `drop-shadow(0 0 ${(m.baseR * 0.7 * h).toFixed(1)}px ${col})` : 'none'
        }
        if (els.glow) {
          els.glow.setAttribute('fill', col)
          els.glow.style.opacity = (0.5 * h).toFixed(3)
        }
        if (els.pulseWrap) els.pulseWrap.style.opacity = Math.max(0, h - 0.06).toFixed(3)
        if (els.label) els.label.style.opacity = (0.28 + 0.55 * h).toFixed(3)
      }

      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  // ---- tooltip ----
  const showTooltip = (e: React.MouseEvent, m: NodeMeta) => {
    const t = tooltipRef.current
    if (!t || draggingRef.current) return
    const flagged = flaggedRef.current.has(m.id)
    t.style.opacity = '1'
    t.style.left = `${e.clientX}px`
    t.style.top = `${e.clientY + 16}px`
    t.innerHTML =
      `<div class="cst-tt-slug">${m.slug}</div>` +
      `<div class="cst-tt-row"><span>project</span><b>${m.projectName}</b></div>` +
      `<div class="cst-tt-row"><span>subagents</span><b>${m.orbitDots}</b></div>` +
      (m.originKind === 'pipeline' ? `<div class="cst-tt-pipeline">◆ Pipeline agent</div>` : '') +
      (flagged ? `<div class="cst-tt-attn">● needs attention</div>` : '')
  }
  const hideTooltip = () => {
    if (tooltipRef.current) tooltipRef.current.style.opacity = '0'
  }

  // ---- focus / drill-in ----
  const focus = (id: string) => {
    const s = simRef.current.get(id)
    if (!s) return
    const { w: cw, h: ch } = containerSizeRef.current
    const aspect = cw && ch ? cw / ch : 16 / 9
    const zh = DRILL_VIEW_H
    const zw = zh * aspect
    drillBoxRef.current = [s.x - zw / 2, s.y - zh / 2, zw, zh]
    setFocusedId(id)
    hideTooltip()
    const sess = sessions.find((x) => x.id === id)
    useUIStore.getState().setPreviewSession(id, sess?.projectId ?? null)
  }
  const unfocus = useCallback(() => {
    drillBoxRef.current = null
    setFocusedId(null)
    useUIStore.getState().clearPreviewSession()
  }, [])

  useEffect(() => () => useUIStore.getState().clearPreviewSession(), [])

  // ---- pan (drag the canvas) ----
  const onPointerDown = (e: React.PointerEvent) => {
    if (focusedRef.current) return
    // Arm a potential pan, but DON'T capture the pointer yet — capturing on
    // press would steal the `click` from a star and break drill-in. We capture
    // only once movement crosses the drag threshold (in onPointerMove).
    draggingRef.current = true
    movedRef.current = false
    panStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      cx: camRef.current.cx,
      cy: camRef.current.cy,
    }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return
    const st = panStartRef.current
    const dx = e.clientX - st.x
    const dy = e.clientY - st.y
    if (!movedRef.current) {
      if (Math.abs(dx) + Math.abs(dy) <= DRAG_THRESH) return // still a click, not a pan
      movedRef.current = true
      svgRef.current?.setPointerCapture?.(e.pointerId)
      capturedRef.current = true
      if (svgRef.current) svgRef.current.style.cursor = 'grabbing'
    }
    const perPx = camRef.current.w / (containerSizeRef.current.w || 1)
    camRef.current = clampCam(
      { ...camRef.current, cx: st.cx - dx * perPx, cy: st.cy - dy * perPx },
      worldBoundsRef.current,
    )
  }
  const onPointerUp = (e: React.PointerEvent) => {
    draggingRef.current = false
    if (capturedRef.current) {
      svgRef.current?.releasePointerCapture?.(e.pointerId)
      capturedRef.current = false
    }
    if (svgRef.current) svgRef.current.style.cursor = ''
  }
  // ---- scroll-to-zoom, centered on the cursor ----
  // Attached as a native (non-passive) listener rather than JSX onWheel:
  // React marks synthetic wheel handlers passive, so preventDefault() inside
  // them is silently ignored (and warns) — we need it to stop page/site
  // scroll from fighting the zoom while the pointer is over the canvas.
  // camRef is updated synchronously here (same as onPointerMove's pan), and
  // the animation loop's existing pan/zoom easing carries it to the on-screen
  // viewBox — no separate zoom-specific easing needed. `setViewH` (which
  // persists to localStorage and drives the zoom slider) is batched to once
  // per animation frame so a fast trackpad fling doesn't spam re-renders.
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (focusedRef.current) return // no zoom while drilled into a session
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      const cam = camRef.current
      const cursorX = e.clientX - (rect.left + rect.width / 2)
      const cursorY = e.clientY - (rect.top + rect.height / 2)
      const worldX = cam.cx + cursorX * (cam.w / rect.width)
      const worldY = cam.cy + cursorY * (cam.h / rect.height)

      // Natural wheel direction: scrolling "down" (positive deltaY) zooms
      // out (larger viewH), matching the map/canvas convention used
      // elsewhere in the app.
      const factor = Math.exp(e.deltaY * 0.0015)
      const nextViewH = Math.min(ZOOM_MAX_VIEW, Math.max(ZOOM_MIN_VIEW, viewHRef.current * factor))
      const scale = nextViewH / viewHRef.current
      const newW = cam.w * scale
      const newH = cam.h * scale
      const newCx = worldX - cursorX * (newW / rect.width)
      const newCy = worldY - cursorY * (newH / rect.height)

      camRef.current = clampCam({ cx: newCx, cy: newCy, w: newW, h: newH }, worldBoundsRef.current)
      viewHRef.current = nextViewH
      if (!wheelZoomFrameRef.current) {
        wheelZoomFrameRef.current = requestAnimationFrame(() => {
          wheelZoomFrameRef.current = 0
          setViewH(viewHRef.current)
        })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      if (wheelZoomFrameRef.current) cancelAnimationFrame(wheelZoomFrameRef.current)
    }
  }, [])

  const onBackgroundClick = () => {
    if (movedRef.current) {
      movedRef.current = false
      return
    }
    if (focusedId) unfocus()
  }
  const recenter = useCallback(() => {
    const ws = wells
    if (!ws.length) return
    const busiest = ws.reduce((m, w) => (w.r > m.r ? w : m), ws[0])
    camRef.current = clampCam(
      { cx: busiest.cx, cy: busiest.cy, ...camSize() },
      worldBoundsRef.current,
    )
  }, [wells, camSize])

  const focusedSim = focusedId ? simRef.current.get(focusedId) : null

  const selectPalette = (id: string) => {
    setPaletteId(id)
    localStorage.setItem(PALETTE_STORAGE_KEY, id)
  }
  const onWindowChange = (ms: number) => {
    setWindowMs(ms)
    localStorage.setItem(WINDOW_STORAGE_KEY, String(ms))
    // The visible projects change with the window — recenter on the next pack.
    camInitedRef.current = false
  }
  const onToggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c
      localStorage.setItem(COLLAPSED_STORAGE_KEY, next ? '1' : '0')
      return next
    })
  }

  if (!isLoading && sessions.length === 0) {
    return (
      <div className="constellation flex items-center justify-center" data-palette={paletteId}>
        <div className="text-sm" style={{ color: 'var(--c-muted)' }}>
          No sessions active in the last 24 hours.
        </div>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      data-palette={paletteId}
      className={
        'constellation' +
        (focusedId ? ' constellation--focused' : '') +
        (reduced ? ' constellation--reduced' : '')
      }
    >
      <svg
        ref={svgRef}
        className="constellation__svg"
        viewBox="-800 -500 1600 1000"
        preserveAspectRatio="xMidYMid slice"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={onBackgroundClick}
        onDoubleClick={() => !focusedId && recenter()}
      >
        <g className="cst-field">
          {wells.map((w) => {
            const small = w.r < SMALL_WELL_R
            return (
              <g
                key={w.key}
                className="cst-well-g"
                style={{ transform: `translate(${w.cx}px, ${w.cy}px)` }}
              >
                <circle className="cst-well" cx={0} cy={0} r={w.r} />
                <circle className="cst-well-ring" cx={0} cy={0} r={w.r} />
                <text
                  className={'cst-well-label' + (small ? ' cst-well-label--small' : '')}
                  x={0}
                  y={-w.r - 10}
                >
                  {wellNames.get(w.key)}
                </text>
                {wellCostLabels.has(w.key) && (
                  <text
                    className={'cst-well-cost-label' + (small ? ' cst-well-cost-label--small' : '')}
                    x={0}
                    y={-w.r - 24}
                  >
                    {wellCostLabels.get(w.key)}
                  </text>
                )}
                {wellCostSplitLabels.has(w.key) && (
                  <text
                    className={
                      'cst-well-split-label' + (small ? ' cst-well-split-label--small' : '')
                    }
                    x={0}
                    y={-w.r - 38}
                  >
                    {wellCostSplitLabels.get(w.key)}
                  </text>
                )}
              </g>
            )
          })}
          {nodes.map((m) => {
            const orbitR = m.baseR + 16
            const flagged = flaggedSet.has(m.id)
            return (
              <g
                key={m.id}
                ref={(g) => registerNode(m.id, g)}
                className={
                  'cst-star' +
                  (focusedId === m.id ? ' cst-star--focused' : '') +
                  (m.originKind === 'pipeline' ? ' cst-star--pipeline' : '')
                }
                onMouseMove={(e) => !focusedId && showTooltip(e, m)}
                onMouseLeave={hideTooltip}
                onClick={(e) => {
                  e.stopPropagation()
                  if (movedRef.current) {
                    movedRef.current = false
                    return
                  }
                  focus(m.id)
                }}
              >
                <g className="cst-pulse-wrap" style={{ opacity: 0 }}>
                  <circle className="cst-pulse" cx={0} cy={0} r={12} />
                </g>
                <circle
                  className="cst-glow"
                  cx={0}
                  cy={0}
                  r={m.baseR * 1.5}
                  style={{ filter: 'blur(6px)', opacity: 0 }}
                  fill="var(--c-cool)"
                />
                {m.orbitDots > 0 && (
                  <>
                    <circle className="cst-orbit-path" cx={0} cy={0} r={orbitR} />
                    <g
                      className="cst-orbit"
                      style={{ animationDuration: `${11 + m.orbitDots * 3}s` }}
                    >
                      {Array.from({ length: m.orbitDots }).map((_, i) => {
                        const a = (i / m.orbitDots) * Math.PI * 2
                        const sx = Math.cos(a) * orbitR
                        const sy = Math.sin(a) * orbitR
                        return (
                          <g key={i}>
                            <line className="cst-edge" x1={0} y1={0} x2={sx} y2={sy} />
                            <circle
                              className="cst-sub"
                              cx={sx}
                              cy={sy}
                              r={4.5}
                              fill="var(--c-warm)"
                            />
                          </g>
                        )
                      })}
                    </g>
                  </>
                )}
                <circle className="cst-core" cx={0} cy={0} r={m.baseR} fill="var(--c-cool)" />
                {flagged && (
                  <>
                    <circle className="cst-flare" cx={0} cy={0} r={15} />
                    <circle className="cst-flare cst-flare--b" cx={0} cy={0} r={15} />
                  </>
                )}
                <text className="cst-label" x={0} y={m.baseR + 13}>
                  {m.slug}
                </text>
              </g>
            )
          })}
        </g>
        <g ref={drillLayerRef} className={'cst-drill' + (focusedId ? ' cst-drill--show' : '')} />
      </svg>

      {focusedId && focusedSim && (
        <DrillIn
          key={focusedId}
          sessionId={focusedId}
          slug={nodes.find((n) => n.id === focusedId)?.slug ?? focusedId.slice(0, 8)}
          originX={focusedSim.x}
          originY={focusedSim.y}
          portalTarget={drillLayerRef.current}
          onClose={unfocus}
          onOpen={() => {
            const s = sessions.find((x) => x.id === focusedId)
            if (s) {
              useUIStore.getState().clearPreviewSession()
              onOpenSession(s)
            }
          }}
        />
      )}

      <ConstellationControls
        collapsed={collapsed}
        onToggleCollapsed={onToggleCollapsed}
        paletteId={paletteId}
        onPalette={selectPalette}
        windowMs={windowMs}
        onWindow={onWindowChange}
        viewH={viewH}
        onZoom={setViewH}
        reduced={reduced}
        onReduced={setReduced}
        tau={tau}
        onTau={setTau}
        onRecenter={recenter}
      />

      <div className="cst-tooltip" ref={tooltipRef} />
    </div>
  )
}

interface ControlsProps {
  collapsed: boolean
  onToggleCollapsed: () => void
  paletteId: string
  onPalette: (id: string) => void
  windowMs: number
  onWindow: (ms: number) => void
  viewH: number
  onZoom: (vh: number) => void
  reduced: boolean
  onReduced: (v: boolean) => void
  tau: number
  onTau: (v: number) => void
  onRecenter: () => void
}

function ConstellationControls({
  collapsed,
  onToggleCollapsed,
  paletteId,
  onPalette,
  windowMs,
  onWindow,
  viewH,
  onZoom,
  reduced,
  onReduced,
  tau,
  onTau,
  onRecenter,
}: ControlsProps) {
  return (
    <div className={'cst-panel cst-controls' + (collapsed ? ' cst-controls--collapsed' : '')}>
      <button
        className="cst-gear"
        onClick={onToggleCollapsed}
        aria-label={collapsed ? 'Show controls' : 'Hide controls'}
        title={collapsed ? 'Show controls' : 'Hide controls'}
      >
        <Settings className="h-4 w-4" />
      </button>
      {!collapsed && (
        <div className="cst-controls-body">
          <div className="cst-panel-h">Palette</div>
          <div className="cst-row">
            {PALETTES.map((p) => (
              <button
                key={p.id}
                className={'cst-btn' + (p.id === paletteId ? ' cst-btn--on' : '')}
                onClick={() => onPalette(p.id)}
              >
                {p.name}
              </button>
            ))}
          </div>
          <div className="cst-slider">
            <label htmlFor="cst-window">window</label>
            <input
              id="cst-window"
              type="range"
              min={0}
              max={1}
              step={0.001}
              value={windowMsToPos(windowMs)}
              onChange={(e) => onWindow(windowPosToMs(Number(e.target.value)))}
            />
            <span>{fmtDuration(windowMs)}</span>
          </div>
          <div className="cst-slider">
            <label htmlFor="cst-zoom">zoom</label>
            <input
              id="cst-zoom"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={viewHToZoomPos(viewH)}
              onChange={(e) => onZoom(zoomPosToViewH(Number(e.target.value)))}
            />
            <span>{zoomPercent(viewH)}%</span>
          </div>
          <div className="cst-slider">
            <label htmlFor="cst-tau">decay τ</label>
            <input
              id="cst-tau"
              type="range"
              min={15}
              max={300}
              value={tau}
              onChange={(e) => onTau(Number(e.target.value))}
            />
            <span>{tau}s</span>
          </div>
          <div className="cst-row">
            <button
              className={'cst-btn' + (reduced ? ' cst-btn--on' : '')}
              onClick={() => onReduced(!reduced)}
            >
              Reduce motion
            </button>
            <button className="cst-btn" onClick={onRecenter}>
              Recenter
            </button>
          </div>
          <div className="cst-meta">drag to pan · double-click to recenter</div>
        </div>
      )}
    </div>
  )
}
