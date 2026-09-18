import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { dataUrlBytes, dataUrlMime } from './assets'
import type { FontFamily } from '../types'

export interface MergeSource {
  name: string
  bytes: Uint8Array
}

/** Concatenates PDFs in the given order. */
export async function mergePdfs(sources: MergeSource[]): Promise<Uint8Array> {
  if (!sources.length) throw new Error('No documents to merge')
  const out = await PDFDocument.create()
  for (const source of sources) {
    const doc = await PDFDocument.load(source.bytes, { ignoreEncryption: true, updateMetadata: false })
    const pages = await out.copyPages(doc, doc.getPageIndices())
    for (const page of pages) out.addPage(page)
  }
  return out.save({ useObjectStreams: true })
}

/** Copies the given 0-based page indices into a new PDF. */
export async function extractPages(bytes: Uint8Array, indices: number[]): Promise<Uint8Array> {
  if (!indices.length) throw new Error('Select at least one page')
  const source = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
  const out = await PDFDocument.create()
  const pages = await out.copyPages(source, indices)
  for (const page of pages) out.addPage(page)
  return out.save({ useObjectStreams: true })
}

/** Parses "1-3,5,8-" (1-based, inclusive) into 0-based indices. */
export function parsePageRanges(input: string, pageCount: number): number[] {
  const result: number[] = []
  const seen = new Set<number>()
  const add = (n: number) => {
    const index = n - 1
    if (index >= 0 && index < pageCount && !seen.has(index)) {
      seen.add(index)
      result.push(index)
    }
  }
  const text = input.trim().toLowerCase()
  if (!text || text === 'all' || text === '*') {
    for (let i = 1; i <= pageCount; i += 1) add(i)
    return result
  }
  for (const chunk of text.split(',')) {
    const part = chunk.trim()
    if (!part) continue
    const range = /^(\d+)\s*-\s*(\d*)$/.exec(part)
    if (range) {
      const start = Number(range[1])
      const end = range[2] ? Number(range[2]) : pageCount
      if (start > end) throw new Error(`Invalid range "${part}"`)
      for (let i = start; i <= end; i += 1) add(i)
      continue
    }
    if (/^\d+$/.test(part)) {
      add(Number(part))
      continue
    }
    throw new Error(`Could not understand "${part}"`)
  }
  return result
}

export interface ImageSource {
  name: string
  src: string
  width: number
  height: number
}

export type ImagePageSize = 'image' | 'a4'

/** Builds a PDF from images, one per page. */
export async function imagesToPdf(images: ImageSource[], pageSize: ImagePageSize = 'a4'): Promise<Uint8Array> {
  if (!images.length) throw new Error('Add at least one image')
  const doc = await PDFDocument.create()
  const a4: [number, number] = [595.28, 841.89]
  for (const image of images) {
    const bytes = dataUrlBytes(image.src)
    const mime = dataUrlMime(image.src)
    const embedded =
      mime === 'image/jpeg' || (bytes[0] === 0xff && bytes[1] === 0xd8)
        ? await doc.embedJpg(bytes)
        : await doc.embedPng(bytes)
    if (pageSize === 'image') {
      const width = Math.min(14400, embedded.width || image.width || 595)
      const height = Math.min(14400, embedded.height || image.height || 842)
      const page = doc.addPage([width, height])
      page.drawImage(embedded, { x: 0, y: 0, width, height })
    } else {
      const page = doc.addPage(a4)
      const margin = 36
      const scale = Math.min(
        (a4[0] - margin * 2) / (embedded.width || 1),
        (a4[1] - margin * 2) / (embedded.height || 1),
      )
      const width = (embedded.width || a4[0]) * scale
      const height = (embedded.height || a4[1]) * scale
      page.drawImage(embedded, {
        x: (a4[0] - width) / 2,
        y: (a4[1] - height) / 2,
        width,
        height,
      })
    }
  }
  return doc.save({ useObjectStreams: true })
}

function sanitizeForStandardFont(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/[^\n\u0020-\u00ff]/g, '?')
}

/** Renders plain text into a paginated PDF using Helvetica. */
export async function textToPdf(
  text: string,
  options: { fontFamily?: FontFamily; fontSize?: number } = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const fontSize = options.fontSize ?? 11
  const font = await doc.embedFont(
    options.fontFamily === 'Times New Roman'
      ? StandardFonts.TimesRoman
      : options.fontFamily === 'Courier New'
        ? StandardFonts.Courier
        : StandardFonts.Helvetica,
  )
  const pageWidth = 595.28
  const pageHeight = 841.89
  const margin = 56
  const lineHeight = fontSize * 1.45
  const maxWidth = pageWidth - margin * 2
  const clean = sanitizeForStandardFont(text)

  const wrap = (line: string): string[] => {
    if (!line) return ['']
    const words = line.split(' ')
    const lines: string[] = []
    let current = ''
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word
      if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth || !current) {
        current = candidate
      } else {
        lines.push(current)
        current = word
      }
    }
    lines.push(current)
    return lines
  }

  let page = doc.addPage([pageWidth, pageHeight])
  let y = pageHeight - margin
  const paragraphs = clean.split('\n')
  for (const paragraph of paragraphs) {
    for (const line of wrap(paragraph)) {
      if (y < margin + lineHeight) {
        page = doc.addPage([pageWidth, pageHeight])
        y = pageHeight - margin
      }
      if (line) {
        page.drawText(line, { x: margin, y, size: fontSize, font, color: rgb(0.1, 0.11, 0.13) })
      }
      y -= lineHeight
    }
  }
  return doc.save({ useObjectStreams: true })
}

/** Extracts the text layer of a document. */
export async function pdfToText(pdf: PDFDocumentProxy): Promise<string> {
  const sections: string[] = []
  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    let text = ''
    for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
      text += item.str ?? ''
      if (item.hasEOL) text += '\n'
    }
    sections.push(`--- Page ${i} ---\n${text.trim()}`)
  }
  return sections.join('\n\n')
}

export type ImageFormat = 'png' | 'jpeg'

export async function renderPdfPageToBlob(
  pdf: PDFDocumentProxy,
  pageIndex: number,
  scale: number,
  format: ImageFormat,
): Promise<Blob> {
  const page = await pdf.getPage(pageIndex + 1)
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.floor(viewport.width))
  canvas.height = Math.max(1, Math.floor(viewport.height))
  await page.render({
    canvas,
    viewport,
    background: format === 'jpeg' ? 'white' : undefined,
  }).promise
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the page'))),
      format === 'jpeg' ? 'image/jpeg' : 'image/png',
      format === 'jpeg' ? 0.92 : undefined,
    )
  })
}

export interface RenderedPage {
  name: string
  blob: Blob
}

export async function renderPdfToImages(
  pdf: PDFDocumentProxy,
  pageIndices: number[],
  scale: number,
  format: ImageFormat,
  onProgress?: (done: number, total: number) => void,
): Promise<RenderedPage[]> {
  const extension = format === 'jpeg' ? 'jpg' : 'png'
  const width = String(pdf.numPages).length
  const out: RenderedPage[] = []
  for (let i = 0; i < pageIndices.length; i += 1) {
    const index = pageIndices[i]
    const blob = await renderPdfPageToBlob(pdf, index, scale, format)
    out.push({ name: `page-${String(index + 1).padStart(width, '0')}.${extension}`, blob })
    onProgress?.(i + 1, pageIndices.length)
  }
  return out
}
