import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PDFDocument, degrees } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { overlayPdf } from '../../src/lib/documentTools.ts'
import { changePageSize, createFillableFields, pagesPerSheet } from '../../src/lib/extraDocumentTools.ts'

async function textPoint(bytes) {
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, standardFontDataUrl: path.resolve('node_modules/pdfjs-dist/standard_fonts') + path.sep }).promise
  try {
    const page = await pdf.getPage(1)
    const viewport = page.getViewport({ scale: 1 })
    const text = (await page.getTextContent()).items.find((item) => item.str === 'Position')
    expect(text).toBeDefined()
    return { point: viewport.convertToViewportPoint(text.transform[4], text.transform[5]), width: viewport.width, height: viewport.height }
  } finally { await pdf.loadingTask.destroy() }
}

describe('visible PDF geometry', () => {
  it.each([0, 90, 180, 270])('keeps cropped %s degree content in place during overlays, resizing, and sheet layout', async (angle) => {
    const source = await PDFDocument.create()
    const page = source.addPage([400, 300])
    page.setCropBox(20, 30, 320, 220)
    page.setRotation(degrees(angle))
    page.drawText('Position', { x: 60, y: 100, size: 12 })
    const bytes = await source.save()
    const original = await textPoint(bytes)
    const base = await PDFDocument.create()
    base.addPage([original.width, original.height])
    const overlay = await textPoint(await overlayPdf(await base.save(), bytes, { opacity: 1, pages: [0] }))
    expect(overlay.point[0]).toBeCloseTo(original.point[0], 3)
    expect(overlay.point[1]).toBeCloseTo(original.point[1], 3)
    const resized = await textPoint(await changePageSize(bytes, 'a4'))
    const scale = Math.min(resized.width / original.width, resized.height / original.height)
    expect(resized.point[0]).toBeCloseTo(original.point[0] * scale + (resized.width - original.width * scale) / 2, 3)
    expect(resized.point[1]).toBeCloseTo(original.point[1] * scale + (resized.height - original.height * scale) / 2, 3)
    const sheet = await textPoint(await pagesPerSheet(bytes, 2))
    const sheetScale = Math.min(sheet.width / original.width, (sheet.height / 2) / original.height)
    expect(sheet.point[0]).toBeCloseTo(original.point[0] * sheetScale + (sheet.width - original.width * sheetScale) / 2, 3)
    expect(sheet.point[1]).toBeCloseTo(original.point[1] * sheetScale + (sheet.height / 2 - original.height * sheetScale) / 2, 3)
    const fields = await createFillableFields(bytes, [{ type: 'text', page: 1, x: 10, y: 20, width: 100, height: 25, name: 'Field' }])
    const parsed = await pdfjs.getDocument({ data: fields, isEvalSupported: false, standardFontDataUrl: path.resolve('node_modules/pdfjs-dist/standard_fonts') + path.sep }).promise
    try {
      const fieldPage = await parsed.getPage(1)
      const widget = (await fieldPage.getAnnotations()).find((annotation) => annotation.fieldName === 'Field')
      const view = fieldPage.getViewport({ scale: 1 })
      const box = [...view.convertToViewportPoint(widget.rect[0], widget.rect[1]), ...view.convertToViewportPoint(widget.rect[2], widget.rect[3])]
      expect(Math.min(box[0], box[2])).toBeCloseTo(9.5, 1)
      expect(Math.min(box[1], box[3])).toBeCloseTo(19.5, 1)
      expect(Math.abs(box[2] - box[0])).toBeCloseTo(101, 1)
      expect(Math.abs(box[3] - box[1])).toBeCloseTo(26, 1)
    } finally { await parsed.loadingTask.destroy() }
  })
})
