import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, BadgeCheck, FileKey, KeyRound, Loader2, ShieldCheck, X } from 'lucide-react'
import { useStore } from '../store'
import { useTranslation } from '../i18n'
import {
  loadSigning,
  signCurrentDocument,
  signingContext,
  type PlacementChoice,
  type SigningContext,
} from '../lib/signController'
import type { SigningIdentity } from '../lib/signing'

type PlacementMode = 'box' | 'invisible' | `field:${string}`

/**
 * Certificate-based signing: unlock a PKCS#12 file, choose where the
 * signature goes, then sign and download. While the user draws the signature
 * box the dialog stays mounted (keeping its state) and shows a banner instead.
 */
export function DigitalSignatureModal() {
  const { t } = useTranslation()
  const stage = useStore((state) => state.digitalSign)
  const placementRequest = useStore((state) => state.signPlacement)
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array } | null>(null)
  const [password, setPassword] = useState('')
  const [identity, setIdentity] = useState<SigningIdentity | null>(null)
  const [certError, setCertError] = useState<string | null>(null)
  const [unlocking, setUnlocking] = useState(false)
  const [reason, setReason] = useState('')
  const [location, setLocation] = useState('')
  const [mode, setMode] = useState<PlacementMode>('box')
  const [certify, setCertify] = useState(false)
  const [context, setContext] = useState<SigningContext | null>(null)
  const [signing, setSigning] = useState(false)
  const open = stage !== 'closed'

  // Fresh state for every opening; the unlocked key is dropped on close.
  useEffect(() => {
    if (open) {
      void signingContext().then(setContext).catch(() => setContext(null))
      void loadSigning()
      return
    }
    setFile(null)
    setPassword('')
    setIdentity(null)
    setCertError(null)
    setReason('')
    setLocation('')
    setMode('box')
    setCertify(false)
    setContext(null)
  }, [open])

  const close = () => useStore.getState().setDigitalSign('closed')

  const sign = async (placement: PlacementChoice) => {
    if (!identity || signing) return
    setSigning(true)
    try {
      await signCurrentDocument({ identity, placement, reason: reason.trim(), location: location.trim(), certify })
      close()
    } catch {
      // The controller already reported the error; keep the dialog open.
    } finally {
      setSigning(false)
    }
  }

  // A box drawn on a page finishes the flow.
  const handledRequest = useRef<number | null>(null)
  useEffect(() => {
    if (!placementRequest || handledRequest.current === placementRequest.nonce) return
    handledRequest.current = placementRequest.nonce
    const { pageIndex, x, y, width, height } = placementRequest
    void sign({ kind: 'box', pageIndex, x, y, width, height })
  }, [placementRequest])

  useEffect(() => {
    if (stage !== 'placing') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        useStore.getState().setDigitalSign('form')
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [stage])

  if (!open) return null

  if (stage === 'placing') {
    return (
      <div className="sign-banner" role="status">
        <ShieldCheck size={16} />
        <span>{t('digitalSign.placingHint')}</span>
        <button type="button" className="button" onClick={() => useStore.getState().setDigitalSign('form')}>
          {t('common.cancel')}
        </button>
      </div>
    )
  }

  const unlock = async () => {
    if (!file || unlocking) return
    setUnlocking(true)
    setCertError(null)
    try {
      const { loadSigningIdentity } = await loadSigning()
      setIdentity(await loadSigningIdentity(file.bytes, password))
      setPassword('')
    } catch (error) {
      const code = (error as { code?: string })?.code
      setCertError(code ? t(`digitalSign.errors.${code}`) : String((error as Error)?.message ?? error))
    } finally {
      setUnlocking(false)
    }
  }

  const summary = context?.summary
  const alreadySigned = Boolean(summary && summary.signed > 0)
  const direct = context?.direct ?? true
  const fields = direct ? (summary?.empty ?? []) : []
  const certifyBlocked = direct && alreadySigned
  const now = Date.now()
  const info = identity?.info
  const formatDate = (date: Date) => date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

  const submit = () => {
    if (mode === 'box') {
      useStore.getState().setDigitalSign('placing')
    } else if (mode === 'invisible') {
      void sign({ kind: 'invisible' })
    } else {
      void sign({ kind: 'field', name: mode.slice('field:'.length) })
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="digital-sign-title">
      <div className="modal digital-sign">
        <div className="modal-head">
          <h2 id="digital-sign-title">{t('digitalSign.title')}</h2>
          <button type="button" className="icon-button" onClick={close} title={t('common.close')}>
            <X size={17} />
          </button>
        </div>
        <p className="digital-sign-intro">{t('digitalSign.intro')}</p>

        {info ? (
          <div className="cert-summary">
            <BadgeCheck size={20} />
            <div>
              <strong className="cert-name">{info.name}</strong>
              <span>
                {t('digitalSign.issuedBy', { issuer: info.issuer })}
                {info.notAfter ? ` · ${t('digitalSign.validUntil', { date: formatDate(info.notAfter) })}` : ''}
              </span>
              {info.notAfter && info.notAfter.getTime() < now && (
                <span className="cert-warning">{t('digitalSign.expired', { date: formatDate(info.notAfter) })}</span>
              )}
              {info.notBefore && info.notBefore.getTime() > now && (
                <span className="cert-warning">{t('digitalSign.notYetValid', { date: formatDate(info.notBefore) })}</span>
              )}
              {info.selfSigned && <span className="cert-note">{t('digitalSign.selfSigned')}</span>}
            </div>
            <button
              type="button"
              className="button button-ghost"
              onClick={() => {
                setIdentity(null)
                setFile(null)
                fileRef.current?.click()
              }}
            >
              {t('signature.replace')}
            </button>
          </div>
        ) : (
          <div className="digital-sign-unlock">
            <label className="digital-sign-label">{t('digitalSign.certificate')}</label>
            <div className="modal-row digital-sign-row">
              <button type="button" className="button" onClick={() => fileRef.current?.click()}>
                <FileKey size={15} /> {t('digitalSign.chooseFile')}
              </button>
              {file && <span className="digital-sign-file">{file.name}</span>}
            </div>
            {file && (
              <form
                className="modal-row digital-sign-row"
                onSubmit={(event) => {
                  event.preventDefault()
                  void unlock()
                }}
              >
                <input
                  className="text-input"
                  type="password"
                  name="certificate-password"
                  autoComplete="off"
                  placeholder={t('digitalSign.password')}
                  aria-label={t('digitalSign.password')}
                  value={password}
                  autoFocus
                  onChange={(event) => setPassword(event.target.value)}
                />
                <button type="submit" className="button button-primary" disabled={unlocking}>
                  {unlocking ? <Loader2 size={15} className="spin" /> : <KeyRound size={15} />}{' '}
                  {unlocking ? t('digitalSign.unlocking') : t('digitalSign.unlock')}
                </button>
              </form>
            )}
            {certError && (
              <p className="cert-error" role="alert">
                <AlertTriangle size={14} /> {certError}
              </p>
            )}
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".p12,.pfx,application/x-pkcs12"
          hidden
          className="digital-sign-file-input"
          onChange={(event) => {
            const chosen = event.target.files?.[0]
            event.target.value = ''
            if (!chosen) return
            setCertError(null)
            setIdentity(null)
            void chosen.arrayBuffer().then((buffer) => setFile({ name: chosen.name, bytes: new Uint8Array(buffer) }))
          }}
        />

        {identity && (
          <div className="digital-sign-options">
            <div className="digital-sign-grid">
              <label>
                <span>{t('digitalSign.reason')}</span>
                <input
                  className="text-input"
                  name="signature-reason"
                  value={reason}
                  placeholder={t('digitalSign.reasonPlaceholder')}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <label>
                <span>{t('digitalSign.location')}</span>
                <input
                  className="text-input"
                  name="signature-location"
                  value={location}
                  placeholder={t('digitalSign.locationPlaceholder')}
                  onChange={(event) => setLocation(event.target.value)}
                />
              </label>
              <label>
                <span>{t('digitalSign.placement')}</span>
                <select
                  className="text-input"
                  name="signature-placement"
                  value={mode}
                  onChange={(event) => setMode(event.target.value as PlacementMode)}
                >
                  <option value="box">{t('digitalSign.placeBox')}</option>
                  {fields.map((field) => (
                    <option key={field.name} value={`field:${field.name}`}>
                      {t('digitalSign.placeField', { name: field.name, page: field.pageIndex + 1 })}
                    </option>
                  ))}
                  <option value="invisible">{t('digitalSign.placeInvisible')}</option>
                </select>
              </label>
            </div>
            <label className="check">
              <input
                type="checkbox"
                name="signature-certify"
                checked={certify && !certifyBlocked}
                disabled={certifyBlocked}
                onChange={(event) => setCertify(event.target.checked)}
              />
              {certifyBlocked ? t('digitalSign.certifyUnavailable') : t('digitalSign.certify')}
            </label>
            {alreadySigned && !direct && <p className="cert-warning">{t('digitalSign.editsBreakSignatures')}</p>}
          </div>
        )}

        <div className="modal-row">
          <div className="modal-spacer" />
          <button type="button" className="button" onClick={close}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="button button-primary digital-sign-submit"
            disabled={!identity || signing}
            onClick={submit}
          >
            {signing ? <Loader2 size={16} className="spin" /> : <ShieldCheck size={16} />}{' '}
            {mode === 'box' ? t('digitalSign.place') : t('digitalSign.sign')}
          </button>
        </div>
      </div>
    </div>
  )
}
