import { useStore } from '../store'
import { t } from '../i18n'
import { buildPdf, type ExportPageInput } from './export'
import { hydrateAnnotations } from './serialize'
import { applyFormValues } from './forms'

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export async function runExport(): Promise<void> {
  const initial = useStore.getState()
  if (!initial.bytes || !initial.pages.length) return
  useStore.getState().setExporting(true, 0)
  try {
    await initial.flushAll()
    const state = useStore.getState()
    let sourceBytes = state.bytes as Uint8Array
    // Fill interactive form fields first so annotations land on top of them.
    if (state.hasForms && Object.keys(state.formValues).length > 0) {
      try {
        const filled = await applyFormValues(sourceBytes, state.formValues, { flatten: state.formFlatten })
        sourceBytes = filled.bytes
        if (filled.errors.length) {
          useStore
            .getState()
            .toastMessage('info', t('toasts.formsPartial', { error: filled.errors[0] }))
        }
      } catch (error) {
        console.error(error)
        useStore.getState().toastMessage('error', t('toasts.formsApplyFailed'))
      }
    }
    const pages: ExportPageInput[] = state.pages.map((page) => ({
      sourceIndex: page.sourceIndex,
      width: page.width,
      height: page.height,
      transform: page.transform,
      objects: hydrateAnnotations(page.annotations).objects,
    }))
    const bytes = await buildPdf(sourceBytes, pages, {
      onProgress: (done, total) => useStore.getState().setExporting(true, done / Math.max(1, total)),
    })
    const base = (state.fileName ?? 'document.pdf').replace(/\.pdf$/i, '')
    const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' })
    downloadBlob(blob, `${base}-edited.pdf`)
    // Keep a local copy (with its editable state) in the browser library.
    await useStore.getState().saveToLibrary(bytes)
    useStore.getState().setExporting(false)
    useStore.getState().toastMessage('success', t('toasts.exported'))
  } catch (error) {
    console.error(error)
    useStore.getState().setExporting(false)
    const message = (error as Error)?.message ?? t('toasts.unknownError')
    useStore.getState().toastMessage('error', t('toasts.exportFailed', { message }))
  }
}
