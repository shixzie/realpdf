import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'

/** Where generated fixtures and downloads are written during tests. */
export const OUT_DIR = process.env.OUT_DIR ?? path.join(os.tmpdir(), 'realpdf-tests')

export const SAMPLE_PDF = path.join(OUT_DIR, 'sample.pdf')

const LIBERATION = path.resolve('node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf')

export function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  return OUT_DIR
}

/** The three-page sample used by the editor, tools, UI and library suites. */
export async function buildSamplePdf(file = SAMPLE_PDF) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)

  const lines = [
    'RealPDF sample document',
    '',
    'This PDF exists so the editor can be exercised end to end:',
    'loading, rendering, annotating and exporting.',
    '',
    'Try the toolbar on the left:',
    '  - Draw freehand with the pen or highlight existing text',
    '  - Drop a text box over a white "Cover" rectangle to replace content',
    '  - Add rectangles, ellipses, lines and arrows',
    '  - Insert images and signatures',
    '  - Reorder or delete pages from the right sidebar',
    '',
    'Everything runs locally in the browser. No uploads, no servers.',
  ]

  for (let index = 1; index <= 3; index += 1) {
    const page = doc.addPage([595, 842])
    page.drawText(`Page ${index} of 3`, {
      x: 56,
      y: 780,
      size: 22,
      font: bold,
      color: rgb(0.07, 0.09, 0.13),
    })
    let y = 730
    for (const line of lines) {
      page.drawText(line, { x: 56, y, size: 12, font, color: rgb(0.15, 0.18, 0.24) })
      y -= line === '' ? 10 : 19
    }
    page.drawRectangle({
      x: 56,
      y: 240,
      width: 483,
      height: 150,
      borderColor: rgb(0.8, 0.84, 0.9),
      borderWidth: 1,
    })
    page.drawText('Signature', { x: 68, y: 360, size: 10, font, color: rgb(0.55, 0.6, 0.68) })
    page.drawLine({
      start: { x: 68, y: 280 },
      end: { x: 320, y: 280 },
      thickness: 0.8,
      color: rgb(0.7, 0.74, 0.8),
    })
    page.drawText('Date', { x: 380, y: 300, size: 10, font, color: rgb(0.55, 0.6, 0.68) })
    page.drawLine({
      start: { x: 380, y: 280 },
      end: { x: 527, y: 280 },
      thickness: 0.8,
      color: rgb(0.7, 0.74, 0.8),
    })
  }

  ensureOutDir()
  fs.writeFileSync(file, await doc.save())
  return file
}

/** A page with AcroForm text, checkbox and dropdown widgets. */
export async function buildFormPdf(file = path.join(OUT_DIR, 'form-fixture.pdf')) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([595, 842])
  page.drawText('Interactive form test', { x: 56, y: 780, size: 18, font })
  const form = doc.getForm()
  const name = form.createTextField('full_name')
  name.addToPage(page, { x: 56, y: 700, width: 300, height: 26 })
  const agree = form.createCheckBox('agree')
  agree.addToPage(page, { x: 56, y: 650, width: 20, height: 20 })
  const color = form.createDropdown('color')
  color.addOptions(['Red', 'Green', 'Blue'])
  color.addToPage(page, { x: 56, y: 600, width: 180, height: 26 })
  ensureOutDir()
  fs.writeFileSync(file, await doc.save())
  return file
}

/** A4 page whose text is drawn with an embedded TrueType font. */
export async function buildEmbeddedFontPdf(file = path.join(OUT_DIR, 'textedit-embedded.pdf')) {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const font = await doc.embedFont(fs.readFileSync(LIBERATION), { subset: false })
  const page = doc.addPage([595, 842])
  page.drawText('The quick brown fox', { x: 56, y: 700, size: 18, font, color: rgb(0.8, 0.1, 0.1) })
  page.drawText('Second line stays', { x: 56, y: 660, size: 12, font, color: rgb(0.1, 0.1, 0.1) })
  ensureOutDir()
  fs.writeFileSync(file, await doc.save())
  return file
}

/** A page whose text is drawn with embedded bold and italic programs. */
export async function buildStyledFontPdf(file = path.join(OUT_DIR, 'textedit-styled.pdf')) {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const dir = path.dirname(LIBERATION)
  const bold = await doc.embedFont(fs.readFileSync(path.join(dir, 'LiberationSans-Bold.ttf')), { subset: false })
  const italic = await doc.embedFont(fs.readFileSync(path.join(dir, 'LiberationSans-Italic.ttf')), { subset: false })
  const page = doc.addPage([500, 300])
  page.drawText('Embedded bold run', { x: 40, y: 240, size: 20, font: bold, color: rgb(0, 0, 0) })
  page.drawText('Embedded italic run', { x: 40, y: 180, size: 20, font: italic, color: rgb(0, 0, 0) })
  ensureOutDir()
  fs.writeFileSync(file, await doc.save())
  return file
}

/** Small page whose text uses the non-embedded base-14 Helvetica. */
export function standardFontPdfBytes() {
  const stream = 'BT /F1 28 Tf 40 100 Td (Standard font test) Tj ET'
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = []
  bodies.forEach((body, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

export function buildStandardFontPdf(file) {
  ensureOutDir()
  fs.writeFileSync(file, standardFontPdfBytes())
  return file
}

/** Page whose text sits on coloured stripes, so a cover would be visible. */
export async function buildStripedPdf(file = path.join(OUT_DIR, 'textedit-striped.pdf')) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([400, 200])
  const colors = [rgb(0.86, 0.2, 0.2), rgb(0.2, 0.65, 0.3), rgb(0.2, 0.3, 0.85)]
  for (let index = 0; index < 13; index += 1) {
    page.drawRectangle({ x: 30 + index * 14, y: 100, width: 14, height: 30, color: colors[index % 3] })
  }
  page.drawText('Replace this', { x: 34, y: 110, size: 16, font, color: rgb(0, 0, 0) })
  ensureOutDir()
  fs.writeFileSync(file, await doc.save())
  return file
}

/** A blank A4 page, used for text annotations. */
export async function buildBlankPdf(file = path.join(OUT_DIR, 'textselect-blank.pdf')) {
  const doc = await PDFDocument.create()
  doc.addPage([595, 842])
  ensureOutDir()
  fs.writeFileSync(file, await doc.save())
  return file
}
