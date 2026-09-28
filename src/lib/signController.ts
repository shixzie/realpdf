import { emptyRequestDraft, useStore, type ActiveSigner, type SignSpot } from '../store'
import { t } from '../i18n'
import { bakedCurrentBytes } from './currentDocument'
import { downloadBlob } from './exportController'
import { makeInverse } from './export'
import { replaceDocumentBytes } from './openDocument'
import { returnSignedCopy } from './signRequestController'
import { dataUrlBytes, forgetSignatureImage, saveSignatureImage, savedSignatureImage } from './signatureImage'
import type { SignatureLine, SignaturePlacement, SignatureSummary } from './signing/pdfSign'

/**
 * Glue between the Sign flow (top bar Sign menu, adopt / place / review /
 * done) and the signer. node-forge and the signer are loaded on demand, so
 * the editor does not pay for them until someone starts signing.
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

interface SignDetails {
  reason: string
  location: string
  certify: boolean
}

/** The text beside the handwritten signature. */
function appearanceLines(name: string, details: SignDetails, date: Date): SignatureLine[] {
  const lines: SignatureLine[] = [
    { text: t('digitalSign.appearance.signedBy'), scale: 0.8 },
    { text: name, bold: true, scale: 1.05 },
    { text: t('digitalSign.appearance.date', { date: formatSigningDate(date) }), scale: 0.8 },
  ]
  if (details.reason) lines.push({ text: t('digitalSign.appearance.reason', { reason: details.reason }), scale: 0.8 })
  if (details.location) lines.push({ text: t('digitalSign.appearance.location', { location: details.location }), scale: 0.8 })
  return lines
}

type Rect = [number, number, number, number]

