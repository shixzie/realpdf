import { describe, expect, it } from 'vitest'
import { PDFDocument, PDFName, PDFDict, PDFHexString, degrees } from 'pdf-lib'
import { cropPages, changePageSize, pagesPerSheet, halvePages, editMetadata, removeMetadata, addBookmarks, createFillableFields } from '../../src/lib/extraDocumentTools.ts'

async function fixture() {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([400, 300])
  page.setRotation(degrees(90))
  page.drawText('Hello')
  pdf.addPage([300, 200]).drawText('Second')
  return pdf.save()
}

describe('extra document tools', () => {
  it('crops and resizes rotated pages', async () => {
    const output = await cropPages(await fixture(), { top: 10, right: 20, bottom: 30, left: 40 })
    const cropped = await PDFDocument.load(output)
    expect(cropped.getPage(0).getCropBox()).toEqual({ x: 10, y: 40, width: 360, height: 240 })
    expect(cropped.getPage(0).getRotation().angle).toBe(90)
    const resized = await changePageSize(output, 'a4')
    expect((await PDFDocument.load(resized)).getPage(0).getSize().width).toBe(595.28)
  })

  it('makes sheets and halves pages', async () => {
    const bytes = await fixture()
    expect((await PDFDocument.load(await pagesPerSheet(bytes, 2))).getPageCount()).toBe(1)
    expect((await PDFDocument.load(await halvePages(bytes, 'vertical'))).getPageCount()).toBe(4)
  })

  it('removes document metadata objects and writes valid bookmark strings and targets', async () => {
    const source = await PDFDocument.load(await fixture())
    source.setTitle('Secret metadata')
    source.setAuthor('Private author')
    const xmp = source.context.register(source.context.stream('<xmp>Private metadata</xmp>'))
    source.catalog.set(PDFName.of('Metadata'), xmp)
    const cleaned = await PDFDocument.load(await removeMetadata(await source.save()), { updateMetadata: false })
    expect(cleaned.context.trailerInfo.Info).toBeUndefined()
    expect(cleaned.catalog.get(PDFName.of('Metadata'))).toBeUndefined()
    expect(cleaned.context.enumerateIndirectObjects().some(([, object]) => object.toString().includes('Private metadata'))).toBe(false)
    const bookmarked = await PDFDocument.load(await addBookmarks(await fixture(), 'Introduction | 1\nSecond | 2'))
    const outline = bookmarked.catalog.lookup(PDFName.of('Outlines'), PDFDict)
    const first = bookmarked.context.lookup(outline.get(PDFName.of('First')), PDFDict)
    expect(first.lookup(PDFName.of('Title'), PDFHexString).decodeText()).toBe('Introduction')
    expect(first.lookup(PDFName.of('Dest')).get(0)).toEqual(bookmarked.getPage(0).ref)
    await expect(addBookmarks(await fixture(), 'Bad | 9')).rejects.toThrow()
  })

  it('rejects crop and field inputs that would lose content or create off-page widgets', async () => {
    const bytes = await fixture()
    await expect(cropPages(bytes, { top: 500, bottom: 0, left: 0, right: 0 })).rejects.toThrow()
    await expect(createFillableFields(bytes, [{ type: 'text', page: 9, name: 'No page', x: 0, y: 0, width: 10, height: 10 }])).rejects.toThrow()
  })

  it('edits metadata and creates fields', async () => {
    const bytes = await editMetadata(await fixture(), { title: 'Edited' })
    const withField = await createFillableFields(bytes, [{ type: 'text', page: 1, x: 10, y: 20, width: 100, height: 20, name: 'name' }])
    const pdf = await PDFDocument.load(withField)
    expect(pdf.getTitle()).toBe('Edited')
    expect(pdf.getForm().getFields()).toHaveLength(1)
  })
})
