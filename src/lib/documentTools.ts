import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib'
import { t } from '../i18n'
import type { PDFPageProxy } from 'pdfjs-dist'
import { embedVisiblePage, visiblePageSize, visiblePoint } from './pdfGeometry'

type PageList = number[]

function fail(key: string, vars?: Record<string, string | number>): never {
  throw new Error(t(key, vars))
}

function checkPages(pages: PageList, count: number): void {
  if (!Array.isArray(pages) || !pages.length || pages.some((p) => !Number.isInteger(p) || p < 0 || p >= count)) {
    fail('advanced.invalidPages')
  }
}

export async function rotatePages(bytes: Uint8Array, angle: 90 | 180 | 270, pages: PageList): Promise<Uint8Array> {
  if (![90, 180, 270].includes(angle)) fail('advanced.invalidAngle')
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
  checkPages(pages, doc.getPageCount())
  for (const index of pages) {
    const page = doc.getPage(index)
    page.setRotation(degrees(page.getRotation().angle + angle))
  }
  return doc.save({ useObjectStreams: true })
}

export async function addWatermark(
  bytes: Uint8Array,
  options: { text: string; opacity: number; fontSize: number; angle: number; pages: PageList },
): Promise<Uint8Array> {
  if (!options.text.trim()) fail('advanced.invalidWatermark')
  if (!Number.isFinite(options.opacity) || options.opacity < 0 || options.opacity > 1) fail('advanced.invalidOpacity')
  if (!Number.isFinite(options.fontSize) || options.fontSize <= 0) fail('advanced.invalidFontSize')
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
  checkPages(options.pages, doc.getPageCount())
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const index of options.pages) {
    const page = doc.getPage(index)
    const box = visiblePageSize(page)
    const width = font.widthOfTextAtSize(options.text, options.fontSize)
    const point = visiblePoint(page, Math.max(0, (box.width - width) / 2), box.height / 2)
    page.drawText(options.text, {
      x: point.x,
      y: point.y,
      size: options.fontSize,
      font,
      rotate: degrees((options.angle || 0) + page.getRotation().angle),
      opacity: options.opacity,
      color: rgb(0.45, 0.45, 0.45),
    })
  }
  return doc.save({ useObjectStreams: true })
}

export async function addPageNumbers(
  bytes: Uint8Array,
  options: { start: number; position: 'top' | 'bottom'; pages: PageList },
): Promise<Uint8Array> {
  if (!Number.isInteger(options.start) || options.start < 0) fail('advanced.invalidStart')
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
  checkPages(options.pages, doc.getPageCount())
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const index of options.pages) {
    const page = doc.getPage(index)
    const box = visiblePageSize(page)
    const text = String(options.start + options.pages.indexOf(index))
    const width = font.widthOfTextAtSize(text, 10)
    const point = visiblePoint(page, (box.width - width) / 2, options.position === 'top' ? 18 : box.height - 28)
    page.drawText(text, {
      x: point.x,
      y: point.y,
      size: 10,
      font,
      rotate: degrees(page.getRotation().angle),
      color: rgb(0.15, 0.15, 0.15),
    })
  }
  return doc.save({ useObjectStreams: true })
}

export async function overlayPdf(
  base: Uint8Array,
  overlay: Uint8Array,
  options: { opacity: number; pages: PageList },
): Promise<Uint8Array> {
  if (!Number.isFinite(options.opacity) || options.opacity < 0 || options.opacity > 1) fail('advanced.invalidOpacity')
  const doc = await PDFDocument.load(base, { ignoreEncryption: true, updateMetadata: false })
  const source = await PDFDocument.load(overlay, { ignoreEncryption: true, updateMetadata: false })
  checkPages(options.pages, doc.getPageCount())
  if (!source.getPageCount()) fail('advanced.overlayEmpty')
  if (source.getPageCount() > 1 && source.getPageCount() < options.pages.length) fail('advanced.overlayTooShort')
  for (let i = 0; i < options.pages.length; i += 1) {
    const page = doc.getPage(options.pages[i])
    const sourcePage = source.getPage(source.getPageCount() === 1 ? 0 : i)
    const embedded = await embedVisiblePage(doc, sourcePage)
    if (!embedded.page) continue
    const target = visiblePageSize(page)
    const scale = Math.min(target.width / embedded.width, target.height / embedded.height)
    const width = embedded.width * scale
    const height = embedded.height * scale
    const point = visiblePoint(page, (target.width - width) / 2, (target.height - height) / 2 + height)
    page.drawPage(embedded.page, {
      x: point.x,
      y: point.y,
      xScale: scale,
      yScale: scale,
      rotate: degrees(page.getRotation().angle),
      opacity: options.opacity,
    })
  }
  return doc.save({ useObjectStreams: true })
}

