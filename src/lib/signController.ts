import { useStore } from '../store'
import { t } from '../i18n'
import { bakedCurrentBytes } from './currentDocument'
import { downloadBlob } from './exportController'
import { makeInverse } from './export'
import type { SigningIdentity } from './signing/identity'
import type { SignatureLine, SignaturePlacement, SignatureSummary } from './signing/pdfSign'

/**
 * Glue between the certificate-signing dialog and the signer. node-forge and
 * the signer are loaded on demand, so the editor does not pay for them until
 * someone opens the dialog.
 */

export const loadSigning = () => import('./signing')

/** True when nothing was changed since the document was opened. */
export function documentIsUnchanged(): boolean {
  const state = useStore.getState()
  if (!state.pdf || state.pages.length !== state.pdf.numPages) return false
  if (Object.keys(state.formValues).length > 0) return false
  return state.pages.every((page, index) => page.sourceIndex === index && page.annotations.objects.length === 0)
}

export interface SigningContext {
  /** Sign the file as opened (keeps earlier signatures valid) rather than an edited copy. */
  direct: boolean
  /** Signatures and signature fields of the file as opened. */
  summary: SignatureSummary
}

export async function signingContext(): Promise<SigningContext> {
  const state = useStore.getState()
  await state.flushAll()
  const { readSignatureSummary } = await loadSigning()
  const summary = state.bytes
    ? await readSignatureSummary(state.bytes)
    : { signed: 0, empty: [], certified: false, encrypted: false }
  return { direct: documentIsUnchanged() && !summary.encrypted, summary }
}

export type PlacementChoice =
  | { kind: 'box'; pageIndex: number; x: number; y: number; width: number; height: number }
  | { kind: 'field'; name: string }
  | { kind: 'invisible' }

export interface SignRequest {
  identity: SigningIdentity
  placement: PlacementChoice
  reason: string
  location: string
  certify: boolean
}

function pad(value: number): string {
  return String(Math.floor(Math.abs(value))).padStart(2, '0')
}

/** `2026-09-28 18:40:12 +02:00`, in local time. */
export function formatSigningDate(date: Date): string {
  const offset = -date.getTimezoneOffset()
  const zone = `${offset >= 0 ? '+' : '-'}${pad(offset / 60)}:${pad(offset % 60)}`
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${zone}`
  )
}

function appearanceLines(request: SignRequest, date: Date): SignatureLine[] {
  const lines: SignatureLine[] = [
    { text: t('digitalSign.appearance.signedBy'), scale: 0.8 },
    { text: request.identity.info.name, bold: true, scale: 1.35 },
    { text: t('digitalSign.appearance.date', { date: formatSigningDate(date) }), scale: 0.8 },
  ]
  if (request.reason) lines.push({ text: t('digitalSign.appearance.reason', { reason: request.reason }), scale: 0.8 })
  if (request.location) lines.push({ text: t('digitalSign.appearance.location', { location: request.location }), scale: 0.8 })
  return lines
}

/** Converts a box drawn on the page (view space) to a PDF user-space rectangle. */
function userSpaceRect(pageIndex: number, box: { x: number; y: number; width: number; height: number }) {
  const page = useStore.getState().pages[pageIndex]
  const inverse = makeInverse(page.transform)
  const corners = [
    inverse.point(box.x, box.y),
    inverse.point(box.x + box.width, box.y),
    inverse.point(box.x, box.y + box.height),
    inverse.point(box.x + box.width, box.y + box.height),
  ]
  const xs = corners.map((corner) => corner.x)
  const ys = corners.map((corner) => corner.y)
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as [number, number, number, number]
}

/**
 * Signs the current document and downloads it. An unchanged, unencrypted file
 * is signed as-is (an incremental update, so earlier signatures survive);
 * otherwise the edited document is baked first and the signature covers that.
 */
export async function signCurrentDocument(request: SignRequest): Promise<void> {
  const state = useStore.getState()
  if (!state.bytes) return
  state.setExporting(true, 0)
  try {
    const context = await signingContext()
    const { signPdf } = await loadSigning()
    const bytes = context.direct ? (useStore.getState().bytes as Uint8Array) : await bakedCurrentBytes()
    useStore.getState().setExporting(true, 0.6)
    const date = new Date()
    const choice = request.placement
    const placement: SignaturePlacement =
      choice.kind === 'box'
        ? { kind: 'box', pageIndex: choice.pageIndex, rect: userSpaceRect(choice.pageIndex, choice) }
        : choice
    const signed = await signPdf(bytes, {
      identity: request.identity,
      placement,
      lines: appearanceLines(request, date),
      reason: request.reason || undefined,
      location: request.location || undefined,
      certify: request.certify,
      date,
    })
    const base = (useStore.getState().fileName ?? 'document.pdf').replace(/\.pdf$/i, '')
    downloadBlob(new Blob([new Uint8Array(signed)], { type: 'application/pdf' }), `${base}-signed.pdf`)
    useStore.getState().setExporting(false)
    useStore.getState().toastMessage('success', t('digitalSign.signed', { name: request.identity.info.name }))
  } catch (error) {
    console.error(error)
    useStore.getState().setExporting(false)
    const code = (error as { code?: string })?.code
    const known = code && ['encrypted', 'alreadyCertified', 'noField', 'tooLarge'].includes(code)
    const message = known ? t(`digitalSign.errors.${code}`) : ((error as Error)?.message ?? t('toasts.unknownError'))
    useStore.getState().toastMessage('error', t('digitalSign.failed', { message }))
    throw error
  }
}
