import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useStore } from '../store'

/** Box used when the user clicks instead of dragging, in points. */
const DEFAULT_WIDTH = 190
const DEFAULT_HEIGHT = 64
const MIN_SIZE = 12

interface Props {
  pageIndex: number
  zoom: number
  /** Page size in points at zoom 1, as displayed. */
  width: number
  height: number
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

function clampBox(box: Box, width: number, height: number): Box {
  const w = Math.min(box.width, width)
  const h = Math.min(box.height, height)
  return {
    x: Math.max(0, Math.min(width - w, box.x)),
    y: Math.max(0, Math.min(height - h, box.y)),
    width: w,
    height: h,
  }
}

/**
 * Covers a page while a certificate signature is being placed: drag a box, or
 * click for a default-sized one centred on the pointer.
 */
export function SignaturePlacementLayer({ pageIndex, zoom, width, height }: Props) {
  const layerRef = useRef<HTMLDivElement>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const [draft, setDraft] = useState<Box | null>(null)

  const local = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = layerRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return {
      x: Math.max(0, Math.min(width, (event.clientX - rect.left) / zoom)),
      y: Math.max(0, Math.min(height, (event.clientY - rect.top) / zoom)),
    }
  }

  const boxFrom = (a: { x: number; y: number }, b: { x: number; y: number }): Box => ({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  })

  return (
    <div
      ref={layerRef}
      className="sign-place-layer"
      onPointerDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.setPointerCapture(event.pointerId)
        const point = local(event)
        startRef.current = point
        setDraft({ ...point, width: 0, height: 0 })
      }}
      onPointerMove={(event) => {
        if (!startRef.current) return
        setDraft(boxFrom(startRef.current, local(event)))
      }}
      onPointerUp={(event) => {
        const start = startRef.current
        startRef.current = null
        if (!start) return
        const end = local(event)
        let box = boxFrom(start, end)
        if (box.width < MIN_SIZE || box.height < MIN_SIZE) {
          box = { x: end.x - DEFAULT_WIDTH / 2, y: end.y - DEFAULT_HEIGHT / 2, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }
        }
        setDraft(null)
        useStore.getState().placeSignature({ pageIndex, ...clampBox(box, width, height) })
      }}
      onPointerCancel={() => {
        startRef.current = null
        setDraft(null)
      }}
    >
      {draft && (
        <div
          className="sign-place-rect"
          style={{ left: draft.x * zoom, top: draft.y * zoom, width: draft.width * zoom, height: draft.height * zoom }}
        />
      )}
    </div>
  )
}