export async function createBlankPdf(options: { width: number; height: number; count: number }): Promise<Uint8Array> {
  if (![options.width, options.height].every((n) => Number.isFinite(n) && n > 0 && n <= 14400) || !Number.isInteger(options.count) || options.count < 1 || options.count > 100) {
    fail('advanced.invalidBlankPage')
  }
  const doc = await PDFDocument.create()
  for (let i = 0; i < options.count; i += 1) doc.addPage([options.width, options.height])
  return doc.save({ useObjectStreams: true })
}

export async function extractEmbeddedImages(bytes: Uint8Array): Promise<Array<{ name: string; bytes: Uint8Array }>> {
  if (typeof document === 'undefined') fail('advanced.imagesBrowserOnly')
  const { openPdfDocumentFromBytes, pdfjs } = await import('./pdfjs')
  const pdf = await openPdfDocumentFromBytes(bytes)
  const output: Array<{ name: string; bytes: Uint8Array }> = []
  let count = 0
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const operators = await page.getOperatorList()
      for (let i = 0; i < operators.fnArray.length; i += 1) {
        const fn = operators.fnArray[i]
        const args = operators.argsArray[i] as unknown[]
        const imageOp = fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintImageXObjectRepeat
        const inlineOp = fn === pdfjs.OPS.paintInlineImageXObject
        if (!imageOp && !inlineOp) continue
        const id = String(args[0])
        const pool = id.startsWith('g_') ? page.commonObjs : page.objs
        const image = inlineOp ? args[0] : await new Promise((resolve) => pool.get(id, resolve))
        const png = await imageDataToPng(image as DecodedImage)
        if (png) output.push({ name: `image-${String(++count).padStart(3, '0')}.png`, bytes: png })
      }
      page.cleanup()
    }
  } finally {
    void pdf.loadingTask.destroy()
  }
  return output
}

interface DecodedImage { width?: number; height?: number; kind?: number; data?: Uint8ClampedArray; bitmap?: ImageBitmap }

async function imageDataToPng(image: DecodedImage): Promise<Uint8Array | null> {
  const width = image.width ?? image.bitmap?.width ?? 0
  const height = image.height ?? image.bitmap?.height ?? 0
  if (!width || !height) return null
  if (width * height > 32_000_000) fail('advanced.imageDecodeFailed')
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return null
  if (image.bitmap) context.drawImage(image.bitmap, 0, 0)
  else if (image.data) {
    const pixels = image.kind === 1 ? expandMonochrome(image.data, width, height) : image.data.length === width * height * 4 ? image.data : expandRgb(image.data, width * height)
    const imageData = context.createImageData(width, height)
    imageData.data.set(pixels)
    context.putImageData(imageData, 0, 0)
  } else return null
  return canvasPng(canvas)
}

function expandRgb(data: Uint8ClampedArray, pixels: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(pixels * 4)
  for (let i = 0; i < pixels; i += 1) {
    output[i * 4] = data[i * 3] ?? 0
    output[i * 4 + 1] = data[i * 3 + 1] ?? 0
    output[i * 4 + 2] = data[i * 3 + 2] ?? 0
    output[i * 4 + 3] = 255
  }
  return output
}

function expandMonochrome(data: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4)
  const stride = Math.ceil(width / 8)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = data[y * stride + (x >> 3)] & (128 >> (x % 8)) ? 255 : 0
      const offset = (y * width + x) * 4
      pixels.set([value, value, value, 255], offset)
    }
  }
  return pixels
}

async function renderPage(page: PDFPageProxy): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }> {
  const base = page.getViewport({ scale: 1 })
  const scale = Math.min(2, Math.sqrt(8_000_000 / (base.width * base.height)))
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.floor(viewport.width))
  canvas.height = Math.max(1, Math.floor(viewport.height))
  await page.render({ canvas, viewport, background: 'white' }).promise
  return { canvas, width: base.width, height: base.height }
}

async function renderPages(bytes: Uint8Array): Promise<{ images: Uint8Array[]; widths: number[]; heights: number[] }> {
  const { openPdfDocumentFromBytes } = await import('./pdfjs')
  const pdf = await openPdfDocumentFromBytes(bytes)
  const images: Uint8Array[] = []
  const widths: number[] = []
  const heights: number[] = []
  try {
    for (let i = 1; i <= pdf.numPages; i += 1) {
      const page = await pdf.getPage(i)
      const { canvas } = await renderPage(page)
      images.push(await canvasPng(canvas))
      widths.push(canvas.width)
      heights.push(canvas.height)
      canvas.width = 0
      canvas.height = 0
      page.cleanup()
    }
  } finally {
    await pdf.loadingTask.destroy()
  }
  return { images, widths, heights }
}

