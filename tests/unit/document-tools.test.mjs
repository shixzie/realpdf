import { describe, expect, it } from 'vitest'
import { PDFDocument, degrees } from 'pdf-lib'
import {
  addPageNumbers,
  addWatermark,
  createBlankPdf,
  overlayPdf,
  rotatePages,
} from '../../src/lib/documentTools.ts'

async function fixture() {
  const doc = await PDFDocument.create()
  const page = doc.addPage([400, 300])
  page.setCropBox(20, 25, 340, 240)
  page.drawText('Original')
  return doc.save({ useObjectStreams: true })
}

describe('document tools', () => {
  it('rotates only selected pages', async () => {
    const doc = await PDFDocument.create()
    doc.addPage([400, 300])
    doc.addPage([400, 300])
    const output = await rotatePages(await doc.save(), 90, [1])
    const result = await PDFDocument.load(output)
    expect(result.getPage(0).getRotation().angle).toBe(0)
    expect(result.getPage(1).getRotation().angle).toBe(90)
  })

  it('adds watermark and page numbers to a cropped, rotated page', async () => {
    const bytes = await fixture()
    const rotated = await rotatePages(bytes, 90, [0])
    const watermarked = await addWatermark(rotated, {
      text: 'CONFIDENTIAL',
      opacity: 0.4,
      fontSize: 20,
      angle: 30,
      pages: [0],
    })
    const output = await addPageNumbers(watermarked, { start: 7, position: 'top', pages: [0] })
    const result = await PDFDocument.load(output)
    expect(result.getPage(0).getRotation().angle).toBe(90)
    expect(result.getPage(0).getCropBox().width).toBe(340)
    expect(output.length).toBeGreaterThan(bytes.length)
  })

  it('overlays one page repeatedly and rejects too few multi-page overlays', async () => {
    const base = await PDFDocument.create()
    base.addPage([300, 200])
    base.addPage([300, 200])
    const overlay = await PDFDocument.create()
    overlay.addPage([100, 100]).drawText('Stamp')
    const repeated = await overlayPdf(await base.save(), await overlay.save(), { opacity: 0.5, pages: [0, 1] })
    expect((await PDFDocument.load(repeated)).getPageCount()).toBe(2)

    const short = await PDFDocument.create()
    short.addPage([100, 100]).drawText('One')
    short.addPage([100, 100]).drawText('Two')
    await expect(overlayPdf(await base.save(), await short.save(), { opacity: 0.5, pages: [0, 1, 0] })).rejects.toThrow()
  })

  it('creates the requested blank pages and validates dimensions', async () => {
    const bytes = await createBlankPdf({ width: 612, height: 792, count: 3 })
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(3)
    expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 })
    await expect(createBlankPdf({ width: 0, height: 792, count: 1 })).rejects.toThrow()
    await expect(createBlankPdf({ width: 612, height: 792, count: 0 })).rejects.toThrow()
  })
})
