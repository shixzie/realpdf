import { useStore } from '../store'
import { t } from '../i18n'
import { loadPdfDocument } from './pdfjs'
import { pdfHasFormFields } from './forms'

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
