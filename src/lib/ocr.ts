import { createWorker, type Worker } from 'tesseract.js'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { openPdfDocumentFromBytes } from './pdfjs'
import { pdfSafeText } from './ooxml'

const SCALE = 300 / 72

function asset(path: string): string {
  return new URL(`/pdf-engine-assets/tesseract/${path}`, window.location.href).toString()
}

function clean(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
}

function renderScale(width: number, height: number): number {
  const maxPixels = 18_000_000
  return Math.min(SCALE, Math.sqrt(maxPixels / Math.max(1, width * height)))
}

export async function ocrPdf(
  bytes: Uint8Array,
  onProgress?: (done: number, total: number) => void,
): Promise<{ bytes: Uint8Array; text: string }> {
  const source = await openPdfDocumentFromBytes(bytes)
  const out = await PDFDocument.create()
  const font = await out.embedFont(StandardFonts.Helvetica)
  let worker: Worker | null = null
  const sections: string[] = []
  try {
    worker = await createWorker('eng', 1, {
      workerPath: asset('worker.min.js'),
      corePath: asset('core'),
      langPath: asset('lang'),
    })
    for (let index = 1; index <= source.numPages; index += 1) {
      const page = await source.getPage(index)
      const scale = renderScale(page.view[2] - page.view[0], page.view[3] - page.view[1])
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.ceil(viewport.width))
      canvas.height = Math.max(1, Math.ceil(viewport.height))
      await page.render({ canvas, viewport, background: 'white' }).promise
      const image = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('OCR_IMAGE_FAILED')), 'image/jpeg', 0.92))
      const result = await worker.recognize(image, {}, { blocks: true })
      const pageOut = out.addPage([viewport.width / scale, viewport.height / scale])
      const jpg = await out.embedJpg(new Uint8Array(await image.arrayBuffer()))
      pageOut.drawImage(jpg, { x: 0, y: 0, width: viewport.width / scale, height: viewport.height / scale })
      const blocks = result.data.blocks ?? []
      const words = blocks.flatMap((block) => (block.paragraphs ?? []).flatMap((paragraph) => (paragraph.lines ?? []).flatMap((line) => line.words ?? [])))
      for (const word of words) {
        const text = pdfSafeText(clean(word.text))
        if (!text) continue
        const x = word.bbox.x0 / scale
        const y = viewport.height / scale - word.bbox.y1 / scale
        const size = Math.max(4, (word.bbox.y1 - word.bbox.y0) / scale)
        pageOut.drawText(text, { x, y, size, font, color: rgb(1, 1, 1), opacity: 0 })
      }
      sections.push(`--- Page ${index} ---\n${clean(result.data.text)}`)
      onProgress?.(index, source.numPages)
      canvas.width = 1
      canvas.height = 1
    }
  } finally {
    try {
      if (worker) await worker.terminate()
    } finally {
      await source.loadingTask.destroy()
    }
  }
  return { bytes: await out.save({ useObjectStreams: true }), text: sections.join('\n\n') }
}
