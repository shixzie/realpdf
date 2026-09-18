import { useStore } from '../store'
import { loadPdfDocument } from './pdfjs'
import { pdfHasFormFields } from './forms'

async function loadIntoEditor(bytes: Uint8Array, fileName: string): Promise<void> {
  const loaded = await loadPdfDocument(bytes, (submit, wrong) => {
    const password = window.prompt(
      wrong ? 'Incorrect password. Try again:' : 'This PDF is password protected. Enter the password:',
    )
    submit(password ?? '')
  })
  useStore.getState().load({ bytes, fileName, pdf: loaded.pdf, pages: loaded.pages })
  useStore.getState().toastMessage('success', `Loaded ${fileName}`)

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
      useStore.getState().toastMessage('info', 'This PDF has no fillable form fields.')
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
    const message = (error as Error)?.message || 'Could not open this PDF.'
    useStore.getState().setError(message)
    useStore.getState().toastMessage('error', `Could not open this PDF: ${message}`)
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
    const message = (error as Error)?.message || 'Could not open the generated PDF.'
    useStore.getState().toastMessage('error', `Could not open the generated PDF: ${message}`)
    throw error
  } finally {
    useStore.getState().setLoading(false)
  }
}
