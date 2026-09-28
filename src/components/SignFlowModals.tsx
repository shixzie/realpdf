import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  AlertTriangle,
  BadgeCheck,
  CheckCircle2,
  Download,
  Eraser,
  FileKey,
  Image as ImageIcon,
  Keyboard,
  Loader2,
  Mail,
  PenLine,
  Send,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useStore } from '../store'
import { useTranslation } from '../i18n'
import {
  adoptSigner,
  downloadSignedCopy,
  forgetSavedSigner,
  loadSigning,
  signedResult,
  signingContext,
  signPlacedSpots,
  startSigning,
  type SigningContext,
} from '../lib/signController'
import {
  prepareUploadedSignature,
  renderTypedSignature,
  savedSignatureImage,
  SIGNATURE_FONTS,
  SIGNATURE_INK,
  trimCanvas,
  type SignatureFont,
} from '../lib/signatureImage'
import type { PendingEnrollment, SavedIdentityMeta, SigningIdentity } from '../lib/signing'

/** The Sign flow's dialogs: adopt a signature, review before signing, and done. */
export function SignFlowModals() {
  const flow = useStore((state) => state.signFlow)
  if (flow?.mode !== 'self') return null
  if (flow.step === 'adopt') return <AdoptSignatureModal />
  if (flow.step === 'review') return <ReviewModal />
  if (flow.step === 'done') return <DoneModal />
  return null
}

const ENROLL_ERRORS = new Set([
  'invalidEmail',
  'invalidName',
  'wrongCode',
  'codeExpired',
  'tooManyAttempts',
  'invalidChallenge',
  'rateLimited',
  'unavailable',
  'network',
])

type Style = 'type' | 'draw' | 'upload'
type Method = 'email' | 'file'

/**
 * Adopt your signature: who you are (a signing ID saved on this device, a
 * new one confirmed by an emailed code, or a certificate file) and how your
 * signature looks (typed, drawn or uploaded). RealPDF issues the certificate
 * behind the scenes; the private key is made in this browser and stays here.
 */
