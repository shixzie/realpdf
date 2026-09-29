import { PDFDict, PDFDocument, PageSizes, PDFHexString, PDFName, PDFRef, degrees } from 'pdf-lib'
import { embedVisiblePage, visiblePageSize, visiblePoint } from './pdfGeometry'
import { t } from '../i18n'

export type CropMargins = { top: number; right: number; bottom: number; left: number }
export type PageSizePreset = 'a4' | 'letter'
export type HalveDirection = 'vertical' | 'horizontal'
export type SheetCount = 2 | 4
export type FormFieldSpec = {
  type: 'text' | 'checkbox'
  page: number
  x: number
  y: number
  width: number
  height: number
  name: string
  options?: { value?: string; checked?: boolean }
}

async function load(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { updateMetadata: false })
}

export async function cropPages(bytes: Uint8Array, margins: CropMargins): Promise<Uint8Array> {
  if (Object.values(margins).some((value) => !Number.isFinite(value) || value < 0)) throw new Error(t('extraTools.invalidMargins'))
  const pdf = await load(bytes)
  for (const page of pdf.getPages()) {
    const size = visiblePageSize(page)
    if (margins.left + margins.right >= size.width || margins.top + margins.bottom >= size.height) throw new Error(t('extraTools.invalidMargins'))
    const a = visiblePoint(page, margins.left, margins.top)
    const b = visiblePoint(page, size.width - margins.right, size.height - margins.bottom)
    page.setCropBox(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y))
  }
  return pdf.save()
}

export async function changePageSize(bytes: Uint8Array, preset: PageSizePreset): Promise<Uint8Array> {
  if (preset !== 'a4' && preset !== 'letter') throw new Error(t('extraTools.invalidPageSize'))
  const source = await load(bytes)
  const out = await PDFDocument.create()
  const [width, height] = preset === 'letter' ? PageSizes.Letter : PageSizes.A4
  for (const page of source.getPages()) {
    const embedded = await embedVisiblePage(out, page)
    const target = out.addPage([width, height])
    const scale = Math.min(width / embedded.width, height / embedded.height)
    if (embedded.page) target.drawPage(embedded.page, {
      x: (width - embedded.width * scale) / 2,
      y: (height - embedded.height * scale) / 2,
      xScale: scale,
      yScale: scale,
    })
  }
  return out.save()
}

export async function editMetadata(bytes: Uint8Array, metadata: Partial<Record<'title' | 'author' | 'subject' | 'keywords' | 'creator' | 'producer', string>>): Promise<Uint8Array> {
  const pdf = await load(bytes)
  if (metadata.title !== undefined) pdf.setTitle(metadata.title)
  if (metadata.author !== undefined) pdf.setAuthor(metadata.author)
  if (metadata.subject !== undefined) pdf.setSubject(metadata.subject)
  if (metadata.keywords !== undefined) pdf.setKeywords(metadata.keywords.split(',').map((item) => item.trim()).filter(Boolean))
  if (metadata.creator !== undefined) pdf.setCreator(metadata.creator)
  if (metadata.producer !== undefined) pdf.setProducer(metadata.producer)
  return pdf.save()
}

export async function removeMetadata(bytes: Uint8Array): Promise<Uint8Array> {
  const pdf = await load(bytes)
  const info = pdf.context.trailerInfo.Info
  if (info instanceof PDFRef) pdf.context.delete(info)
  pdf.context.trailerInfo.Info = undefined
  const metadata = pdf.catalog.get(PDFName.of('Metadata'))
  if (metadata instanceof PDFRef) pdf.context.delete(metadata)
  pdf.catalog.delete(PDFName.of('Metadata'))
  return pdf.save()
}

export async function pagesPerSheet(bytes: Uint8Array, count: SheetCount): Promise<Uint8Array> {
  if (count !== 2 && count !== 4) throw new Error(t('extraTools.invalidCount'))
  const source = await load(bytes)
  const out = await PDFDocument.create()
  const cols = count === 2 ? 1 : 2
  const [width, height] = PageSizes.A4
  for (let index = 0; index < source.getPageCount(); index += count) {
    const sheet = out.addPage([width, height])
    for (let slot = 0; slot < count && index + slot < source.getPageCount(); slot += 1) {
      const embedded = await embedVisiblePage(out, source.getPage(index + slot))
      const cellWidth = width / cols
      const cellHeight = height / 2
      const scale = Math.min(cellWidth / embedded.width, cellHeight / embedded.height)
      if (embedded.page) sheet.drawPage(embedded.page, {
        x: (slot % cols) * cellWidth + (cellWidth - embedded.width * scale) / 2,
        y: height - (Math.floor(slot / cols) + 1) * cellHeight + (cellHeight - embedded.height * scale) / 2,
        xScale: scale,
        yScale: scale,
      })
    }
  }
  return out.save()
}

export async function halvePages(bytes: Uint8Array, direction: HalveDirection): Promise<Uint8Array> {
  if (direction !== 'vertical' && direction !== 'horizontal') throw new Error(t('extraTools.invalidPageSize'))
  const source = await load(bytes)
  const out = await PDFDocument.create()
  for (const page of source.getPages()) {
    const embedded = await embedVisiblePage(out, page)
    const vertical = direction === 'vertical'
    const width = vertical ? embedded.width / 2 : embedded.width
    const height = vertical ? embedded.height : embedded.height / 2
    for (let half = 0; half < 2; half += 1) {
      const target = out.addPage([width, height])
      if (embedded.page) target.drawPage(embedded.page, {
        x: vertical ? -half * width : 0,
        y: vertical ? 0 : -(1 - half) * height,
        xScale: 1,
        yScale: 1,
      })
    }
  }
  return out.save()
}

