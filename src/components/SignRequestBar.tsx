import { CheckCircle2, Copy, Download, PenLine, Send } from 'lucide-react'
import { useStore } from '../store'
import { useTranslation } from '../i18n'
import { downloadBlob } from '../lib/exportController'
import { signedFileName, startSigning } from '../lib/signController'
import { requestLink } from '../lib/signRequests'

/**
 * Shown above the document when it was opened from a signing link: who asked
 * for signatures, who has signed so far, and the next step for this person.
 */
export function SignRequestBar() {
  const { t } = useTranslation()
  const request = useStore((state) => state.signRequest)
  const placing = useStore((state) => state.signFlow?.step === 'place')
  if (!request || placing) return null
  const { header } = request

  const signers = header.signers.length
    ? t('signRequest.signedBy', { names: header.signers.join(', ') })
    : t('signRequest.notSigned')

  const download = () => {
    const state = useStore.getState()
    if (!state.bytes) return
    downloadBlob(new Blob([new Uint8Array(state.bytes)], { type: 'application/pdf' }), signedFileName(header.fileName))
  }

  let lead: string
  let icon = <Send size={16} />
  if (request.signedHere) {
    lead = t('signRequest.signedHere')
    icon = <CheckCircle2 size={16} />
  } else if (request.owner) {
    lead = t('signRequest.ownerTitle', { fileName: header.fileName })
  } else {
    lead = header.from
      ? t('signRequest.askedBy', { name: header.from, fileName: header.fileName })
      : t('signRequest.askedAnonymous', { fileName: header.fileName })
  }

  return (
    <div className={`sign-request-bar ${request.signedHere ? 'is-done' : ''}`} role="status">
      {icon}
      <div className="sign-request-text">
        <strong>{lead}</strong>
        {header.message && !request.signedHere && <span className="sign-request-message">“{header.message}”</span>}
        <span className="sign-request-signers">{signers}</span>
      </div>
      {request.owner && (
        <button
          type="button"
          className="button button-ghost sign-request-copy"
          onClick={() => {
            void navigator.clipboard
              .writeText(requestLink(request.id, request.key))
              .then(() => useStore.getState().toastMessage('success', t('signRequest.copied')))
              .catch(() => undefined)
          }}
        >
          <Copy size={14} /> {t('signRequest.copyLink')}
        </button>
      )}
      {header.signers.length > 0 && (
        <button type="button" className="button sign-request-download" onClick={download}>
          <Download size={14} /> {t('signRequest.download')}
        </button>
      )}
      {!request.signedHere && (
        <button
          type="button"
          className={`button ${request.owner ? '' : 'button-primary'} sign-request-sign`}
          onClick={() => void startSigning('self')}
        >
          <PenLine size={14} /> {request.owner ? t('signRequest.sign') : t('signRequest.startSigning')}
        </button>
      )}
    </div>
  )
}
