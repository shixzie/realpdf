/**
 * Unit coverage for the content-stream walk that deletes edited text runs.
 * Each case builds a small PDF, removes one run and checks what a fresh reader
 * sees afterwards.
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { removeTextRuns } from '../../src/lib/contentEdit.ts'
import { buildEmbeddedFontPdf } from '../helpers/fixtures.mjs'

async function itemsOf(bytes) {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise
  const page = await pdf.getPage(1)
  const content = await page.getTextContent()
  return content.items
}

function targetFor(item, text = item.str) {
  const [a, b, c, d, e, f] = item.transform
  return {
    text,
    x: e,
    y: f,
    width: item.width,
    fontSize: Math.hypot(c, d) || Math.hypot(a, b),
    angle: Math.atan2(b, a),
  }
}

/** Removes the item matching `pick` and returns what is left. */
async function removeAndRead(bytes, pick) {
  const before = await itemsOf(bytes)
  const item = before.find(pick)
  expect(item, 'the fixture draws the run to edit').toBeTruthy()
  const doc = await PDFDocument.load(bytes)
  const removed = removeTextRuns(doc.getPage(0), [targetFor(item)])
  const out = await doc.save({ useObjectStreams: true })
  return { before, after: await itemsOf(out), removed, item }
}

/** Two words on one page, drawn with the given raw content and resources. */
async function pageFromContent(content, resources) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([400, 200])
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content, {})))
  page.node.set(PDFName.of('Resources'), doc.context.obj(resources(font)))
  return doc.save()
}

