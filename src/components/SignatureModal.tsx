import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Check, Eraser, Image as ImageIcon, PenLine, Upload, X } from 'lucide-react'
import { useStore } from '../store'
import { commitCanvas, getCanvas, insertImageObject } from '../lib/canvasRegistry'
import { loadImage } from '../lib/assets'

const WIDTH = 640
const HEIGHT = 240

/** Crops fully transparent borders and returns a PNG data URL. */
function trimCanvas(source: HTMLCanvasElement): string | null {
  const context = source.getContext('2d')
  if (!context) return null
  const { data } = context.getImageData(0, 0, source.width, source.height)
  let minX = source.width
  let minY = source.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const alpha = data[(y * source.width + x) * 4 + 3]
      if (alpha > 8) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0 || maxY < 0) return null
  const pad = 8
  minX = Math.max(0, minX - pad)
  minY = Math.max(0, minY - pad)
  maxX = Math.min(source.width - 1, maxX + pad)
  maxY = Math.min(source.height - 1, maxY + pad)
  const out = document.createElement('canvas')
  out.width = maxX - minX + 1
  out.height = maxY - minY + 1
  const outContext = out.getContext('2d')
  if (!outContext) return null
  outContext.drawImage(source, minX, minY, out.width, out.height, 0, 0, out.width, out.height)
  return out.toDataURL('image/png')
}

/** Makes near-white pixels transparent and crops the result. */
async function prepareUploadedSignature(src: string, removeWhite: boolean): Promise<string | null> {
  const image = await loadImage(src)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, image.naturalWidth)
  canvas.height = Math.max(1, image.naturalHeight)
  const context = canvas.getContext('2d')
  if (!context) return null
  context.drawImage(image, 0, 0)
  if (removeWhite) {
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height)
    const pixels = imageData.data
    for (let i = 0; i < pixels.length; i += 4) {
      const luminance = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]
      const alpha = Math.max(0, Math.min(255, Math.round((238 - luminance) * 2.6)))
      pixels[i + 3] = Math.min(pixels[i + 3], alpha)
    }
    context.putImageData(imageData, 0, 0)
  }
  return trimCanvas(canvas)
}

