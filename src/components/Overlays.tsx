import { useEffect, useState, type CSSProperties } from 'react'
import { AlertTriangle, CheckCircle2, FileDown, Info, Loader2, X } from 'lucide-react'
import { TOAST_MS, useStore } from '../store'
import { useTranslation } from '../i18n'
import { mayBeDocumentType } from '../lib/openDocument'

export function Toast() {
  const toast = useStore((state) => state.toast)
  if (!toast) return null
  const Icon = toast.kind === 'error' ? AlertTriangle : toast.kind === 'success' ? CheckCircle2 : Info
  return (
    <div
      key={toast.id}
      className={`toast toast-${toast.kind}`}
      role="status"
      style={{ '--toast-ms': `${TOAST_MS}ms` } as CSSProperties}
    >
      <Icon size={16} />
      <span>{toast.message}</span>
      <button type="button" className="icon-button" onClick={() => useStore.getState().clearToast()}>
        <X size={14} />
      </button>
    </div>
  )
}

export function ExportOverlay() {
  const { t } = useTranslation()
  const exporting = useStore((state) => state.exporting)
  const progress = useStore((state) => state.exportProgress)
  if (!exporting) return null
  return (
    <div className="modal-backdrop">
      <div className="export-card">
        <Loader2 size={22} className="spin" />
        <div>
          <strong>{t('overlays.building')}</strong>
          <span>{t('overlays.progress', { percent: Math.round(progress * 100) })}</span>
          <div className="export-progress" aria-hidden="true">
            <div className="export-progress-bar" style={{ transform: `scaleX(${progress})` }} />
          </div>
        </div>
      </div>
    </div>
  )
}

export function DropOverlay() {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    // Enter and leave fire for every element crossed, so a depth count tells
    // when a drag has left the window.
    let depth = 0
    const onDragEnter = (event: DragEvent) => {
      depth += 1
      const items = Array.from(event.dataTransfer?.items ?? [])
      setVisible(items.some((item) => item.kind === 'file' && mayBeDocumentType(item.type)))
    }
    const onDragLeave = () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setVisible(false)
    }
    const onDragDone = () => {
      depth = 0
      setVisible(false)
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('dragend', onDragDone)
    window.addEventListener('drop', onDragDone, true)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('dragend', onDragDone)
      window.removeEventListener('drop', onDragDone, true)
    }
  }, [])

  if (!visible) return null
  return (
    <div className="drop-overlay" aria-hidden="true">
      <div className="drop-card">
        <FileDown size={30} />
        <strong>{t('drop.title')}</strong>
        <span>{t('drop.hint')}</span>
      </div>
    </div>
  )
}
