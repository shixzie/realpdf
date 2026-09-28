import { useState } from 'react'
import { ChevronDown, PenLine, Send } from 'lucide-react'
import { useStore } from '../store'
import { useTranslation } from '../i18n'
import { startSigning } from '../lib/signController'
import { useMenuDismiss } from './ExportControl'

/**
 * The top bar's Sign button: sign the document yourself, or ask others to.
 * Opened from someone else's signing link, it goes straight to signing.
 */
export function SignControl() {
  const { t } = useTranslation()
  const busy = useStore((state) => Boolean(state.signFlow) || state.exporting)
  const invited = useStore((state) => Boolean(state.signRequest && !state.signRequest.owner && !state.signRequest.signedHere))
  const [open, setOpen] = useState(false)
  const ref = useMenuDismiss(open, () => setOpen(false))

  const start = (mode: 'self' | 'request') => {
    setOpen(false)
    void startSigning(mode)
  }

  return (
    <div className="export-wrap" ref={ref}>
      <button
        type="button"
        className="button sign-trigger"
        aria-haspopup={invited ? undefined : 'menu'}
        aria-expanded={invited ? undefined : open}
        disabled={busy}
        onClick={() => (invited ? start('self') : setOpen((value) => !value))}
      >
        <PenLine size={16} /> {t('sign.trigger')}
        {!invited && <ChevronDown size={14} />}
      </button>
      {open && (
        <div className="export-menu sign-menu" role="menu">
          <button type="button" role="menuitem" className="export-menu-item sign-menu-self" onClick={() => start('self')}>
            <span className="export-menu-icon">
              <PenLine size={16} />
            </span>
            <span className="export-menu-text">
              <span className="export-menu-label">{t('sign.self')}</span>
              <span className="export-menu-hint">{t('sign.selfHint')}</span>
            </span>
          </button>
          <button type="button" role="menuitem" className="export-menu-item sign-menu-request" onClick={() => start('request')}>
            <span className="export-menu-icon">
              <Send size={16} />
            </span>
            <span className="export-menu-text">
              <span className="export-menu-label">{t('sign.request')}</span>
              <span className="export-menu-hint">{t('sign.requestHint')}</span>
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