export function SignatureModal() {
  const open = useStore((state) => state.tool === 'signature')
  const padRef = useRef<HTMLCanvasElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const drawingRef = useRef(false)
  const lastRef = useRef<{ x: number; y: number } | null>(null)
  const [mode, setMode] = useState<'draw' | 'upload'>('draw')
  const [color, setColor] = useState('#111827')
  const [width, setWidth] = useState(2.6)
  const [uploadSrc, setUploadSrc] = useState<string | null>(null)
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const [removeWhite, setRemoveWhite] = useState(true)
  const [processing, setProcessing] = useState(false)
  const sizeRef = useRef({ color, width })
  sizeRef.current = { color, width }

  useEffect(() => {
    if (!open) return
    setMode('draw')
    setUploadSrc(null)
    setPreviewSrc(null)
    const canvas = padRef.current
    const context = canvas?.getContext('2d')
    if (canvas && context) {
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.lineCap = 'round'
      context.lineJoin = 'round'
    }
  }, [open])

  // Re-process the uploaded image whenever the background option changes.
  useEffect(() => {
    if (!uploadSrc) {
      setPreviewSrc(null)
      return
    }
    let cancelled = false
    setProcessing(true)
    void prepareUploadedSignature(uploadSrc, removeWhite)
      .then((result) => {
        if (!cancelled) setPreviewSrc(result)
      })
      .catch((error) => console.error(error))
      .finally(() => {
        if (!cancelled) setProcessing(false)
      })
    return () => {
      cancelled = true
    }
  }, [uploadSrc, removeWhite])

  if (!open) return null

  const pointFor = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = padRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    }
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = padRef.current
    if (!canvas) return
    canvas.setPointerCapture(event.pointerId)
    drawingRef.current = true
    lastRef.current = pointFor(event)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return
    const canvas = padRef.current
    const context = canvas?.getContext('2d')
    const last = lastRef.current
    if (!canvas || !context || !last) return
    const point = pointFor(event)
    context.strokeStyle = sizeRef.current.color
    context.lineWidth = sizeRef.current.width
    context.beginPath()
    context.moveTo(last.x, last.y)
    context.lineTo(point.x, point.y)
    context.stroke()
    lastRef.current = point
  }

  const onPointerUp = () => {
    drawingRef.current = false
    lastRef.current = null
  }

  const close = () => useStore.getState().setTool('select')

  const apply = async () => {
    const state = useStore.getState()
    let dataUrl: string | null = null
    if (mode === 'draw') {
      const canvas = padRef.current
      dataUrl = canvas ? trimCanvas(canvas) : null
    } else {
      dataUrl = previewSrc
    }
    if (!dataUrl) {
      state.toastMessage('error', mode === 'draw' ? 'Draw a signature first.' : 'Choose a signature image first.')
      return
    }
    const target = getCanvas(state.currentPageId)
    if (!target) {
      state.toastMessage('error', 'Scroll to a page first, then add the signature.')
      close()
      return
    }
    state.beginChange()
    await insertImageObject(target, dataUrl, { maxWidth: 220 })
    if (state.currentPageId) commitCanvas(state.currentPageId)
    close()
    state.toastMessage('success', 'Signature added — drag to position it.')
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-head">
          <h2>Add your signature</h2>
          <button type="button" className="icon-button" onClick={close} title="Close">
            <X size={17} />
          </button>
        </div>

        <div className="segmented">
          <button
            type="button"
            className={mode === 'draw' ? 'is-active' : ''}
            onClick={() => setMode('draw')}
          >
            <PenLine size={15} /> Draw
          </button>
          <button
            type="button"
            className={mode === 'upload' ? 'is-active' : ''}
            onClick={() => setMode('upload')}
          >
            <ImageIcon size={15} /> Upload image
          </button>
        </div>

        {mode === 'draw' ? (
          <canvas
            ref={padRef}
            className="signature-pad"
            width={WIDTH}
            height={HEIGHT}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          />
        ) : (
          <div className="signature-upload">
            {previewSrc ? (
              <img className="signature-preview" src={previewSrc} alt="Signature preview" />
            ) : (
              <div className="signature-drop">
                <ImageIcon size={26} />
                <span>{processing ? 'Processing…' : 'PNG or JPEG of your signature on a light background'}</span>
                <button type="button" className="button" onClick={() => fileRef.current?.click()}>
                  <Upload size={15} /> Choose image
                </button>
              </div>
            )}
            {uploadSrc && (
              <div className="modal-row">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={removeWhite}
                    onChange={(event) => setRemoveWhite(event.target.checked)}
                  />
                  Remove white background
                </label>
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => {
                    setUploadSrc(null)
                    setPreviewSrc(null)
                    fileRef.current?.click()
                  }}
                >
                  <Upload size={15} /> Replace
                </button>
              </div>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (!file) return
                const reader = new FileReader()
                reader.onload = () => setUploadSrc(String(reader.result))
                reader.onerror = () => useStore.getState().toastMessage('error', 'Could not read that image.')
                reader.readAsDataURL(file)
              }}
            />
          </div>
        )}

        <div className="modal-row">
          {mode === 'draw' && (
            <>
              <div className="modal-colors">
                {['#111827', '#1d4ed8', '#b91c1c'].map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={`swatch ${color === value ? 'is-active' : ''}`}
                    style={{ background: value }}
                    onClick={() => setColor(value)}
                  />
                ))}
              </div>
              <input
                className="slider"
                type="range"
                min={1.5}
                max={6}
                step={0.5}
                value={width}
                onChange={(event) => setWidth(Number(event.target.value))}
              />
              <button
                type="button"
                className="button button-ghost"
                onClick={() => {
                  const canvas = padRef.current
                  const context = canvas?.getContext('2d')
                  if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height)
                }}
              >
                <Eraser size={15} /> Clear
              </button>
            </>
          )}
          <div className="modal-spacer" />
          <button type="button" className="button" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={() => void apply()}
            disabled={processing || (mode === 'upload' && !previewSrc)}
          >
            <Check size={16} /> Add signature
          </button>
        </div>
      </div>
    </div>
  )
}