describe('contentEdit.removeTextRuns', () => {
  it('removes a plain run and leaves its neighbours', async () => {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const page = doc.addPage([400, 200])
    page.drawText('Edit me please', { x: 40, y: 150, size: 20, font })
    page.drawText('Keep this line', { x: 40, y: 120, size: 20, font })
    const { removed, after } = await removeAndRead(await doc.save(), (item) => item.str.includes('Edit me'))
    expect(removed.size).toBe(1)
    expect(justText(after)).toEqual(['Keep this line'])
  })

  it('removes runs drawn with an embedded font', async () => {
    const file = await buildEmbeddedFontPdf()
    const { removed, after } = await removeAndRead(fs.readFileSync(file), (item) => item.str.includes('quick'))
    expect(removed.size).toBe(1)
    expect(justText(after)).toContain('Second line stays')
    expect(justText(after).join('')).not.toContain('quick')
  })

  it('removes runs inside a form XObject', async () => {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const page = doc.addPage([400, 200])
    const form = doc.context.stream('BT /F1 18 Tf 30 40 Td (Inside form object) Tj ET', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 300, 100],
      Resources: { Font: { F1: font.ref } },
    })
    const content = 'q 1 0 0 1 20 130 cm /Fm0 Do Q\nBT /F1 18 Tf 40 40 Td (Outside text) Tj ET'
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content, {})))
    page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: font.ref }, XObject: { Fm0: form } }))
    const { removed, after } = await removeAndRead(await doc.save(), (item) => item.str.includes('Inside'))
    expect(removed.size).toBe(1)
    expect(justText(after)).toEqual(['Outside text'])
  })

  it('removes runs behind cm scaling and Tm translation', async () => {
    const bytes = await pageFromContent(
      'q 2 0 0 2 10 10 cm BT /F1 10 Tf 1 0 0 1 20 50 Tm (Scaled operator text) Tj ET Q',
      (font) => ({ Font: { F1: font.ref } }),
    )
    const { removed, after } = await removeAndRead(bytes, (item) => item.str.includes('Scaled'))
    expect(removed.size).toBe(1)
    expect(justText(after)).toEqual([])
  })

  it('removes a whole TJ array that maps to one item', async () => {
    const bytes = await pageFromContent(
      'BT /F1 16 Tf 40 160 Td [(Whole) -20 (array)] TJ ET\nBT /F1 16 Tf 40 120 Td (Keep line) Tj ET',
      (font) => ({ Font: { F1: font.ref } }),
    )
    const { removed, after } = await removeAndRead(bytes, (item) => item.str.includes('Whole'))
    expect(removed.size).toBe(1)
    expect(justText(after)).toEqual(['Keep line'])
  })

  it('keeps a split TJ untouched instead of eating its sibling', async () => {
    const bytes = await pageFromContent('BT /F1 16 Tf 40 160 Td [(Array) -250 (spaced) 300 (words)] TJ ET', (font) => ({
      Font: { F1: font.ref },
    }))
    const { after, removed } = await removeAndRead(bytes, (item) => item.str.includes('Array'))
    expect(removed.size).toBe(0)
    expect(justText(after).join(' ')).toBe('Array spaced words')
  })

  it('removes consecutive show operators merged into one item', async () => {
    const bytes = await pageFromContent(
      'BT /F1 18 Tf 40 150 Td (Hello ) Tj (merged world) Tj ET\nBT /F1 18 Tf 40 100 Td (Different line) Tj ET',
      (font) => ({ Font: { F1: font.ref } }),
    )
    const { after, removed } = await removeAndRead(bytes, (item) => item.str.includes('Hello'))
    expect(removed.size).toBe(1)
    expect(justText(after)).toEqual(['Different line'])
  })

  it('removes rotated runs', async () => {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const page = doc.addPage([400, 300])
    page.drawText('Rotated run here', { x: 200, y: 60, size: 16, font, rotate: { type: 'degrees', angle: 30 } })
    page.drawText('Flat line', { x: 40, y: 200, size: 16, font })
    const { after, removed } = await removeAndRead(await doc.save(), (item) => item.str.includes('Rotated'))
    expect(removed.size).toBe(1)
    expect(justText(after)).toEqual(['Flat line'])
  })

  it('removes a form painted twice at the same transform', async () => {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const page = doc.addPage([400, 200])
    const form = doc.context.stream('BT /F1 14 Tf 10 20 Td (Shared form text) Tj ET', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 300, 100],
      Resources: { Font: { F1: font.ref } },
    })
    const ref = doc.context.register(form)
    page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: font.ref }, XObject: { A: ref, B: ref } }))
    const content = 'q 1 0 0 1 30 150 cm /A Do Q\nq 1 0 0 1 30 150 cm /B Do Q'
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content, {})))
    const { after, removed } = await removeAndRead(await doc.save(), (item) => item.str.includes('Shared'))
    expect(removed.size).toBe(1)
    expect(justText(after)).toEqual([])
  })

  it('keeps a form painted at different transforms', async () => {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const page = doc.addPage([400, 200])
    const form = doc.context.stream('BT /F1 14 Tf 10 20 Td (Shared form text) Tj ET', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 300, 100],
      Resources: { Font: { F1: font.ref } },
    })
    const ref = doc.context.register(form)
    page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: font.ref }, XObject: { A: ref, B: ref } }))
    const content = 'q 1 0 0 1 30 150 cm /A Do Q\nq 1 0 0 1 30 60 cm /B Do Q'
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content, {})))
    const { after, removed } = await removeAndRead(await doc.save(), (item) => item.str.includes('Shared'))
    expect(removed.size).toBe(0)
    expect(justText(after).filter((text) => text.includes('Shared'))).toHaveLength(2)
  })

  it('keeps a run whose neighbours use another font', async () => {
    const doc = await PDFDocument.create()
    const regular = await doc.embedFont(StandardFonts.Helvetica)
    const bold = await doc.embedFont(StandardFonts.HelveticaBold)
    const page = doc.addPage([400, 200])
    const content = 'BT 40 150 Td /F1 16 Tf (Hello ) Tj /F2 16 Tf (world) Tj ET'
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content, {})))
    page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: regular.ref, F2: bold.ref } }))
    const { after, removed } = await removeAndRead(await doc.save(), (item) => item.str.includes('Hello'))
    expect(removed.size).toBe(0)
    expect(justText(after).join('')).toContain('Hello')
    expect(justText(after).join('')).toContain('world')
  })

  it('removes runs after an explicit text move', async () => {
    const bytes = await pageFromContent('BT 40 150 Td /F1 16 Tf (Hello) Tj 3 0 Td (world) Tj ET', (font) => ({
      Font: { F1: font.ref },
    }))
    const { after, removed } = await removeAndRead(bytes, (item) => item.str.includes('Hello'))
    expect(removed.size).toBe(1)
    expect(justText(after)).toEqual(['world'])
  })

  it('removes runs inside nested form XObjects with a matrix', async () => {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const page = doc.addPage([400, 200])
    const inner = doc.context.stream('BT /F1 14 Tf 5 5 Td (Deep nested text) Tj ET', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 200, 50],
      Resources: { Font: { F1: font.ref } },
    })
    const outer = doc.context.stream('q 1 0 0 1 10 10 cm /Inner Do Q', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 300, 100],
      Matrix: [1.5, 0, 0, 1.5, 10, 20],
      Resources: { XObject: { Inner: inner } },
    })
    const content = 'q 1 0 0 1 20 100 cm /Outer Do Q\nBT /F1 14 Tf 40 30 Td (Outside nested) Tj ET'
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content, {})))
    page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: font.ref }, XObject: { Outer: outer } }))
    const { after, removed } = await removeAndRead(await doc.save(), (item) => item.str.includes('Deep'))
    expect(removed.size).toBe(1)
    expect(justText(after)).toEqual(['Outside nested'])
  })

  it('keeps a run that only partly covers a TJ array', async () => {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const page = doc.addPage([400, 200])
    // The two strings overlap; pdf.js splits them into separate items.
    const content = 'BT /F1 16 Tf 40 160 Td [(First) 300 (Second)] TJ ET'
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content, {})))
    page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: font.ref } }))
    const bytes = await doc.save()
    const before = await itemsOf(bytes)
    expect(before.length).toBeGreaterThan(1)
    const doc2 = await PDFDocument.load(bytes)
    const removed = removeTextRuns(doc2.getPage(0), [targetFor(before[0])])
    expect(removed.size).toBe(0)
  })
})

function justText(items) {
  return items.map((item) => item.str).filter((text) => text.trim())
}
