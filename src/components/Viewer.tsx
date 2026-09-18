import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { PageView } from './PageView'

const PAGE_GAP = 28
const WINDOW_PAD = 700

export function Viewer() {
  const pages = useStore((state) => state.pages)
  const zoom = useStore((state) => state.zoom)
  const fitNonce = useStore((state) => state.fitNonce)
  const scrollRequest = useStore((state) => state.scrollRequest)

  const containerRef = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState({ start: 0, end: 0 })

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
      setRange({ start: 0, end: 0 })
      return
    }
    const top = element.scrollTop - WINDOW_PAD
    const bottom = element.scrollTop + element.clientHeight + WINDOW_PAD
    let start = 0
    while (start < list.length - 1 && current.offsets[start] + current.heights[start] < top) start += 1
    let end = start
    while (end < list.length && current.offsets[end] < bottom) end += 1
    end = Math.min(list.length, end + 1)
    setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }))

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
    const onScroll = () => {
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
    element.scrollTo({ top: Math.max(0, offset - PAGE_GAP), behavior: 'smooth' })
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
              <PageView pageIndex={index} />
            </div>
          )
        })}
      </div>
    </div>
  )
}
