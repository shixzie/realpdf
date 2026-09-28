import { useState } from 'react'
import { AlertTriangle, Loader2, Mail, ShieldCheck } from 'lucide-react'
import { useTranslation } from '../i18n'
import { loadSigning } from '../lib/signController'
import type { PendingEnrollment, SavedIdentityMeta, SigningIdentity } from '../lib/signing'

interface Props {
  onReady: (identity: SigningIdentity, saved: SavedIdentityMeta) => void
}

/**
 * Creates a signing ID for people without a certificate file: name and
 * email, then the code RealPDF emails. The key pair is made in this browser
 * and remembered here; only the public key is sent to be certified.
 */
export function SigningIdSetup({ onReady }: Props) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [pending, setPending] = useState<PendingEnrollment | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resent, setResent] = useState(false)

  const fail = (caught: unknown) => {
    const errorCode = (caught as { code?: string })?.code
    setError(t(`signingId.errors.${errorCode && errorCode in ERROR_KEYS ? errorCode : 'network'}`))
  }

  const send = async (previous?: PendingEnrollment) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const { startEnrollment } = await loadSigning()
      setPending(await startEnrollment(email.trim(), previous))
      setCode('')
      setResent(Boolean(previous))
    } catch (caught) {
      fail(caught)
    } finally {
      setBusy(false)
    }
  }

  const verify = async () => {
    if (!pending || busy) return
    setBusy(true)
    setError(null)
    try {
      const { completeEnrollment } = await loadSigning()
      const { identity, saved } = await completeEnrollment(pending, code, name.trim())
      onReady(identity, saved)
    } catch (caught) {
      fail(caught)
      const errorCode = (caught as { code?: string })?.code
      if (errorCode === 'codeExpired' || errorCode === 'tooManyAttempts' || errorCode === 'invalidChallenge') {
        setCode('')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="signing-id">
      <div className="signing-id-head">
        <ShieldCheck size={18} />
        <div>
          <strong>{t('signingId.title')}</strong>
          <span>{t('signingId.intro')}</span>
        </div>
      </div>
      {!pending ? (
        <form
          className="signing-id-form"
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
        >
          <label>
            <span>{t('signingId.name')}</span>
            <input
              className="text-input"
              name="signer-name"
              autoComplete="name"
              required
              maxLength={100}
              value={name}
              placeholder={t('signingId.namePlaceholder')}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            <span>{t('signingId.email')}</span>
            <input
              className="text-input"
              name="signer-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              placeholder={t('signingId.emailPlaceholder')}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="button button-primary signing-id-send"
            disabled={busy || !name.trim() || !email.trim()}
          >
            {busy ? <Loader2 size={15} className="spin" /> : <Mail size={15} />} {t('signingId.sendCode')}
          </button>
        </form>
      ) : (
        <form
          className="signing-id-form"
          onSubmit={(event) => {
            event.preventDefault()
            void verify()
          }}
        >
          <p className="signing-id-sent">{t(resent ? 'signingId.resent' : 'signingId.sent', { email: pending.email })}</p>
          <label>
            <span>{t('signingId.code')}</span>
            <input
              className="text-input signing-id-code"
              name="signer-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]*"
              maxLength={7}
              required
              autoFocus
              value={code}
              placeholder="123456"
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="button button-primary signing-id-verify"
            disabled={busy || code.replace(/\s+/g, '').length !== 6}
          >
            {busy ? <Loader2 size={15} className="spin" /> : <ShieldCheck size={15} />} {t('signingId.verify')}
          </button>
          <div className="signing-id-links">
            <button type="button" className="link-button" disabled={busy} onClick={() => void send(pending)}>
              {t('signingId.resend')}
            </button>
            <button
              type="button"
              className="link-button"
              disabled={busy}
              onClick={() => {
                setPending(null)
                setError(null)
              }}
            >
              {t('signingId.changeEmail')}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="cert-error" role="alert">
          <AlertTriangle size={14} /> {error}
        </p>
      )}
    </div>
  )
}

const ERROR_KEYS = {
  invalidEmail: true,
  invalidName: true,
  wrongCode: true,
  codeExpired: true,
  tooManyAttempts: true,
  invalidChallenge: true,
  rateLimited: true,
  unavailable: true,
  network: true,
}
