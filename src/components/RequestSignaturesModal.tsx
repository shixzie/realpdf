import { useEffect, useState } from 'react'
import { AlertTriangle, Copy, ExternalLink, Link2, Loader2, Lock, Mail, Trash2, X } from 'lucide-react'
import { useStore } from '../store'
import { useTranslation } from '../i18n'
import { loadSigning } from '../lib/signController'
import { createRequestForCurrentDocument, requestErrorMessage } from '../lib/signRequestController'
import {
  deleteMyRequest,
  fetchRequestStatus,
  listMyRequests,
  requestLink,
  type MyRequest,
  type RequestStatus,
} from '../lib/signRequests'

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** A mailto: link the sender's own mail app opens; nothing is sent by RealPDF. */
function mailLink(created: { link: string; fileName: string }, from: string, message: string, t: (key: string, vars?: Record<string, string>) => string) {
  const subject = t('signRequest.emailSubject', { fileName: created.fileName })
  const body = [t('signRequest.emailBody', { from, fileName: created.fileName }), '', created.link, message ? `\n${message}` : '']
    .join('\n')
    .trim()
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
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
 * Sends the current document for signature: encrypts it here, uploads the
 * ciphertext and shows a link to share. Also lists earlier requests.
 */
export function RequestSignaturesModal() {
  const { t } = useTranslation()
  const open = useStore((state) => state.requestSignOpen)
  const fileName = useStore((state) => state.fileName)
  const [from, setFrom] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<(MyRequest & { link: string }) | null>(null)
  const [listKey, setListKey] = useState(0)

  useEffect(() => {
    if (!open) {
      setCreated(null)
      setError(null)
      setMessage('')
      return
    }
    // Prefill the sender's name from their signing ID.
    void loadSigning()
      .then(({ listSavedIdentities }) => listSavedIdentities())
      .then((saved) => setFrom((current) => current || saved[0]?.info.name || ''))
      .catch(() => undefined)
  }, [open])

  if (!open) return null
  const close = () => useStore.getState().setRequestSignOpen(false)

  const create = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      setCreated(await createRequestForCurrentDocument({ from: from.trim(), message: message.trim() }))
      setListKey((key) => key + 1)
    } catch (caught) {
      console.error(caught)
      setError(requestErrorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="request-sign-title">
      <div className="modal request-sign">
        <div className="modal-head">
          <h2 id="request-sign-title">{t('signRequest.title')}</h2>
          <button type="button" className="icon-button" onClick={close} title={t('common.close')}>
            <X size={17} />
          </button>
        </div>
        <p className="digital-sign-intro">{t('signRequest.intro')}</p>

        {created ? (
          <div className="request-sign-ready">
            <p className="request-sign-status">{t('signRequest.linkReady')}</p>
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
              <a className="button request-email" href={mailLink(created, from.trim(), message.trim(), t)}>
                <Mail size={15} /> {t('signRequest.email')}
              </a>
            </div>
          </div>
        ) : (
          <form
            className="request-sign-form"
            onSubmit={(event) => {
              event.preventDefault()
              void create()
            }}
          >
            <div className="digital-sign-grid">
              <label>
                <span>{t('signRequest.from')}</span>
                <input
                  className="text-input"
                  name="request-from"
                  value={from}
                  maxLength={100}
                  placeholder={t('signRequest.fromPlaceholder')}
                  onChange={(event) => setFrom(event.target.value)}
                />
              </label>
              <label>
                <span>{t('signRequest.message')}</span>
                <input
                  className="text-input"
                  name="request-message"
                  value={message}
                  maxLength={500}
                  placeholder={t('signRequest.messagePlaceholder')}
                  onChange={(event) => setMessage(event.target.value)}
                />
              </label>
            </div>
            <p className="request-sign-privacy">
              <Lock size={13} /> {t('signRequest.privacy')}
            </p>
            {error && (
              <p className="cert-error" role="alert">
                <AlertTriangle size={14} /> {error}
              </p>
            )}
            <div className="modal-row">
              <span className="digital-sign-file">{fileName}</span>
              <div className="modal-spacer" />
              <button type="button" className="button" onClick={close}>
                {t('common.cancel')}
              </button>
              <button type="submit" className="button button-primary request-create" disabled={busy}>
                {busy ? <Loader2 size={15} className="spin" /> : <Link2 size={15} />}{' '}
                {busy ? t('signRequest.creating') : t('signRequest.create')}
              </button>
            </div>
          </form>
        )}

        <div className="request-sign-list">
          <MyRequestsList key={listKey} title={t('signRequest.yours')} />
        </div>
      </div>
    </div>
  )
}
