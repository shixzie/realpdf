import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Check, Eraser, Image as ImageIcon, PenLine, ShieldCheck, Upload, X } from 'lucide-react'
import { useStore } from '../store'
import { commitCanvas, getCanvas, insertImageObject } from '../lib/canvasRegistry'
import { prepareUploadedSignature, trimCanvas } from '../lib/signatureImage'
import { startSigning } from '../lib/signController'
import { useTranslation } from '../i18n'
import { useActiveIndicator } from '../lib/useActiveIndicator'

const WIDTH = 640
const HEIGHT = 240

export function SignatureModal() {
  const { t } = useTranslation()
  const open = useStore((state) => state.tool === 'signature')
  const padRef = useRef<HTMLCanvasElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const drawingRef = useRef(false)
  const lastRef = useRef<{ x: number; y: number } | null>(null)
  const [mode, setMode] = useState<'draw' | 'upload'>('draw')
  const modeRef = useActiveIndicator(mode)
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
      state.toastMessage('error', mode === 'draw' ? t('signature.needDraw') : t('signature.needImage'))
      return
    }
    const target = getCanvas(state.currentPageId)
    if (!target) {
      state.toastMessage('error', t('signature.needPage'))
      close()
      return
    }
    state.beginChange()
    await insertImageObject(target, dataUrl, { maxWidth: 220 })
    if (state.currentPageId) commitCanvas(state.currentPageId)
    close()
    state.toastMessage('success', t('signature.added'))
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-head">
          <h2>{t('signature.title')}</h2>
          <button type="button" className="icon-button" onClick={close} title={t('common.close')}>
            <X size={17} />
          </button>
        </div>

        <div className="segmented" ref={modeRef}>
          <span className="active-indicator" aria-hidden="true" />
          <button
            type="button"
            className={mode === 'draw' ? 'is-active' : ''}
            onClick={() => setMode('draw')}
          >
            <PenLine size={15} /> {t('signature.draw')}
          </button>
          <button
            type="button"
            className={mode === 'upload' ? 'is-active' : ''}
            onClick={() => setMode('upload')}
          >
            <ImageIcon size={15} /> {t('signature.upload')}
          </button>
        </div>

        <button
          type="button"
          className="link-button signature-cert-link"
          onClick={() => {
            close()
            void startSigning('self')
          }}
        >
          <ShieldCheck size={14} /> {t('signature.certLink')}
        </button>

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
              <img className="signature-preview" src={previewSrc} alt={t('signature.previewAlt')} />
            ) : (
              <div className="signature-drop">
                <ImageIcon size={26} />
                <span>{processing ? t('common.processing') : t('signature.uploadHint')}</span>
                <button type="button" className="button" onClick={() => fileRef.current?.click()}>
                  <Upload size={15} /> {t('signature.chooseImage')}
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
                  {t('signature.removeWhite')}
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
                  <Upload size={15} /> {t('signature.replace')}
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
                reader.onerror = () => useStore.getState().toastMessage('error', t('signature.readFailed'))
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
                <Eraser size={15} /> {t('common.clear')}
              </button>
            </>
          )}
          <div className="modal-spacer" />
          <button type="button" className="button" onClick={close}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={() => void apply()}
            disabled={processing || (mode === 'upload' && !previewSrc)}
          >
            <Check size={16} /> {t('signature.add')}
          </button>
        </div>
      </div>
    </div>
  )
}
