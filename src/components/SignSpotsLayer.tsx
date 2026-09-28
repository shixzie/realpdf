import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { PenLine, X } from 'lucide-react'
import { useStore, type SignSpot } from '../store'
import { useTranslation } from '../i18n'
import { viewRect } from '../lib/signController'

/** Default sizes in points, used when the user clicks instead of dragging. */
const SIGNATURE_SIZE = { width: 210, height: 70 }
const FIELD_SIZE = { width: 180, height: 56 }
const MIN_SIZE = 12

/** One color per signer, for their "sign here" fields. */
export const SIGNER_COLORS = ['#0ea5e9', '#f97316', '#a855f7', '#16a34a', '#e11d48', '#ca8a04']

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

interface Drag {
  id: string
  kind: 'move' | 'resize'
  start: { x: number; y: number }
  origin: Box
}

function clampBox(box: Box, width: number, height: number): Box {
  const w = Math.max(MIN_SIZE, Math.min(box.width, width))
  const h = Math.max(MIN_SIZE, Math.min(box.height, height))
  return {
    x: Math.max(0, Math.min(width - w, box.x)),
    y: Math.max(0, Math.min(height - h, box.y)),
    width: w,
    height: h,
  }
}

/**
 * Covers a page while signatures are placed. Signing yourself: click (or
 * drag a box) to drop your signature, click a "Sign here" tag to fill that
 * field, drag a signature to move it or its corner to resize it. Requesting
 * signatures: the same, placing a field for the chosen signer.
 */