function AdoptSignatureModal() {
  const { t } = useTranslation()
  const current = useStore((state) => state.signer)
  const [saved, setSaved] = useState<SavedIdentityMeta[] | null>(null)
  const [chosen, setChosen] = useState<{ identity: SigningIdentity; savedId: string | null } | null>(
    current ? { identity: current.identity, savedId: current.savedId } : null,
  )
  const [method, setMethod] = useState<Method>('email')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [pending, setPending] = useState<PendingEnrollment | null>(null)
  const [code, setCode] = useState('')
  const [resent, setResent] = useState(false)
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array } | null>(null)
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [style, setStyle] = useState<Style>('type')
  const [font, setFont] = useState<SignatureFont>(SIGNATURE_FONTS[0])
  const [uploadSrc, setUploadSrc] = useState<string | null>(null)
  const [uploadPreview, setUploadPreview] = useState<string | null>(null)
  const [removeWhite, setRemoveWhite] = useState(true)
  /** The signature to adopt; starts as the current one, and any style change replaces it. */
  const [image, setImage] = useState<string | null>(current?.image ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const padRef = useRef<HTMLCanvasElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const uploadRef = useRef<HTMLInputElement>(null)
  const drawingRef = useRef<{ x: number; y: number } | null>(null)
  const [drawn, setDrawn] = useState(false)

  const refreshSaved = async () => {
    const { listSavedIdentities } = await loadSigning()
    const list = await listSavedIdentities()
    setSaved(list)
    return list
  }

  const forget = async (id: string) => {
    setSaved((list) => list?.filter((entry) => entry.id !== id) ?? null)
    await forgetSavedSigner(id)
    await refreshSaved()
    useStore.getState().toastMessage('info', t('digitalSign.forgotten'))
  }

  const pickSaved = async (id: string) => {
    setError(null)
    try {
      const { getSavedIdentity } = await loadSigning()
      const identity = await getSavedIdentity(id)
      if (!identity) throw new Error('missing')
      setChosen({ identity, savedId: id })
      setImage(savedSignatureImage(id))
    } catch {
      setError(t('digitalSign.savedMissing'))
      await refreshSaved()
    }
  }

  // Preselect the most recent signing ID saved on this device.
  useEffect(() => {
    void refreshSaved()
      .then((list) => {
        if (!chosen && list[0]) void pickSaved(list[0].id)
      })
      .catch(() => setSaved([]))
  }, [])

  useEffect(() => {
    if (!uploadSrc) {
      setUploadPreview(null)
      return
    }
    let cancelled = false
    void prepareUploadedSignature(uploadSrc, removeWhite)
      .then((result) => !cancelled && setUploadPreview(result))
      .catch(() => !cancelled && setError(t('signature.readFailed')))
    return () => {
      cancelled = true
    }
  }, [uploadSrc, removeWhite])

  const close = () => {
    const state = useStore.getState()
    // "Change" from the placing step returns there; otherwise the flow ends.
    if (state.signer) state.setSignStep('place')
    else state.setSignFlow(null)
  }

  const signatureName = chosen?.identity.info.name ?? name.trim()

  const fail = (caught: unknown, keys: 'signingId' | 'digitalSign') => {
    const errorCode = (caught as { code?: string })?.code
    if (keys === 'signingId') setError(t(`signingId.errors.${errorCode && ENROLL_ERRORS.has(errorCode) ? errorCode : 'network'}`))
    else setError(errorCode ? t(`digitalSign.errors.${errorCode}`) : String((caught as Error)?.message ?? caught))
  }

  /** The adopted signature as a PNG, from the chosen style. */
  const makeImage = async (): Promise<string | null> => {
    if (style === 'type') return renderTypedSignature(signatureName, font)
    if (style === 'draw') return drawn && padRef.current ? trimCanvas(padRef.current) : null
    return uploadPreview
  }

  const finish = async (identity: SigningIdentity, savedId: string | null, adopted: string) => {
    await adoptSigner({ identity, savedId, image: adopted })
  }

  const submit = async () => {
    if (busy) return
    setError(null)
    const adopted = image ?? (await makeImage())
    if (!adopted) {
      setError(t(style === 'type' ? 'sign.needName' : style === 'draw' ? 'signature.needDraw' : 'signature.needImage'))
      return
    }
    setBusy(true)
    try {
      if (chosen) {
        await finish(chosen.identity, chosen.savedId, adopted)
      } else if (method === 'email') {
        const { startEnrollment } = await loadSigning()
        setPending(await startEnrollment(email.trim()))
        setImage(adopted)
        setCode('')
        setResent(false)
      } else if (file) {
        const { loadSigningIdentity, rememberIdentity } = await loadSigning()
        let identity: SigningIdentity
        try {
          identity = await loadSigningIdentity(file.bytes, password)
        } catch (caught) {
          fail(caught, 'digitalSign')
          return
        }
        let savedId: string | null = null
        if (remember) {
          try {
            savedId = (await rememberIdentity(identity)).id
          } catch (caught) {
            console.error(caught)
            useStore.getState().toastMessage('error', t('digitalSign.rememberFailed'))
          }
        }
        setPassword('')
        await finish(identity, savedId, adopted)
      }
    } catch (caught) {
      fail(caught, 'signingId')
    } finally {
      setBusy(false)
    }
  }

  const verify = async () => {
    if (!pending || !image || busy) return
    setBusy(true)
    setError(null)
    try {
      const { completeEnrollment } = await loadSigning()
      const created = await completeEnrollment(pending, code, name.trim())
      await finish(created.identity, created.saved.id, image)
    } catch (caught) {
      fail(caught, 'signingId')
      const errorCode = (caught as { code?: string })?.code
      if (errorCode === 'codeExpired' || errorCode === 'tooManyAttempts' || errorCode === 'invalidChallenge') setCode('')
    } finally {
      setBusy(false)
    }
  }

  const resend = async () => {
    if (!pending || busy) return
    setBusy(true)
    setError(null)
    try {
      const { startEnrollment } = await loadSigning()
      setPending(await startEnrollment(pending.email, pending))
      setCode('')
      setResent(true)
    } catch (caught) {
      fail(caught, 'signingId')
    } finally {
      setBusy(false)
    }
  }

  const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    }
  }

  const clearPad = () => {
    const canvas = padRef.current
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
    setDrawn(false)
    setImage(null)
  }

  const header = (
    <div className="modal-head">
      <h2 id="adopt-title">{chosen ? t('sign.adoptTitleKnown') : t('sign.adoptTitle')}</h2>
      <button type="button" className="icon-button" onClick={close} title={t('common.close')}>
        <X size={17} />
      </button>
    </div>
  )

  if (pending) {
    return (
      <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="adopt-title">
        <div className="modal adopt-signature">
          {header}
          <form
            className="adopt-code"
            onSubmit={(event) => {
              event.preventDefault()
              void verify()
            }}
          >
            <Mail size={28} className="adopt-code-icon" />
            <strong>{t('sign.checkEmail')}</strong>
            <p className="signing-id-sent">{t(resent ? 'signingId.resent' : 'signingId.sent', { email: pending.email })}</p>
            <input
              className="text-input signing-id-code"
              name="signer-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]*"
              maxLength={7}
              required
              autoFocus
              aria-label={t('signingId.code')}
              value={code}
              placeholder="123456"
              onChange={(event) => setCode(event.target.value)}
            />
            {error && (
              <p className="cert-error" role="alert">
                <AlertTriangle size={14} /> {error}
              </p>
            )}
            <button type="submit" className="button button-primary adopt-verify" disabled={busy || code.replace(/\s+/g, '').length !== 6}>
              {busy ? <Loader2 size={15} className="spin" /> : <ShieldCheck size={15} />} {t('sign.verifyAndSign')}
            </button>
            <div className="signing-id-links">
              <button type="button" className="link-button" disabled={busy} onClick={() => void resend()}>
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
        </div>
      </div>
    )
  }

  const info = chosen?.identity.info
  const otherSaved = (saved ?? []).filter((entry) => entry.id !== chosen?.savedId)
  const canSubmit = chosen
    ? true
    : method === 'email'
      ? Boolean(name.trim() && email.trim())
      : Boolean(file && password)

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="adopt-title">
      <div className="modal adopt-signature">
        {header}

        {info ? (
          <div className="adopt-identity">
            <BadgeCheck size={18} />
            <div>
              <strong className="cert-name">{info.name}</strong>
              <span>{info.email ?? t('digitalSign.issuedBy', { issuer: info.issuer })}</span>
            </div>
            <button
              type="button"
              className="link-button adopt-switch"
              onClick={() => {
                setChosen(null)
                setImage(null)
              }}
            >
              {t('sign.useAnother')}
            </button>
            {chosen?.savedId && (
              <button
                type="button"
                className="link-button adopt-forget"
                onClick={() => {
                  const id = chosen.savedId as string
                  setChosen(null)
                  setImage(null)
                  if (current?.savedId === id) useStore.getState().setSigner(null)
                  void forget(id)
                }}
              >
                <Trash2 size={13} /> {t('digitalSign.forget')}
              </button>
            )}
          </div>
        ) : (
          <>
            {otherSaved.length > 0 && (
              <div className="saved-certs">
                <span className="digital-sign-label">{t('digitalSign.savedTitle')}</span>
                {otherSaved.map((entry) => (
                  <div key={entry.id} className="saved-cert">
                    <BadgeCheck size={16} />
                    <div>
                      <strong>{entry.info.name}</strong>
                      <span>{entry.info.email ?? t('digitalSign.issuedBy', { issuer: entry.info.issuer })}</span>
                    </div>
                    <button type="button" className="button saved-cert-use" onClick={() => void pickSaved(entry.id)}>
                      {t('digitalSign.useSaved')}
                    </button>
                    <button
                      type="button"
                      className="icon-button saved-cert-forget"
                      title={t('digitalSign.forget')}
                      aria-label={t('digitalSign.forget')}
                      onClick={() => void forget(entry.id)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="adopt-details">
              <label>
                <span>{t('signingId.name')}</span>
                <input
                  className="text-input"
                  name="signer-name"
                  autoComplete="name"
                  maxLength={100}
                  value={name}
                  placeholder={t('signingId.namePlaceholder')}
                  onChange={(event) => {
                    setName(event.target.value)
                    setImage(null)
                  }}
                />
              </label>
              {method === 'email' ? (
                <label>
                  <span>{t('signingId.email')}</span>
                  <input
                    className="text-input"
                    name="signer-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    placeholder={t('signingId.emailPlaceholder')}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </label>
              ) : (
                <div className="adopt-file">
                  <span>{t('digitalSign.certificate')}</span>
                  <div className="adopt-file-row">
                    <button type="button" className="button" onClick={() => fileRef.current?.click()}>
                      <FileKey size={15} /> {file ? file.name : t('digitalSign.chooseFile')}
                    </button>
                    <input
                      className="text-input"
                      type="password"
                      name="certificate-password"
                      autoComplete="off"
                      placeholder={t('digitalSign.password')}
                      aria-label={t('digitalSign.password')}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </div>
                  <label className="check">
                    <input
                      type="checkbox"
                      name="certificate-remember"
                      checked={remember}
                      onChange={(event) => setRemember(event.target.checked)}
                    />
                    {t('digitalSign.remember')}
                  </label>
                </div>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".p12,.pfx,application/x-pkcs12"
              hidden
              className="adopt-file-input"
              onChange={(event) => {
                const picked = event.target.files?.[0]
                event.target.value = ''
                if (!picked) return
                setError(null)
                setMethod('file')
                void picked.arrayBuffer().then((buffer) => setFile({ name: picked.name, bytes: new Uint8Array(buffer) }))
              }}
            />
          </>
        )}

        <div className="adopt-style">
          {image && (
            <p className="adopt-current">
              <img src={image} alt={t('signature.previewAlt')} />
              <span>{t('sign.keepCurrent')}</span>
            </p>
          )}
          <div className="segmented" role="tablist">
            {(
              [
                ['type', Keyboard, t('sign.styleType')],
                ['draw', PenLine, t('signature.draw')],
                ['upload', ImageIcon, t('sign.styleUpload')],
              ] as const
            ).map(([id, Icon, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={style === id}
                className={`adopt-style-${id} ${style === id ? 'is-active' : ''}`}
                onClick={() => {
                  setStyle(id)
                  setImage(null)
                }}
              >
                <Icon size={15} /> {label}
              </button>
            ))}
          </div>

          {style === 'type' && (
            <div className="adopt-fonts" role="radiogroup">
              {SIGNATURE_FONTS.map((family) => (
                <button
                  key={family}
                  type="button"
                  role="radio"
                  aria-checked={font === family}
                  className={`adopt-font ${font === family ? 'is-active' : ''}`}
                  style={{ fontFamily: `"${family}", cursive`, color: SIGNATURE_INK }}
                  onClick={() => {
                    setFont(family)
                    setImage(null)
                  }}
                >
                  {signatureName || t('sign.typePlaceholder')}
                </button>
              ))}
            </div>
          )}
          {style === 'draw' && (
            <div className="adopt-draw">
              <canvas
                ref={padRef}
                className="signature-pad adopt-pad"
                width={640}
                height={200}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId)
                  drawingRef.current = point(event)
                }}
                onPointerMove={(event) => {
                  const last = drawingRef.current
                  const context = event.currentTarget.getContext('2d')
                  if (!last || !context) return
                  const next = point(event)
                  context.strokeStyle = SIGNATURE_INK
                  context.lineWidth = 3
                  context.lineCap = 'round'
                  context.lineJoin = 'round'
                  context.beginPath()
                  context.moveTo(last.x, last.y)
                  context.lineTo(next.x, next.y)
                  context.stroke()
                  drawingRef.current = next
                  if (!drawn) setDrawn(true)
                  setImage(null)
                }}
                onPointerUp={() => (drawingRef.current = null)}
                onPointerLeave={() => (drawingRef.current = null)}
              />
              <button type="button" className="link-button adopt-clear" onClick={clearPad}>
                <Eraser size={13} /> {t('common.clear')}
              </button>
            </div>
          )}
          {style === 'upload' && (
            <div className="adopt-upload">
              {uploadPreview ? (
                <img className="signature-preview" src={uploadPreview} alt={t('signature.previewAlt')} />
              ) : (
                <div className="signature-drop">
                  <ImageIcon size={24} />
                  <span>{t('signature.uploadHint')}</span>
                </div>
              )}
              <div className="modal-row">
                <button type="button" className="button" onClick={() => uploadRef.current?.click()}>
                  <Upload size={15} /> {uploadPreview ? t('signature.replace') : t('signature.chooseImage')}
                </button>
                {uploadSrc && (
                  <label className="check">
                    <input type="checkbox" checked={removeWhite} onChange={(event) => setRemoveWhite(event.target.checked)} />
                    {t('signature.removeWhite')}
                  </label>
                )}
              </div>
              <input
                ref={uploadRef}
                type="file"
                className="adopt-upload-input"
                accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
                hidden
                onChange={(event) => {
                  const picked = event.target.files?.[0]
                  event.target.value = ''
                  if (!picked) return
                  const reader = new FileReader()
                  reader.onload = () => {
                    setUploadSrc(String(reader.result))
                    setImage(null)
                  }
                  reader.onerror = () => setError(t('signature.readFailed'))
                  reader.readAsDataURL(picked)
                }}
              />
            </div>
          )}
        </div>


        <p className="adopt-legal">
          <ShieldCheck size={13} /> {chosen ? t('sign.legalKnown') : method === 'email' ? t('sign.legalEmail') : t('sign.legalFile')}
        </p>

        {error && (
          <p className="cert-error" role="alert">
            <AlertTriangle size={14} /> {error}
          </p>
        )}

        <div className="modal-row">
          {!chosen && (
            <button
              type="button"
              className="link-button adopt-method"
              onClick={() => {
                setError(null)
                if (method === 'email') {
                  setMethod('file')
                  if (!file) fileRef.current?.click()
                } else {
                  setMethod('email')
                  setFile(null)
                }
              }}
            >
              {method === 'email' ? t('sign.useCertificateFile') : t('sign.useEmailInstead')}
            </button>
          )}
          <div className="modal-spacer" />
          <button type="button" className="button" onClick={close}>
            {t('common.cancel')}
          </button>
          <button type="button" className="button button-primary adopt-submit" disabled={busy || !canSubmit} onClick={() => void submit()}>
            {busy ? <Loader2 size={15} className="spin" /> : chosen || method === 'file' ? <PenLine size={15} /> : <Mail size={15} />}{' '}
            {chosen || method === 'file' ? t('sign.adoptAndSign') : t('sign.continue')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Last look before signing: who signs, where, and the less common options. */
function ReviewModal() {
  const { t } = useTranslation()
  const signer = useStore((state) => state.signer)
  const spots = useStore((state) => state.signSpots)
  const [context, setContext] = useState<SigningContext | null>(null)
  const [reason, setReason] = useState('')
  const [location, setLocation] = useState('')
  const [certify, setCertify] = useState(false)
  const [signing, setSigning] = useState(false)

  useEffect(() => {
    void signingContext()
      .then(setContext)
      .catch(() => setContext(null))
  }, [])

  if (!signer) return null
  const info = signer.identity.info
  const now = Date.now()
  const formatDate = (date: Date) => date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  const pages = Array.from(new Set(spots.map((spot) => spot.pageIndex + 1))).sort((a, b) => a - b)
  const alreadySigned = Boolean(context && context.summary.signed > 0)
  const certifyBlocked = alreadySigned || spots.length > 1
  const back = () => useStore.getState().setSignStep('place')

  const sign = async () => {
    if (signing) return
    setSigning(true)
    try {
      await signPlacedSpots({ reason: reason.trim(), location: location.trim(), certify: certify && !certifyBlocked })
    } catch {
      // The controller already reported the error; stay on this step.
      setSigning(false)
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="review-title">
      <div className="modal sign-review">
        <div className="modal-head">
          <h2 id="review-title">{t('sign.reviewTitle')}</h2>
          <button type="button" className="icon-button" onClick={back} title={t('common.close')}>
            <X size={17} />
          </button>
        </div>
        <div className="sign-review-card">
          <img src={signer.image} alt="" />
          <div>
            <strong className="cert-name">{info.name}</strong>
            <span>{info.email ?? t('digitalSign.issuedBy', { issuer: info.issuer })}</span>
            <span>{t('sign.reviewWhere', { count: spots.length, pages: pages.join(', ') })}</span>
          </div>
        </div>
        {info.notAfter && info.notAfter.getTime() < now && (
          <p className="cert-warning">{t('digitalSign.expired', { date: formatDate(info.notAfter) })}</p>
        )}
        {info.notBefore && info.notBefore.getTime() > now && (
          <p className="cert-warning">{t('digitalSign.notYetValid', { date: formatDate(info.notBefore) })}</p>
        )}
        {info.selfSigned && <p className="cert-note">{t('digitalSign.selfSigned')}</p>}
        {alreadySigned && context && !context.direct && <p className="cert-warning">{t('digitalSign.editsBreakSignatures')}</p>}
        <p className="sign-review-note">{t('sign.reviewNote')}</p>

        <details className="sign-more">
          <summary>{t('sign.moreOptions')}</summary>
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
          </div>
          <label className="check">
            <input
              type="checkbox"
              name="signature-certify"
              checked={certify && !certifyBlocked}
              disabled={certifyBlocked}
              onChange={(event) => setCertify(event.target.checked)}
            />
            {alreadySigned ? t('digitalSign.certifyUnavailable') : spots.length > 1 ? t('sign.certifyOneSpot') : t('digitalSign.certify')}
          </label>
        </details>

        <div className="modal-row">
          <button type="button" className="button button-ghost sign-review-back" onClick={back}>
            {t('common.back')}
          </button>
          <div className="modal-spacer" />
          <button type="button" className="button button-primary sign-submit" disabled={signing} onClick={() => void sign()}>
            {signing ? <Loader2 size={16} className="spin" /> : <PenLine size={16} />} {t('sign.signNow')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Signed: download it, ask others to sign, or keep working. */
function DoneModal() {
  const { t } = useTranslation()
  const inRequest = useStore((state) => Boolean(state.signRequest))
  const result = signedResult()
  const close = () => useStore.getState().setSignFlow(null)
  let followUp: string | null = null
  if (result?.returned) followUp = result.returnedTo ? t('sign.doneReturnedTo', { name: result.returnedTo }) : t('sign.doneReturned')
  else if (inRequest) followUp = t('sign.doneNotReturned')

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="done-title">
      <div className="modal sign-done">
        <CheckCircle2 size={40} className="sign-done-icon" />
        <h2 id="done-title">{t('sign.doneTitle')}</h2>
        <p>{t('sign.doneBody', { name: result?.name ?? '' })}</p>
        {followUp && <p className={result?.returned ? 'sign-done-returned' : 'cert-warning'}>{followUp}</p>}
        <div className="modal-row sign-done-actions">
          <button type="button" className="button button-ghost sign-done-close" onClick={close}>
            {t('common.close')}
          </button>
          {!inRequest && (
            <button
              type="button"
              className="button sign-done-request"
              onClick={() => {
                close()
                void startSigning('request')
              }}
            >
              <Send size={15} /> {t('sign.request')}
            </button>
          )}
          <button type="button" className="button button-primary sign-download" onClick={downloadSignedCopy}>
            <Download size={15} /> {t('sign.download')}
          </button>
        </div>
      </div>
    </div>
  )
}
