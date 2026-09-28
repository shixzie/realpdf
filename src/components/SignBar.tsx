import type { CSSProperties } from 'react'
import { ArrowDown, Check, ChevronLeft, PenLine, Send } from 'lucide-react'
import { useStore } from '../store'
import { useTranslation } from '../i18n'
import { goToNextField } from '../lib/signController'
import { sendForSignatures } from '../lib/signRequestController'
import { SIGNER_COLORS } from './SignSpotsLayer'

/**
 * Shown above the document while signatures (or signers' fields) are being
 * placed: what to do, who is signing, and the way forward.
 */
export function SignBar() {
  const { t } = useTranslation()
  const flow = useStore((state) => state.signFlow)
  const spots = useStore((state) => state.signSpots)
  const fields = useStore((state) => state.signFields)
  const signer = useStore((state) => state.signer)
  const draft = useStore((state) => state.requestDraft)
  const exporting = useStore((state) => state.exporting)
  if (flow?.step !== 'place') return null
  const cancel = () => useStore.getState().setSignFlow(null)

  if (flow.mode === 'request') {
    return (
      <div className="sign-bar" role="status">
        <Send size={16} />
        <div className="sign-bar-text">
          <strong>{t('sign.placeFieldsTitle')}</strong>
          <span>{spots.length ? t('sign.fieldsPlaced', { count: spots.length }) : t('sign.placeFieldsHint')}</span>
        </div>
        <div className="sign-signers" role="radiogroup" aria-label={t('sign.signers')}>
          {draft.signers.map((entry, index) => (
            <button
              key={entry.id}
              type="button"
              role="radio"
              aria-checked={draft.activeSigner === entry.id}
              className={`sign-signer-chip ${draft.activeSigner === entry.id ? 'is-active' : ''}`}
              style={{ '--signer': SIGNER_COLORS[index % SIGNER_COLORS.length] } as CSSProperties}
              onClick={() => useStore.getState().updateRequestDraft({ activeSigner: entry.id })}
            >
              <span className="sign-signer-dot" />
              {entry.name.trim() || t('sign.signerN', { n: index + 1 })}
            </button>
          ))}
        </div>
        <div className="sign-bar-actions">
          <button type="button" className="button button-ghost sign-back" onClick={() => useStore.getState().setSignStep('signers')}>
            <ChevronLeft size={15} /> {t('common.back')}
          </button>
          <button type="button" className="button button-ghost sign-cancel" onClick={cancel}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="button button-primary request-send"
            disabled={exporting}
            title={spots.length ? undefined : t('sign.noFieldsNote')}
            onClick={() => void sendForSignatures()}
          >
            <Send size={15} /> {t('sign.send')}
          </button>
        </div>
      </div>
    )
  }

  const remaining = fields.filter((field) => !spots.some((spot) => spot.field === field.name)).length
  return (
    <div className="sign-bar" role="status">
      <PenLine size={16} />
      <div className="sign-bar-text">
        <strong>{remaining ? t('sign.fillTagsTitle', { count: remaining }) : t('sign.placeTitle')}</strong>
        <span>{spots.length ? t('sign.signaturesPlaced', { count: spots.length }) : t('sign.placeHint')}</span>
      </div>
      {signer && (
        <div className="sign-as">
          <img src={signer.image} alt="" />
          <span>{signer.identity.info.name}</span>
          <button type="button" className="link-button sign-change" onClick={() => useStore.getState().setSignStep('adopt')}>
            {t('sign.change')}
          </button>
        </div>
      )}
      <div className="sign-bar-actions">
        {remaining > 0 && (
          <button type="button" className="button sign-next" onClick={goToNextField}>
            <ArrowDown size={15} /> {t('sign.next')}
          </button>
        )}
        <button type="button" className="button button-ghost sign-cancel" onClick={cancel}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="button button-primary sign-finish"
          disabled={!spots.length}
          onClick={() => useStore.getState().setSignStep('review')}
        >
          <Check size={15} /> {t('sign.finish')}
        </button>
      </div>
    </div>
  )
}
