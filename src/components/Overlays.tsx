import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react'
import { useStore } from '../store'
import { useTranslation } from '../i18n'

export function Toast() {
  const toast = useStore((state) => state.toast)
  if (!toast) return null
  const Icon = toast.kind === 'error' ? AlertTriangle : toast.kind === 'success' ? CheckCircle2 : Info
  return (
    <div className={`toast toast-${toast.kind}`} role="status">
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
        </div>
      </div>
    </div>
  )
}
