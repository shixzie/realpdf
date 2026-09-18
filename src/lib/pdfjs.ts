import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentProxy, PDFWorker } from 'pdfjs-dist'
import type { PageSourceInfo } from '../types'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/**
 * pdf.js decodes JBIG2 / JPEG2000 streams with WebAssembly, needs the
 * predefined CMaps for CJK documents, standard font data for PDFs that rely on
 * non-embedded base-14 fonts, and ICC profiles for color-managed images.
 * All of these are served from our own origin.
 */
const ASSET_BASE = new URL(`${import.meta.env.BASE_URL}pdfjs-assets/`, window.location.href).href

export interface LoadedDocument {
  pdf: PDFDocumentProxy
  pages: PageSourceInfo[]
}

function documentOptions(bytes: Uint8Array) {
  return {
    data: bytes.slice(),
    cMapUrl: `${ASSET_BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${ASSET_BASE}standard_fonts/`,
    wasmUrl: `${ASSET_BASE}wasm/`,
    iccUrl: `${ASSET_BASE}iccs/`,
    // Keeps the raw font programs on `page.commonObjs` so existing text can be
    // edited with its original font (see lib/textEdit.ts).
    fontExtraProperties: true,
  }
}

/** Opens arbitrary PDF bytes (used for rendering exported/converted documents). */
export async function openPdfDocumentFromBytes(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return await pdfjs.getDocument(documentOptions(bytes)).promise
}

/** Starts a worker that outlives any single document (preview rebuilds). */
export function createPdfWorker(): PDFWorker | null {
  try {
    return new pdfjs.PDFWorker()
  } catch (error) {
    console.warn('Could not start a pdf.js worker', error)
    return null
  }
}

/**
 * Like `openPdfDocumentFromBytes`, but on a caller-provided worker so repeated
 * documents (live previews) share one worker instead of starting a new one.
 */
export async function openPdfDocumentOnWorker(
  bytes: Uint8Array,
  worker: PDFWorker | null,
): Promise<PDFDocumentProxy> {
  const options = documentOptions(bytes)
  return await pdfjs.getDocument(worker ? { ...options, worker } : options).promise
}

export function loadPdfDocument(
  bytes: Uint8Array,
  onPassword?: (submit: (password: string) => void, wrong: boolean) => void,
): Promise<LoadedDocument> {
  const task = pdfjs.getDocument(documentOptions(bytes))
  if (onPassword) {
    task.onPassword = (submit: (password: string) => void, reason: number) => {
      onPassword(submit, reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD)
    }
  }
  return task.promise.then(async (pdf) => {
    const pages: PageSourceInfo[] = []
    for (let i = 1; i <= pdf.numPages; i += 1) {
      const page = await pdf.getPage(i)
      const viewport = page.getViewport({ scale: 1 })
      pages.push({
        sourceIndex: i - 1,
        width: viewport.width,
        height: viewport.height,
        transform: viewport.transform.slice(),
        rotation: page.rotate,
      })
    }
    return { pdf, pages }
  })
}

export { pdfjs }
export type { PDFDocumentProxy }
