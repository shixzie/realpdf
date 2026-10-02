import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { PageView } from './PageView'
import { prefersReducedMotion } from '../lib/motion'

const PAGE_GAP = 28
const WINDOW_PAD = 700
// How long the viewer must sit still before visible pages count as settled.
const SETTLE_MS = 200

export function Viewer() {
  const pages = useStore((state) => state.pages)
  const zoom = useStore((state) => state.zoom)
  const fitNonce = useStore((state) => state.fitNonce)
  const scrollRequest = useStore((state) => state.scrollRequest)

  const containerRef = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState({ start: 0, end: 0, visibleStart: 0, visibleEnd: 0 })
  const [scrolling, setScrolling] = useState(false)

  const dimsKey = pages.map((page) => `${page.id}:${page.width}x${page.height}`).join('|')

  const layout = useMemo(() => {
    const heights = pages.map((page) => Math.max(1, page.height * zoom))
    const offsets: number[] = []
    let acc = PAGE_GAP
    for (const height of heights) {
      offsets.push(acc)
      acc += height + PAGE_GAP
    }
    return { heights, offsets, total: acc }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimsKey, zoom])

  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const pagesRef = useRef(pages)
  pagesRef.current = pages

  const updateRange = useCallback(() => {
    const element = containerRef.current
    if (!element) return
    const list = pagesRef.current
    const current = layoutRef.current
    if (!list.length) {
      setRange({ start: 0, end: 0, visibleStart: 0, visibleEnd: 0 })
      return
    }
    const spanOf = (top: number, bottom: number) => {
      let first = 0
      while (first < list.length - 1 && current.offsets[first] + current.heights[first] < top) first += 1
      let last = first
      while (last < list.length && current.offsets[last] < bottom) last += 1
      return [first, last] as const
    }
    const viewTop = element.scrollTop
    const viewBottom = viewTop + element.clientHeight
    const [start, padEnd] = spanOf(viewTop - WINDOW_PAD, viewBottom + WINDOW_PAD)
    const end = Math.min(list.length, padEnd + 1)
    const [visibleStart, visibleEnd] = spanOf(viewTop, viewBottom)
    setRange((prev) =>
      prev.start === start && prev.end === end && prev.visibleStart === visibleStart && prev.visibleEnd === visibleEnd
        ? prev
        : { start, end, visibleStart, visibleEnd },
    )

    const center = element.scrollTop + element.clientHeight / 2
    let index = 0
    for (let i = 0; i < list.length; i += 1) {
      if (current.offsets[i] <= center) index = i
      else break
    }
    const page = list[index]
    if (page) useStore.getState().setCurrentPage(page.id)
  }, [])

  useEffect(() => {
    updateRange()
  }, [updateRange, layout, pages])

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    let frame = 0
    let settle = 0
    const onScroll = () => {
      setScrolling(true)
      window.clearTimeout(settle)
      settle = window.setTimeout(() => setScrolling(false), SETTLE_MS)
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        updateRange()
      })
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      useStore.getState().zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      element.removeEventListener('scroll', onScroll)
      element.removeEventListener('wheel', onWheel)
      if (frame) cancelAnimationFrame(frame)
      window.clearTimeout(settle)
    }
  }, [updateRange])

  // Fit the current page to the viewport width.
  useEffect(() => {
    if (!fitNonce) return
    const element = containerRef.current
    if (!element) return
    const state = useStore.getState()
    const page = state.pages.find((p) => p.id === state.currentPageId) ?? state.pages[0]
    if (!page) return
    const available = Math.max(120, element.clientWidth - 120)
    state.setZoom(available / page.width)
  }, [fitNonce])

  // Keep the current page in view when the zoom level changes.
  const zoomRef = useRef(zoom)
  useEffect(() => {
    if (zoomRef.current === zoom) return
    zoomRef.current = zoom
    const element = containerRef.current
    if (!element) return
    const state = useStore.getState()
    const index = state.pages.findIndex((p) => p.id === state.currentPageId)
    if (index < 0) return
    const offset = layoutRef.current.offsets[index]
    if (offset == null) return
    element.scrollTop = Math.max(0, offset - PAGE_GAP)
  }, [zoom])

  useEffect(() => {
    if (!scrollRequest) return
    const element = containerRef.current
    if (!element) return
    const index = pagesRef.current.findIndex((page) => page.id === scrollRequest.pageId)
    if (index < 0) return
    const offset = layoutRef.current.offsets[index]
    if (offset == null) return
    element.scrollTo({ top: Math.max(0, offset - PAGE_GAP), behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }, [scrollRequest])

  if (!pages.length) return null

  const visible = pages.slice(range.start, Math.max(range.end, range.start + 1))

  return (
    <div className="viewer" ref={containerRef}>
      <div className="viewer-inner" style={{ height: layout.total }}>
        {visible.map((page, offset) => {
          const index = range.start + offset
          return (
            <div
              key={page.id}
              className="page-slot"
              style={{ top: layout.offsets[index], width: Math.max(1, page.width * zoom) }}
            >
              <PageView
                pageIndex={index}
                settled={!scrolling && index >= range.visibleStart && index < range.visibleEnd}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