export async function rasterFlatten(bytes: Uint8Array): Promise<Uint8Array> {
  const { openPdfDocumentFromBytes } = await import('./pdfjs')
  const source = await openPdfDocumentFromBytes(bytes)
  const doc = await PDFDocument.create({ updateMetadata: false })
  try {
    for (let index = 1; index <= source.numPages; index += 1) {
      const original = await source.getPage(index)
      const { canvas, width, height } = await renderPage(original)
      const image = await doc.embedPng(await canvasPng(canvas))
      const page = doc.addPage([width, height])
      page.drawImage(image, { x: 0, y: 0, width, height })
      canvas.width = 0
      canvas.height = 0
      original.cleanup()
    }
    return await doc.save({ useObjectStreams: true })
  } finally {
    await source.loadingTask.destroy()
  }
}

export async function comparePdfs(left: Uint8Array, right: Uint8Array): Promise<{ bytes: Uint8Array; changedPages: number; totalPages: number }> {
  const [a, b] = await Promise.all([renderPages(left), renderPages(right)])
  const totalPages = Math.max(a.images.length, b.images.length)
  const report = await PDFDocument.create()
  let changedPages = 0
  for (let i = 0; i < totalPages; i += 1) {
    const original = a.images[i] ?? new Uint8Array()
    const revised = b.images[i] ?? new Uint8Array()
    const sizeChanged = !original.length || !revised.length || a.widths[i] !== b.widths[i] || a.heights[i] !== b.heights[i]
    if (!original.length && !revised.length) continue
    const width = Math.max(a.widths[i] ?? 0, b.widths[i] ?? 0)
    const height = Math.max(a.heights[i] ?? 0, b.heights[i] ?? 0)
    const originalCanvas = await pngCanvas(original, width, height)
    const revisedCanvas = await pngCanvas(revised, width, height)
    const diffCanvas = document.createElement('canvas')
    diffCanvas.width = width
    diffCanvas.height = height
    const originalData = originalCanvas.getContext('2d')?.getImageData(0, 0, width, height).data
    const revisedData = revisedCanvas.getContext('2d')?.getImageData(0, 0, width, height).data
    const diffContext = diffCanvas.getContext('2d')
    const diffData = diffContext?.createImageData(width, height)
    let changed = false
    if (originalData && revisedData && diffData && diffContext) {
      for (let p = 0; p < originalData.length; p += 4) {
        const different = Math.abs(originalData[p] - revisedData[p]) + Math.abs(originalData[p + 1] - revisedData[p + 1]) + Math.abs(originalData[p + 2] - revisedData[p + 2]) > 24
        if (different) changed = true
        diffData.data[p] = different ? 220 : 245
        diffData.data[p + 1] = different ? 45 : 245
        diffData.data[p + 2] = different ? 45 : 245
        diffData.data[p + 3] = different ? 220 : 90
      }
      diffContext.putImageData(diffData, 0, 0)
    }
    if (sizeChanged || changed) changedPages += 1
    const [leftImage, rightImage, diffImage] = await Promise.all([
      report.embedPng(await canvasPng(originalCanvas)),
      report.embedPng(await canvasPng(revisedCanvas)),
      report.embedPng(await canvasPng(diffCanvas)),
    ])
    const labelBand = 24
    const page = report.addPage([width * 3 / 2, height / 2 + labelBand])
    const drawWidth = width / 2
    const drawHeight = height / 2
    page.drawImage(leftImage, { x: 0, y: labelBand, width: drawWidth, height: drawHeight })
    page.drawImage(rightImage, { x: drawWidth, y: labelBand, width: drawWidth, height: drawHeight })
    page.drawImage(diffImage, { x: drawWidth * 2, y: labelBand, width: drawWidth, height: drawHeight })
    const font = await report.embedFont(StandardFonts.Helvetica)
    page.drawRectangle({ x: 0, y: 0, width: width * 3 / 2, height: labelBand, color: rgb(0.12, 0.14, 0.18) })
    page.drawText(t('advanced.compareOriginal'), { x: 8, y: 8, size: 8, font, color: rgb(1, 1, 1) })
    page.drawText(t('advanced.compareRevised'), { x: drawWidth + 8, y: 8, size: 8, font, color: rgb(1, 1, 1) })
    page.drawText(t('advanced.compareDifference'), { x: drawWidth * 2 + 8, y: 8, size: 8, font, color: rgb(1, 1, 1) })
  }
  return { bytes: await report.save({ useObjectStreams: true }), changedPages, totalPages }
}

async function pngCanvas(bytes: Uint8Array, width: number, height: number): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  if (!bytes.length) return canvas
  const image = new Image()
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }))
  try {
    image.src = url
    await image.decode()
    canvas.getContext('2d')?.drawImage(image, 0, 0)
  } finally {
    URL.revokeObjectURL(url)
  }
  return canvas
}

async function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error(t('advanced.imageDecodeFailed'))), 'image/png'))
  return new Uint8Array(await blob.arrayBuffer())
}
