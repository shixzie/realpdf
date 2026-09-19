import { useStore } from '../store'
import { t } from '../i18n'
import { loadPdfDocument } from './pdfjs'
import { pdfHasFormFields } from './forms'
import { isOfficeFileName, officeToPdf } from './officeToPdf'

async function loadIntoEditor(bytes: Uint8Array, fileName: string): Promise<void> {
  const loaded = await loadPdfDocument(bytes, (submit, wrong) => {
    const password = window.prompt(
      wrong ? t('toasts.incorrectPassword') : t('toasts.passwordProtected'),
    )
    submit(password ?? '')
  })
  useStore.getState().load({ bytes, fileName, pdf: loaded.pdf, pages: loaded.pages })
  useStore.getState().toastMessage('success', t('toasts.loaded', { fileName }))

  // Actions chosen on the home screen before a file existed.
  const pending = useStore.getState().pendingAction
  useStore.getState().setPendingAction(null)

  if (pending === 'forms') {
    const hasForms = await pdfHasFormFields(bytes)
    useStore.getState().setHasForms(hasForms)
    if (hasForms) {
      useStore.getState().setTool('select')
      await useStore.getState().enterFormMode()
    } else {
      useStore.getState().toastMessage('info', t('toasts.noFormFields'))
    }
    return
  }

  if (pending) {
    useStore.getState().setToolsOpen(true, pending)
    return
  }

  void pdfHasFormFields(bytes)
    .then((hasForms) => {
      if (useStore.getState().fileName === fileName) useStore.getState().setHasForms(hasForms)
    })
    .catch(() => undefined)
}

export async function openPdfFile(file: File): Promise<void> {
  const store = useStore.getState()
  store.setLoading(true)
  store.setError(null)
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    await loadIntoEditor(bytes, file.name)
  } catch (error) {
    console.error(error)
    const message = (error as Error)?.message
    useStore.getState().setError(message || t('toasts.openFailedGeneric'))
    useStore
      .getState()
      .toastMessage('error', message ? t('toasts.openFailed', { message }) : t('toasts.openFailedGeneric'))
  } finally {
    useStore.getState().setLoading(false)
  }
}

function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
}

export function isSupportedFileName(name: string): boolean {
  return /\.pdf$/i.test(name) || isOfficeFileName(name)
}

/** Opens whatever the app supports: a PDF directly, Office files converted to PDF. */
export async function openDocumentFile(file: File): Promise<void> {
  if (isPdfFile(file)) return openPdfFile(file)
  if (!isOfficeFileName(file.name)) {
    useStore.getState().toastMessage('error', t('toasts.unsupportedFile'))
    return
  }
  const store = useStore.getState()
  store.setLoading(true)
  store.setError(null)
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const converted = await officeToPdf(bytes, file.name)
    const pdfName = `${file.name.replace(/\.[^.]+$/, '')}.pdf`
    await loadIntoEditor(converted, pdfName)
  } catch (error) {
    console.error(error)
    const message = (error as Error)?.message
    const fallback = t('toasts.officeOpenFailedGeneric')
    useStore.getState().setError(message || fallback)
    useStore
      .getState()
      .toastMessage('error', message ? t('toasts.officeOpenFailed', { message }) : fallback)
  } finally {
    useStore.getState().setLoading(false)
  }
}

/** Opens raw PDF bytes (used by merge/split/convert tools). */
export async function openPdfBytes(bytes: Uint8Array, fileName: string): Promise<void> {
  const store = useStore.getState()
  store.setLoading(true)
  store.setError(null)
  try {
    await loadIntoEditor(bytes, fileName)
  } catch (error) {
    console.error(error)
    const message = (error as Error)?.message
    useStore
      .getState()
      .toastMessage(
        'error',
        message
          ? t('toasts.generatedOpenFailed', { message })
          : t('toasts.generatedOpenFailedGeneric'),
      )
    throw error
  } finally {
    useStore.getState().setLoading(false)
  }
}
