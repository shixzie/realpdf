import { useStore, type ActiveSignRequest } from '../store'
import { t } from '../i18n'
import { bakedCurrentBytes } from './currentDocument'
import { openPdfBytes, replaceDocumentBytes } from './openDocument'
import { documentIsUnchanged, loadSigning, userSpaceRect } from './signController'
import {
  addSignedVersion,
  createRequest,
  isMyRequest,
  openRequest,
  RequestError,
  type MyRequest,
} from './signRequests'

/** Glue between signing requests (src/lib/signRequests.ts) and the editor. */

export function requestErrorMessage(error: unknown): string {
  const code = error instanceof RequestError ? error.code : 'network'
  return t(`signRequest.errors.${code}`)
}

/** Opens the document behind a `/sign/<id>#<key>` link in the editor. */
export async function openRequestFromLink(id: string, key: string): Promise<void> {
  const store = useStore.getState()
  store.setLoading(true)
  try {
    const opened = await openRequest(id, key)
    await openPdfBytes(opened.bytes, opened.header.fileName)
    useStore.getState().setSignRequest({
      id,
      key,
      header: opened.header,
      versions: opened.status.versions.length,
      expiresAt: opened.status.expiresAt,
      owner: isMyRequest(id),
      signedHere: false,
    })
  } catch (error) {
    console.error(error)
    useStore.getState().setError(requestErrorMessage(error))
    useStore.getState().toastMessage('error', requestErrorMessage(error))
    window.history.replaceState(null, '', '/')
  } finally {
    useStore.getState().setLoading(false)
  }
}

/**
 * Encrypts the current document, with an empty signature field for every
 * placed "sign here" spot, and uploads it as a new request. An unchanged file
 * is sent as-is (the fields are an incremental update) so any signatures it
 * already has stay valid.
 */
export async function createRequestForCurrentDocument(args: {
  from: string
  message: string
}): Promise<MyRequest & { link: string }> {
  const state = useStore.getState()
  await state.flushAll()
  let bytes = documentIsUnchanged() && state.bytes ? state.bytes : await bakedCurrentBytes()
  const { signSpots, requestDraft } = useStore.getState()
  if (signSpots.length) {
    const { addSignatureFields } = await loadSigning()
    const names = new Map(requestDraft.signers.map((signer) => [signer.id, signer.name.trim()]))
    bytes = await addSignatureFields(
      bytes,
      signSpots.map((spot) => ({
        pageIndex: spot.pageIndex,
        rect: userSpaceRect(spot.pageIndex, spot),
        label: (spot.signer && names.get(spot.signer)) || undefined,
      })),
    )
  }
  const fileName = state.fileName ?? 'document.pdf'
  return createRequest({ bytes, fileName, from: args.from, message: args.message })
}

/** Creates the request from the Sign flow and shows its link. */
export async function sendForSignatures(): Promise<void> {
  const state = useStore.getState()
  if (!state.bytes) return
  const { from, message } = state.requestDraft
  state.setExporting(true, 0.3)
  try {
    const created = await createRequestForCurrentDocument({ from: from.trim(), message: message.trim() })
    const current = useStore.getState()
    current.updateRequestDraft({ created })
    current.setSignStep('sent')
  } catch (error) {
    console.error(error)
    useStore.getState().toastMessage('error', requestErrorMessage(error))
  } finally {
    useStore.getState().setExporting(false)
  }
}

/**
 * Sends a signed copy back to the request it came from, then shows that
 * copy in the editor so the next person signs on top of it.
 */
export async function returnSignedCopy(request: ActiveSignRequest, signed: Uint8Array, signer: string): Promise<boolean> {
  try {
    const { header, status } = await addSignedVersion(request, signed, signer)
    await replaceDocumentBytes(new Uint8Array(signed), header.fileName)
    useStore.getState().setSignRequest({
      ...request,
      header,
      versions: status.versions.length,
      signedHere: true,
    })
    return true
  } catch (error) {
    console.error(error)
    useStore.getState().toastMessage('error', t('signRequest.sendBackFailed', { message: requestErrorMessage(error) }))
    return false
  }
}