/** Converts a box on the page (view space) to a PDF user-space rectangle. */
export function userSpaceRect(pageIndex: number, box: { x: number; y: number; width: number; height: number }): Rect {
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
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

/** Converts a PDF user-space rectangle to a box on the page (view space). */
export function viewRect(pageIndex: number, rect: Rect): { x: number; y: number; width: number; height: number } {
  const page = useStore.getState().pages[pageIndex]
  const [a, b, c, d, e, f] = page.transform
  const corners = [
    [rect[0], rect[1]],
    [rect[2], rect[1]],
    [rect[0], rect[3]],
    [rect[2], rect[3]],
  ].map(([x, y]) => ({ x: a * x + c * y + e, y: b * x + d * y + f }))
  const xs = corners.map((corner) => corner.x)
  const ys = corners.map((corner) => corner.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

/** The most recent signing ID saved on this device, with the signature adopted for it. */
async function restoreSavedSigner(): Promise<ActiveSigner | null> {
  try {
    const { getSavedIdentity, listSavedIdentities } = await loadSigning()
    for (const saved of await listSavedIdentities()) {
      const image = savedSignatureImage(saved.id)
      if (!image) continue
      const identity = await getSavedIdentity(saved.id)
      if (identity) return { identity, savedId: saved.id, image }
    }
  } catch (error) {
    console.error(error)
  }
  return null
}

let starting = false

/**
 * Starts the Sign flow. Signing yourself goes straight to placing the
 * signature when this device already has one; otherwise it starts by
 * adopting a signature. Requesting signatures starts with the signers.
 */
export async function startSigning(mode: 'self' | 'request'): Promise<void> {
  const state = useStore.getState()
  if (!state.bytes || state.signFlow || starting) return
  starting = true
  try {
    state.setTool('select')
    if (state.formMode) state.exitFormMode()
    if (mode === 'request') {
      const draft = emptyRequestDraft()
      try {
        const { listSavedIdentities } = await loadSigning()
        draft.from = (await listSavedIdentities())[0]?.info.name ?? ''
      } catch {
        // No saved signing ID to prefill the sender's name from.
      }
      useStore.getState().updateRequestDraft({ ...draft, activeSigner: draft.signers[0].id })
      useStore.getState().setSignFlow({ mode: 'request', step: 'signers' })
      return
    }
    // Returning signers skip the adopt step (checked first, so it does not flash).
    const signer = await restoreSavedSigner()
    if (signer) {
      useStore.getState().setSignFlow({ mode: 'self', step: 'place' })
      await adoptSigner(signer)
      return
    }
    // With "Sign here" fields, show them first and adopt a signature at the
    // first one, as DocuSign does. Without, adopt first, then place it.
    const fields = await emptyFields()
    if (fields.length) {
      useStore.getState().setSignFlow({ mode: 'self', step: 'place' })
      await enterPlacing(fields)
    } else {
      useStore.getState().setSignFlow({ mode: 'self', step: 'adopt' })
    }
  } finally {
    starting = false
  }
}

/** Uses `signer` from now on (remembering the signature on this device) and moves on to placing it. */
export async function adoptSigner(signer: ActiveSigner): Promise<void> {
  if (signer.savedId) saveSignatureImage(signer.savedId, signer.image)
  useStore.getState().setSigner(signer)
  await enterPlacing()
}

export async function forgetSavedSigner(id: string): Promise<void> {
  const { forgetIdentity } = await loadSigning()
  await forgetIdentity(id)
  forgetSignatureImage(id)
}

type EmptyFields = SigningContext['summary']['empty']

/** The document's empty signature fields, when they can be filled (only in the file as opened). */
async function emptyFields(): Promise<EmptyFields> {
  try {
    const context = await signingContext()
    return context.direct ? context.summary.empty : []
  } catch (error) {
    console.error(error)
    return []
  }
}

/** Shows the page overlay where signatures (or signers' fields) are placed. */
export async function enterPlacing(known?: EmptyFields): Promise<void> {
  const flow = useStore.getState().signFlow
  if (!flow) return
  const fields = known ?? (await emptyFields())
  const state = useStore.getState()
  state.setSignFields(fields)
  state.setSignStep('place')
  lastField = null
  if (flow.mode === 'self' && openFields().length) goToNextField()
}

/**
 * Puts a signature in a box or a "Sign here" field. Without a signature yet,
 * the adopt step opens and the signature lands there once adopted. After a
 * field, the view moves on to the next open one.
 */
export function placeSignature(spot: Omit<SignSpot, 'id'>): void {
  const state = useStore.getState()
  state.addSignSpot(spot)
  if (!state.signer) {
    state.setSignStep('adopt')
    return
  }
  if (spot.field) {
    lastField = spot.field
    goToNextField()
  }
}

/** The open field the guide points at: the first one in page order. */
export function nextOpenField() {
  return sortedOpenFields()[0] ?? null
}

/** Empty fields not yet covered by a placed signature. */
export function openFields() {
  const { signFields, signSpots } = useStore.getState()
  return signFields.filter((field) => !signSpots.some((spot) => spot.field === field.name))
}

let lastField: string | null = null

function sortedOpenFields() {
  return openFields().sort((a, b) => a.pageIndex - b.pageIndex || b.rect[3] - a.rect[3])
}

/** Scrolls to the next "Sign here" field, in page order, starting over after the last one. */
export function goToNextField(): void {
  const state = useStore.getState()
  const fields = sortedOpenFields()
  if (!fields.length) return
  const previous = fields.findIndex((field) => field.name === lastField)
  const next = fields[(previous + 1) % fields.length]
  lastField = next.name
  const page = state.pages[next.pageIndex]
  if (!page) return
  state.setCurrentPage(page.id)
  state.requestScrollTo(page.id)
  centerField(next.name)
}

/** Once its page is on screen, brings the field's tag (and the flag beside it) to the middle of the view. */
function centerField(name: string, frames = 30): void {
  requestAnimationFrame(() => {
    const tag = document.querySelector(`.sign-tag[data-field="${CSS.escape(name)}"]`)
    if (tag) tag.scrollIntoView({ block: 'center' })
    else if (frames > 0) centerField(name, frames - 1)
  })
}

export interface SignedResult {
  bytes: Uint8Array
  fileName: string
  name: string
  /** Who the signed copy was sent back to (a signing request), if anyone. */
  returnedTo: string | null
  returned: boolean
}

let lastSigned: SignedResult | null = null

/** The document signed most recently, for the done step. */
export function signedResult(): SignedResult | null {
  return lastSigned
}

export function signedFileName(fileName: string): string {
  const base = fileName.replace(/\.pdf$/i, '')
  return `${base.endsWith('-signed') ? base : `${base}-signed`}.pdf`
}

export function downloadSignedCopy(): void {
  if (!lastSigned) return
  downloadBlob(new Blob([new Uint8Array(lastSigned.bytes)], { type: 'application/pdf' }), signedFileName(lastSigned.fileName))
}

/**
 * Signs every placed spot, one signature each, then shows the signed file.
 * An unchanged, unencrypted file is signed as-is (incremental updates, so
 * earlier signatures survive); otherwise the edited document is baked first
 * and the signatures cover that. From a signing link, the signed copy goes
 * back to the request.
 */
export async function signPlacedSpots(details: SignDetails): Promise<void> {
  const state = useStore.getState()
  const signer = state.signer
  const spots = state.signSpots
  if (!state.bytes || !signer || !spots.length) return
  state.setExporting(true, 0)
  try {
    const context = await signingContext()
    const { signPdf } = await loadSigning()
    let bytes = context.direct ? (useStore.getState().bytes as Uint8Array) : await bakedCurrentBytes()
    const image = dataUrlBytes(signer.image)
    const date = new Date()
    const lines = appearanceLines(signer.identity.info.name, details, date)
    for (const [index, spot] of spots.entries()) {
      useStore.getState().setExporting(true, 0.2 + (0.6 * index) / spots.length)
      const placement: SignaturePlacement = spot.field
        ? { kind: 'field', name: spot.field }
        : { kind: 'box', pageIndex: spot.pageIndex, rect: userSpaceRect(spot.pageIndex, spot) }
      bytes = await signPdf(bytes, {
        identity: signer.identity,
        placement,
        lines,
        image,
        reason: details.reason || undefined,
        location: details.location || undefined,
        certify: details.certify && index === 0,
        date,
      })
    }
    const fileName = useStore.getState().fileName ?? 'document.pdf'
    const name = signer.identity.info.name
    const request = useStore.getState().signRequest
    useStore.getState().setExporting(true, 0.9)
    if (request) {
      const returned = await returnSignedCopy(request, bytes, name)
      lastSigned = { bytes, fileName: request.header.fileName, name, returnedTo: request.owner ? null : request.header.from || null, returned }
    } else {
      await replaceDocumentBytes(new Uint8Array(bytes), fileName)
      lastSigned = { bytes, fileName, name, returnedTo: null, returned: false }
    }
    useStore.getState().setExporting(false)
    // Opening the signed file reset the flow; show the done step on top of it.
    useStore.getState().setSignFlow({ mode: 'self', step: 'done' })
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