export function SignSpotsLayer({ pageIndex, zoom, width, height }: Props) {
  const { t } = useTranslation()
  const mode = useStore((state) => state.signFlow?.mode)
  const allSpots = useStore((state) => state.signSpots)
  const allFields = useStore((state) => state.signFields)
  const signer = useStore((state) => state.signer)
  const draft = useStore((state) => state.requestDraft)
  const layerRef = useRef<HTMLDivElement>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const [drawing, setDrawing] = useState<Box | null>(null)
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null)

  const spots = allSpots.filter((spot) => spot.pageIndex === pageIndex)
  const fields = allFields.filter(
    (field) => field.pageIndex === pageIndex && !allSpots.some((spot) => spot.field === field.name),
  )
  const requesting = mode === 'request'
  const size = requesting ? FIELD_SIZE : SIGNATURE_SIZE
  const signerIndex = (id?: string) => Math.max(0, draft.signers.findIndex((entry) => entry.id === id))
  const signerName = (id?: string) => draft.signers.find((entry) => entry.id === id)?.name.trim() || t('sign.signerN', { n: signerIndex(id) + 1 })

  const local = (event: ReactPointerEvent) => {
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

  const place = (box: Box) => {
    const state = useStore.getState()
    const spot: Omit<SignSpot, 'id'> = { pageIndex, ...clampBox(box, width, height) }
    if (requesting) spot.signer = state.requestDraft.activeSigner ?? state.requestDraft.signers[0]?.id
    state.addSignSpot(spot)
  }

  const beginDrag = (event: ReactPointerEvent, spot: SignSpot, kind: Drag['kind']) => {
    event.preventDefault()
    event.stopPropagation()
    layerRef.current?.setPointerCapture(event.pointerId)
    dragRef.current = { id: spot.id, kind, start: local(event), origin: { x: spot.x, y: spot.y, width: spot.width, height: spot.height } }
    setHover(null)
  }

  const ghost = hover && !drawing && !dragRef.current
  const spotStyle = (box: Box) => ({ left: box.x * zoom, top: box.y * zoom, width: box.width * zoom, height: box.height * zoom })

  return (
    <div
      ref={layerRef}
      className={`sign-spots-layer ${requesting ? 'is-request' : ''}`}
      onPointerDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.setPointerCapture(event.pointerId)
        const point = local(event)
        startRef.current = point
        setDrawing({ ...point, width: 0, height: 0 })
        setHover(null)
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current
        if (drag) {
          const point = local(event)
          const dx = point.x - drag.start.x
          const dy = point.y - drag.start.y
          const next =
            drag.kind === 'move'
              ? { ...drag.origin, x: drag.origin.x + dx, y: drag.origin.y + dy }
              : { ...drag.origin, width: drag.origin.width + dx, height: drag.origin.height + dy }
          useStore.getState().updateSignSpot(drag.id, clampBox(next, width, height))
          return
        }
        if (startRef.current) {
          setDrawing(boxFrom(startRef.current, local(event)))
          return
        }
        // No ghost over placed signatures and tags, only over the bare page.
        if (event.pointerType === 'mouse') setHover(event.target === event.currentTarget ? local(event) : null)
      }}
      onPointerUp={(event) => {
        if (dragRef.current) {
          dragRef.current = null
          return
        }
        const start = startRef.current
        startRef.current = null
        setDrawing(null)
        if (!start) return
        const end = local(event)
        let box = boxFrom(start, end)
        if (box.width < MIN_SIZE || box.height < MIN_SIZE) {
          box = { x: end.x - size.width / 2, y: end.y - size.height / 2, ...size }
        }
        place(box)
      }}
      onPointerCancel={() => {
        startRef.current = null
        dragRef.current = null
        setDrawing(null)
      }}
      onPointerLeave={() => setHover(null)}
    >
      {fields.map((field) => {
        const box = viewRect(pageIndex, field.rect)
        return requesting ? (
          <div key={field.name} className="sign-tag is-existing" style={spotStyle(box)}>
            <span>{field.label || t('sign.existingField')}</span>
          </div>
        ) : (
          <button
            key={field.name}
            type="button"
            className="sign-tag"
            style={spotStyle(box)}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => useStore.getState().addSignSpot({ pageIndex, ...box, field: field.name })}
          >
            <PenLine size={14} />
            <span className="sign-tag-text">
              <strong>{t('sign.signHere')}</strong>
              {field.label && <span>{field.label}</span>}
            </span>
          </button>
        )
      })}

      {spots.map((spot) => {
        const color = requesting ? SIGNER_COLORS[signerIndex(spot.signer) % SIGNER_COLORS.length] : undefined
        return (
          <div
            key={spot.id}
            className={`sign-spot ${requesting ? 'is-field' : ''} ${spot.field ? 'is-fixed' : ''}`}
            style={{ ...spotStyle(spot), ...(color ? { borderColor: color, color } : {}) }}
            onPointerDown={(event) => (spot.field ? event.stopPropagation() : beginDrag(event, spot, 'move'))}
          >
            {requesting ? (
              <span className="sign-spot-label">
                <strong>{t('sign.signHere')}</strong>
                <span>{signerName(spot.signer)}</span>
              </span>
            ) : (
              signer && <SignaturePreview image={signer.image} name={signer.identity.info.name} box={spot} zoom={zoom} />
            )}
            <button
              type="button"
              className="sign-spot-remove"
              title={t('sign.remove')}
              aria-label={t('sign.remove')}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => useStore.getState().removeSignSpot(spot.id)}
            >
              <X size={12} />
            </button>
            {!spot.field && (
              <span className="sign-spot-resize" aria-hidden onPointerDown={(event) => beginDrag(event, spot, 'resize')} />
            )}
          </div>
        )
      })}

      {drawing && drawing.width >= MIN_SIZE && drawing.height >= MIN_SIZE && (
        <div className="sign-place-rect" style={spotStyle(drawing)} />
      )}
      {ghost && (
        <div
          className="sign-ghost"
          style={spotStyle(clampBox({ x: hover.x - size.width / 2, y: hover.y - size.height / 2, ...size }, width, height))}
        >
          {requesting ? (
            <span className="sign-spot-label">
              <strong>{t('sign.signHere')}</strong>
              <span>{signerName(draft.activeSigner ?? undefined)}</span>
            </span>
          ) : (
            signer && <SignaturePreview image={signer.image} name={signer.identity.info.name} box={size} zoom={zoom} />
          )}
        </div>
      )}
    </div>
  )
}

/** Roughly what the signed PDF shows: the handwritten signature beside (or above) who signed. */
function SignaturePreview({ image, name, box, zoom }: { image: string; name: string; box: { width: number; height: number }; zoom: number }) {
  const { t } = useTranslation()
  const wide = box.width / box.height >= 2.4
  const fontSize = Math.max(4, Math.min(8, box.height / (wide ? 5.5 : 8))) * zoom
  return (
    <span className={`sign-preview ${wide ? 'is-wide' : ''}`}>
      <img src={image} alt="" draggable={false} />
      <span className="sign-preview-text" style={{ fontSize }}>
        <span>{t('digitalSign.appearance.signedBy')}</span>
        <strong>{name}</strong>
      </span>
    </span>
  )
}