export async function addBookmarks(bytes: Uint8Array, lines: string): Promise<Uint8Array> {
  const pdf = await load(bytes)
  const pages = pdf.getPages()
  const outline = pdf.context.register(pdf.context.obj({ Type: PDFName.of('Outlines'), Count: 0 }))
  const entries = lines.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (!entries.length) throw new Error(t('extraTools.invalidBookmarks'))
  const kids = entries.map((line) => {
    const match = line.match(/^(.*?)[\t|,: ]+(\d+)$/)
    const title = (match?.[1] ?? line).trim()
    const pageNumber = Number(match?.[2] ?? NaN)
    if (!match || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pages.length || !title) throw new Error(t('extraTools.invalidBookmarks'))
    return pdf.context.register(pdf.context.obj({ Title: PDFHexString.fromText(title), Parent: outline, Dest: pdf.context.obj([pages[pageNumber - 1].ref, PDFName.of('XYZ'), null, null, null]) }))
  })
  const outlineDict = pdf.context.lookup(outline, PDFDict)
  outlineDict.set(PDFName.of('Count'), pdf.context.obj(kids.length))
  if (kids[0]) outlineDict.set(PDFName.of('First'), kids[0])
  if (kids[kids.length - 1]) outlineDict.set(PDFName.of('Last'), kids[kids.length - 1])
  for (let i = 0; i < kids.length; i++) {
    const current = pdf.context.lookup(kids[i], PDFDict)
    if (kids[i - 1]) current.set(PDFName.of('Prev'), kids[i - 1])
    if (kids[i + 1]) current.set(PDFName.of('Next'), kids[i + 1])
  }
  pdf.catalog.set(PDFName.of('Outlines'), outline)
  return pdf.save()
}

export async function createFillableFields(bytes: Uint8Array, specs: FormFieldSpec[]): Promise<Uint8Array> {
  const pdf = await load(bytes)
  const form = pdf.getForm()
  const names = new Set(form.getFields().map((field) => field.getName()))
  if (!specs.length) throw new Error(t('extraTools.invalidField'))
  for (const spec of specs) {
    const page = pdf.getPages()[spec.page - 1]
    if (!Number.isInteger(spec.page) || !page || !spec.name.trim()) throw new Error(t('extraTools.invalidField'))
    if (names.has(spec.name)) throw new Error(t('extraTools.duplicateField'))
    if (![spec.x, spec.y, spec.width, spec.height].every(Number.isFinite) || spec.x < 0 || spec.y < 0 || spec.width <= 0 || spec.height <= 0) throw new Error(t('extraTools.invalidField'))
    const { width: visibleWidth, height: visibleHeight } = visiblePageSize(page)
    if (spec.x + spec.width > visibleWidth || spec.y + spec.height > visibleHeight) throw new Error(t('extraTools.invalidField'))
    names.add(spec.name)
    const origin = visiblePoint(page, spec.x, spec.y + spec.height)
    const placement = { x: origin.x, y: origin.y, width: spec.width, height: spec.height, rotate: degrees(page.getRotation().angle), borderWidth: 1 }
    if (spec.type === 'checkbox') {
      const field = form.createCheckBox(spec.name)
      field.addToPage(page, placement)
      if (spec.options?.checked) field.check()
    } else {
      const field = form.createTextField(spec.name)
      field.addToPage(page, placement)
      if (spec.options?.value !== undefined) field.setText(spec.options.value)
    }
  }
  return pdf.save()
}

export async function setViewerPreferences(bytes: Uint8Array, options: { hideToolbar?: boolean; hideMenubar?: boolean; fitWindow?: boolean; displayDocTitle?: boolean }): Promise<Uint8Array> {
  const pdf = await load(bytes)
  const prefs = pdf.catalog.getOrCreateViewerPreferences()
  if (options.hideToolbar !== undefined) prefs.setHideToolbar(options.hideToolbar)
  if (options.hideMenubar !== undefined) prefs.setHideMenubar(options.hideMenubar)
  if (options.fitWindow !== undefined) prefs.setFitWindow(options.fitWindow)
  if (options.displayDocTitle !== undefined) prefs.setDisplayDocTitle(options.displayDocTitle)
  return pdf.save()
}

export type SearchMatch = { page: number; text: string }
export async function searchPdfText(bytes: Uint8Array, query: string): Promise<SearchMatch[]> {
  const matches: SearchMatch[] = []
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return matches
  const { openPdfDocumentFromBytes } = await import('./pdfjs')
  const document = await openPdfDocumentFromBytes(bytes)
  try {
    for (let page = 1; page <= document.numPages; page++) {
      const content = await (await document.getPage(page)).getTextContent()
      const text = content.items.map((item) => ('str' in item ? item.str : '')).join(' ')
      if (text.toLocaleLowerCase().includes(needle)) matches.push({ page, text })
    }
  } finally {
    await document.loadingTask.destroy()
  }
  return matches
}
