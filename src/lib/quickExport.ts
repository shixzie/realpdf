import { useStore } from '../store'
import { t } from '../i18n'
import { downloadBlob } from './exportController'
import { bakedCurrentBytes } from './currentDocument'
import { openPdfDocumentFromBytes } from './pdfjs'
import { pdfToText, renderPdfPageToBlob, renderPdfToImages, type ImageFormat } from './pdfOps'
import { pdfToDocx, pdfToPptx, pdfToXlsx } from './pdfToOffice'
import { createZip } from './zip'

export type ExportFormatId = 'png' | 'jpg' | 'txt' | 'docx' | 'xlsx' | 'pptx'
export type ExportScope = 'current' | 'all'

const OFFICE_MIME: Record<'docx' | 'xlsx' | 'pptx', string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export interface QuickExportOptions {
  /** Images only: export just the visible page or every page as a ZIP. */
  scope?: ExportScope
  /** Images only: render scale (1 = 72 dpi, 2 = 144 dpi, 3 = 216 dpi). */
  scale?: number
  /** Images only: download this page instead of the visible one. */
  pageId?: string
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

async function exportImages(
  format: ImageFormat,
  scope: ExportScope,
  scale: number,
  pageId?: string,
): Promise<void> {
  const state = useStore.getState()
  const base = stripExtension(state.fileName ?? 'document.pdf')
  const index = state.pages.findIndex((page) => page.id === (pageId ?? state.currentPageId))
  const currentIndex = index < 0 ? 0 : index
  const scratch = await openPdfDocumentFromBytes(await bakedCurrentBytes())
  try {
    if (scope === 'all') {
      const rendered = await renderPdfToImages(
        scratch,
        Array.from({ length: scratch.numPages }, (_, index) => index),
        scale,
        format,
      )
      const zip = await createZip(rendered.map((page) => ({ name: page.name, data: page.blob })))
      downloadBlob(zip, `${base}-images.zip`)
    } else {
      const blob = await renderPdfPageToBlob(scratch, currentIndex, scale, format)
      downloadBlob(blob, `${base}-page-${currentIndex + 1}.${format === 'jpeg' ? 'jpg' : 'png'}`)
    }
  } finally {
    void scratch.loadingTask.destroy()
  }
}

/**
 * Exports the current document (edits baked in) to a download-only format.
 * PDF is handled by `runExport`, which also updates the browser library.
 */
export async function quickExport(
  format: ExportFormatId,
  options: QuickExportOptions = {},
): Promise<void> {
  const state = useStore.getState()
  if (!state.bytes || !state.pages.length) return
  const base = stripExtension(state.fileName ?? 'document.pdf')
  const scope = options.scope ?? 'current'
  const scale = options.scale ?? 2
  try {
    if (format === 'txt') {
      const scratch = await openPdfDocumentFromBytes(await bakedCurrentBytes())
      try {
        const content = await pdfToText(scratch)
        downloadBlob(new Blob([content], { type: 'text/plain' }), `${base}.txt`)
      } finally {
        void scratch.loadingTask.destroy()
      }
    } else if (format === 'docx' || format === 'xlsx' || format === 'pptx') {
      const scratch = await openPdfDocumentFromBytes(await bakedCurrentBytes())
      try {
        const bytes =
          format === 'docx'
            ? await pdfToDocx(scratch)
            : format === 'xlsx'
              ? await pdfToXlsx(scratch)
              : await pdfToPptx(scratch)
        downloadBlob(new Blob([bytes as BlobPart], { type: OFFICE_MIME[format] }), `${base}.${format}`)
      } finally {
        void scratch.loadingTask.destroy()
      }
    } else {
      await exportImages(format === 'jpg' ? 'jpeg' : 'png', scope, scale, options.pageId)
    }
    useStore.getState().toastMessage('success', t('export.downloaded'))
  } catch (error) {
    console.error(error)
    const message = (error as Error)?.message ?? t('toasts.unknownError')
    useStore.getState().toastMessage('error', t('toasts.exportFailed', { message }))
  }
}
