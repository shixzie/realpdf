import { useEffect, useState } from 'react'
import { ExternalLink, Heart, Loader2, X } from 'lucide-react'
import { useTranslation } from '../i18n'

export const KOFI_PAGE_URL = 'https://ko-fi.com/shixzie'
// The same donation panel Ko-fi's own overlay widget frames.
const KOFI_EMBED_URL = `${KOFI_PAGE_URL}/?hidefeed=true&widget=true&embed=true`
// A cross-origin frame can't report a blocked or failed load, so if it hasn't
// finished by then, assume it won't and point at the Ko-fi page instead.
const LOAD_TIMEOUT_MS = 12_000

type FrameState = 'loading' | 'ready' | 'failed'

export function SupportModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [frame, setFrame] = useState<FrameState>(() => (navigator.onLine ? 'loading' : 'failed'))

  useEffect(() => {
    if (frame !== 'loading') return
    const timer = window.setTimeout(() => setFrame('failed'), LOAD_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [frame])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('support.title')}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="modal support-modal">
        <div className="modal-head">
          <h2>
            <Heart size={16} /> {t('support.title')}
          </h2>
          <button type="button" className="icon-button" onClick={onClose} title={t('common.close')}>
            <X size={17} />
          </button>
        </div>
        <p className="tool-hint">{t('support.intro')}</p>

        <div className="support-frame">
          {frame !== 'failed' && (
            <iframe
              src={KOFI_EMBED_URL}
              title={t('support.frameTitle')}
              onLoad={() => setFrame('ready')}
              style={{ visibility: frame === 'ready' ? 'visible' : 'hidden' }}
            />
          )}
          {frame === 'loading' && (
            <div className="support-frame-status">
              <Loader2 size={18} className="spin" /> {t('common.loading')}
            </div>
          )}
          {frame === 'failed' && (
            <div className="support-frame-status">
              <span>{t('support.failed')}</span>
              <a className="button" href={KOFI_PAGE_URL} target="_blank" rel="noreferrer noopener">
                <ExternalLink size={14} /> {t('support.openKofi')}
              </a>
            </div>
          )}
        </div>

        <div className="modal-row">
          {frame !== 'failed' && (
            <a className="support-external" href={KOFI_PAGE_URL} target="_blank" rel="noreferrer noopener">
              <ExternalLink size={13} /> {t('support.openKofi')}
            </a>
          )}
          <div className="modal-spacer" />
          <button type="button" className="button" onClick={onClose}>
            {t('common.done')}
          </button>
        </div>
      </div>
    </div>
  )
}
