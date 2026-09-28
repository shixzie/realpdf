import { useEffect, useState } from 'react'
import { ArrowRight, CheckCircle2, Copy, ExternalLink, Lock, Mail, Trash2, UserPlus, X } from 'lucide-react'
import { useStore, type RequestSigner } from '../store'
import { useTranslation } from '../i18n'
import { enterPlacing } from '../lib/signController'
import { requestErrorMessage } from '../lib/signRequestController'
import {
  deleteMyRequest,
  fetchRequestStatus,
  listMyRequests,
  requestLink,
  type MyRequest,
  type RequestStatus,
} from '../lib/signRequests'
import { uid } from '../lib/uid'
import { SIGNER_COLORS } from './SignSpotsLayer'

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** A mailto: link to the signers that the sender's own mail app opens; nothing is sent by RealPDF. */
function mailLink(
  created: { link: string; fileName: string },
  to: string[],
  from: string,
  message: string,
  t: (key: string, vars?: Record<string, string>) => string,
) {
  const subject = t('signRequest.emailSubject', { fileName: created.fileName })
  const body = [
    from ? t('signRequest.emailBody', { from, fileName: created.fileName }) : t('signRequest.emailBodyAnonymous', { fileName: created.fileName }),
    '',
    created.link,
    message ? `\n${message}` : '',
  ]
    .join('\n')
    .trim()
  return `mailto:${to.map((address) => encodeURIComponent(address).replace(/%40/g, '@')).join(',')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

/** Lists this device's requests with how many signed copies each has. */
export function MyRequestsList({ title, compact = false }: { title: string; compact?: boolean }) {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<MyRequest[]>(() => listMyRequests())
  const [statuses, setStatuses] = useState<Record<string, RequestStatus | null>>({})

  useEffect(() => {
    let cancelled = false
    for (const entry of entries) {
      void fetchRequestStatus(entry.id)
        .then((status) => !cancelled && setStatuses((current) => ({ ...current, [entry.id]: status })))
        .catch(() => !cancelled && setStatuses((current) => ({ ...current, [entry.id]: null })))
    }
    return () => {
      cancelled = true
    }
  }, [entries])

  if (!entries.length) return null
  const formatDate = (time: number) => new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

  return (
    <div className={`my-requests ${compact ? 'is-compact' : ''}`}>
      <span className="my-requests-title">{title}</span>
      {entries.map((entry) => {
        const status = statuses[entry.id]
        const signed = status ? status.versions.length - 1 : 0
        return (
          <div key={entry.id} className="my-request">
            <div>
              <strong>{entry.fileName}</strong>
              <span className={signed > 0 ? 'my-request-signed' : undefined}>
                {status === undefined
                  ? t('common.loading')
                  : signed > 0
                    ? t('signRequest.signedCopies', { count: signed })
                    : t('signRequest.waiting')}
                {' · '}
                {t('signRequest.expires', { date: formatDate(entry.expiresAt) })}
              </span>
            </div>
            <a className="button my-request-open" href={requestLink(entry.id, entry.key)}>
              <ExternalLink size={14} /> {t('signRequest.open')}
            </a>
            <button
              type="button"
              className="icon-button my-request-delete"
              title={t('signRequest.remove')}
              aria-label={t('signRequest.remove')}
              onClick={() => {
                void deleteMyRequest(entry.id)
                  .then(() => {
                    setEntries(listMyRequests())
                    useStore.getState().toastMessage('info', t('signRequest.removed'))
                  })
                  .catch((error) => useStore.getState().toastMessage('error', requestErrorMessage(error)))
              }}
            >
              <Trash2 size={15} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Requesting signatures, around the placing step: first who needs to sign
 * (and an optional note), then, once their "sign here" fields are placed and
 * the document is encrypted and uploaded, the link to share.
 */
export function RequestSignaturesModal() {
  const { t } = useTranslation()
  const flow = useStore((state) => state.signFlow)
  const draft = useStore((state) => state.requestDraft)
  const fileName = useStore((state) => state.fileName)
  const fieldCount = useStore((state) => state.signSpots.length)
  if (flow?.mode !== 'request' || (flow.step !== 'signers' && flow.step !== 'sent')) return null
  const close = () => useStore.getState().setSignFlow(null)
  const update = useStore.getState().updateRequestDraft
  const setSigner = (id: string, patch: Partial<RequestSigner>) =>
    update({ signers: draft.signers.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)) })
  const ready = draft.signers.length > 0 && draft.signers.every((entry) => entry.name.trim())
  const created = draft.created

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="request-sign-title">
      <div className="modal request-sign">
        <div className="modal-head">
          <h2 id="request-sign-title">{created ? t('signRequest.sentTitle') : t('signRequest.title')}</h2>
          <button type="button" className="icon-button" onClick={close} title={t('common.close')}>
            <X size={17} />
          </button>
        </div>

        {created ? (
          <div className="request-sign-ready">
            <p className="request-sign-status">
              <CheckCircle2 size={16} />{' '}
              {fieldCount ? t('signRequest.linkReadyFields', { count: fieldCount }) : t('signRequest.linkReady')}
            </p>
            <label className="digital-sign-label" htmlFor="request-link">
              {t('signRequest.link')}
            </label>
            <div className="modal-row request-sign-link-row">
              <input
                id="request-link"
                className="text-input request-link"
                readOnly
                value={created.link}
                onFocus={(event) => event.currentTarget.select()}
              />
              <button
                type="button"
                className="button button-primary request-copy"
                onClick={() =>
                  void copyText(created.link).then((ok) => ok && useStore.getState().toastMessage('success', t('signRequest.copied')))
                }
              >
                <Copy size={15} /> {t('signRequest.copy')}
              </button>
              <a
                className="button request-email"
                href={mailLink(created, draft.signers.map((entry) => entry.email.trim()).filter(Boolean), draft.from.trim(), draft.message.trim(), t)}
              >
                <Mail size={15} /> {t('signRequest.email')}
              </a>
            </div>
            <p className="request-sign-privacy">
              <Lock size={13} /> {t('signRequest.privacy')}
            </p>
            <div className="modal-row">
              <div className="modal-spacer" />
              <button type="button" className="button request-done" onClick={close}>
                {t('common.done')}
              </button>
            </div>
          </div>
        ) : (
          <form
            className="request-sign-form"
            onSubmit={(event) => {
              event.preventDefault()
              if (!ready) return
              update({ activeSigner: draft.activeSigner ?? draft.signers[0]?.id ?? null })
              void enterPlacing()
            }}
          >
            <p className="digital-sign-intro">{t('signRequest.intro')}</p>
            <span className="digital-sign-label">{t('signRequest.signers')}</span>
            <div className="request-signers">
              {draft.signers.map((entry, index) => (
                <div key={entry.id} className="request-signer">
                  <span className="sign-signer-dot" style={{ background: SIGNER_COLORS[index % SIGNER_COLORS.length] }} />
                  <input
                    className="text-input request-signer-name"
                    name={`signer-name-${index + 1}`}
                    value={entry.name}
                    maxLength={100}
                    required
                    autoFocus={index === 0}
                    placeholder={t('signRequest.signerName')}
                    aria-label={t('signRequest.signerName')}
                    onChange={(event) => setSigner(entry.id, { name: event.target.value })}
                  />
                  <input
                    className="text-input request-signer-email"
                    name={`signer-email-${index + 1}`}
                    type="email"
                    value={entry.email}
                    placeholder={t('signRequest.signerEmail')}
                    aria-label={t('signRequest.signerEmail')}
                    onChange={(event) => setSigner(entry.id, { email: event.target.value })}
                  />
                  <button
                    type="button"
                    className="icon-button request-signer-remove"
                    title={t('signRequest.removeSigner')}
                    aria-label={t('signRequest.removeSigner')}
                    disabled={draft.signers.length === 1}
                    onClick={() => {
                      const state = useStore.getState()
                      update({
                        signers: draft.signers.filter((other) => other.id !== entry.id),
                        activeSigner: draft.activeSigner === entry.id ? null : draft.activeSigner,
                      })
                      for (const spot of state.signSpots) if (spot.signer === entry.id) state.removeSignSpot(spot.id)
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="link-button request-add-signer"
                onClick={() => update({ signers: [...draft.signers, { id: uid(), name: '', email: '' }] })}
              >
                <UserPlus size={14} /> {t('signRequest.addSigner')}
              </button>
            </div>
            <div className="digital-sign-grid">
              <label>
                <span>{t('signRequest.from')}</span>
                <input
                  className="text-input"
                  name="request-from"
                  value={draft.from}
                  maxLength={100}
                  placeholder={t('signRequest.fromPlaceholder')}
                  onChange={(event) => update({ from: event.target.value })}
                />
              </label>
              <label>
                <span>{t('signRequest.message')}</span>
                <input
                  className="text-input"
                  name="request-message"
                  value={draft.message}
                  maxLength={500}
                  placeholder={t('signRequest.messagePlaceholder')}
                  onChange={(event) => update({ message: event.target.value })}
                />
              </label>
            </div>
            <div className="modal-row">
              <span className="digital-sign-file">{fileName}</span>
              <div className="modal-spacer" />
              <button type="button" className="button" onClick={close}>
                {t('common.cancel')}
              </button>
              <button type="submit" className="button button-primary request-next" disabled={!ready}>
                {t('signRequest.next')} <ArrowRight size={15} />
              </button>
            </div>
          </form>
        )}

        <div className="request-sign-list">
          <MyRequestsList key={created?.id ?? 'list'} title={t('signRequest.yours')} />
        </div>
      </div>
    </div>
  )
}
